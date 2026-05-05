// Drives the public surface (routeNodeEvent + registerSessionQueue) rather than
// importing parseJsonRpcLine directly — keeps the parser internal and exercises
// the codex/gemini tool_call paths end-to-end.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AcpRuntimeEvent } from "openclaw/plugin-sdk/remote-acpx";

vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { collectTurnOutput } from "./output-collector.js";
import {
  registerSessionQueue,
  registerSpawnResolver,
  routeNodeEvent,
  unregisterSessionQueue,
  unregisterSpawnResolver,
} from "./event-router.js";
import { log } from "./log.js";

type CapturedQueue = {
  events: AcpRuntimeEvent[];
  push(event: AcpRuntimeEvent): void;
  close(): void;
  error(err: Error): void;
};

function makeCapturedQueue(): CapturedQueue {
  const events: AcpRuntimeEvent[] = [];
  return {
    events,
    push(event) {
      events.push(event);
    },
    close() {},
    error() {},
  };
}

function feedLine(acpSessionId: string, line: string): void {
  routeNodeEvent("node-1", {
    event: "acp.message",
    payload: { acpSessionId, line },
  });
}

describe("event-router parseJsonRpcLine — claude path (regression)", () => {
  const acpSessionId = "claude-session";
  let queue: CapturedQueue;

  beforeEach(() => {
    queue = makeCapturedQueue();
    registerSessionQueue(acpSessionId, queue);
  });

  it("maps agent_message_chunk to text_delta", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello, world." },
        },
      },
    });

    feedLine(acpSessionId, line);

    expect(queue.events).toEqual([{ type: "text_delta", text: "Hello, world." }]);
    unregisterSessionQueue(acpSessionId);
  });
});

