// Routes acp.message/acp.spawned/acp.exited/acp.error events to the correct
// session queue by acpSessionId. Parses ndjson lines into AcpRuntimeEvent.

import type { AcpRuntimeEvent } from "openclaw/plugin-sdk/remote-acpx";
import { log } from "./log.js";

type SessionEventQueue = {
  push(event: AcpRuntimeEvent): void;
  close(): void;
  error(err: Error): void;
};

type SpawnResolver = {
  resolve: () => void;
  reject: (err: Error) => void;
};

// Use Symbol.for globalThis to share state across module loader instances.
// Jiti may load this module multiple times (plugin loader + gateway subsystem),
// creating separate module-level Maps. Symbol.for ensures a single shared instance.
type EventRouterState = {
  sessionQueues: Map<string, SessionEventQueue>;
  spawnResolvers: Map<string, SpawnResolver>;
};

const EVENT_ROUTER_STATE_KEY = Symbol.for("moltbot.remoteAcpxEventRouterState");
function resolveState(): EventRouterState {
  const g = globalThis as typeof globalThis & { [EVENT_ROUTER_STATE_KEY]?: EventRouterState };
  if (!g[EVENT_ROUTER_STATE_KEY]) {
    g[EVENT_ROUTER_STATE_KEY] = {
      sessionQueues: new Map(),
      spawnResolvers: new Map(),
    };
  }
  return g[EVENT_ROUTER_STATE_KEY];
}

const sessionQueues = resolveState().sessionQueues;

export function registerSessionQueue(acpSessionId: string, queue: SessionEventQueue): void {
  sessionQueues.set(acpSessionId, queue);
}

export function unregisterSessionQueue(acpSessionId: string): void {
  sessionQueues.delete(acpSessionId);
}

const spawnResolvers = resolveState().spawnResolvers;

export function registerSpawnResolver(acpSessionId: string, resolver: SpawnResolver): void {
  spawnResolvers.set(acpSessionId, resolver);
}

export function unregisterSpawnResolver(acpSessionId: string): void {
  spawnResolvers.delete(acpSessionId);
}

export function drainAllSessions(): void {
  if (sessionQueues.size > 0 || spawnResolvers.size > 0) {
    log.info(`drainAllSessions: draining ${sessionQueues.size} session(s), ${spawnResolvers.size} spawn resolver(s)`);
  }
  for (const [, queue] of sessionQueues) {
    queue.push({ type: "error", message: "Service stopped" });
    queue.close();
  }
  sessionQueues.clear();
  for (const [, resolver] of spawnResolvers) {
    resolver.reject(new Error("Service stopped"));
  }
  spawnResolvers.clear();
}

function parseNdjsonLine(line: string): AcpRuntimeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (e) {
    log.warn(`parseNdjsonLine: invalid JSON: ${e instanceof Error ? e.message : String(e)} line=${line.slice(0, 200)}`);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  // Handle JSON-RPC 2.0 format (acpx/claude-agent-acp output)
  if (obj.jsonrpc === "2.0") {
    return parseJsonRpcLine(obj);
  }

  // Handle simple event format (legacy acpx --format json output)
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

// Flatten an ACP `session/update` content[] into a single text string.
// Known shapes (all tolerated so claude/codex/gemini flatten consistently):
//   "..."                                                         — bare string
//   [{ type: "content", content: { type: "text", text: "..." } }] — openclaw/translator emit
//   [{ type: "text", text: "..." }]                               — simpler agents
function flattenToolCallContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of value) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const entry = block as Record<string, unknown>;
    if (entry.type === "content" && typeof entry.content === "object" && entry.content !== null) {
      const inner = entry.content as Record<string, unknown>;
      if (typeof inner.text === "string") {
        parts.push(inner.text);
        continue;
      }
    }
    if (typeof entry.text === "string") {
      parts.push(entry.text);
    }
  }
  return parts.join("\n");
}

