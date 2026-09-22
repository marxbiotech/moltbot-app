import { randomUUID } from "node:crypto";
import { parseConfig } from "./config.js";
import {
  clientMessageSchema,
  parseRequest,
  retainsWorker,
  permissionResponse,
  type ElicitationResponse,
  type PermissionResponse,
  type ServerMessage,
} from "./protocol.js";
import { createWorkerRuntime } from "./worker-runtime.js";

const pending = new Map<string, (response: ElicitationResponse) => void>();
const pendingPermissions = new Map<string, (response: PermissionResponse) => void>();
let runtime: ReturnType<typeof createWorkerRuntime> | undefined;
let controller: AbortController | undefined;
let running = false;
let stopping = false;

function send(message: ServerMessage): Promise<void> {
  if (!process.connected || !process.send)
    return Promise.reject(new Error("ACP worker parent disconnected"));
  return new Promise((resolve, reject) =>
    process.send!(message, (error: Error | null) => (error ? reject(error) : resolve())),
  );
}

async function shutdown(): Promise<void> {
  stopping = true;
  await runtime?.shutdown();
  if (process.connected) process.disconnect();
}
function stop(): void {
  stopping = true;
  controller?.abort(new Error("ACP worker cancelled"));
  for (const resolve of pending.values()) resolve({ action: "cancel" });
  pending.clear();
  for (const resolve of pendingPermissions.values()) resolve({ outcome: "cancel" });
  pendingPermissions.clear();
  if (!running) void shutdown().catch(() => process.exit(1));
}

async function start(value: Record<string, unknown>): Promise<void> {
  const config = parseConfig({ node: value.config }).node;
  if (!config) throw new Error("ACP worker requires node configuration");
  const request = parseRequest(value.request);
  const current = new AbortController();
  controller = current;
  runtime ??= createWorkerRuntime({ type: "start", request, config });
  const terminal = await runtime.run(request, {
    signal: current.signal,
    send,
    onPermissionRequest: async (permission, context) => {
      if (
        request.op !== "turn" ||
        !request.input.permissions ||
        current.signal.aborted ||
        context.signal.aborted ||
        pendingPermissions.size >= 32
      )
        return { outcome: "cancel" };
      const id = randomUUID();
      const signal = AbortSignal.any([current.signal, context.signal]);
      let cancel: () => void = () => {};
      const response = new Promise<PermissionResponse>((resolve) => {
        pendingPermissions.set(id, resolve);
        cancel = () => resolve({ outcome: "cancel" });
        signal.addEventListener("abort", cancel, { once: true });
      });
      try {
        await send({ type: "permission", id, request: permission });
        const value = await response;
        return signal.aborted ? { outcome: "cancel" } : permissionResponse(permission, value);
      } finally {
        signal.removeEventListener("abort", cancel);
        pendingPermissions.delete(id);
      }
    },
    onElicitation: async (elicitation, context) => {
      if (
        request.op !== "turn" ||
        !request.input.elicitation ||
        current.signal.aborted ||
        context.signal.aborted
      )
        return { action: "cancel" };
      const id = randomUUID();
      let cancel: () => void = () => {};
      const response = new Promise<ElicitationResponse>((resolve) => {
        pending.set(id, resolve);
        cancel = () => resolve({ action: "cancel" });
        context.signal.addEventListener("abort", cancel, { once: true });
      });
      try {
        await send({ type: "elicitation", id, request: elicitation });
        return await response;
      } finally {
        context.signal.removeEventListener("abort", cancel);
        pending.delete(id);
      }
    },
  });
  const retain = retainsWorker(request) && terminal.type !== "error" && !stopping;
  if (!retain) await runtime.shutdown();
  // The response settles admission. No later request may inherit this controller.
  running = false;
  controller = undefined;
  if (!retain) stopping = true;
  await send(terminal);
  if (!retain && process.connected) process.disconnect();
}

process.on("message", (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const message = value as Record<string, unknown>;
  if (message.type === "start") {
    if (running || stopping) {
      stop();
      return;
    }
    running = true;
    void start(message).catch(async (error: unknown) => {
      stopping = true;
      await runtime?.shutdown().catch(() => {});
      await send({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
      if (process.connected) process.disconnect();
    });
    return;
  }
  const parsed = clientMessageSchema.safeParse(value);
  if (!parsed.success) {
    stop();
    return;
  }
  if (parsed.data.type === "cancel") stop();
  else if (parsed.data.type === "permission_response")
    pendingPermissions.get(parsed.data.id)?.(parsed.data.response);
  else pending.get(parsed.data.id)?.(parsed.data.response);
});
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
