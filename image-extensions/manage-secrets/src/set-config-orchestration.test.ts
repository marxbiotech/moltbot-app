import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies not installed in dev environment
vi.mock("@sinclair/typebox", () => ({
  Type: { Object: (s: unknown) => s, String: (opts?: unknown) => opts ?? {} },
}));

// Mock shared.ts before importing the tool
vi.mock("./shared.ts", () => ({
  resolveContext: vi.fn(),
  dispatchWorkflow: vi.fn(),
  fetchRunsSection: vi.fn(),
  toolResult: (text: string) => ({ content: [{ type: "text", text }], details: undefined }),
}));

import { setConfigTool } from "./set-config.ts";
import { resolveContext, dispatchWorkflow, fetchRunsSection } from "./shared.ts";

const mockResolveContext = vi.mocked(resolveContext);
const mockDispatchWorkflow = vi.mocked(dispatchWorkflow);
const mockFetchRunsSection = vi.mocked(fetchRunsSection);

function runExec(patch: string) {
  return setConfigTool.execute("test-call", { patch });
}

function textOf(result: Awaited<ReturnType<typeof runExec>>): string {
  return result.content[0].text;
}

/** Valid single-path patch for reuse across tests. */
const VALID_PATCH = '{"agents":{"defaults":{"model":{"primary":"gemini"}}}}';

/** Valid multi-path patch. */
const MULTI_PATCH = JSON.stringify({
  agents: { defaults: { model: { primary: "gemini", fallbacks: ["claude"] } } },
  channels: { telegram: { streaming: true } },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("set_config orchestration", () => {
  it("returns resolveContext error without calling dispatchWorkflow", async () => {
    mockResolveContext.mockResolvedValue("Error: AGENT_GITHUB_PAT is not set and github-apps fallback unavailable. Check logs for details.");

    const result = await runExec(VALID_PATCH);

    expect(textOf(result)).toMatch(/AGENT_GITHUB_PAT/);
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
    expect(mockFetchRunsSection).not.toHaveBeenCalled();
  });

  it("returns preflight error for invalid JSON without calling dispatchWorkflow", async () => {
    mockResolveContext.mockResolvedValue({ token: "t", repo: "r", persona: "p" });

    const result = await runExec("not-json");

    expect(textOf(result)).toMatch(/must be valid JSON/);
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("returns preflight error for non-object patch", async () => {
    mockResolveContext.mockResolvedValue({ token: "t", repo: "r", persona: "p" });

    const result = await runExec("[1,2]");

    expect(textOf(result)).toMatch(/must be a JSON object/);
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("returns preflight error for null leaf values", async () => {
    mockResolveContext.mockResolvedValue({ token: "t", repo: "r", persona: "p" });

    const result = await runExec('{"agents":{"model":null}}');

    expect(textOf(result)).toMatch(/null.*not supported/);
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("returns preflight error for invalid path segments in patch keys", async () => {
    mockResolveContext.mockResolvedValue({ token: "t", repo: "r", persona: "p" });

    const result = await runExec('{"bad[0]": true}');

    expect(textOf(result)).toMatch(/Unsupported path segment/);
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("returns dispatch error on workflow failure", async () => {
    mockResolveContext.mockResolvedValue({ token: "t", repo: "r", persona: "p" });
    mockDispatchWorkflow.mockResolvedValue({ ok: false, message: "Save failed (403): forbidden" });

    const result = await runExec(VALID_PATCH);

    expect(textOf(result)).toBe("Save failed (403): forbidden");
    expect(mockFetchRunsSection).not.toHaveBeenCalled();
  });

  it("dispatches with persona and patch (single path)", async () => {
    mockResolveContext.mockResolvedValue({ token: "t", repo: "r", persona: "da-vinci" });
    mockDispatchWorkflow.mockResolvedValue({ ok: true, message: "ok" });
    mockFetchRunsSection.mockResolvedValue("\n\nNote: Could not fetch deployment status. The save was still initiated successfully.");

    await runExec(VALID_PATCH);

    expect(mockDispatchWorkflow).toHaveBeenCalledWith("r", "t", "set-config.yml", {
      persona: "da-vinci",
      patch: VALID_PATCH,
    });
  });

  it("returns success with leaf paths summary and deployment info", async () => {
    mockResolveContext.mockResolvedValue({ token: "t", repo: "r", persona: "p" });
    mockDispatchWorkflow.mockResolvedValue({ ok: true, message: "ok" });
    mockFetchRunsSection.mockResolvedValue("\n\nRecent deployments:\n#123 in_progress — 2026-04-25\n  https://example.com/runs/123");

    const result = await runExec(VALID_PATCH);

    const text = textOf(result);
    expect(text).toContain("Saving config [agents.defaults.model.primary]");
    expect(text).toContain("deployment in progress");
    expect(text).toContain("Recent deployments:");
    expect(text).toContain("#123");
  });

  it("lists multiple leaf paths in status message", async () => {
    mockResolveContext.mockResolvedValue({ token: "t", repo: "r", persona: "p" });
    mockDispatchWorkflow.mockResolvedValue({ ok: true, message: "ok" });
    mockFetchRunsSection.mockResolvedValue("\n\nRecent deployments:\n#456 in_progress — 2026-04-25\n  https://example.com/runs/456");

    const result = await runExec(MULTI_PATCH);

    const text = textOf(result);
    expect(text).toContain("agents.defaults.model.primary");
    expect(text).toContain("agents.defaults.model.fallbacks");
    expect(text).toContain("channels.telegram.streaming");
  });

  it("includes fallback note when fetchRunsSection reports failure", async () => {
    mockResolveContext.mockResolvedValue({ token: "t", repo: "r", persona: "p" });
    mockDispatchWorkflow.mockResolvedValue({ ok: true, message: "ok" });
    mockFetchRunsSection.mockResolvedValue("\n\nNote: Could not fetch deployment status. The save was still initiated successfully.");

    const result = await runExec(VALID_PATCH);

    const text = textOf(result);
    expect(text).toContain("deployment in progress");
    expect(text).toContain("save was still initiated successfully");
    expect(text).not.toContain("Recent deployments:");
  });
});
