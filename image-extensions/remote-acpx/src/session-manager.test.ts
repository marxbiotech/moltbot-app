// Unit tests for SessionManager — focused on variant-aware cache behavior.
//
// Mocks the openclaw/plugin-sdk/remote-acpx imports so tests run without
// the full openclaw runtime.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

// Mock isAcpNodeConnected — default: connected
const mockIsAcpNodeConnected = vi.fn(() => true);
vi.mock("openclaw/plugin-sdk/remote-acpx", () => ({
  isAcpNodeConnected: (...args: unknown[]) => mockIsAcpNodeConnected(...args),
}));

// Mock getNodeIdFromHandle — returns a stable nodeId by default
vi.mock("./runtime.js", () => ({
  getNodeIdFromHandle: () => "node-1",
}));

// Mock log
vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SessionManager } from "./session-manager.js";
import { inFlightSessions } from "./in-flight.js";
import type { RemoteAcpxRuntime } from "./runtime.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeFakeRuntime(overrides?: Partial<RemoteAcpxRuntime>): RemoteAcpxRuntime {
  return {
    isHealthy: () => true,
    ensureSession: vi.fn(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "remote-acpx",
      runtimeSessionName: `handle:${input.agent}:${input.cwd}:${Math.random().toString(36).slice(2, 8)}`,
      cwd: input.cwd || undefined,
    })),
    runTurn: vi.fn(),
    getCapabilities: () => ({ controls: [] }),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  } as unknown as RemoteAcpxRuntime;
}

// Clear the global session state between tests so each test starts fresh.
function clearGlobalSessionState(): void {
  const key = Symbol.for("remote-acpx.sessionManagerState");
  const g = globalThis as unknown as Record<symbol, { sessions: Map<string, unknown> }>;
  if (g[key]) {
    g[key].sessions.clear();
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("SessionManager", () => {
  let mgr: SessionManager;
  let runtime: RemoteAcpxRuntime;

  beforeEach(() => {
    clearGlobalSessionState();
    mockIsAcpNodeConnected.mockReturnValue(true);
    mgr = new SessionManager();
    runtime = makeFakeRuntime();
  });

  it("reuses cached session for same key + cwd + agent", async () => {
    const h1 = await mgr.getOrCreate("s1", runtime, { agent: "claude", cwd: "/app" });
    const h2 = await mgr.getOrCreate("s1", runtime, { agent: "claude", cwd: "/app" });

    expect(h1).toBe(h2);
    expect(vi.mocked(runtime.ensureSession)).toHaveBeenCalledTimes(1);
  });

  it("spawns new session when agent differs (same key + cwd)", async () => {
    const h1 = await mgr.getOrCreate("s1", runtime, { agent: "claude", cwd: "/app" });
    const h2 = await mgr.getOrCreate("s1", runtime, { agent: "codex", cwd: "/app" });

    expect(h1).not.toBe(h2);
    expect(vi.mocked(runtime.ensureSession)).toHaveBeenCalledTimes(2);
    // Old session should have been closed
    expect(vi.mocked(runtime.close)).toHaveBeenCalledTimes(1);
  });

  it("spawns new session when cwd differs (same key + agent)", async () => {
    const h1 = await mgr.getOrCreate("s1", runtime, { agent: "claude", cwd: "/app-a" });
    const h2 = await mgr.getOrCreate("s1", runtime, { agent: "claude", cwd: "/app-b" });

    expect(h1).not.toBe(h2);
    expect(vi.mocked(runtime.ensureSession)).toHaveBeenCalledTimes(2);
  });

  it("spawns new session when node is disconnected", async () => {
    await mgr.getOrCreate("s1", runtime, { agent: "claude", cwd: "/app" });

    // Simulate node disconnect
    mockIsAcpNodeConnected.mockReturnValue(false);

    const h2 = await mgr.getOrCreate("s1", runtime, { agent: "claude", cwd: "/app" });

    // Should have spawned a second session
    expect(vi.mocked(runtime.ensureSession)).toHaveBeenCalledTimes(2);
    expect(h2).toBeDefined();
  });

  it("spawns new session after invalidate()", async () => {
    const h1 = await mgr.getOrCreate("s1", runtime, { agent: "claude", cwd: "/app" });
    mgr.invalidate("s1");
    const h2 = await mgr.getOrCreate("s1", runtime, { agent: "claude", cwd: "/app" });

    expect(h1).not.toBe(h2);
    expect(vi.mocked(runtime.ensureSession)).toHaveBeenCalledTimes(2);
  });

  it("independent session keys do not interfere", async () => {
    const h1 = await mgr.getOrCreate("s1", runtime, { agent: "claude", cwd: "/app" });
    const h2 = await mgr.getOrCreate("s2", runtime, { agent: "codex", cwd: "/app" });

    // Different session keys → both should exist independently
    expect(h1).not.toBe(h2);
    expect(vi.mocked(runtime.ensureSession)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runtime.close)).not.toHaveBeenCalled();
  });

  it("reuses cached session for agent='gemini' on same key + cwd", async () => {
    const h1 = await mgr.getOrCreate("s1", runtime, { agent: "gemini", cwd: "/work" });
    const h2 = await mgr.getOrCreate("s1", runtime, { agent: "gemini", cwd: "/work" });

    expect(h1).toBe(h2);
    expect(vi.mocked(runtime.ensureSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runtime.close)).not.toHaveBeenCalled();
  });

  it("respawns and closes prior handle when switching claude → gemini on same key", async () => {
    const h1 = await mgr.getOrCreate("s1", runtime, { agent: "claude", cwd: "/work" });
    const h2 = await mgr.getOrCreate("s1", runtime, { agent: "gemini", cwd: "/work" });

    expect(h1).not.toBe(h2);
    expect(vi.mocked(runtime.ensureSession)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runtime.close)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runtime.close).mock.calls[0]?.[0]).toMatchObject({ reason: "stale" });
    // Confirm the second spawn requested the gemini variant.
    expect(vi.mocked(runtime.ensureSession).mock.calls[1]?.[0]).toMatchObject({
      sessionKey: "s1",
      agent: "gemini",
      cwd: "/work",
    });
  });

  it("handles close failure gracefully on stale session", async () => {
    const failRuntime = makeFakeRuntime({
      close: vi.fn(async () => { throw new Error("close boom"); }),
    });

    await mgr.getOrCreate("s1", failRuntime, { agent: "claude", cwd: "/app" });
    // Switch agent → triggers close of old session which will throw
    const h2 = await mgr.getOrCreate("s1", failRuntime, { agent: "codex", cwd: "/app" });

    // Should still succeed despite close failure
    expect(h2).toBeDefined();
    expect(vi.mocked(failRuntime.ensureSession)).toHaveBeenCalledTimes(2);
  });
});