describe("event-router parseJsonRpcLine — codex tool_call path", () => {
  const acpSessionId = "codex-session";
  let queue: CapturedQueue;

  beforeEach(() => {
    queue = makeCapturedQueue();
    registerSessionQueue(acpSessionId, queue);
  });

  it("maps session/update tool_call to a tool_call AcpRuntimeEvent", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_001",
          title: "Reading file src/index.ts",
          status: "in_progress",
          kind: "read",
          rawInput: { path: "src/index.ts" },
        },
      },
    });

    feedLine(acpSessionId, line);

    expect(queue.events).toHaveLength(1);
    expect(queue.events[0]).toMatchObject({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_001",
      title: "Reading file src/index.ts",
      status: "in_progress",
    });
    unregisterSessionQueue(acpSessionId);
  });

  it("maps session/update tool_call_update with openclaw-style content[] to a tool_call event", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_001",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "ok: 12 lines read" },
            },
          ],
          rawOutput: "ok: 12 lines read",
        },
      },
    });

    feedLine(acpSessionId, line);

    expect(queue.events).toHaveLength(1);
    expect(queue.events[0]).toMatchObject({
      type: "tool_call",
      tag: "tool_call_update",
      toolCallId: "call_001",
      status: "completed",
      text: "ok: 12 lines read",
    });
    unregisterSessionQueue(acpSessionId);
  });

  it("flattens simpler { type: 'text', text } content blocks", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_002",
          status: "completed",
          content: [
            { type: "text", text: "first chunk" },
            { type: "text", text: "second chunk" },
          ],
        },
      },
    });

    feedLine(acpSessionId, line);

    expect(queue.events).toHaveLength(1);
    expect((queue.events[0] as { text: string }).text).toBe("first chunk\nsecond chunk");
    unregisterSessionQueue(acpSessionId);
  });

  it("collectTurnOutput merges tool_call + tool_call_update into one entry per toolCallId", async () => {
    // Replay a small but realistic codex transcript:
    //   tool_call (in_progress) → tool_call_update (completed) → done
    // Regression for #29 — previously this produced 4 entries (2 logical calls
    // × {creation, completion}) with the completion rows showing as
    // `unknown [completed]` because tool_call_update has no title.
    const lines = [
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_a",
            title: "Read file foo.ts",
            status: "in_progress",
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_a",
            status: "completed",
            content: [
              { type: "content", content: { type: "text", text: "42 lines" } },
            ],
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_b",
            title: "Edit file foo.ts",
            status: "in_progress",
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_b",
            status: "completed",
            content: [{ type: "text", text: "wrote 1 hunk" }],
          },
        },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } }),
    ];

    for (const line of lines) {
      feedLine(acpSessionId, line);
    }

    const iter = (async function* () {
      for (const event of queue.events) {
        yield event;
      }
    })();

    const result = await collectTurnOutput(iter, { maxOutputChars: 8000 });

    expect(result.status).toBe("success");
    expect(result.stopReason).toBe("end_turn");
    expect(result.operationCount).toBe(2);
    expect(result.operations).toEqual([
      { tool: "Read file foo.ts", summary: "42 lines", status: "completed" },
      { tool: "Edit file foo.ts", summary: "wrote 1 hunk", status: "completed" },
    ]);

    unregisterSessionQueue(acpSessionId);
  });

  it("merges interleaved updates for multiple tool calls in original creation order", async () => {
    const lines = [
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_a",
            title: "pwd",
            status: "in_progress",
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_b",
            title: "ls /tmp",
            status: "in_progress",
          },
        },
      }),
      // Updates arrive out of creation order — b completes before a.
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_b",
            status: "completed",
            content: [{ type: "text", text: "3 entries" }],
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_a",
            status: "completed",
            content: [{ type: "text", text: "/Users/me" }],
          },
        },
      }),
    ];

    for (const line of lines) {
      feedLine(acpSessionId, line);
    }

    const iter = (async function* () {
      for (const event of queue.events) {
        yield event;
      }
    })();

    const result = await collectTurnOutput(iter, { maxOutputChars: 8000 });

    expect(result.operationCount).toBe(2);
    // Insertion order is creation order, not completion order.
    expect(result.operations).toEqual([
      { tool: "pwd", summary: "/Users/me", status: "completed" },
      { tool: "ls /tmp", summary: "3 entries", status: "completed" },
    ]);

    unregisterSessionQueue(acpSessionId);
  });

  it("backfills title when tool_call_update arrives before its tool_call", async () => {
    // Defensive — if an update for a fresh toolCallId arrives first, the entry
    // is created with `tool: \"unknown\"`. A later `tool_call` with the same id
    // must backfill the title rather than push a duplicate row.
    const lines = [
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_late",
            status: "completed",
            content: [{ type: "text", text: "done" }],
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_late",
            title: "Read REVIEW.txt",
            status: "in_progress",
          },
        },
      }),
    ];

    for (const line of lines) {
      feedLine(acpSessionId, line);
    }

    const iter = (async function* () {
      for (const event of queue.events) {
        yield event;
      }
    })();

    const result = await collectTurnOutput(iter, { maxOutputChars: 8000 });

    expect(result.operationCount).toBe(1);
    // Title backfilled from the late `tool_call`; status stays at the most
    // recent value (`in_progress` here, since the late event was the create).
    // Summary preserved from the earlier update — empty creation text must not
    // clobber non-empty content already collected.
    expect(result.operations).toEqual([
      { tool: "Read REVIEW.txt", summary: "done", status: "in_progress" },
    ]);

    unregisterSessionQueue(acpSessionId);
  });

  it("keeps tool_call events without toolCallId as separate entries", async () => {
    // The simple-event-format path (event-router.ts:107-115) and any agent
    // that omits toolCallId must not have its events merged into a single row.
    const lines = [
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "tool_call",
            title: "first call",
            status: "completed",
            content: [{ type: "text", text: "alpha" }],
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "tool_call",
            title: "second call",
            status: "completed",
            content: [{ type: "text", text: "beta" }],
          },
        },
      }),
    ];

    for (const line of lines) {
      feedLine(acpSessionId, line);
    }

    const iter = (async function* () {
      for (const event of queue.events) {
        yield event;
      }
    })();

    const result = await collectTurnOutput(iter, { maxOutputChars: 8000 });

    expect(result.operationCount).toBe(2);
    expect(result.operations).toEqual([
      { tool: "first call", summary: "alpha", status: "completed" },
      { tool: "second call", summary: "beta", status: "completed" },
    ]);

    unregisterSessionQueue(acpSessionId);
  });

  it("ignores unrelated session/update tags (usage_update, plan, etc.)", () => {
    const lines = [
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "usage_update",
            inputTokens: 100,
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "plan",
            entries: [{ content: "step 1", priority: "high" }],
          },
        },
      }),
    ];

    for (const line of lines) {
      feedLine(acpSessionId, line);
    }

    expect(queue.events).toEqual([]);
    unregisterSessionQueue(acpSessionId);
  });
});

describe("event-router parseJsonRpcLine — flattenToolCallContent shapes", () => {
  const acpSessionId = "shape-session";
  let queue: CapturedQueue;

  beforeEach(() => {
    queue = makeCapturedQueue();
    registerSessionQueue(acpSessionId, queue);
  });

  it("forwards bare-string content verbatim", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_x",
          status: "completed",
          content: "raw stdout text",
        },
      },
    });

    feedLine(acpSessionId, line);

    expect(queue.events).toHaveLength(1);
    expect((queue.events[0] as { text: string }).text).toBe("raw stdout text");
    unregisterSessionQueue(acpSessionId);
  });

  it("normalizes a single-object content to a one-element array", () => {
    // Some agents emit `content` as a single object instead of an array.
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_y",
          status: "completed",
          content: { type: "text", text: "single block" },
        },
      },
    });

    feedLine(acpSessionId, line);

    expect(queue.events).toHaveLength(1);
    expect((queue.events[0] as { text: string }).text).toBe("single block");
    unregisterSessionQueue(acpSessionId);
  });

  it("logs a warn for unrecognized block shapes and drops them while keeping recognized ones", () => {
    const warn = vi.mocked(log.warn);
    warn.mockClear();

    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_z",
          status: "completed",
          content: [
            { type: "image", url: "..." },
            { type: "text", text: "kept" },
            { type: "diff", oldText: "a", newText: "b" },
          ],
        },
      },
    });

    feedLine(acpSessionId, line);

    expect(queue.events).toHaveLength(1);
    expect((queue.events[0] as { text: string }).text).toBe("kept");
    // Two unrecognized blocks → two warn calls.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain("flattenToolCallContent: unrecognized block");
    unregisterSessionQueue(acpSessionId);
  });
});

