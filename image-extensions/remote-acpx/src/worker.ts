import { randomUUID } from "node:crypto";
import { parseConfig } from "./config.js";
import {
  clientMessageSchema,
  parseRequest,
  type ElicitationResponse,
  type ServerMessage,
  type WorkerStart,
} from "./protocol.js";
import { runWorker } from "./worker-runtime.js";

const controller = new AbortController();
const pending = new Map<string, (response: ElicitationResponse) => void>();
let running = false;

function send(message: ServerMessage): Promise<void> {
  if (!process.connected || !process.send)
    return Promise.reject(new Error("ACP worker parent disconnected"));
  return new Promise((resolve, reject) =>
    process.send!(message, (error: Error | null) => (error ? reject(error) : resolve())),
  );
}

function stop(): void {
  controller.abort(new Error("ACP worker cancelled"));
  for (const resolve of pending.values()) resolve({ action: "cancel" });
  pending.clear();
}

async function start(value: Record<string, unknown>): Promise<void> {
  const config = parseConfig({ node: value.config }).node;
  if (!config) throw new Error("ACP worker requires node configuration");
  const request = parseRequest(value.request);
  const message: WorkerStart = { type: "start", request, config };
  await runWorker(message, {
    signal: controller.signal,
    send,
    onElicitation: async (request, context) => {
      if (controller.signal.aborted || context.signal.aborted) return { action: "cancel" };
      const id = randomUUID();
      let cancel: () => void = () => {};
      const response = new Promise<ElicitationResponse>((resolve) => {
        pending.set(id, resolve);
        cancel = () => resolve({ action: "cancel" });
        context.signal.addEventListener("abort", cancel, { once: true });
      });
      try {
        await send({ type: "elicitation", id, request });
        return await response;
      } finally {
        context.signal.removeEventListener("abort", cancel);
        pending.delete(id);
      }
    },
  });
}

process.on("message", (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const message = value as Record<string, unknown>;
  if (message.type === "start") {
    if (running) {
      stop();
      return;
    }
    running = true;
    void start(message)
      .catch(async (error: unknown) => {
        await send({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
      })
      .finally(() => {
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
  else pending.get(parsed.data.id)?.(parsed.data.response);
});
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
