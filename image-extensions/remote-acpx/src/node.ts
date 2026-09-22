import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import type { NodeConfig } from "./config.js";
import {
  COMMAND,
  MAX_BUFFER_BYTES,
  MAX_MESSAGE_BYTES,
  clientMessageSchema,
  decodeMessage,
  encodeMessage,
  envelopeSchema,
  parseRequest,
  serverMessageSchema,
  type ClientMessage,
  type Request,
  type ServerMessage,
  type WorkerInput,
} from "./protocol.js";

type TerminalMessage = Extract<ServerMessage, { type: "value" | "result" }>;
type WorkerOwner = {
  request: Request;
  cancel: () => Promise<void>;
  send: (message: ClientMessage) => Promise<void>;
  closed: Promise<void>;
};

function requestHandle(request: Request) {
  return "handle" in request.input
    ? request.input.handle
    : "persistedHandle" in request.input
      ? request.input.persistedHandle
      : undefined;
}

function hasSameHandle(left: Request, right: Request): boolean {
  const a = requestHandle(left);
  const b = requestHandle(right);
  return Boolean(
    a &&
    b &&
    a.backend === b.backend &&
    a.runtimeSessionName === b.runtimeSessionName &&
    a.acpxRecordId === b.acpxRecordId &&
    a.backendSessionId === b.backendSessionId,
  );
}

type NodeOptions = {
  /** Local dependency injection for process-boundary tests; never accepted over the wire. */
  workerUrl?: URL;
  cancelGraceMs?: number;
  killGraceMs?: number;
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

async function finishesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sendWorker(child: ChildProcess, message: WorkerInput): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected) {
      reject(new Error("Remote ACP worker connection is closed."));
      return;
    }
    child.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

function signalWorkerGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    // Workers are detached POSIX group leaders; never signal the node host's group.
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

