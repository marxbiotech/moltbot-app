// Tests for event-router's JSON-RPC session/update parsing. Focused on the
// codex / gemini path that emits tool_call and tool_call_update notifications
// instead of agent_message_chunk. Drives the public surface (routeNodeEvent +
// registerSessionQueue) so the parsing logic is exercised end-to-end.

import { describe, it, expect, beforeEach } from "vitest";
import type { AcpRuntimeEvent } from "openclaw/plugin-sdk/remote-acpx";
import { collectTurnOutput } from "./output-collector.js";
import {
  registerSessionQueue,
  routeNodeEvent,
  unregisterSessionQueue,
} from "./event-router.js";

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

  it("collectTurnOutput surfaces operations[] and operationCount for a codex turn", async () => {
    // Replay a small but realistic codex transcript:
    //   tool_call (in_progress) → tool_call_update (completed) → done
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

    // Drain the queue into an async iterable so collectTurnOutput can consume it.
    const iter = (async function* () {
      for (const event of queue.events) {
        yield event;
      }
    })();

    const result = await collectTurnOutput(iter, { maxOutputChars: 8000 });

    expect(result.status).toBe("success");
    expect(result.stopReason).toBe("end_turn");
    expect(result.operationCount).toBe(4); // 2 tool_call + 2 tool_call_update
    expect(result.operations.map((op) => op.tool)).toEqual([
      "Read file foo.ts",
      "unknown", // tool_call_update has no title
      "Edit file foo.ts",
      "unknown",
    ]);
    expect(result.operations[1]?.summary).toBe("42 lines");
    expect(result.operations[3]?.summary).toBe("wrote 1 hunk");

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
