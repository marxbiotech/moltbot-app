// Focused tests for the run_coder agentId resolution logic.
// Covers: fail-loud on unknown agentId without an explicit cwd anchor
// (bare or with agent-only overrides), and graceful degradation when
// the caller supplies an explicit cwd alongside an unknown agentId.

import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { registerCodingTool, type CodingToolConfig } from "./tool.js";

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
