// Collects streaming AcpRuntimeEvents from a runTurn() call into a structured result.
// Separates claude's final message from tool operations and thought process.
// Truncation is applied per-section with independent budgets.

import type { AcpRuntimeEvent } from "openclaw/plugin-sdk/remote-acpx";
import { log } from "./log.js";

export type OperationEntry = {
  tool: string;
  summary: string;
  status?: string;
};

export type CollectedResult = {
  status: "success" | "error";
  stopReason?: string;
  error?: string;
  /** Claude's final text reply (questions, summaries, explanations). */
  message: string;
  /** Structured tool call records. */
  operations: OperationEntry[];
  /** Total unique logical tool calls seen (before cap). */
  operationCount: number;
};

const MAX_OPERATIONS = 30;
const OPERATION_SUMMARY_LENGTH = 200;

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const separator = "\n\n... [truncated] ...\n\n";
  const available = maxChars - separator.length;
  // Favor tail: claude's conclusion/question is usually at the end.
  const headSize = Math.floor(available * 0.3);
  const tailSize = available - headSize;
  return text.slice(0, headSize) + separator + text.slice(-tailSize);
}

export async function collectTurnOutput(
  events: AsyncIterable<AcpRuntimeEvent>,
  opts: { maxOutputChars: number; signal?: AbortSignal },
): Promise<CollectedResult> {
  const messageChunks: string[] = [];
  const operations: OperationEntry[] = [];
  // Lookup for in-place merging of tool_call_update into the entry created by
  // the originating tool_call. Entries also live in `operations` so insertion
  // order is preserved.
  const operationsById = new Map<string, OperationEntry>();
  let operationCount = 0;
  let status: "success" | "error" = "success";
  let stopReason: string | undefined;
  let error: string | undefined;

  try {
    for await (const event of events) {
      if (opts.signal?.aborted) {
        status = "error";
        error = "Turn timed out or was cancelled";
        break;
      }

      switch (event.type) {
        case "text_delta":
          // Only collect output stream; discard thought stream.
          if (event.stream === "thought") {
            break;
          }
          messageChunks.push(event.text);
          break;

        case "tool_call": {
          // ACP emits one `tool_call` (creation, with title) followed by one or
          // more `tool_call_update`s (no title, terminal status/content). Merge
          // by toolCallId so each logical call renders as a single row instead
          // of `<title> [in_progress]` + `unknown [completed]` pairs.
          const id = event.toolCallId;
          const incomingSummary = event.text.slice(0, OPERATION_SUMMARY_LENGTH);
          const existing = id ? operationsById.get(id) : undefined;

          if (existing) {
            // Backfill title only when we don't already have a real one — never
            // overwrite a known title with the "unknown" placeholder from an
            // update that lacks `title`.
            if (event.title && existing.tool === "unknown") {
              existing.tool = event.title;
            }
            if (event.status) {
              existing.status = event.status;
            }
            // Empty text on creation must not clobber later content from an
            // update that arrived first (defensive ordering).
            if (incomingSummary) {
              existing.summary = incomingSummary;
            }
            break;
          }

          operationCount += 1;
          if (operations.length < MAX_OPERATIONS) {
            const entry: OperationEntry = {
              tool: event.title || "unknown",
              summary: incomingSummary,
              ...(event.status ? { status: event.status } : {}),
            };
            operations.push(entry);
            if (id) {
              operationsById.set(id, entry);
            }
          }
          break;
        }

        case "done":
          stopReason = event.stopReason;
          break;

        case "error":
          status = "error";
          error = event.message;
          break;

        case "status":
          // Ignored — does not affect final result.
          break;
      }
    }
  } catch (err) {
    status = "error";
    error = err instanceof Error ? err.message : String(err);
    log.error(`collectTurnOutput exception: ${error}`);
  }

  const rawMessage = messageChunks.join("");
  const message = truncateText(rawMessage, opts.maxOutputChars);

  return { status, stopReason, error, message, operations, operationCount };
}
