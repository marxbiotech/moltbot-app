// Unit tests for RemoteAcpxRuntime — focused on session/set_config_option
// support. We mock the openclaw/plugin-sdk surface so tests run without a live
// gateway / paired node.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockSendAcpEventToNode = vi.fn(() => true);
const mockIsAcpNodeConnected = vi.fn(() => true);

vi.mock("openclaw/plugin-sdk/remote-acpx", () => {
  // Defined inside the factory because vi.mock is hoisted above top-level
  // declarations — referencing an outer class would hit a TDZ error.
  class MockAcpRuntimeError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = "AcpRuntimeError";
    }
  }
  return {
    AcpRuntimeError: MockAcpRuntimeError,
    sendAcpEventToNode: (...args: unknown[]) => mockSendAcpEventToNode(...(args as [])),
    isAcpNodeConnected: (...args: unknown[]) => mockIsAcpNodeConnected(...(args as [])),
  };
});

vi.mock("./node-resolver.js", () => ({
  resolveNodeId: vi.fn(() => "node-1"),
}));

vi.mock("./event-router.js", () => ({
  registerSessionQueue: vi.fn(),
  unregisterSessionQueue: vi.fn(),
  registerSpawnResolver: (acpSessionId: string, resolver: { resolve: () => void }) => {
    // Resolve immediately so ensureSession returns synchronously in tests.
    queueMicrotask(() => resolver.resolve());
  },
  unregisterSpawnResolver: vi.fn(),
}));

vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  RemoteAcpxRuntime,
  normalizeGeminiModel,
  normalizeModelForAgent,
  type RemoteAcpxConfig,
} from "./runtime.js";

// Reset the global config option cache between tests so leftover state from
// one ensureSession call does not contaminate another.
function clearGlobalConfigCache(): void {
  const key = Symbol.for("moltbot.remoteAcpxConfigOptionCache");
  const g = globalThis as unknown as Record<symbol, { options: Map<string, unknown> }>;
  if (g[key]) {
    g[key].options.clear();
  }
}

