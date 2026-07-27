// Focused tests for the run_coder agentId resolution logic.
// Covers: fail-loud on unknown agentId without an explicit cwd anchor
// (bare or with agent-only overrides), and graceful degradation when
// the caller supplies an explicit cwd alongside an unknown agentId.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockResolveAgentById = vi.fn();
vi.mock("./agent-roster.js", () => ({
  resolveAgentById: (...args: unknown[]) => mockResolveAgentById(...args),
}));

vi.mock("openclaw/plugin-sdk/remote-acpx", () => ({
  isAcpRuntimeError: () => false,
  isAcpNodeConnected: () => false,
}));

const mockEmitTrustedDiagnosticEvent = vi.fn();
vi.mock("openclaw/plugin-sdk/diagnostic-runtime", () => ({
  emitTrustedDiagnosticEvent: (...args: unknown[]) =>
    mockEmitTrustedDiagnosticEvent(...args),
}));

// vitest's resolver cannot load typebox the way jiti does at runtime;
// stub the methods registerCodingTool calls during registration. The
// resolution paths under test never exercise these schemas.
vi.mock("typebox", () => ({
  Type: {
    Object: () => ({}),
    String: () => ({}),
    Integer: () => ({}),
    Optional: () => ({}),
  },
}));

import { registerCodingTool, createProgressReporter, type CodingToolConfig } from "./tool.js";

// ── Helpers ────────────────────────────────────────────────────────────────

type ToolFactory = Parameters<OpenClawPluginApi["registerTool"]>[0];
type ToolDef = ReturnType<ToolFactory>;

function captureRegisteredTool(): {
  getTool: () => ToolDef;
  api: OpenClawPluginApi;
} {
  let captured: ToolFactory | null = null;
  const api = {
    registerTool: vi.fn((factory: ToolFactory) => {
      captured = factory;
    }),
  } as unknown as OpenClawPluginApi;

  const getTool = (): ToolDef => {
    const factory = captured;
    if (!factory) {
      throw new Error("registerCodingTool did not register a factory");
    }
    return factory({ sessionKey: "test-session" });
  };
  return { getTool, api };
}

const config: CodingToolConfig = { defaultAgent: "claude", maxOutputChars: 6000 };

function getText(result: { content: Array<{ type: "text"; text: string }> }): string {
  return result.content[0]!.text;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("run_coder — agentId resolution", () => {
  beforeEach(() => {
    mockResolveAgentById.mockReset();
  });

  it("fails loud with AGENTID_UNRESOLVED when bare unknown agentId is given (no overrides)", async () => {
    mockResolveAgentById.mockReturnValue(null);

    const { getTool, api } = captureRegisteredTool();
    const runTurn = vi.fn();
    const ensureSession = vi.fn();
    const runtime = { runTurn, ensureSession } as never;
    registerCodingTool(api, { getRuntime: () => runtime, getConfig: () => config });

    const result = await getTool().execute("call-1", {
      agentId: "does-not-exist",
      prompt: "noop",
    });

    expect(mockResolveAgentById).toHaveBeenCalledWith("does-not-exist");

    // The load-bearing assertion: an unresolved agentId must not touch the
    // remote runtime. If silent fallback regressed, runTurn or ensureSession
    // would be invoked here.
    expect(runTurn).not.toHaveBeenCalled();
    expect(ensureSession).not.toHaveBeenCalled();

    const text = getText(result);
    expect(text).toContain("AGENTID_UNRESOLVED");
    expect(text).toContain("does-not-exist");
    expect(text).toContain("coding_agents_list");
  });

  it("fails loud with AGENTID_UNRESOLVED when unknown agentId is given alongside explicit agent only (no cwd)", async () => {
    mockResolveAgentById.mockReturnValue(null);

    const { getTool, api } = captureRegisteredTool();
    const runTurn = vi.fn();
    const ensureSession = vi.fn();
    const runtime = { runTurn, ensureSession } as never;
    registerCodingTool(api, { getRuntime: () => runtime, getConfig: () => config });

    const result = await getTool().execute("call-2", {
      agentId: "does-not-exist",
      agent: "codex",
      prompt: "noop",
    });

    expect(mockResolveAgentById).toHaveBeenCalledWith("does-not-exist");

    // cwd is the workspace-safety anchor — agent-only is not enough to
    // justify graceful degradation. The runtime must not be touched.
    expect(runTurn).not.toHaveBeenCalled();
    expect(ensureSession).not.toHaveBeenCalled();

    const text = getText(result);
    expect(text).toContain("AGENTID_UNRESOLVED");
    expect(text).toContain("does-not-exist");
    expect(text).toContain("coding_agents_list");
  });

  it("does NOT fail loud when unknown agentId is given alongside explicit cwd (degrades gracefully with default agent)", async () => {
    mockResolveAgentById.mockReturnValue(null);

    const { getTool, api } = captureRegisteredTool();
    // ensureSession resolves so the call advances past session setup.
    // runTurn throws to short-circuit the rest of the turn — we only need
    // to assert that ensureSession was reached and called with the
    // explicit cwd + default agent.
    const ensureSession = vi.fn().mockResolvedValue({ id: "fake-handle" });
    const runTurn = vi.fn().mockImplementation(() => {
      throw new Error("stop");
    });
    const runtime = { runTurn, ensureSession, close: vi.fn() } as never;
    registerCodingTool(api, { getRuntime: () => runtime, getConfig: () => config });

    const result = await getTool().execute("call-3", {
      agentId: "stale",
      cwd: "/explicit/path",
      prompt: "noop",
    });

    expect(mockResolveAgentById).toHaveBeenCalledWith("stale");
    expect(getText(result)).not.toContain("AGENTID_UNRESOLVED");

    // Pin the contract: explicit cwd + default agent are actually passed
    // through to session setup, not the roster's (missing) values.
    expect(ensureSession).toHaveBeenCalledTimes(1);
    expect(ensureSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/explicit/path",
      agent: config.defaultAgent,
    }));
  });

  it("does NOT fail loud when unknown agentId is given alongside explicit cwd + agent (3-arg explicit override)", async () => {
    // 3-arg explicit override skips roster lookup entirely.
    const { getTool, api } = captureRegisteredTool();
    const ensureSession = vi.fn().mockResolvedValue({ id: "fake-handle" });
    const runTurn = vi.fn().mockImplementation(() => {
      throw new Error("stop");
    });
    const runtime = { runTurn, ensureSession, close: vi.fn() } as never;
    registerCodingTool(api, { getRuntime: () => runtime, getConfig: () => config });

    const result = await getTool().execute("call-4", {
      agentId: "stale",
      cwd: "/explicit/path",
      agent: "codex",
      prompt: "noop",
    });

    expect(mockResolveAgentById).not.toHaveBeenCalled();
    expect(getText(result)).not.toContain("AGENTID_UNRESOLVED");

    expect(ensureSession).toHaveBeenCalledTimes(1);
    expect(ensureSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/explicit/path",
      agent: "codex",
    }));
  });
});

