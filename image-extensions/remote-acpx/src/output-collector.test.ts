// Tests for the onProgress reporting seam added so a long dispatch is visible
// while it runs. The collector reports on every folded event; throttling is the
// caller's job, so these assert per-event emission and snapshot contents.

import { describe, it, expect, vi } from "vitest";
import type { AcpRuntimeEvent } from "openclaw/plugin-sdk/remote-acpx";

vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { collectTurnOutput } = await import("./output-collector.js");
const { log } = await import("./log.js");

async function* stream(...events: AcpRuntimeEvent[]): AsyncIterable<AcpRuntimeEvent> {
  for (const event of events) {
    yield event;
  }
}

describe("collectTurnOutput onProgress", () => {
  it("reports once per event with a running operation count", async () => {
    const snapshots: Array<{ operationCount: number; messageChars: number }> = [];

    await collectTurnOutput(
      stream(
        { type: "text_delta", text: "hello", stream: "output" },
        { type: "tool_call", text: "reading", toolCallId: "a", title: "Read" },
        { type: "tool_call", text: "editing", toolCallId: "b", title: "Edit" },
      ),
      {
        maxOutputChars: 1000,
        onProgress: (s) => snapshots.push({
          operationCount: s.operationCount,
          messageChars: s.messageChars,
        }),
      },
    );

    expect(snapshots).toEqual([
      { operationCount: 0, messageChars: 5 },
      { operationCount: 1, messageChars: 5 },
      { operationCount: 2, messageChars: 5 },
    ]);
  });

  it("carries the most recent operation, including a merged status update", async () => {
    const latest: Array<string | undefined> = [];

    await collectTurnOutput(
      stream(
        { type: "tool_call", text: "reading", toolCallId: "a", title: "Read" },
        { type: "tool_call", text: "done", toolCallId: "a", status: "completed", tag: "tool_call_update" },
      ),
      {
        maxOutputChars: 1000,
        onProgress: (s) => latest.push(s.latest ? `${s.latest.tool}:${s.latest.status ?? "-"}` : undefined),
      },
    );

    // Second event merges into the first entry rather than creating a new one,
    // so operationCount stays at 1 while the status advances.
    expect(latest).toEqual(["Read:-", "Read:completed"]);
  });

  it("does not count thought-stream text toward messageChars", async () => {
    const seen: number[] = [];

    await collectTurnOutput(
      stream(
        { type: "text_delta", text: "thinking hard", stream: "thought" },
        { type: "text_delta", text: "answer", stream: "output" },
      ),
      { maxOutputChars: 1000, onProgress: (s) => seen.push(s.messageChars) },
    );

    expect(seen).toEqual([0, 6]);
  });

  it("survives a throwing onProgress and still returns the turn result", async () => {
    const result = await collectTurnOutput(
      stream(
        { type: "text_delta", text: "kept", stream: "output" },
        { type: "done", stopReason: "end_turn" },
      ),
      {
        maxOutputChars: 1000,
        onProgress: () => {
          throw new Error("reporter blew up");
        },
      },
    );

    expect(result.status).toBe("success");
    expect(result.message).toBe("kept");
    expect(result.stopReason).toBe("end_turn");
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining("onProgress threw"),
    );
  });

  it("stops collecting once the abort signal fires", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await collectTurnOutput(
      stream({ type: "text_delta", text: "never seen", stream: "output" }),
      { maxOutputChars: 1000, signal: controller.signal },
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("Turn timed out or was cancelled");
    expect(result.message).toBe("");
  });
});