function makeRuntime(overrides: Partial<RemoteAcpxConfig> = {}): RemoteAcpxRuntime {
  return new RemoteAcpxRuntime({
    nodeName: "test-node",
    agentCommand: "acpx",
    defaultAgent: "claude",
    permissionMode: "approve-all",
    turnTimeoutMs: 0,
    ...overrides,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("RemoteAcpxRuntime — capabilities", () => {
  it("advertises session/set_config_option with a key allowlist", () => {
    const runtime = makeRuntime();
    const caps = runtime.getCapabilities();
    expect(caps.controls).toContain("session/set_config_option");
    expect(caps.controls).not.toContain("session/set_mode");
    expect(caps.configOptionKeys).toEqual(
      expect.arrayContaining(["model", "timeout", "approval_policy", "max_turns"]),
    );
    expect(caps.configOptionKeys).not.toContain("thinking");
  });
});

describe("RemoteAcpxRuntime — ensureSession seeding", () => {
  beforeEach(() => {
    clearGlobalConfigCache();
    mockSendAcpEventToNode.mockClear();
    mockSendAcpEventToNode.mockReturnValue(true);
  });

  it("seeds model and thinking from input so the next turn carries them", async () => {
    const runtime = makeRuntime();
    const handle = await runtime.ensureSession({
      sessionKey: "s1",
      agent: "claude",
      mode: "persistent",
      model: "claude-sonnet-4-6",
      thinking: "high",
      cwd: "/work",
    });

    // Run a no-op turn iteration to capture the outbound payload.
    const iter = runtime.runTurn({
      handle,
      text: "hi",
      mode: "prompt",
      requestId: "req-1",
    });
    // Pull the iterator to trigger the sendAcpEventToNode call. We don't
    // await events because the mocked event router never resolves the queue.
    void iter[Symbol.asyncIterator]().next();
    await new Promise((r) => setTimeout(r, 0));

    const turnCall = mockSendAcpEventToNode.mock.calls.find(
      (c) => (c as unknown as [string, string])[1] === "acp.turn",
    );
    expect(turnCall).toBeDefined();
    const turnPayload = (turnCall as unknown as [string, string, Record<string, unknown>])[2];
    expect(turnPayload.configOptions).toEqual({
      model: "claude-sonnet-4-6",
      thinking: "high",
    });
  });

  it("forwards the gemini agent variant unchanged on spawn and turn", async () => {
    const runtime = makeRuntime();
    const handle = await runtime.ensureSession({
      sessionKey: "s1",
      agent: "gemini",
      mode: "persistent",
      cwd: "/work",
    });

    const spawnCall = mockSendAcpEventToNode.mock.calls.find(
      (c) => (c as unknown as [string, string])[1] === "acp.spawn",
    );
    expect(spawnCall).toBeDefined();
    const spawnPayload = (spawnCall as unknown as [string, string, Record<string, unknown>])[2];
    expect(spawnPayload.agent).toBe("gemini");

    const iter = runtime.runTurn({
      handle,
      text: "hi",
      mode: "prompt",
      requestId: "req-1",
    });
    void iter[Symbol.asyncIterator]().next();
    await new Promise((r) => setTimeout(r, 0));

    const turnCall = mockSendAcpEventToNode.mock.calls.find(
      (c) => (c as unknown as [string, string])[1] === "acp.turn",
    );
    expect(turnCall).toBeDefined();
    const turnPayload = (turnCall as unknown as [string, string, Record<string, unknown>])[2];
    expect(turnPayload.agent).toBe("gemini");
  });
});

describe("normalizeGeminiModel", () => {
  it("resolves the known short aliases to full Gemini model ids", () => {
    expect(normalizeGeminiModel("flash")).toBe("gemini-3.1-flash-preview");
    expect(normalizeGeminiModel("pro")).toBe("gemini-3.1-pro-preview");
    expect(normalizeGeminiModel("flash-lite")).toBe("gemini-3.1-flash-lite-preview");
  });

  it("passes through unknown inputs unchanged", () => {
    expect(normalizeGeminiModel("gemini-3.1-flash-preview")).toBe("gemini-3.1-flash-preview");
    expect(normalizeGeminiModel("custom-model")).toBe("custom-model");
    expect(normalizeGeminiModel("")).toBe("");
  });
});

describe("normalizeModelForAgent", () => {
  it("rewrites Gemini aliases only when the agent is gemini", () => {
    expect(normalizeModelForAgent("gemini", "flash")).toBe("gemini-3.1-flash-preview");
    expect(normalizeModelForAgent("claude", "flash")).toBe("flash");
    expect(normalizeModelForAgent("codex", "pro")).toBe("pro");
  });
});

describe("RemoteAcpxRuntime — Gemini model normalization", () => {
  beforeEach(() => {
    clearGlobalConfigCache();
    mockSendAcpEventToNode.mockClear();
    mockSendAcpEventToNode.mockReturnValue(true);
  });

  async function captureTurnConfigOptions(input: {
    agent: string;
    model: string;
  }): Promise<Record<string, unknown> | undefined> {
    const runtime = makeRuntime();
    const handle = await runtime.ensureSession({
      sessionKey: "s1",
      agent: input.agent,
      mode: "persistent",
      model: input.model,
      cwd: "/work",
    });
    const iter = runtime.runTurn({
      handle,
      text: "hi",
      mode: "prompt",
      requestId: "req-1",
    });
    void iter[Symbol.asyncIterator]().next();
    await new Promise((r) => setTimeout(r, 0));
    const turnCall = mockSendAcpEventToNode.mock.calls.find(
      (c) => (c as unknown as [string, string])[1] === "acp.turn",
    );
    if (!turnCall) return undefined;
    const payload = (turnCall as unknown as [string, string, Record<string, unknown>])[2];
    return payload.configOptions as Record<string, unknown> | undefined;
  }

  it("normalizes a known Gemini alias on ensureSession", async () => {
    const opts = await captureTurnConfigOptions({ agent: "gemini", model: "flash" });
    expect(opts).toEqual({ model: "gemini-3.1-flash-preview" });
  });

  it("passes through an unknown Gemini model unchanged", async () => {
    const opts = await captureTurnConfigOptions({
      agent: "gemini",
      model: "gemini-experimental-foo",
    });
    expect(opts).toEqual({ model: "gemini-experimental-foo" });
  });

  it("leaves non-gemini agents untouched even when the model collides with a Gemini alias", async () => {
    const opts = await captureTurnConfigOptions({ agent: "claude", model: "flash" });
    expect(opts).toEqual({ model: "flash" });
  });

  it("normalizes Gemini aliases on setConfigOption too", async () => {
    const runtime = makeRuntime();
    const handle = await runtime.ensureSession({
      sessionKey: "s1",
      agent: "gemini",
      mode: "persistent",
    });
    await runtime.setConfigOption({ handle, key: "model", value: "pro" });

    const iter = runtime.runTurn({
      handle,
      text: "hi",
      mode: "prompt",
      requestId: "req-1",
    });
    void iter[Symbol.asyncIterator]().next();
    await new Promise((r) => setTimeout(r, 0));

    const turnCall = mockSendAcpEventToNode.mock.calls.find(
      (c) => (c as unknown as [string, string])[1] === "acp.turn",
    );
    const payload = (turnCall as unknown as [string, string, Record<string, unknown>])[2];
    expect(payload.configOptions).toEqual({ model: "gemini-3.1-pro-preview" });
  });

  it("normalizes when agent comes from defaultAgent fallback (no input.agent)", async () => {
    const runtime = makeRuntime({ defaultAgent: "gemini" });
    const handle = await runtime.ensureSession({
      sessionKey: "s1",
      mode: "persistent",
      model: "flash",
      cwd: "/work",
    });
    const iter = runtime.runTurn({
      handle,
      text: "hi",
      mode: "prompt",
      requestId: "req-1",
    });
    void iter[Symbol.asyncIterator]().next();
    await new Promise((r) => setTimeout(r, 0));

    const turnCall = mockSendAcpEventToNode.mock.calls.find(
      (c) => (c as unknown as [string, string])[1] === "acp.turn",
    );
    const payload = (turnCall as unknown as [string, string, Record<string, unknown>])[2];
    expect(payload.configOptions).toEqual({ model: "gemini-3.1-flash-preview" });
  });

  it("does not normalize non-model keys on a Gemini session", async () => {
    const runtime = makeRuntime();
    const handle = await runtime.ensureSession({
      sessionKey: "s1",
      agent: "gemini",
      mode: "persistent",
    });
    // Value collides with a Gemini alias to verify only the model branch normalizes.
    await runtime.setConfigOption({ handle, key: "approval_policy", value: "flash" });

    const iter = runtime.runTurn({
      handle,
      text: "hi",
      mode: "prompt",
      requestId: "req-1",
    });
    void iter[Symbol.asyncIterator]().next();
    await new Promise((r) => setTimeout(r, 0));

    const turnCall = mockSendAcpEventToNode.mock.calls.find(
      (c) => (c as unknown as [string, string])[1] === "acp.turn",
    );
    const payload = (turnCall as unknown as [string, string, Record<string, unknown>])[2];
    expect(payload.configOptions).toEqual({ approval_policy: "flash" });
  });

  it("ignores empty-string model on setConfigOption (mirrors ensureSession guard)", async () => {
    const runtime = makeRuntime();
    const handle = await runtime.ensureSession({
      sessionKey: "s1",
      agent: "gemini",
      mode: "persistent",
    });
    await runtime.setConfigOption({ handle, key: "model", value: "" });

    const iter = runtime.runTurn({
      handle,
      text: "hi",
      mode: "prompt",
      requestId: "req-1",
    });
    void iter[Symbol.asyncIterator]().next();
    await new Promise((r) => setTimeout(r, 0));

    const turnCall = mockSendAcpEventToNode.mock.calls.find(
      (c) => (c as unknown as [string, string])[1] === "acp.turn",
    );
    const payload = (turnCall as unknown as [string, string, Record<string, unknown>])[2];
    const opts = (payload.configOptions ?? {}) as Record<string, unknown>;
    expect(opts).not.toHaveProperty("model");
  });
});

describe("RemoteAcpxRuntime — setConfigOption", () => {
  beforeEach(() => {
    clearGlobalConfigCache();
    mockSendAcpEventToNode.mockClear();
    mockSendAcpEventToNode.mockReturnValue(true);
  });

  it("caches options and emits them on the next turn", async () => {
    const runtime = makeRuntime();
    const handle = await runtime.ensureSession({
      sessionKey: "s1",
      agent: "claude",
      mode: "persistent",
    });

    await runtime.setConfigOption({ handle, key: "model", value: "claude-sonnet-4-6" });
    await runtime.setConfigOption({ handle, key: "timeout", value: "120" });

    const iter = runtime.runTurn({
      handle,
      text: "hi",
      mode: "prompt",
      requestId: "req-1",
    });
    void iter[Symbol.asyncIterator]().next();
    await new Promise((r) => setTimeout(r, 0));

    const turnCall = mockSendAcpEventToNode.mock.calls.find(
      (c) => (c as unknown as [string, string])[1] === "acp.turn",
    );
    const turnPayload = (turnCall as unknown as [string, string, Record<string, unknown>])[2];
    expect(turnPayload.configOptions).toEqual({
      model: "claude-sonnet-4-6",
      timeout: "120",
    });
  });

  it("rejects setConfigOption when the handle is malformed", async () => {
    const runtime = makeRuntime();
    await expect(
      runtime.setConfigOption({
        handle: {
          sessionKey: "s1",
          backend: "remote-acpx",
          runtimeSessionName: "not-a-valid-handle",
        },
        key: "model",
        value: "x",
      }),
    ).rejects.toThrow(/Invalid remote-acpx handle/);
  });
});
