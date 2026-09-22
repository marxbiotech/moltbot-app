import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  encodeMessage,
  MAX_BUFFER_BYTES,
  serverMessageSchema,
  type ClientMessage,
  type ServerMessage,
  type WorkerInput,
  type WorkerStart,
} from "./protocol.js";

type Terminal = Extract<ServerMessage, { type: "value" | "result" }>;
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
async function finishesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One process owner; each request installs a new, bounded response sink. */
export function launchWorker(options: {
  url: URL;
  cancelGraceMs: number;
  killGraceMs: number;
  onClose: () => void;
}) {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(options.url)], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    detached: true,
    serialization: "json",
  });
  const exited = deferred<void>();
  let hasExited = false;
  let diagnostic = "";
  let failure: Error | undefined;
  let termination: Promise<void> | undefined;
  let groupTerminated = false;
  let active:
    | {
        terminal: ReturnType<typeof deferred<Terminal>>;
        receivedTerminal: boolean;
        pendingBytes: number;
        delivery: Promise<void>;
        send: (bytes: Uint8Array) => Promise<void>;
      }
    | undefined;
  function signalGroup(signal: "SIGTERM" | "SIGKILL") {
    if (!child.pid)
      throw new Error("Remote ACP worker process identity is unavailable during cleanup.");
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  const forceGroup = () => {
    if (!groupTerminated) {
      signalGroup("SIGKILL");
      groupTerminated = true;
    }
  };
  const send = (message: WorkerInput): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!child.connected) {
        reject(new Error("Remote ACP worker connection is closed."));
        return;
      }
      child.send(message, (error) => (error ? reject(error) : resolve()));
    });
  const cancel = () =>
    (termination ??= (async () => {
      if (hasExited) return;
      void send({ type: "cancel" }).catch(() => {});
      if (await finishesWithin(exited.promise, options.cancelGraceMs)) return;
      signalGroup("SIGTERM");
      const rootExited = await finishesWithin(exited.promise, options.killGraceMs);
      // The process leader may exit before its descendants.
      forceGroup();
      if (!rootExited && !(await finishesWithin(exited.promise, 5_000)))
        throw new Error(
          "Remote ACP worker did not exit after process-tree termination; session remains busy.",
        );
    })());
  const fail = (error: unknown) => {
    failure = error instanceof Error ? error : new Error(String(error));
    active?.terminal.reject(failure);
    void cancel().catch(() => {});
  };
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-4_096);
  });
  child.on("error", fail);
  child.once("close", (code, signal) => {
    hasExited = true;
    // Also reap descendants of an idle setup worker that exits unexpectedly.
    try {
      forceGroup();
    } catch (error) {
      active?.terminal.reject(error);
    }
    if (active && !active.receivedTerminal) {
      active.terminal.reject(
        new Error(
          `Remote ACP worker exited before a result (${signal ?? code ?? "unknown"}).${diagnostic ? ` ${diagnostic}` : ""}`,
        ),
      );
    }
    options.onClose();
    exited.resolve();
  });
  child.on("message", (raw: unknown) => {
    try {
      const current = active;
      if (!current || current.receivedTerminal)
        throw new Error("Remote ACP worker sent data outside its invocation.");
      const message = serverMessageSchema.parse(raw);
      const bytes = encodeMessage(message);
      if (current.pendingBytes + bytes.byteLength > MAX_BUFFER_BYTES)
        throw new Error("Remote ACP worker exceeded its output delivery buffer.");
      if (message.type === "value" || message.type === "result") {
        current.receivedTerminal = true;
        current.terminal.resolve(message);
      } else if (message.type === "error") {
        current.receivedTerminal = true;
        current.terminal.reject(
          new Error(`${message.code ? `${message.code}: ` : ""}${message.message}`),
        );
      } else {
        current.pendingBytes += bytes.byteLength;
        current.delivery = current.delivery
          .then(() => current.send(bytes))
          .finally(() => {
            current.pendingBytes -= bytes.byteLength;
          });
        void current.delivery.catch(fail);
      }
    } catch (error) {
      fail(error);
    }
  });
  return {
    get hasExited() {
      return hasExited;
    },
    get reusable() {
      return !hasExited && !termination && !failure && child.connected;
    },
    closed: exited.promise,
    cancel,
    send: (message: ClientMessage) => send(message),
    async execute(
      start: WorkerStart,
      output: (bytes: Uint8Array) => Promise<void>,
    ): Promise<Terminal> {
      if (active) throw new Error("ACP_SESSION_BUSY: worker already has an active invocation.");
      if (failure) throw failure;
      const current = {
        terminal: deferred<Terminal>(),
        receivedTerminal: false,
        pendingBytes: 0,
        delivery: Promise.resolve(),
        send: output,
      };
      active = current;
      try {
        await Promise.race([send(start), current.terminal.promise]);
        const terminal = await current.terminal.promise;
        await current.delivery;
        if (failure) throw failure;
        return terminal;
      } finally {
        active = undefined;
      }
    },
    async finish() {
      if (!(await finishesWithin(exited.promise, 5_000))) await cancel();
      await exited.promise;
    },
  };
}