describe("SessionManager.pruneStale", () => {
  let mgr: SessionManager;
  let runtime: RemoteAcpxRuntime;

  beforeEach(() => {
    clearGlobalSessionState();
    inFlightSessions.clear();
    mockIsAcpNodeConnected.mockReturnValue(true);
    mgr = new SessionManager();
    runtime = makeFakeRuntime();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    inFlightSessions.clear();
  });

  const TTL_MS = 30 * 60 * 1000;

  it("closes a session left idle beyond the TTL", async () => {
    await mgr.getOrCreate("s1", runtime, { agent: "claude", cwd: "/app" });

    vi.advanceTimersByTime(TTL_MS + 1);
    mgr.pruneStale(runtime);

    expect(vi.mocked(runtime.close)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runtime.close)).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "ttl" }),
    );
  });

  it("leaves a session whose turn is still running, however long it has run", async () => {
    await mgr.getOrCreate("s1", runtime, { agent: "claude", cwd: "/app" });
    // run_coder marks the key for the duration of the dispatch. lastUsedAt is
    // not refreshed while the turn runs, so without the in-flight guard this
    // session ages exactly like an abandoned one and gets killed mid-dispatch.
    inFlightSessions.add("s1");

    vi.advanceTimersByTime(TTL_MS * 3);
    mgr.pruneStale(runtime);

    expect(vi.mocked(runtime.close)).not.toHaveBeenCalled();
  });

  it("reclaims the session once its turn finishes and it goes idle", async () => {
    await mgr.getOrCreate("s1", runtime, { agent: "claude", cwd: "/app" });
    inFlightSessions.add("s1");

    vi.advanceTimersByTime(TTL_MS + 1);
    mgr.pruneStale(runtime);
    expect(vi.mocked(runtime.close)).not.toHaveBeenCalled();

    // Dispatch ends; the sweeper is now free to reclaim it.
    inFlightSessions.delete("s1");
    mgr.pruneStale(runtime);

    expect(vi.mocked(runtime.close)).toHaveBeenCalledTimes(1);
  });

  it("prunes only the idle session when another is mid-dispatch", async () => {
    await mgr.getOrCreate("busy", runtime, { agent: "claude", cwd: "/app" });
    await mgr.getOrCreate("idle", runtime, { agent: "claude", cwd: "/other" });
    inFlightSessions.add("busy");

    vi.advanceTimersByTime(TTL_MS + 1);
    mgr.pruneStale(runtime);

    expect(vi.mocked(runtime.close)).toHaveBeenCalledTimes(1);
    const closedHandle = vi.mocked(runtime.close).mock.calls[0]![0] as {
      handle: { sessionKey: string };
    };
    expect(closedHandle.handle.sessionKey).toBe("idle");
  });
});
