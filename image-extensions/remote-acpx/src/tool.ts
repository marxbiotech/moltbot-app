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

// Session keys with a run_coder turn currently executing. Shared via Symbol.for
// because jiti can load this module more than once (plugin loader + gateway
// subsystem); a module-local Set would let each copy see an empty guard.
const IN_FLIGHT_KEY = Symbol.for("remote-acpx.inFlightSessions");
const globalRef = globalThis as unknown as Record<symbol, Set<string>>;
if (!globalRef[IN_FLIGHT_KEY]) {
  globalRef[IN_FLIGHT_KEY] = new Set<string>();
}
const inFlightSessions = globalRef[IN_FLIGHT_KEY];

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
      "Run a remote coding agent (Claude Code, Codex, Gemini CLI, etc.) on the paired Mac to perform a coding task. " +
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
            "ACP agent variant (e.g. 'claude', 'codex', 'gemini'). " +
            "Overrides the variant resolved from agentId. " +
            "If omitted, uses the variant from the agentId roster entry (if set), otherwise the plugin default.",
        }),
      ),
      // Read by the codex agent runtime's per-tool-call watchdog
      // (resolveDynamicToolCallTimeoutMs), which otherwise kills the call at its
      // 90s default while the remote turn keeps running to completion — the
      // caller then sees a timeout and the finished result is discarded.
      // Runtime caps the effective budget at 600s.
      timeoutSeconds: Type.Optional(
        Type.Integer({
          description:
            "Seconds to wait for the remote agent before this call times out. " +
            "The default (90) is only enough for trivial single-file edits. " +
            "Set 300 for ordinary multi-step work and 600 (the maximum) for codebase " +
            "investigation, research, test runs, or builds.",
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

      // Resolve cwd and variant: explicit params > agentId lookup > defaults.
      // When an unknown agentId is given without an explicit cwd, fail loud
      // with AGENTID_UNRESOLVED — silent fallback to the default workspace
      // would mask routing bugs and contradicts the remote-acp-router SKILL.md
      // "do not guess paths or ids" rule. cwd is the workspace-safety anchor:
      // an explicit `agent` alone is not enough to justify degradation, since
      // we'd still be guessing the workspace. When the caller supplies an
      // explicit cwd (with or without agent), an unknown agentId is treated
      // as a roster miss and the call degrades to that cwd + the resolved
      // agent variant.
      let resolvedCwd = cwd || "";
      let resolvedAgent = agent || "";
      if (agentId && cwd && agent) {
        log.info(`execute: agentId="${agentId}" ignored — explicit cwd and agent provided`);
      } else if (agentId) {
        const roster = resolveAgentById(agentId);
        if (roster) {
          if (!cwd) resolvedCwd = roster.cwd;
          if (!agent && roster.agent) resolvedAgent = roster.agent;
        } else if (cwd) {
          log.warn(`execute: agentId="${agentId}" not found in roster — proceeding with explicit cwd + ${agent ? "explicit agent" : "default agent"}`);
        } else {
          log.warn(`execute: agentId="${agentId}" not found in roster — returning AGENTID_UNRESOLVED`);
          return {
            content: [{
              type: "text",
              text:
                `Error: AGENTID_UNRESOLVED — agentId="${agentId}" is not in the roster. ` +
                `Call coding_agents_list to see available ids, or pass an explicit cwd ` +
                `(optionally with agent) to bypass roster lookup.`,
            }],
          };
        }
      }
      if (!resolvedAgent) resolvedAgent = config.defaultAgent;
      const sessionKey = ctx.sessionKey || "default";

      // A second call on a session whose turn is still running would reach the
      // node-host's handleTurn, which kills the in-flight acpx process before
      // starting the new one. Both calls then fail: the first loses its work,
      // the second inherits the kill's acp.exited and returns ops=0. Refuse
      // instead — the common trigger is a caller retrying after the outer
      // watchdog fired while the remote turn was still progressing.
      if (inFlightSessions.has(sessionKey)) {
        log.warn(`execute: rejected — turn already in flight for sessionKey=${sessionKey}`);
        return {
          content: [{
            type: "text",
            text:
              "Error: TURN_IN_FLIGHT — a previous run_coder call on this session is still " +
              "executing on the remote agent. Wait for it to return rather than retrying; " +
              "a retry would kill the in-flight run and discard its work. If the earlier call " +
              "timed out, raise timeoutSeconds (max 600) on the next attempt.",
          }],
        };
      }
      inFlightSessions.add(sessionKey);

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
      } finally {
        inFlightSessions.delete(sessionKey);
      }
    },
  }));

  // Start prune interval after registration (uses lazy runtime getter)
  sessionMgr.resetPruneInterval(() => {
    const runtime = deps.getRuntime();
    if (runtime) sessionMgr.pruneStale(runtime);
  });
}
