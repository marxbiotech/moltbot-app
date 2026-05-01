// Tool registration for run_coder — the LLM-invocable coding task dispatch tool.
// Uses a tool factory to access sessionKey from OpenClawPluginToolContext.
// Must be called during plugin register() phase (not service start()) so the
// tool appears in the agent's tool catalog. Runtime and config are resolved
// lazily via getters since the service hasn't started yet at registration time.

import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { isAcpRuntimeError } from "openclaw/plugin-sdk/remote-acpx";
import type { RemoteAcpxRuntime } from "./runtime.js";
import { SessionManager } from "./session-manager.js";
import { collectTurnOutput, type CollectedResult, type OperationEntry } from "./output-collector.js";
import { resolveAgentById } from "./agent-roster.js";
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

  log.info(`registerCodingTool: registering run_coder tool`);

  // Tool factory — invoked per agent turn with context containing sessionKey
  api.registerTool((ctx) => ({
    name: "run_coder",
    label: "Run Coder",
    description:
      "Run a remote coding agent (Claude Code, Codex, etc.) on the paired Mac to perform a coding task. " +
      "Returns a structured result with Operations (tool calls made) and Message (developer reply). " +
      "Use this when the user needs code changes, codebase exploration, " +
      "git operations, tests, builds, or any task requiring source code access.",
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "Complete technical instruction for the coding agent (English). " +
          "Include specific file paths, module names, function names, and expected behavior.",
      }),
      agentId: Type.Optional(
        Type.String({
          description:
            "Agent id from the roster (as returned by coding_agents_list). " +
            "Resolves cwd and agent variant automatically from agent config. " +
            "Preferred over explicit cwd/agent — use this when routing to a known agent.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Absolute path to the working directory on the remote Mac. " +
            "Overrides the cwd resolved from agentId. " +
            "If both agentId and cwd are omitted, falls back to the plugin-configured default cwd.",
        }),
      ),
      agent: Type.Optional(
        Type.String({
          description:
            "ACP agent variant (e.g. 'claude', 'codex'). " +
            "Overrides the variant resolved from agentId. " +
            "If omitted, uses the variant from the agentId roster entry (if set), otherwise the plugin default.",
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

      const { prompt, agentId, cwd, agent } = params as {
        prompt: string; agentId?: string; cwd?: string; agent?: string;
      };

      // Resolve cwd and variant: explicit params > agentId lookup > defaults
      let resolvedCwd = cwd || "";
      let resolvedAgent = agent || "";
      if (agentId && cwd && agent) {
        log.info(`execute: agentId="${agentId}" ignored — explicit cwd and agent provided`);
      } else if (agentId && (!cwd || !agent)) {
        const roster = resolveAgentById(agentId);
        if (roster) {
          if (!cwd) resolvedCwd = roster.cwd;
          if (!agent && roster.agent) resolvedAgent = roster.agent;
        } else {
          log.warn(`execute: agentId="${agentId}" not found in roster, falling back to defaults`);
        }
      }
      if (!resolvedAgent) resolvedAgent = config.defaultAgent;
      const sessionKey = ctx.sessionKey || "default";

      try {
        log.info(`execute: sessionKey=${sessionKey} agentId=${agentId || "(none)"} agent=${resolvedAgent} cwd=${resolvedCwd || "(none)"} prompt=${prompt.slice(0, 100)}`);

        const handle = await sessionMgr.getOrCreate(sessionKey, runtime, {
          agent: resolvedAgent,
          cwd: resolvedCwd,
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
              hint = "\n\nFailed to start a coding agent session. Check that the node is running and try again.";
              break;
            case "ACP_TURN_FAILED":
              hint = "\n\nFailed to send the request to the coding agent. The node may have disconnected — try again.";
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
