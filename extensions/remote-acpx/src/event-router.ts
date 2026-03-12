// Routes acp.message/acp.spawned/acp.exited/acp.error events to the correct
// session queue by acpSessionId. Parses ndjson lines into AcpRuntimeEvent.

import type { AcpRuntimeEvent } from "openclaw/plugin-sdk/remote-acpx";

type SessionEventQueue = {
  push(event: AcpRuntimeEvent): void;
  close(): void;
  error(err: Error): void;
};

const sessionQueues = new Map<string, SessionEventQueue>();

export function registerSessionQueue(acpSessionId: string, queue: SessionEventQueue): void {
  sessionQueues.set(acpSessionId, queue);
}

export function unregisterSessionQueue(acpSessionId: string): void {
  sessionQueues.delete(acpSessionId);
}

// Promise resolvers for acp.spawned responses
type SpawnResolver = {
  resolve: () => void;
  reject: (err: Error) => void;
};
const spawnResolvers = new Map<string, SpawnResolver>();

export function registerSpawnResolver(acpSessionId: string, resolver: SpawnResolver): void {
  spawnResolvers.set(acpSessionId, resolver);
}

export function unregisterSpawnResolver(acpSessionId: string): void {
  spawnResolvers.delete(acpSessionId);
}

function parseNdjsonLine(line: string): AcpRuntimeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";
  switch (type) {
    case "text_delta":
      return {
        type: "text_delta",
        text: typeof obj.text === "string" ? obj.text : "",
        ...(typeof obj.stream === "string" ? { stream: obj.stream as "output" | "thought" } : {}),
        ...(typeof obj.tag === "string" ? { tag: obj.tag } : {}),
      };
    case "status":
      return {
        type: "status",
        text: typeof obj.text === "string" ? obj.text : "",
        ...(typeof obj.tag === "string" ? { tag: obj.tag } : {}),
      };
    case "tool_call":
      return {
        type: "tool_call",
        text: typeof obj.text === "string" ? obj.text : "",
        ...(typeof obj.tag === "string" ? { tag: obj.tag } : {}),
        ...(typeof obj.toolCallId === "string" ? { toolCallId: obj.toolCallId } : {}),
        ...(typeof obj.status === "string" ? { status: obj.status } : {}),
        ...(typeof obj.title === "string" ? { title: obj.title } : {}),
      };
    case "done":
      return {
        type: "done",
        ...(typeof obj.stopReason === "string" ? { stopReason: obj.stopReason } : {}),
      };
    case "error":
      return {
        type: "error",
        message: typeof obj.message === "string" ? obj.message : "Unknown error",
        ...(typeof obj.code === "string" ? { code: obj.code } : {}),
      };
    default:
      // Forward unrecognized types as text_delta for robustness
      if (typeof obj.text === "string") {
        return { type: "text_delta", text: obj.text };
      }
      return null;
  }
}

export function routeNodeEvent(
  _nodeId: string,
  evt: { event: string; payload: unknown },
): void {
  const payload = evt.payload as Record<string, unknown> | null;
  if (!payload) {
    return;
  }
  const acpSessionId = typeof payload.acpSessionId === "string" ? payload.acpSessionId : "";
  if (!acpSessionId) {
    return;
  }

  switch (evt.event) {
    case "acp.spawned": {
      const resolver = spawnResolvers.get(acpSessionId);
      if (resolver) {
        spawnResolvers.delete(acpSessionId);
        resolver.resolve();
      }
      break;
    }
    case "acp.message": {
      const queue = sessionQueues.get(acpSessionId);
      if (!queue) {
        break;
      }
      const line = typeof payload.line === "string" ? payload.line : "";
      if (!line) {
        break;
      }
      const event = parseNdjsonLine(line);
      if (event) {
        queue.push(event);
      }
      break;
    }
    case "acp.exited": {
      const queue = sessionQueues.get(acpSessionId);
      if (queue) {
        const exitCode =
          typeof payload.exitCode === "number" ? payload.exitCode : -1;
        const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
        if (exitCode !== 0 && stderr) {
          queue.push({ type: "error", message: stderr });
        }
        queue.push({ type: "done" });
        queue.close();
        sessionQueues.delete(acpSessionId);
      }
      break;
    }
    case "acp.error": {
      const errorMsg = typeof payload.error === "string" ? payload.error : "Unknown ACP error";
      // Check if this is a spawn error
      const spawnResolver = spawnResolvers.get(acpSessionId);
      if (spawnResolver) {
        spawnResolvers.delete(acpSessionId);
        spawnResolver.reject(new Error(errorMsg));
        break;
      }
      // Otherwise route to session queue
      const queue = sessionQueues.get(acpSessionId);
      if (queue) {
        queue.push({ type: "error", message: errorMsg });
        queue.close();
        sessionQueues.delete(acpSessionId);
      }
      break;
    }
  }
}