// Parse JSON-RPC 2.0 messages from acpx / claude-agent-acp
function parseJsonRpcLine(obj: Record<string, unknown>): AcpRuntimeEvent | null {
  const method = typeof obj.method === "string" ? obj.method : "";
  const params = typeof obj.params === "object" && obj.params !== null
    ? (obj.params as Record<string, unknown>)
    : null;
  const result = typeof obj.result === "object" && obj.result !== null
    ? (obj.result as Record<string, unknown>)
    : null;
  const error = typeof obj.error === "object" && obj.error !== null
    ? (obj.error as Record<string, unknown>)
    : null;

  // session/update notifications
  if (method === "session/update" && params) {
    const update = typeof params.update === "object" && params.update !== null
      ? (params.update as Record<string, unknown>)
      : null;
    if (!update) return null;

    const sessionUpdate = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";

    if (sessionUpdate === "agent_message_chunk") {
      const content = typeof update.content === "object" && update.content !== null
        ? (update.content as Record<string, unknown>)
        : null;
      const text = content && typeof content.text === "string" ? content.text : "";
      if (!text) return null;
      return { type: "text_delta", text };
    }

    // Codex / gemini turns are tool-driven and rarely emit agent_message_chunk;
    // they signal progress via tool_call (creation) and tool_call_update (state
    // transitions). Forward both as tool_call AcpRuntimeEvents so the downstream
    // output-collector can surface them in the Operations: section. tag carries
    // the originating sessionUpdate for any future dedupe-by-toolCallId logic.
    if (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
      return {
        type: "tool_call",
        text: flattenToolCallContent(update.content),
        tag: sessionUpdate,
        ...(typeof update.toolCallId === "string" ? { toolCallId: update.toolCallId } : {}),
        ...(typeof update.title === "string" ? { title: update.title } : {}),
        ...(typeof update.status === "string" ? { status: update.status } : {}),
      };
    }

    // Ignore protocol/control messages (usage_update, available_commands_update, etc.)
    return null;
  }

  // JSON-RPC error/result responses are keyed by request id.
  // Only treat errors on the prompt request as fatal turn errors.
  // Protocol errors (session/load "Resource not found", etc.) are handled
  // internally by acpx and should be ignored.
  const rpcId = typeof obj.id === "number" || typeof obj.id === "string" ? obj.id : null;

  if (error) {
    // Track: acpx sends prompt as the highest-numbered request (typically id=3+).
    // Protocol setup requests (initialize=0, session/load=1, session/new=2) may
    // fail with recoverable errors. Only surface errors with high ids or unknown ids
    // as fatal, since we can't reliably track which id is the prompt request.
    // Heuristic: ignore errors with id <= 2 (protocol setup phase).
    // Design Decision: Protocol setup errors (id <= 2) are logged at INFO level and suppressed.
    // Common examples: session/load "Resource not found" (first run), initialize version mismatch.
    if (typeof rpcId === "number" && rpcId <= 2) {
      log.info(`parseJsonRpcLine: suppressed protocol error (id=${rpcId}): ${typeof error.message === "string" ? error.message : JSON.stringify(error)}`);
      return null;
    }
    const msg = typeof error.message === "string" ? error.message : "ACP agent error";
    return { type: "error", message: msg };
  }

  // JSON-RPC result with stopReason → done
  if (result && typeof result.stopReason === "string") {
    return { type: "done", stopReason: result.stopReason };
  }

  // Ignore other JSON-RPC messages (initialize, session/load, session/new, session/prompt)
  return null;
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
    log.warn(`routeNodeEvent: missing acpSessionId in ${evt.event} event`);
    return;
  }

  log.info(`routeNodeEvent: event=${evt.event} acpSessionId=${acpSessionId} queues=${sessionQueues.size} spawns=${spawnResolvers.size}`);

  switch (evt.event) {
    case "acp.spawned": {
      const resolver = spawnResolvers.get(acpSessionId);
      if (resolver) {
        spawnResolvers.delete(acpSessionId);
        resolver.resolve();
      } else {
        log.warn(`acp.spawned with no resolver: acpSessionId=${acpSessionId}`);
      }
      break;
    }
    case "acp.message": {
      const queue = sessionQueues.get(acpSessionId);
      if (!queue) {
        log.warn(`acp.message with no queue: acpSessionId=${acpSessionId} (session may have timed out)`);
        break;
      }
      const line = typeof payload.line === "string" ? payload.line : "";
      if (!line) {
        break;
      }
      const event = parseNdjsonLine(line);
      if (event) {
        queue.push(event);
      } else {
        log.warn(`parseNdjsonLine: unrecognized line=${line.slice(0, 200)}`);
      }
      break;
    }
    case "acp.exited": {
      const queue = sessionQueues.get(acpSessionId);
      if (queue) {
        const exitCode =
          typeof payload.exitCode === "number" ? payload.exitCode : -1;
        const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
        if (exitCode !== 0) {
          queue.push({ type: "error", message: stderr || `ACP agent exited with code ${exitCode}` });
        }
        queue.push({ type: "done" });
        queue.close();
        sessionQueues.delete(acpSessionId);
      } else {
        const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : -1;
        log.warn(`acp.exited with no queue: acpSessionId=${acpSessionId} exitCode=${exitCode} (session may have timed out)`);
      }
      break;
    }
    case "acp.error": {
      const errorMsg = typeof payload.error === "string" ? payload.error : "Unknown ACP error";
      // Surface the payload so spawn-time failures (ENOENT, "Agent command not
      // found: acpx", chdir errors) are visible in the pod log without ssh.
      log.error(`acp.error: acpSessionId=${acpSessionId} error=${errorMsg}`);
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
      } else {
        log.warn(`acp.error with no handler: acpSessionId=${acpSessionId} error=${errorMsg}`);
      }
      break;
    }
    default:
      log.warn(`routeNodeEvent: unrecognized event type="${evt.event}" acpSessionId=${acpSessionId}`);
      break;
  }
}
