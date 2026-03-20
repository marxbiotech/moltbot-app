// Tool registration for claude_code — the LLM-invocable Claude Code tool.
// Uses a tool factory to access sessionKey from OpenClawPluginToolContext.

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { RemoteAcpxRuntime, type RemoteAcpxConfig } from "../../remote-acpx/src/runtime.js";
import { SessionManager } from "./session-manager.js";
import { collectTurnOutput, type CollectedResult } from "./output-collector.js";
import { log } from "./log.js";

type CodingToolConfig = {
  nodeName: string;
  agentCommand: string;
  defaultAgent: string;
  workspaceRoot: string;
  workspaces: Record<string, string>;
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
    workspaceRoot: typeof cfg.workspaceRoot === "string" ? cfg.workspaceRoot : "/Users/li/Projects",
    workspaces:
      typeof cfg.workspaces === "object" && cfg.workspaces !== null
        ? (cfg.workspaces as Record<string, string>)
        : {},
    permissionMode: typeof cfg.permissionMode === "string" ? cfg.permissionMode : "approve-all",
    turnTimeoutMs: typeof cfg.turnTimeoutMs === "number" ? cfg.turnTimeoutMs : 300000,
    maxOutputChars: typeof cfg.maxOutputChars === "number" ? cfg.maxOutputChars : 6000,
  };
}

function resolveWorkspacePath(
  workspace: string | undefined,
  config: CodingToolConfig,
): string {
  if (!workspace) return "";
  // Check explicit workspace map first
  if (config.workspaces[workspace]) {
    return config.workspaces[workspace];
  }
  // Fallback: workspaceRoot + workspace name
  return `${config.workspaceRoot}/${workspace}`;
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

  // Periodically prune stale sessions (every 10 minutes)
  const pruneInterval = setInterval(() => sessionMgr.pruneStale(runtime), 10 * 60 * 1000);
  pruneInterval.unref?.();

  log.info(`registerCodingTool: nodeName=${config.nodeName} agent=${config.defaultAgent} workspaceRoot=${config.workspaceRoot}`);

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
      workspace: Type.Optional(
        Type.String({
          description:
            "Target workspace name (e.g., bindash, moltbot-app, marxbiotech-web). " +
            "Determines the working directory on the Mac.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const { prompt, workspace } = params as { prompt: string; workspace?: string };
      const sessionKey = ctx.sessionKey || "default";

      try {
        const cwd = resolveWorkspacePath(workspace, config);
        log.info(`execute: sessionKey=${sessionKey} workspace=${workspace || "(none)"} cwd=${cwd} prompt=${prompt.slice(0, 100)}`);

        // Get or create session (reuses existing Claude Code session for context)
        const handle = await sessionMgr.getOrCreate(sessionKey, runtime, {
          agent: config.defaultAgent,
          cwd,
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
          timeoutMs: config.turnTimeoutMs,
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
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
        };
      }
    },
  }));
}
