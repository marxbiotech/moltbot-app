// Unit tests for agent-roster — resolveEffectiveCwd and resolveAgentById.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock node:fs so we can control readFileSync without touching real files.
const mockReadFileSync = vi.fn();
vi.mock("node:fs", () => ({
  default: { readFileSync: (...args: unknown[]) => mockReadFileSync(...args), writeFileSync: vi.fn() },
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: vi.fn(),
}));

import { resolveEffectiveCwd, resolveAgentById, type AgentEntry } from "./agent-roster.js";
import { log } from "./log.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(agents: AgentEntry[]): string {
  return JSON.stringify({ agents: { list: agents } });
}

const acpAgent: AgentEntry = {
  id: "store",
  name: "store",
  runtime: { type: "acp", acp: { agent: "claude", cwd: "/remote/store", nodeName: "mac-1" } },
};

const workspaceAgent: AgentEntry = {
  id: "local-app",
  name: "local-app",
  workspace: "/local/app",
};

const minimalAgent: AgentEntry = {
  id: "bare",
};

const acpNoVariant: AgentEntry = {
  id: "no-variant",
  runtime: { type: "acp", acp: { cwd: "/remote/nv" } },
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("resolveEffectiveCwd", () => {
  it("returns runtime.acp.cwd for ACP agents", () => {
    expect(resolveEffectiveCwd(acpAgent)).toBe("/remote/store");
  });

  it("falls back to workspace for non-ACP agents", () => {
    expect(resolveEffectiveCwd(workspaceAgent)).toBe("/local/app");
  });

  it("falls back to workspace when ACP runtime has no cwd", () => {
    const agent: AgentEntry = {
      id: "acp-no-cwd",
      workspace: "/fallback",
      runtime: { type: "acp", acp: { agent: "claude" } },
    };
    expect(resolveEffectiveCwd(agent)).toBe("/fallback");
  });

  it("returns empty string when neither runtime.acp.cwd nor workspace is set", () => {
    expect(resolveEffectiveCwd(minimalAgent)).toBe("");
  });

  it("returns workspace when runtime type is not acp", () => {
    const agent: AgentEntry = {
      id: "embedded",
      workspace: "/embed/path",
      runtime: { type: "embedded" },
    };
    expect(resolveEffectiveCwd(agent)).toBe("/embed/path");
  });
});

describe("resolveAgentById", () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
    vi.mocked(log.error).mockClear();
  });

  it("resolves ACP agent with cwd and variant", () => {
    mockReadFileSync.mockReturnValue(makeConfig([acpAgent, workspaceAgent]));

    const result = resolveAgentById("store");
    expect(result).toEqual({ cwd: "/remote/store", agent: "claude" });
  });

  it("resolves workspace-only agent with empty agent string", () => {
    mockReadFileSync.mockReturnValue(makeConfig([workspaceAgent]));

    const result = resolveAgentById("local-app");
    expect(result).toEqual({ cwd: "/local/app", agent: "" });
  });

  it("returns null for unknown agentId", () => {
    mockReadFileSync.mockReturnValue(makeConfig([acpAgent]));

    const result = resolveAgentById("nonexistent");
    expect(result).toBeNull();
    // Should not log an error for a clean "not found"
    expect(log.error).not.toHaveBeenCalled();
  });

  it("returns null and logs error on config read failure", () => {
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT: no such file"); });

    const result = resolveAgentById("store");
    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to read config"),
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("ENOENT"),
    );
  });

  it("returns null and logs error on malformed JSON", () => {
    mockReadFileSync.mockReturnValue("not valid json{{{");

    const result = resolveAgentById("store");
    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to read config"),
    );
  });

  it("returns empty cwd and agent for minimal agent entry", () => {
    mockReadFileSync.mockReturnValue(makeConfig([minimalAgent]));

    const result = resolveAgentById("bare");
    expect(result).toEqual({ cwd: "", agent: "" });
  });

  it("returns empty agent string when ACP entry has no variant", () => {
    mockReadFileSync.mockReturnValue(makeConfig([acpNoVariant]));

    const result = resolveAgentById("no-variant");
    expect(result).toEqual({ cwd: "/remote/nv", agent: "" });
  });
});
