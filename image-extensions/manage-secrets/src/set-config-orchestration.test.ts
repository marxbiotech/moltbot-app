import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies not installed in dev environment
vi.mock("@sinclair/typebox", () => ({
  Type: { Object: (s: unknown) => s, String: (opts?: unknown) => opts ?? {} },
}));

// Mock shared.ts before importing the tool
vi.mock("./shared.ts", () => ({
  resolveContext: vi.fn(),
  dispatchWorkflow: vi.fn(),
  getLatestRuns: vi.fn(),
  toolResult: (text: string) => ({ content: [{ type: "text", text }], details: undefined }),
}));

import { setConfigTool } from "./set-config.ts";
import { resolveContext, dispatchWorkflow, getLatestRuns } from "./shared.ts";

const mockResolveContext = vi.mocked(resolveContext);
const mockDispatchWorkflow = vi.mocked(dispatchWorkflow);
const mockGetLatestRuns = vi.mocked(getLatestRuns);

function exec(config_path: string, config_value: string) {
  return setConfigTool.execute("test-call", { config_path, config_value });
}

function textOf(result: Awaited<ReturnType<typeof exec>>): string {
  return result.content[0].text;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

describe("set_config orchestration", () => {
  it("returns resolveContext error without calling dispatchWorkflow", async () => {
    mockResolveContext.mockResolvedValue("Error: AGENT_GITHUB_PAT is not set and github-apps fallback unavailable. Check logs for details.");

    const result = await exec("agents.defaults.model.primary", '"gemini"');

    expect(textOf(result)).toMatch(/AGENT_GITHUB_PAT/);
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
    expect(mockGetLatestRuns).not.toHaveBeenCalled();
  });

  it("returns preflight path error without calling dispatchWorkflow", async () => {
    mockResolveContext.mockResolvedValue({ token: "t", repo: "r", persona: "p" });

    const result = await exec("bad[0]", '"value"');

    expect(textOf(result)).toMatch(/Unsupported path segment/);
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("returns preflight value error without calling dispatchWorkflow", async () => {
    mockResolveContext.mockResolvedValue({ token: "t", repo: "r", persona: "p" });

    const result = await exec("agents.defaults.model.primary", "not-json");

    expect(textOf(result)).toMatch(/must be valid JSON/);
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("returns dispatch error on workflow failure", async () => {
    mockResolveContext.mockResolvedValue({ token: "t", repo: "r", persona: "p" });
    mockDispatchWorkflow.mockResolvedValue({ ok: false, message: "Save failed (403): forbidden" });

    const result = await exec("agents.defaults.model.primary", '"gemini"');

    expect(textOf(result)).toBe("Save failed (403): forbidden");
    expect(mockGetLatestRuns).not.toHaveBeenCalled();
  });

  it("returns success with deployment info on happy path", async () => {
    mockResolveContext.mockResolvedValue({ token: "t", repo: "r", persona: "p" });
    mockDispatchWorkflow.mockResolvedValue({ ok: true, message: "Save initiated successfully." });
    mockGetLatestRuns.mockResolvedValue("#123 in_progress — 2026-04-25\n  https://example.com/runs/123");

    const promise = exec("agents.defaults.model.primary", '"gemini"');
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    const text = textOf(result);
    expect(text).toContain("Saving config agents.defaults.model.primary");
    expect(text).toContain("deployment in progress");
    expect(text).toContain("Recent deployments:");
    expect(text).toContain("#123");
  });

  it("separates getLatestRuns failure from success message", async () => {
    mockResolveContext.mockResolvedValue({ token: "t", repo: "r", persona: "p" });
    mockDispatchWorkflow.mockResolvedValue({ ok: true, message: "Save initiated successfully." });
    mockGetLatestRuns.mockResolvedValue("Failed to fetch deployment status (500)");

    const promise = exec("agents.defaults.model.primary", '"gemini"');
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    const text = textOf(result);
    expect(text).toContain("deployment in progress");
    expect(text).toContain("save was still initiated successfully");
    expect(text).not.toContain("Recent deployments:");
  });
});
