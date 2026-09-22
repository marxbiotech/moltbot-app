import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import type { NodeConfig } from "./config.js";
import {
  COMMAND,
  clientMessageSchema,
  decodeMessage,
  encodeMessage,
  envelopeSchema,
  handleSchema,
  parseRequest,
  retainsWorker,
  type Request,
  type WorkerStart,
} from "./protocol.js";
import { launchWorker } from "./worker-process.js";

type Worker = ReturnType<typeof launchWorker>;
type Active = { request: Request; worker: Worker; done: Promise<void> };
type NodeOptions = {
  /** Local dependency injection for process-boundary tests; never accepted over the wire. */
  workerUrl?: URL;
  cancelGraceMs?: number;
  killGraceMs?: number;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function requestHandle(request: Request) {
  return "handle" in request.input
    ? request.input.handle
    : "persistedHandle" in request.input
      ? request.input.persistedHandle
      : undefined;
}
function sameHandle(
  a: ReturnType<typeof requestHandle>,
  b: ReturnType<typeof requestHandle>,
): boolean {
  return Boolean(
    a &&
    b &&
    a.backend === b.backend &&
    a.runtimeSessionName === b.runtimeSessionName &&
    a.acpxRecordId === b.acpxRecordId &&
    a.backendSessionId === b.backendSessionId,
  );
}

/** Retain only session setup between invocations; turns still join worker cleanup. */
export function createRemoteAcpxNodeCommand(
  config: NodeConfig | undefined,
  options: NodeOptions = {},
): OpenClawPluginNodeHostCommand {
  const writers = new Map<string, Active>();
  const idle = new Map<string, { worker: Worker; handle: ReturnType<typeof requestHandle> }>();
  const workers = new Set<Worker>();
  let disconnecting: Promise<void> | undefined;
  return {
    command: COMMAND,
    cap: "remote-acpx",
    dangerous: true,
    duplex: true,
    isAvailable: () => Boolean(config) && process.platform !== "win32",
    onDisconnect: () => {
      if (disconnecting) return disconnecting;
      disconnecting = Promise.all([...workers].map((worker) => worker.cancel()))
        .then(() => {})
        .finally(() => {
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
      if (context.sessionKey !== request.owner.sessionKey)
        throw new Error("Remote ACP invocation session does not match its owner.");
      if ((request.op === "cancel") !== (envelope.authorization === "cancel-only"))
        throw new Error("Remote ACP authorization does not match the requested operation.");
      const signal = context.signal ? AbortSignal.any([io.signal, context.signal]) : io.signal;
      signal.throwIfAborted();
      const key = JSON.stringify([request.owner.agentId, request.owner.sessionKey]);
      const readOnly = request.op === "status" || request.op === "capabilities";
      let worker: Worker | undefined;
      let cancelledBeforeAdmission = false;
      const frameFailure = deferred<never>();
      const unsubscribe = io.frames.onMessage(async (bytes) => {
        try {
          const message = clientMessageSchema.parse(decodeMessage(bytes));
          if (message.type === "cancel") {
            cancelledBeforeAdmission = true;
            await worker?.cancel();
          } else {
            if (!worker)
              throw new Error("Remote ACP worker is not ready for elicitation responses.");
            await worker.send(message);
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
            if (!sameHandle(requestHandle(request), requestHandle(running.request)))
              throw new Error("Remote ACP cancellation handle does not match the active turn.");
            await running.worker.cancel();
            await running.done;
          }
          return JSON.stringify({
            type: "value",
            value: { cancelled: running?.request.op === "turn" },
          });
        }
        const assertAuthorized =
          envelope.authorization === "node-policy"
            ? context.prepareConfiguredExecAuthorization?.()
            : context.prepareExecAuthorization?.("human-approved");
        if (!assertAuthorized)
          throw new Error(
            "Remote ACP requires matching node-local exec authorization support; upgrade the node host for node-policy execution.",
          );
        const previous = writers.get(key);
        if (previous && (request.op === "fresh" || request.op === "close")) {
          if (
            requestHandle(request) &&
            !sameHandle(requestHandle(request), requestHandle(previous.request))
          )
            throw new Error("Remote ACP session handle does not match its active worker.");
          await previous.worker.cancel();
          await previous.done;
        }
        if (!readOnly && writers.has(key))
          throw new Error("ACP_SESSION_BUSY: this node session already has active work.");
        if (cancelledBeforeAdmission)
          throw new Error("Remote ACP execution was cancelled before launch.");
        signal.throwIfAborted();
        const start: WorkerStart = { type: "start", request, config };
        encodeMessage(start);
        const setup = readOnly ? undefined : idle.get(key);
        const retained = setup?.worker;
        if (
          setup?.handle &&
          requestHandle(request) &&
          !sameHandle(requestHandle(request), setup.handle)
        )
          throw new Error("Remote ACP session handle does not match its retained setup worker.");
        if (retained && !retained.reusable) {
          await retained.cancel();
          if (writers.has(key))
            throw new Error("ACP_SESSION_BUSY: this node session already has active work.");
        }
        signal.throwIfAborted();
        if (disconnecting)
          throw new Error("Remote ACP node is still cleaning up disconnected work.");
        // Both process creation and reuse require this invocation's live authority.
        // No await separates the guard from spawn or the admitted IPC request.
        assertAuthorized();
        if (retained?.reusable) {
          worker = retained;
          idle.delete(key);
        } else {
          worker = launchWorker({
            url: options.workerUrl ?? new URL("./worker.ts", import.meta.url),
            cancelGraceMs: options.cancelGraceMs ?? 5_000,
            killGraceMs: options.killGraceMs ?? 1_000,
            onClose: () => {
              if (idle.get(key)?.worker === worker) idle.delete(key);
              if (writers.get(key)?.worker === worker) writers.delete(key);
              if (worker) workers.delete(worker);
            },
          });
          workers.add(worker);
        }
        const done = deferred<void>();
        const active = { request, worker, done: done.promise };
        if (!readOnly) writers.set(key, active);
        let keep = false;
        const aborted = deferred<never>();
        const onAbort = () =>
          aborted.reject(signal.reason ?? new Error("Remote ACP invocation was cancelled."));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        try {
          const result = await Promise.race([
            worker.execute(start, io.frames.send),
            frameFailure.promise,
            aborted.promise,
          ]);
          signal.throwIfAborted();
          keep = retainsWorker(request) && worker.reusable;
          if (keep) {
            const parsed =
              result.type === "value" && request.op === "ensure"
                ? handleSchema.safeParse(result.value)
                : undefined;
            idle.set(key, {
              worker,
              handle: parsed?.success ? parsed.data : requestHandle(request),
            });
          } else await worker.finish();
          return JSON.stringify(result);
        } finally {
          signal.removeEventListener("abort", onAbort);
          try {
            if (!keep) await worker.cancel();
          } finally {
            // Failed cleanup retains the busy owner until the process actually exits.
            if ((keep || worker.hasExited) && writers.get(key) === active) writers.delete(key);
            done.resolve();
          }
        }
      } finally {
        unsubscribe();
      }
    },
  };
}
