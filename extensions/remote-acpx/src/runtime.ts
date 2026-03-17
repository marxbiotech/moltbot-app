// Core AcpRuntime implementation for remote dispatch.
// Sends ACP events to a paired Mac node via WebSocket and yields
// AcpRuntimeEvent from the ndjson stream coming back.

import { randomUUID } from "node:crypto";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurnInput,
  PluginLogger,
} from "openclaw/plugin-sdk/remote-acpx";
import {
  AcpRuntimeError,
  sendAcpEventToNode,
  isAcpNodeConnected,
} from "openclaw/plugin-sdk/remote-acpx";
import { log } from "./log.js";
import { resolveNodeId } from "./node-resolver.js";
import {
  registerSessionQueue,
  unregisterSessionQueue,
  registerSpawnResolver,
  unregisterSpawnResolver,
} from "./event-router.js";

export const REMOTE_ACPX_BACKEND_ID = "remote-acpx";

const HANDLE_PREFIX = "remote-acpx:v1:";

type RemoteHandleState = {
  acpSessionId: string;
  nodeId: string;
  agent: string;
  cwd: string;
  sessionName: string;
};

function encodeHandle(state: RemoteHandleState): string {
  if (!state.acpSessionId || !state.nodeId || !state.agent) {
    throw new Error(`encodeHandle: missing required fields: acpSessionId=${state.acpSessionId}, nodeId=${state.nodeId}, agent=${state.agent}`);
  }
  return HANDLE_PREFIX + Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeHandle(runtimeSessionName: string): RemoteHandleState | null {
  if (!runtimeSessionName.startsWith(HANDLE_PREFIX)) {
    return null;
  }
  try {
    const raw = Buffer.from(runtimeSessionName.slice(HANDLE_PREFIX.length), "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const acpSessionId = typeof obj.acpSessionId === "string" ? obj.acpSessionId : "";
    const nodeId = typeof obj.nodeId === "string" ? obj.nodeId : "";
    const agent = typeof obj.agent === "string" ? obj.agent : "";
    const cwd = typeof obj.cwd === "string" ? obj.cwd : "";
    const sessionName = typeof obj.sessionName === "string" ? obj.sessionName : "";
    if (!acpSessionId || !nodeId || !agent) {
      return null;
    }
    return { acpSessionId, nodeId, agent, cwd, sessionName };
  } catch (e) {
    log.warn(`decodeHandle: failed to decode: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export type RemoteAcpxConfig = {
  nodeName: string;
  agentCommand: string;
  defaultAgent: string;
  cwd?: string;
  permissionMode: string;
  turnTimeoutMs: number;
};

export class RemoteAcpxRuntime implements AcpRuntime {
  private readonly config: RemoteAcpxConfig;
  private readonly logger?: PluginLogger;

  constructor(config: RemoteAcpxConfig, opts?: { logger?: PluginLogger }) {
    this.config = config;
    this.logger = opts?.logger;
  }

  isHealthy(): boolean {
    try {
      const nodeId = resolveNodeId(this.config.nodeName);
      const connected = nodeId !== null && isAcpNodeConnected(nodeId);
      if (!connected) {
        log.warn(`isHealthy=false nodeName=${this.config.nodeName} nodeId=${nodeId}`);
      }
      return connected;
    } catch (e: unknown) {
      log.error(`isHealthy exception: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    const nodeId = resolveNodeId(this.config.nodeName);
    if (!nodeId) {
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNAVAILABLE",
        `Node "${this.config.nodeName}" is not connected.`,
      );
    }
    if (!isAcpNodeConnected(nodeId)) {
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNAVAILABLE",
        `Node "${this.config.nodeName}" (${nodeId}) is offline.`,
      );
    }

    const acpSessionId = `racp-${randomUUID()}`;
    const agent = input.agent || this.config.defaultAgent;
    const cwd = input.cwd || this.config.cwd || "";
    const sessionName = input.sessionKey;

    // Send acp.spawn and wait for acp.spawned response
    const spawnPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unregisterSpawnResolver(acpSessionId);
        reject(new Error("acp.spawn timed out (10s)"));
      }, 10_000);
      registerSpawnResolver(acpSessionId, {
        resolve: () => { clearTimeout(timeout); resolve(); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });
    });

    const sent = sendAcpEventToNode(nodeId, "acp.spawn", {
      acpSessionId,
      agentCommand: this.config.agentCommand,
      agent,
      cwd,
    });
    if (!sent) {
      unregisterSpawnResolver(acpSessionId);
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNAVAILABLE",
        `Failed to send acp.spawn to node ${nodeId}.`,
      );
    }

    try {
      await spawnPromise;
    } catch (err) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `ACP spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.logger?.info?.(`ACP session ensured: ${acpSessionId} on node ${nodeId}`);

    return {
      sessionKey: input.sessionKey,
      backend: REMOTE_ACPX_BACKEND_ID,
      runtimeSessionName: encodeHandle({
        acpSessionId,
        nodeId,
        agent,
        cwd,
        sessionName,
      }),
      cwd: cwd || undefined,
    };
  }

  async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
    const state = decodeHandle(input.handle.runtimeSessionName);
    if (!state) {
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        "Invalid remote-acpx handle.",
      );
    }

    if (!isAcpNodeConnected(state.nodeId)) {
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNAVAILABLE",
        `Node ${state.nodeId} disconnected.`,
      );
    }

    // Create an async iterable backed by a queue
    const eventQueue: AcpRuntimeEvent[] = [];
    let closed = false;
    let waiter: ((value: IteratorResult<AcpRuntimeEvent>) => void) | null = null;

    const queueHandle = {
      push(event: AcpRuntimeEvent) {
        if (closed) {
          return;
        }
        if (waiter) {
          const w = waiter;
          waiter = null;
          w({ value: event, done: false });
        } else {
          eventQueue.push(event);
        }
      },
      close() {
        closed = true;
        if (waiter) {
          const w = waiter;
          waiter = null;
          w({ value: undefined as unknown as AcpRuntimeEvent, done: true });
        }
      },
      error(err: Error) {
        closed = true;
        if (waiter) {
          const w = waiter;
          waiter = null;
          w({ value: { type: "error", message: err.message }, done: false });
        } else {
          eventQueue.push({ type: "error", message: err.message });
        }
      },
    };

    registerSessionQueue(state.acpSessionId, queueHandle);

    // Handle abort signal
    const onAbort = () => {
      void this.cancel({ handle: input.handle, reason: "abort-signal" }).catch((e) => {
        log.error(`cancel on abort failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    };
    if (input.signal?.aborted) {
      unregisterSessionQueue(state.acpSessionId);
      await this.cancel({ handle: input.handle, reason: "abort-signal" });
      return;
    }
    if (input.signal) {
      input.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Set up turn timeout — uses the captured queueHandle closure
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    if (this.config.turnTimeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        queueHandle.push({ type: "error", message: `Turn timed out after ${this.config.turnTimeoutMs}ms` });
        queueHandle.close();
        void this.cancel({ handle: input.handle, reason: "timeout" }).catch((e) => {
          log.error(`cancel on timeout failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }, this.config.turnTimeoutMs);
    }

    // Send acp.turn event to node
    const sent = sendAcpEventToNode(state.nodeId, "acp.turn", {
      acpSessionId: state.acpSessionId,
      agent: state.agent,
      text: input.text,
      sessionName: state.sessionName,
      cwd: state.cwd,
      permissionMode: this.config.permissionMode,
      agentCommand: this.config.agentCommand,
      mode: input.mode || "prompt",
    });

    if (!sent) {
      unregisterSessionQueue(state.acpSessionId);
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbort);
      }
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        `Failed to send acp.turn to node ${state.nodeId}.`,
      );
    }

    // Yield events from queue
    try {
      while (true) {
        if (eventQueue.length > 0) {
          const event = eventQueue.shift()!;
          yield event;
          if (event.type === "done" || event.type === "error") {
            break;
          }
          continue;
        }
        if (closed) {
          break;
        }
        // Wait for next event
        const result = await new Promise<IteratorResult<AcpRuntimeEvent>>((resolve) => {
          waiter = resolve;
        });
        if (result.done) {
          break;
        }
        yield result.value;
        if (result.value.type === "done" || result.value.type === "error") {
          break;
        }
      }
    } finally {
      unregisterSessionQueue(state.acpSessionId);
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbort);
      }
    }
  }

  getCapabilities(): AcpRuntimeCapabilities {
    return { controls: [] };
  }

  // Design Decision: cancel() silently returns on failure (invalid handle or send failure) rather than
  // throwing. The remote session will self-terminate via idle timeout. Propagating errors from cancel()
  // requires coordinating with abort/timeout handlers to push error events to the queue — deferred.
  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const state = decodeHandle(input.handle.runtimeSessionName);
    if (!state) {
      log.warn("cancel: unable to decode handle, cannot send acp.kill");
      return;
    }
    const sent = sendAcpEventToNode(state.nodeId, "acp.kill", {
      acpSessionId: state.acpSessionId,
    });
    if (!sent) {
      log.error(`cancel: failed to send acp.kill to node ${state.nodeId} for session ${state.acpSessionId}`);
    }
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    await this.cancel({ handle: input.handle, reason: input.reason });
  }
}
