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

import { RemoteAcpxRuntime, type RemoteAcpxConfig } from "./runtime.js";

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
