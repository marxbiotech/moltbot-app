// Tool registration for run_coder — the LLM-invocable coding task dispatch tool.
// Uses a tool factory to access sessionKey from OpenClawPluginToolContext.
// Must be called during plugin register() phase (not service start()) so the
// tool appears in the agent's tool catalog. Runtime and config are resolved
// lazily via getters since the service hasn't started yet at registration time.

import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { isAcpRuntimeError } from "openclaw/plugin-sdk/remote-acpx";
import type { RemoteAcpxRuntime } from "./runtime.js";
import { SessionManager } from "./session-manager.js";
import {
  collectTurnOutput,
  type CollectedResult,
  type OperationEntry,
  type ProgressSnapshot,
} from "./output-collector.js";
import { resolveAgentById } from "./agent-roster.js";
import { inFlightSessions } from "./in-flight.js";
import { createJobStore, type DispatchJob } from "./job-store.js";
import { startDispatch } from "./dispatcher.js";
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

function formatJobStatus(job: DispatchJob): { content: Array<{ type: "text"; text: string }> } {
  const elapsed = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
  const head = `Job ${job.jobId} — ${job.status} after ${elapsed}s (${job.agentId ?? job.agent}).`;

  if (job.status === "running") {
    const p = job.progress;
    return {
      content: [{
        type: "text",
        text:
          `${head}\n` +
          (p
            ? `Progress: ${p.operationCount} operation(s), latest ${p.latest ?? "-"}.`
            : "No operations reported yet.") +
          `\nStill running — do not start the task again. You will be woken when it finishes.`,
      }],
    };
  }

  const sections = [head];
  if (job.result?.error) sections.push(`Error: ${job.result.error}`);
  if (job.result?.operationCount) sections.push(`Operations: ${job.result.operationCount}`);
  if (job.result?.message) sections.push(`Message:\n${job.result.message}`);
  if (job.result?.stopReason) sections.push(`Stop reason: ${job.result.stopReason}`);
  return { content: [{ type: "text", text: sections.join("\n\n") }] };
}

export type CodingToolDeps = {
  getRuntime: () => RemoteAcpxRuntime | null;
  getConfig: () => CodingToolConfig;
};


// A dispatch streams on the order of a thousand ACP events. Both progress sinks
// are coalesced to this cadence: the channel renderer would otherwise redraw
// continuously, and the diagnostic bus only needs enough traffic to keep the
// no-progress timer from advancing.
const PROGRESS_INTERVAL_MS = 5_000;

/**
 * Builds the throttled `onProgress` sink for one dispatch. Reports to two
 * independent places:
 *
 * - `onUpdate` — the framework's partial-result callback, which becomes a
 *   `tool_execution_update` and renders as channel progress. Without it the
 *   channel is silent for the whole dispatch, which is what drives operators to
 *   retry and kill in-flight work.
 * - `run.progress` on the diagnostic bus — what `diagnostic-run-activity`
 *   consumes to reset `lastProgressAge`. remote-acpx cannot otherwise report
 *   that the session is alive, so a long dispatch looks stalled to
 *   `diagnostics.stuckSessionAbortMs` recovery.
 */
export function createProgressReporter(params: {
  sessionKey: string;
  sessionId?: string;
  agent: string;
  onUpdate?: (partial: { content: Array<{ type: "text"; text: string }> }) => void;
}): (snapshot: ProgressSnapshot) => void {
  let lastEmitAt = 0;

  return (snapshot) => {
    const now = Date.now();
    if (now - lastEmitAt < PROGRESS_INTERVAL_MS) {
      return;
    }
    lastEmitAt = now;

    // The diagnostic bus does not log run.progress, and the channel sink is
    // invisible from a CLI-originated dispatch — so without this line there is
    // no way to confirm from a running gateway that progress is actually being
    // reported, only that nothing complained. One line per interval is noise-
    // free next to the ~1e3 routeNodeEvent entries a turn already writes here.
    log.info(
      `progress: sessionKey=${params.sessionKey} ops=${snapshot.operationCount} ` +
        `latest=${snapshot.latest?.tool ?? "-"} msgChars=${snapshot.messageChars}`,
    );

    emitTrustedDiagnosticEvent({
      type: "run.progress",
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      sessionKey: params.sessionKey,
      reason: "remote_acpx:turn_progress",
    });

    if (!params.onUpdate) {
      return;
    }
    const latest = snapshot.latest
      ? `${snapshot.latest.tool}${snapshot.latest.status ? ` [${snapshot.latest.status}]` : ""}`
      : "starting";
    params.onUpdate({
      content: [{
        type: "text",
        text: `${params.agent}: ${snapshot.operationCount} operation(s) · ${latest}`,
      }],
    });
  };
}

