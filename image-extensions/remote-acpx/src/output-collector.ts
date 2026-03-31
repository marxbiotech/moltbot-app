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
  /** Total tool_call events received (before cap). */
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
          operationCount += 1;
          if (operations.length < MAX_OPERATIONS) {
            const tool = event.title || "unknown";
            const summary = event.text.slice(0, OPERATION_SUMMARY_LENGTH);
            operations.push({
              tool,
              summary,
              ...(event.status ? { status: event.status } : {}),
            });
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