describe("event-router routeNodeEvent — acp.error logging", () => {
  beforeEach(() => {
    vi.mocked(log.error).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  it("logs the payload and rejects the spawn resolver", async () => {
    const acpSessionId = "spawn-fail-session";
    const rejectPromise = new Promise<Error>((resolve) => {
      registerSpawnResolver(acpSessionId, {
        resolve: () => {},
        reject: (err) => resolve(err),
      });
    });

    routeNodeEvent("node-1", {
      event: "acp.error",
      payload: { acpSessionId, error: "Agent command not found: acpx" },
    });

    const err = await rejectPromise;
    expect(err.message).toBe("Agent command not found: acpx");
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.stringContaining("acp.error: acpSessionId=spawn-fail-session"),
    );
    expect(vi.mocked(log.error).mock.calls[0]?.[0]).toContain("Agent command not found: acpx");
    unregisterSpawnResolver(acpSessionId);
  });

  it("logs the payload and routes to the session queue when no spawn resolver is registered", () => {
    const acpSessionId = "session-fail-session";
    const queue = makeCapturedQueue();
    registerSessionQueue(acpSessionId, queue);

    routeNodeEvent("node-1", {
      event: "acp.error",
      payload: { acpSessionId, error: "ENOENT: chdir failed" },
    });

    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.stringContaining("acp.error: acpSessionId=session-fail-session"),
    );
    expect(queue.events).toEqual([{ type: "error", message: "ENOENT: chdir failed" }]);
    unregisterSessionQueue(acpSessionId);
  });

  it("logs both error and the orphan warn when no resolver and no queue are registered", () => {
    routeNodeEvent("node-1", {
      event: "acp.error",
      payload: { acpSessionId: "orphan-session", error: "stale error" },
    });

    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.stringContaining("acp.error: acpSessionId=orphan-session"),
    );
    // The orphan warn is the operator's only signal that an acp.error arrived
    // for an unknown session; assert it explicitly so a regression that drops
    // the warn is caught.
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining("acp.error with no handler: acpSessionId=orphan-session"),
    );
  });

  it("stringifies object-shaped error payloads instead of dropping them as 'Unknown ACP error'", () => {
    routeNodeEvent("node-1", {
      event: "acp.error",
      payload: {
        acpSessionId: "obj-error-session",
        error: { code: "ENOENT", path: "/usr/bin/acpx" },
      },
    });

    const logged = vi.mocked(log.error).mock.calls[0]?.[0] ?? "";
    expect(logged).toContain("non-string error payload");
    expect(logged).toContain("ENOENT");
    expect(logged).toContain("/usr/bin/acpx");
    expect(logged).not.toContain("Unknown ACP error");
  });

  it("falls back to the placeholder when payload.error is undefined", () => {
    routeNodeEvent("node-1", {
      event: "acp.error",
      payload: { acpSessionId: "no-error-session" },
    });

    const logged = vi.mocked(log.error).mock.calls[0]?.[0] ?? "";
    expect(logged).toContain("Unknown ACP error (no payload.error)");
  });

  it("treats payload.error === null the same as missing", () => {
    routeNodeEvent("node-1", {
      event: "acp.error",
      payload: { acpSessionId: "null-error-session", error: null },
    });

    const logged = vi.mocked(log.error).mock.calls[0]?.[0] ?? "";
    expect(logged).toContain("Unknown ACP error (no payload.error)");
  });

  it("does not throw when payload.error is a circular object, and still logs", () => {
    const circular: Record<string, unknown> = { code: "ENOENT" };
    circular.self = circular;

    expect(() => {
      routeNodeEvent("node-1", {
        event: "acp.error",
        payload: { acpSessionId: "circular-session", error: circular },
      });
    }).not.toThrow();

    const logged = vi.mocked(log.error).mock.calls[0]?.[0] ?? "";
    expect(logged).toContain("acp.error: acpSessionId=circular-session");
    expect(logged).toContain("non-string error payload");
    expect(logged).toContain("<unserializable:");
  });

  it("appends a truncation marker when the stringified payload exceeds the cap", () => {
    const longPayload = { detail: "x".repeat(800) };

    routeNodeEvent("node-1", {
      event: "acp.error",
      payload: { acpSessionId: "long-error-session", error: longPayload },
    });

    const logged = vi.mocked(log.error).mock.calls[0]?.[0] ?? "";
    expect(logged).toContain("non-string error payload");
    expect(logged).toMatch(/…\(truncated, \d+ chars\)/);
  });
});
