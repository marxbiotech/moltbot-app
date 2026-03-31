// Caches AcpRuntimeHandle objects by sessionKey for session reuse.
// When the same conversation calls claude_code multiple times,
// the cached session keeps Claude Code's conversation context.

import type { AcpRuntimeHandle } from "openclaw/plugin-sdk/remote-acpx";
import { isAcpNodeConnected } from "openclaw/plugin-sdk/remote-acpx";
import { type RemoteAcpxRuntime, getNodeIdFromHandle } from "./runtime.js";
import { log } from "./log.js";

export type CachedSession = {
  handle: AcpRuntimeHandle;
  lastUsedAt: number;
  workspace: string;
};

// Use Symbol.for to share state across jiti module reloads (same pattern as event-router).
const STATE_KEY = Symbol.for("remote-acpx.sessionManagerState");
type SessionState = { sessions: Map<string, CachedSession>; pruneInterval?: ReturnType<typeof setInterval> };
const globalRef = globalThis as unknown as Record<symbol, SessionState>;
if (!globalRef[STATE_KEY]) {
  globalRef[STATE_KEY] = { sessions: new Map() };
}
const sessions = globalRef[STATE_KEY].sessions;

const TTL_MS = 30 * 60 * 1000; // 30 minutes

export class SessionManager {
  /**
   * Get existing session or create a new one.
   * Reuses cached session if: same workspace, node still connected.
   * Otherwise spawns a new session.
   */
  async getOrCreate(
    sessionKey: string,
    runtime: RemoteAcpxRuntime,
    opts: { agent: string; cwd: string },
  ): Promise<AcpRuntimeHandle> {
    const cached = sessions.get(sessionKey);

    if (cached) {
      // Validate cached session: workspace must match and node must be connected
      const nodeId = getNodeIdFromHandle(cached.handle);
      if (
        cached.workspace === opts.cwd &&
        nodeId &&
        isAcpNodeConnected(nodeId)
      ) {
        cached.lastUsedAt = Date.now();
        log.info(`session reused: key=${sessionKey} workspace=${opts.cwd}`);
        return cached.handle;
      }
      // Stale session — clean up
      log.info(`session stale: key=${sessionKey} (workspace changed or node disconnected)`);
      sessions.delete(sessionKey);
      try {
        await runtime.close({ handle: cached.handle, reason: "stale" });
      } catch (err) {
        log.warn(`session close failed: key=${sessionKey} err=${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Spawn new session
    log.info(`session spawn: key=${sessionKey} agent=${opts.agent} cwd=${opts.cwd}`);
    const handle = await runtime.ensureSession({
      sessionKey,
      agent: opts.agent,
      mode: "persistent",
      cwd: opts.cwd,
    });

    sessions.set(sessionKey, {
      handle,
      lastUsedAt: Date.now(),
      workspace: opts.cwd,
    });

    return handle;
  }

  /** Remove a session from cache */
  invalidate(sessionKey: string): void {
    sessions.delete(sessionKey);
  }

  /** Clear previous prune interval (if any) and start a new one. Prevents accumulation on jiti reload. */
  resetPruneInterval(fn: () => void): void {
    const state = globalRef[STATE_KEY];
    if (state.pruneInterval) {
      clearInterval(state.pruneInterval);
    }
    state.pruneInterval = setInterval(fn, 10 * 60 * 1000);
    state.pruneInterval.unref?.();
  }

  /** Clean up sessions that have been idle longer than TTL */
  pruneStale(runtime: RemoteAcpxRuntime): void {
    const now = Date.now();
    for (const [key, cached] of sessions) {
      if (now - cached.lastUsedAt > TTL_MS) {
        log.info(`session pruned (TTL): key=${key}`);
        sessions.delete(key);
        runtime.close({ handle: cached.handle, reason: "ttl" }).catch((err) => {
          log.warn(`session close failed (TTL): key=${key} err=${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
  }
}
