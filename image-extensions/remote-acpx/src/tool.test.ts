// Focused tests for the run_coder agentId resolution logic.
// Covers: fail-loud on bare unknown agentId, and graceful degradation
// when the caller supplies explicit overrides alongside an unknown agentId.

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
}));

// vitest's resolver cannot load typebox the way jiti does at runtime;
// stub the methods registerCodingTool calls during registration. The
// resolution paths under test never exercise these schemas.
vi.mock("typebox", () => ({
  Type: {
    Object: () => ({}),
    String: () => ({}),
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

  it("does NOT fail loud when unknown agentId is given alongside explicit cwd (degrades gracefully)", async () => {
    mockResolveAgentById.mockReturnValue(null);

    const { getTool, api } = captureRegisteredTool();
    // Minimal stub — downstream calls past the resolution point will throw,
    // get caught by the outer try/catch, and be returned as a generic error.
    // The point is only to assert that the AGENTID_UNRESOLVED early-return
    // did not fire.
    const runtime = {} as never;
    registerCodingTool(api, { getRuntime: () => runtime, getConfig: () => config });

    const result = await getTool().execute("call-2", {
      agentId: "stale",
      cwd: "/explicit/path",
      prompt: "noop",
    });

    // Roster was still consulted (because agent was missing), but the miss
    // degraded to the explicit cwd + default agent rather than failing loud.
    expect(mockResolveAgentById).toHaveBeenCalledWith("stale");
    expect(getText(result)).not.toContain("AGENTID_UNRESOLVED");
  });
});
