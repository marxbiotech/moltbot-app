// Tool registration for claude_code — the LLM-invocable Claude Code tool.
// Uses a tool factory to access sessionKey from OpenClawPluginToolContext.
// Must be called during plugin register() phase (not service start()) so the
// tool appears in the agent's tool catalog. Runtime and config are resolved
// lazily via getters since the service hasn't started yet at registration time.

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { isAcpRuntimeError } from "openclaw/plugin-sdk/remote-acpx";
import type { RemoteAcpxRuntime } from "./runtime.js";
import { SessionManager } from "./session-manager.js";
import { collectTurnOutput, type CollectedResult, type OperationEntry } from "./output-collector.js";
import { log } from "./log.js";

export type CodingToolConfig = {
  defaultAgent: string;
  maxOutputChars: number;
};

function formatOperationLine(op: OperationEntry): string {
  const statusTag = op.status ? ` [${op.status}]` : "";
  return `- ${op.tool}${statusTag}: ${op.summary}`;
}

function formatToolResult(result: CollectedResult): { content: Array<{ type: "text"; text: string }> } {
  const sections: string[] = [];

  if (result.status === "error" && result.error) {
    sections.push(`Error: ${result.error}`);
  }

  if (result.operations.length > 0) {
    const countNote = result.operationCount > result.operations.length
      ? ` (showing ${result.operations.length} of ${result.operationCount})`
      : "";
    sections.push(`Operations${countNote}:\n${result.operations.map(formatOperationLine).join("\n")}`);
  }

  if (result.message) {
    sections.push(`Message:\n${result.message}`);
  }

  if (result.stopReason) {
    sections.push(`Stop reason: ${result.stopReason}`);
  }

  return {
    content: [{ type: "text", text: sections.join("\n\n") || "(no output)" }],
  };
}

export type CodingToolDeps = {
  getRuntime: () => RemoteAcpxRuntime | null;
  getConfig: () => CodingToolConfig;
};

export function registerCodingTool(
  api: OpenClawPluginApi,
  deps: CodingToolDeps,
): void {
  const sessionMgr = new SessionManager();

  log.info(`registerCodingTool: registering claude_code tool`);

  // Tool factory — invoked per agent turn with context containing sessionKey
  api.registerTool((ctx) => ({
    name: "claude_code",
    label: "Claude Code",
    description:
      "Execute Claude Code CLI on the remote Mac to perform coding tasks. " +
      "Returns a structured result with Operations (tool calls made) and Message (developer reply). " +
      "Use this when the user needs code changes, codebase exploration, " +
      "git operations, tests, builds, or any task requiring source code access.",
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "Complete technical instruction for Claude Code (English). " +
          "Include specific file paths, module names, function names, and expected behavior.",
      }),
      cwd: Type.Optional(
        Type.String({
          description:
            "Absolute path to the working directory on the remote Mac. " +
            "If omitted, uses the session's existing cwd.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const runtime = deps.getRuntime();
      const config = deps.getConfig();

      if (!runtime) {
        return {
          content: [{ type: "text", text: "Error: Remote-acpx service not started yet. Try again in a moment." }],
        };
      }

      const { prompt, cwd } = params as { prompt: string; cwd?: string };
      const sessionKey = ctx.sessionKey || "default";

      try {
        log.info(`execute: sessionKey=${sessionKey} cwd=${cwd || "(none)"} prompt=${prompt.slice(0, 100)}`);

        const handle = await sessionMgr.getOrCreate(sessionKey, runtime, {
          agent: config.defaultAgent,
          cwd: cwd || "",
        });

        const events = runtime.runTurn({
          handle,
          text: prompt,
          mode: "prompt",
          requestId: randomUUID(),
        });
        const result = await collectTurnOutput(events, {
          maxOutputChars: config.maxOutputChars,
        });

        if (result.status === "error") {
          sessionMgr.invalidate(sessionKey);
        }

        log.info(`execute done: sessionKey=${sessionKey} status=${result.status} ops=${result.operationCount} msgLen=${result.message.length}`);
        return formatToolResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`execute error: sessionKey=${sessionKey} err=${message}`);
        sessionMgr.invalidate(sessionKey);

        let hint = "";
        if (isAcpRuntimeError(err)) {
          switch (err.code) {
            case "ACP_BACKEND_UNAVAILABLE":
              hint = "\n\nNo node is connected. Start one with `make node` in the overlay directory.";
              break;
            case "ACP_SESSION_INIT_FAILED":
              hint = "\n\nFailed to start a Claude Code session. Check that the node is running and try again.";
              break;
            case "ACP_TURN_FAILED":
              hint = "\n\nFailed to send the request to Claude Code. The node may have disconnected — try again.";
              break;
          }
        }

        return {
          content: [{ type: "text", text: `Error: ${message}${hint}` }],
        };
      }
    },
  }));

  // Start prune interval after registration (uses lazy runtime getter)
  sessionMgr.resetPruneInterval(() => {
    const runtime = deps.getRuntime();
    if (runtime) sessionMgr.pruneStale(runtime);
  });
}