/** Each invocation owns one worker and its process tree until complete cleanup. */
export function createRemoteAcpxNodeCommand(
  config: NodeConfig | undefined,
  options: NodeOptions = {},
): OpenClawPluginNodeHostCommand {
  const writers = new Map<string, WorkerOwner>();
  const workers = new Set<WorkerOwner>();
  const cancelGraceMs = options.cancelGraceMs ?? 5_000;
  const killGraceMs = options.killGraceMs ?? 1_000;
  const workerUrl = options.workerUrl ?? new URL("./worker.ts", import.meta.url);
  let disconnecting: Promise<void> | undefined;

  return {
    command: COMMAND,
    cap: "remote-acpx",
    dangerous: true,
    duplex: true,
    isAvailable: () => Boolean(config) && process.platform !== "win32",
    onDisconnect: () => {
      if (disconnecting) return disconnecting;
      const cleanup = Promise.all([...workers].map((owner) => owner.cancel())).then(() => {});
      disconnecting = cleanup.finally(() => {
        disconnecting = undefined;
      });
      return disconnecting;
    },
    async handle(paramsJSON, io, context) {
      if (process.platform === "win32")
        throw new Error("Remote ACP node execution currently supports macOS and Linux only.");
      if (!config)
        throw new Error("Configure remote-acpx.node on this paired node before executing ACP.");
      if (!io?.frames || !context)
        throw new Error("Remote ACP requires framed node invocation context.");
      if (disconnecting) throw new Error("Remote ACP node is still cleaning up disconnected work.");
      const envelope = envelopeSchema.parse(JSON.parse(paramsJSON ?? "null"));
      const request = parseRequest(envelope.request);
      const readOnly = request.op === "status" || request.op === "capabilities";
      if (context.sessionKey !== request.owner.sessionKey) {
        throw new Error("Remote ACP invocation session does not match its owner.");
      }
      if ((request.op === "cancel") !== (envelope.authorization === "cancel-only")) {
        throw new Error("Remote ACP authorization does not match the requested operation.");
      }
      const signal = context.signal ? AbortSignal.any([io.signal, context.signal]) : io.signal;
      signal.throwIfAborted();
      const key = JSON.stringify([request.owner.agentId, request.owner.sessionKey]);
      let owner: WorkerOwner | undefined;
      let cancellationBeforeSpawn = false;
      const frameFailure = deferred<never>();
      const unsubscribe = io.frames.onMessage(async (bytes) => {
        try {
          const message = clientMessageSchema.parse(decodeMessage(bytes));
          if (message.type === "cancel") {
            cancellationBeforeSpawn = true;
            await owner?.cancel();
          } else {
            if (!owner)
              throw new Error("Remote ACP worker is not ready for elicitation responses.");
            await owner.send(message);
          }
        } catch (error) {
          frameFailure.reject(error);
          throw error;
        }
      });
      try {
        if (request.op === "cancel") {
          const running = writers.get(key);
          if (running?.request.op === "turn") {
            if (!hasSameHandle(request, running.request))
              throw new Error("Remote ACP cancellation handle does not match the active turn.");
            await running.cancel();
          }
          return JSON.stringify({
            type: "value",
            value: { cancelled: running?.request.op === "turn" },
          });
        }
        if (!context.prepareExecAuthorization) {
          throw new Error("Remote ACP requires node-local exec authorization support.");
        }
        const assertAuthorized = context.prepareExecAuthorization("human-approved");
        const previous = writers.get(key);
        if (previous && (request.op === "fresh" || request.op === "close")) {
          if (requestHandle(request) && !hasSameHandle(request, previous.request)) {
            throw new Error("Remote ACP session handle does not match its active worker.");
          }
          await previous.cancel();
        }
        if (!readOnly && writers.has(key))
          throw new Error("ACP_SESSION_BUSY: this node session already has active work.");
        if (cancellationBeforeSpawn)
          throw new Error("Remote ACP execution was cancelled before launch.");
        signal.throwIfAborted();
        const start: WorkerInput = { type: "start", request, config };
        encodeMessage(start);

        // No awaited work may separate this guard from the actual process spawn.
        assertAuthorized();
        const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(workerUrl)], {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          detached: true,
          serialization: "json",
        });
        const exited = deferred<void>();
        const terminal = deferred<TerminalMessage>();
        let hasExited = false;
        let hasTerminal = false;
        let pendingBytes = 0;
        let delivery = Promise.resolve();
        let termination: Promise<void> | undefined;
        let groupTerminated = false;
        const forceGroup = () => {
          if (!groupTerminated && child.pid) {
            signalWorkerGroup(child.pid, "SIGKILL");
            groupTerminated = true;
          }
        };
        let diagnostic = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          diagnostic = (diagnostic + chunk.toString("utf8")).slice(-4_096);
        });
        child.on("error", (error) => terminal.reject(error));
        child.once("close", (code, childSignal) => {
          hasExited = true;
          if (!hasTerminal) {
            if (child.pid) {
              try {
                forceGroup();
              } catch (error) {
                terminal.reject(error);
              }
            }
            terminal.reject(
              new Error(
                `Remote ACP worker exited before a result (${childSignal ?? code ?? "unknown"}).${diagnostic ? ` ${diagnostic}` : ""}`,
              ),
            );
          }
          if (writers.get(key) === owner) writers.delete(key);
          if (owner) workers.delete(owner);
          exited.resolve();
        });
        const cancel = () =>
          (termination ??= (async () => {
            if (hasExited) return;
            // A blocked child IPC channel must not postpone the termination deadline.
            void sendWorker(child, { type: "cancel" }).catch(() => {});
            if (await finishesWithin(exited.promise, cancelGraceMs)) return;
            if (!child.pid)
              throw new Error("Remote ACP worker process identity is unavailable during cleanup.");
            signalWorkerGroup(child.pid, "SIGTERM");
            const rootExited = await finishesWithin(exited.promise, killGraceMs);
            // The root may exit before its ACP descendants; finish the retained tree cleanup too.
            forceGroup();
            if (!rootExited) {
              if (!(await finishesWithin(exited.promise, 5_000))) {
                throw new Error(
                  "Remote ACP worker did not exit after process-tree termination; session remains busy.",
                );
              }
            }
          })());
        owner = {
          request,
          cancel,
          closed: exited.promise,
          send: (message) => sendWorker(child, message),
        };
        if (!readOnly) writers.set(key, owner);
        workers.add(owner);
        child.on("message", (raw: unknown) => {
          try {
            const message = serverMessageSchema.parse(raw);
            if (hasTerminal)
              throw new Error("Remote ACP worker sent data after its terminal result.");
            const bytes = encodeMessage(message);
            if (
              bytes.byteLength > MAX_MESSAGE_BYTES ||
              pendingBytes + bytes.byteLength > MAX_BUFFER_BYTES
            ) {
              throw new Error("Remote ACP worker exceeded its output delivery buffer.");
            }
            if (message.type === "value" || message.type === "result") {
              hasTerminal = true;
              terminal.resolve(message);
            } else if (message.type === "error") {
              hasTerminal = true;
              terminal.reject(
                new Error(`${message.code ? `${message.code}: ` : ""}${message.message}`),
              );
            } else {
              pendingBytes += bytes.byteLength;
              delivery = delivery
                .then(() => io.frames!.send(bytes))
                .finally(() => {
                  pendingBytes -= bytes.byteLength;
                });
              void delivery.catch((error) => terminal.reject(error));
            }
          } catch (error) {
            terminal.reject(error);
          }
        });
        const onAbort = () => {
          terminal.reject(signal.reason ?? new Error("Remote ACP invocation was cancelled."));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        try {
          await Promise.race([sendWorker(child, start), terminal.promise, frameFailure.promise]);
          const result = await Promise.race([terminal.promise, frameFailure.promise]);
          await delivery;
          if (!(await finishesWithin(exited.promise, 5_000))) await cancel();
          await exited.promise;
          return JSON.stringify(result);
        } finally {
          signal.removeEventListener("abort", onAbort);
          try {
            await cancel();
          } finally {
            // Failed cleanup retains its owner so another worker cannot race the old writer.
            if (hasExited && writers.get(key) === owner) writers.delete(key);
            if (hasExited) workers.delete(owner);
          }
        }
      } finally {
        unsubscribe();
      }
    },
  };
}
