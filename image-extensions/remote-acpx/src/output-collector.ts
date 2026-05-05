// Collects streaming AcpRuntimeEvents from a runTurn() call into a structured result.
// Separates claude's final message from tool operations and thought process.
// Truncation is applied per-section with independent budgets.

import type { AcpRuntimeEvent } from "openclaw/plugin-sdk/remote-acpx";
import { log } from "./log.js";

// Documented ACP tool-call lifecycle states. The `(string & {})` fallback keeps
// autocomplete on the union while tolerating protocol drift — an agent that
// emits a status outside this list is not rejected at the type level.
export type ToolCallStatus =
  | "in_progress"
  | "pending"
  | "completed"
  | "completed_with_error"
  | "failed"
  | "cancelled";

export type OperationEntry = {
  tool: string;
  summary: string;
  status?: ToolCallStatus | (string & {});
};

export type CollectedResult = {
  status: "success" | "error";
  stopReason?: string;
  error?: string;
  /** Claude's final text reply (questions, summaries, explanations). */
  message: string;
  /** Structured tool call records. Read-only at the boundary — entries are
   * mutated only inside `collectTurnOutput` during merge. */
  operations: ReadonlyArray<Readonly<OperationEntry>>;
  /**
   * Total unique logical tool calls seen (before cap). Counts creations only —
   * does NOT increment when a `tool_call_update` merges into an existing entry.
   */
  operationCount: number;
};

const MAX_OPERATIONS = 30;
const OPERATION_SUMMARY_LENGTH = 200;
// Sentinel used when an OperationEntry was created from a `tool_call_update`
// before the originating `tool_call` was seen — and as the gate that allows a
// later `tool_call` to backfill the real title without overwriting one that
// was already set.
const UNKNOWN_TOOL = "unknown";

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
  // order is preserved. A `null` value is a tombstone: the toolCallId was seen
  // but the entry could not be stored because MAX_OPERATIONS was reached;
  // subsequent updates for that id must not re-inflate operationCount.
  const operationsById = new Map<string, OperationEntry | null>();
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
          const mapEntry = id ? operationsById.get(id) : undefined;

          // Tombstone: id was seen but its entry was dropped at the cap. Skip
          // silently so subsequent updates do not re-inflate operationCount.
          if (id && mapEntry === null) {
            break;
          }

          const existing = mapEntry ?? undefined;

          if (existing) {
            // Title drift: a later event tries to overwrite an already-known
            // title with a different non-empty title. Keep the first; surface
            // it so an operator can correlate the change with protocol drift.
            if (
              event.title &&
              existing.tool !== UNKNOWN_TOOL &&
              existing.tool !== event.title
            ) {
              log.warn(
                `output-collector: title drift for toolCallId=${id} ` +
                  `existing="${existing.tool}" incoming="${event.title}" tag=${event.tag ?? "<none>"} — keeping existing`,
              );
            }
            // Backfill title only when we don't already have a real one — never
            // overwrite a known title with the "unknown" placeholder from an
            // update that lacks `title`.
            if (event.title && existing.tool === UNKNOWN_TOOL) {
              existing.tool = event.title;
            }
            if (event.status) {
              existing.status = event.status;
            }
            // Empty text on creation must not clobber later content from an
            // update that arrived first (defensive ordering).
            if (incomingSummary) {
              existing.summary = incomingSummary;
            } else if (
              event.tag === "tool_call_update" &&
              !existing.summary
            ) {
              // Both incoming update and existing entry are empty — likely an
              // upstream content-extraction regression (see #31). Surface so
              // an empty-summary row in user output isn't a silent loss.
              log.warn(
                `output-collector: tool_call_update toolCallId=${id} status=${event.status ?? "<none>"} ` +
                  `had empty content and existing summary is empty — operation will render with empty summary`,
              );
            }
            break;
          }

          // No existing entry. If this is a tool_call_update, that is an
          // anomaly (orphan / out-of-order delivery / missing toolCallId on
          // the JSON-RPC update). The defensive create still happens so the
          // row is preserved, but the warn lets an operator distinguish a
          // legitimate simple-event-format stream from protocol drift.
          if (event.tag === "tool_call_update") {
            log.warn(
              `output-collector: tool_call_update without prior tool_call ` +
                `(toolCallId=${id ?? "<none>"}) — orphan, out-of-order delivery, or missing id`,
            );
          }

          operationCount += 1;
          if (operations.length < MAX_OPERATIONS) {
            const entry: OperationEntry = {
              tool: event.title || UNKNOWN_TOOL,
              summary: incomingSummary,
              ...(event.status ? { status: event.status } : {}),
            };
            operations.push(entry);
            if (id) {
              operationsById.set(id, entry);
            }
          } else if (id) {
            // Cap reached. Tombstone the id so its updates stay accounted for
            // (no double-counting in operationCount) without storing the entry.
            operationsById.set(id, null);
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
