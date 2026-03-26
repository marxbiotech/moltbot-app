// Collects streaming AcpRuntimeEvents from a runTurn() call into a structured result.
// Handles text accumulation, tool call summarization, and truncation.
// Timeout is handled by the runtime (sends acp.kill), not by the collector.

import type { AcpRuntimeEvent } from "openclaw/plugin-sdk/remote-acpx";
import { log } from "./log.js";

export type CollectedResult = {
  status: "success" | "error";
  stopReason?: string;
  error?: string;
  /** Claude Code internal tool call summaries (max 20) */
  operations: string[];
  /** Claude Code text output (truncated to maxOutputChars) */
  output: string;
};

const MAX_OPERATIONS = 20;

function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const separator = "\n\n... [truncated] ...\n\n";
  const available = maxChars - separator.length;
  const headSize = Math.floor(available * 0.6);
  const tailSize = available - headSize;
  return text.slice(0, headSize) + separator + text.slice(-tailSize);
}

export async function collectTurnOutput(
  events: AsyncIterable<AcpRuntimeEvent>,
  opts: { maxOutputChars: number; signal?: AbortSignal },
): Promise<CollectedResult> {
  const chunks: string[] = [];
  const operations: string[] = [];
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
          chunks.push(event.text);
          break;

        case "tool_call":
          if (operations.length < MAX_OPERATIONS) {
            const summary = event.text.slice(0, 200);
            operations.push(summary);
          }
          break;

        case "done":
          stopReason = event.stopReason;
          break;

        case "error":
          status = "error";
          error = event.message;
          break;

        case "status":
          // Ignored — does not affect final result
          break;
      }
    }
  } catch (err) {
    status = "error";
    error = err instanceof Error ? err.message : String(err);
    log.error(`collectTurnOutput exception: ${error}`);
  }

  const rawOutput = chunks.join("");
  const output = truncateOutput(rawOutput, opts.maxOutputChars);

  return { status, stopReason, error, operations, output };
}