export function registerCodingTool(
  api: OpenClawPluginApi,
  deps: CodingToolDeps,
): void {
  const sessionMgr = new SessionManager();
  const jobStore = createJobStore();

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
            "investigation, research, test runs, or builds. Ignored when mode is 'async'.",
        }),
      ),
      mode: Type.Optional(
        Type.String({
          description:
            "'sync' (default) waits for the remote agent and returns the result. It cannot " +
            "run longer than 600s — that is a hard runtime limit, not a setting. " +
            "'async' starts the work and returns a jobId immediately, with no time limit; " +
            "use it whenever the task plausibly exceeds ten minutes. In async mode you MUST " +
            "NOT call run_coder again for the same task: you will be woken when it finishes, " +
            "and a repeat call returns the running job's status instead of starting anything.",
        }),
      ),
      action: Type.Optional(
        Type.String({
          description:
            "'start' (default) dispatches work. 'status' reads a previously started async " +
            "job — pass jobId. Use it when you were woken about a job, or when the user asks " +
            "how one is going.",
        }),
      ),
      jobId: Type.Optional(
        Type.String({ description: "Job id to read. Required when action is 'status'." }),
      ),
    }),
    // signal and onUpdate are supplied by the agent-core tool loop
    // (executePreparedToolCall). Both were previously dropped: runTurn and
    // collectTurnOutput already honour an AbortSignal, so cancellation was
    // implemented on both ends but never wired through the middle.
    async execute(_toolCallId, params, signal, onUpdate) {
      const runtime = deps.getRuntime();
      const config = deps.getConfig();

      if (!runtime) {
        return {
          content: [{ type: "text", text: "Error: Remote-acpx service not started yet. Try again in a moment." }],
        };
      }

      const { prompt, agentId, cwd, agent, mode, action, jobId } = params as {
        prompt: string; agentId?: string; cwd?: string; agent?: string;
        mode?: string; action?: string; jobId?: string;
      };

      if (action === "status") {
        if (!jobId) {
          return {
            content: [{ type: "text", text: "Error: action=\"status\" requires jobId." }],
          };
        }
        const job = jobStore.get(jobId);
        if (!job) {
          return {
            content: [{
              type: "text",
              text:
                `Error: no job ${jobId}. Async job records expire after 6 hours; if the ` +
                `dispatch was that long ago, re-run the task rather than waiting for it.`,
            }],
          };
        }
        return formatJobStatus(job);
      }

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

      if (mode === "async") {
        // Concurrent guardrail rather than a hard refusal: a caller that repeats
        // the request gets the running job back, which is what it needed to know.
        const active = jobStore.findActiveForSession(sessionKey);
        if (active) {
          log.info(`execute: async repeat on ${sessionKey} — returning job ${active.jobId}`);
          return formatJobStatus(active);
        }
        const job = await startDispatch({
          api,
          runtime,
          sessionMgr,
          jobStore,
          sessionKey,
          ...(ctx.deliveryContext ? { deliveryContext: ctx.deliveryContext } : {}),
          ...(agentId ? { agentId } : {}),
          agent: resolvedAgent,
          cwd: resolvedCwd,
          prompt,
          maxOutputChars: config.maxOutputChars,
        });
        return {
          content: [{
            type: "text",
            text:
              `Started job ${job.jobId} on ${agentId ?? resolvedAgent}. Do not call run_coder ` +
              `again for this task — you will be woken when it finishes, and a repeat call ` +
              `only returns this job's status. Report to the user that the work is under way.`,
          }],
          // Recognised by the codex bridge (isAsyncStartedToolResult) as work
          // continuing out of band, so the turn is released instead of waiting
          // on the item/tool/call RPC.
          details: { async: true, status: "started", jobId: job.jobId },
        };
      }

      // A second call on a session whose turn is still running would reach the
      // node-host's handleTurn, which kills the in-flight acpx process before
      // starting the new one. Both calls then fail: the first loses its work,
      // the second inherits the kill's acp.exited and returns ops=0. Refuse
      // instead — the common trigger is a caller retrying after the outer
      // watchdog fired while the remote turn was still progressing.
      if (inFlightSessions.has(sessionKey)) {
        // An async dispatch holds the same marker for its whole background run,
        // so point the caller at that job rather than at timeoutSeconds.
        const active = jobStore.findActiveForSession(sessionKey);
        if (active) {
          log.warn(`execute: sync call rejected — async job ${active.jobId} still running`);
          return formatJobStatus(active);
        }
        log.warn(`execute: rejected — turn already in flight for sessionKey=${sessionKey}`);
        return {
          content: [{
            type: "text",
            text:
              "Error: TURN_IN_FLIGHT — a previous run_coder call on this session is still " +
              "executing on the remote agent. Wait for it to return rather than retrying; " +
              "a retry would kill the in-flight run and discard its work. If the earlier call " +
              "timed out, raise timeoutSeconds (max 600) on the next attempt, or use " +
              "mode=\"async\" which has no time limit.",
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
          ...(signal ? { signal } : {}),
        });
        const result = await collectTurnOutput(events, {
          maxOutputChars: config.maxOutputChars,
          ...(signal ? { signal } : {}),
          onProgress: createProgressReporter({
            sessionKey,
            ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
            agent: resolvedAgent,
            ...(onUpdate ? { onUpdate } : {}),
          }),
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
