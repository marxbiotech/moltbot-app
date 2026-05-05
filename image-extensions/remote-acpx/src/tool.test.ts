// Focused test for the run_coder fail-loud behavior on unresolved agentId.
// The early-return path under test does not touch the runtime or the session
// manager, so mocks here cover only what tool.ts imports at module load.

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

// typebox is not installed in the test environment (jiti resolves it at runtime
// in production). Stub the only methods registerCodingTool calls during
// registration; schemas are not exercised by the early-return path under test.
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
type ToolDef = ToolFactory extends (ctx: infer _C) => infer T ? T : never;

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
    if (typeof captured !== "function") {
      throw new Error("registerCodingTool did not register a factory");
    }
    return (captured as (ctx: { sessionKey: string }) => ToolDef)({
      sessionKey: "test-session",
    });
  };
  return { getTool, api };
}

const config: CodingToolConfig = { defaultAgent: "claude", maxOutputChars: 6000 };

// ── Tests ──────────────────────────────────────────────────────────────────

describe("run_coder — unresolved agentId", () => {
  beforeEach(() => {
    mockResolveAgentById.mockReset();
  });

  it("returns AGENTID_UNRESOLVED instead of silently falling back to defaults", async () => {
    mockResolveAgentById.mockReturnValue(null);

    const { getTool, api } = captureRegisteredTool();
    const getRuntime = vi.fn(() => ({}) as never);
    registerCodingTool(api, { getRuntime, getConfig: () => config });

    const tool = getTool();
    const result = await tool.execute("call-1", {
      agentId: "does-not-exist",
      prompt: "noop",
    });

    expect(mockResolveAgentById).toHaveBeenCalledWith("does-not-exist");
    expect(getRuntime).toHaveBeenCalledTimes(1);

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("AGENTID_UNRESOLVED");
    expect(text).toContain('agentId="does-not-exist"');
    expect(text).toContain("coding_agents_list");
  });
});
