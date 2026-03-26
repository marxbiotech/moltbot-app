// Tool registration for claude_code — the LLM-invocable Claude Code tool.
// Uses a tool factory to access sessionKey from OpenClawPluginToolContext.

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { RemoteAcpxRuntime, type RemoteAcpxConfig } from "../../remote-acpx/src/runtime.js";
import { isAcpRuntimeError } from "openclaw/plugin-sdk/remote-acpx";
import { SessionManager } from "./session-manager.js";
import { collectTurnOutput, type CollectedResult } from "./output-collector.js";
import { log } from "./log.js";

type CodingToolConfig = {
  nodeName: string;
  agentCommand: string;
  defaultAgent: string;
  permissionMode: string;
  turnTimeoutMs: number;
  maxOutputChars: number;
};

function resolveConfig(raw: Record<string, unknown> | undefined): CodingToolConfig {
  const cfg = raw || {};
  return {
    nodeName: typeof cfg.nodeName === "string" ? cfg.nodeName : "",
    agentCommand: typeof cfg.agentCommand === "string" ? cfg.agentCommand : "acpx",
    defaultAgent: typeof cfg.defaultAgent === "string" ? cfg.defaultAgent : "claude",
    permissionMode: typeof cfg.permissionMode === "string" ? cfg.permissionMode : "approve-all",
    turnTimeoutMs: typeof cfg.turnTimeoutMs === "number" ? cfg.turnTimeoutMs : 300000,
    maxOutputChars: typeof cfg.maxOutputChars === "number" ? cfg.maxOutputChars : 6000,
  };
}

function formatToolResult(result: CollectedResult): { content: Array<{ type: "text"; text: string }> } {
  const parts: string[] = [];

  if (result.status === "error" && result.error) {
    parts.push(`Error: ${result.error}`);
  }

  if (result.operations.length > 0) {
    parts.push(`Operations (${result.operations.length}):`);
    for (const op of result.operations) {
      parts.push(`- ${op}`);
    }
  }

  if (result.output) {
    parts.push("");
    parts.push("Output:");
    parts.push(result.output);
  }

  if (result.stopReason) {
    parts.push(`\nStop reason: ${result.stopReason}`);
  }

  return {
    content: [{ type: "text", text: parts.join("\n") || "(no output)" }],
  };
}

export function registerCodingTool(api: OpenClawPluginApi): void {
  const config = resolveConfig(api.pluginConfig);
  const runtimeConfig: RemoteAcpxConfig = {
    nodeName: config.nodeName,
    agentCommand: config.agentCommand,
    defaultAgent: config.defaultAgent,
    permissionMode: config.permissionMode,
    turnTimeoutMs: config.turnTimeoutMs,
  };
  const runtime = new RemoteAcpxRuntime(runtimeConfig);
  const sessionMgr = new SessionManager();

  // Periodically prune stale sessions (every 10 minutes).
  // Store interval in SessionManager's global state so it survives jiti reloads without accumulating.
  sessionMgr.resetPruneInterval(() => sessionMgr.pruneStale(runtime));

  log.info(`registerCodingTool: nodeName=${config.nodeName} agent=${config.defaultAgent}`);

  // Tool factory — invoked per agent turn with context containing sessionKey
  api.registerTool((ctx) => ({
    name: "claude_code",
    label: "Claude Code",
    description:
      "Execute Claude Code CLI on the remote Mac to perform coding tasks. " +
      "Returns execution results including tool operations and text output. " +
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
      const { prompt, cwd } = params as { prompt: string; cwd?: string };
      const sessionKey = ctx.sessionKey || "default";

      try {
        // Design Decision: Log prompt prefix for debugging. /tmp is ephemeral (cleared on container restart)
        // and only accessible via sandbox debug endpoint, so the sensitivity tradeoff is acceptable.
        log.info(`execute: sessionKey=${sessionKey} cwd=${cwd || "(none)"} prompt=${prompt.slice(0, 100)}`);

        // Get or create session (reuses existing Claude Code session for context)
        const handle = await sessionMgr.getOrCreate(sessionKey, runtime, {
          agent: config.defaultAgent,
          cwd: cwd || "",
        });

        // Run the turn and collect output
        const events = runtime.runTurn({
          handle,
          text: prompt,
          mode: "prompt",
          requestId: randomUUID(),
        });
        const result = await collectTurnOutput(events, {
          maxOutputChars: config.maxOutputChars,
        });

        // If session errored, invalidate cache so next call spawns fresh
        if (result.status === "error") {
          sessionMgr.invalidate(sessionKey);
        }

        log.info(`execute done: sessionKey=${sessionKey} status=${result.status} ops=${result.operations.length} outputLen=${result.output.length}`);
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
}