describe("createProgressReporter", () => {
  beforeEach(() => {
    mockEmitTrustedDiagnosticEvent.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const snapshot = (operationCount: number) => ({
    operationCount,
    latest: { tool: "Edit", summary: "foo.ts", status: "in_progress" },
    messageChars: 0,
  });

  it("emits on the first snapshot and then coalesces until the interval elapses", () => {
    vi.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    const onUpdate = vi.fn();
    const report = createProgressReporter({ sessionKey: "s1", agent: "claude", onUpdate });

    report(snapshot(1));
    // A dispatch streams ~1e3 events; everything inside the window is dropped.
    for (let i = 0; i < 200; i++) {
      report(snapshot(i + 2));
    }

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(mockEmitTrustedDiagnosticEvent).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    report(snapshot(500));

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(mockEmitTrustedDiagnosticEvent).toHaveBeenCalledTimes(2);
  });

  it("emits run.progress carrying the session refs the activity tracker keys on", () => {
    vi.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    const report = createProgressReporter({
      sessionKey: "agent:main:slack:channel:c1",
      sessionId: "sess-42",
      agent: "codex",
    });

    report(snapshot(3));

    expect(mockEmitTrustedDiagnosticEvent).toHaveBeenCalledWith({
      type: "run.progress",
      sessionId: "sess-42",
      sessionKey: "agent:main:slack:channel:c1",
      reason: "remote_acpx:turn_progress",
    });
  });

  it("omits sessionId when the tool context did not supply one", () => {
    vi.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    const report = createProgressReporter({ sessionKey: "s1", agent: "codex" });

    report(snapshot(1));

    expect(mockEmitTrustedDiagnosticEvent).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.anything() }),
    );
  });

  it("still reports progress when no channel sink is attached", () => {
    vi.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    const report = createProgressReporter({ sessionKey: "s1", agent: "claude" });

    expect(() => report(snapshot(1))).not.toThrow();
    expect(mockEmitTrustedDiagnosticEvent).toHaveBeenCalledTimes(1);
  });

  it("summarises the agent and latest operation for the channel", () => {
    vi.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    const onUpdate = vi.fn();
    const report = createProgressReporter({ sessionKey: "s1", agent: "claude", onUpdate });

    report(snapshot(7));

    expect(onUpdate).toHaveBeenCalledWith({
      content: [{ type: "text", text: "claude: 7 operation(s) · Edit [in_progress]" }],
    });
  });
});
