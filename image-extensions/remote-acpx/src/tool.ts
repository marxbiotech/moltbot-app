// Tool registration for run_coder — the LLM-invocable coding task dispatch tool.
// Uses a tool factory to access sessionKey from OpenClawPluginToolContext.
// Must be called during plugin register() phase (not service start()) so the
// tool appears in the agent's tool catalog. Runtime and config are resolved
// lazily via getters since the service hasn't started yet at registration time.

import { Type } from "typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { RemoteAcpxRuntime } from "./runtime.js";
import { SessionManager } from "./session-manager.js";
import type { ProgressSnapshot } from "./output-collector.js";
import { resolveAgentById } from "./agent-roster.js";
import { createJobStore, type DispatchJob } from "./job-store.js";
import { startDispatch } from "./dispatcher.js";
import { log } from "./log.js";

export type CodingToolConfig = {
  defaultAgent: string;
  maxOutputChars: number;
};

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
      // No mode or timeoutSeconds parameter by design. Every dispatch runs in
      // the background and wakes the caller. `timeoutSeconds` existed only to
      // buy headroom against the codex 90s per-tool-call watchdog (4d3fe88,
      // before async dispatch existed) and asked the model to predict a
      // duration it has no way to know — the observed spread is 23s to 1800s
      // with a 373s median, so a guess is wrong far more often than right, and
      // being wrong discarded the whole turn's work. A synchronous mode has the
      // same defect in weaker form, so there is no way to ask for one.
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
    async execute(_toolCallId, params) {
      const runtime = deps.getRuntime();
      const config = deps.getConfig();

      if (!runtime) {
        return {
          content: [{ type: "text", text: "Error: Remote-acpx service not started yet. Try again in a moment." }],
        };
      }

      const { prompt, agentId, cwd, agent, action, jobId } = params as {
        prompt: string; agentId?: string; cwd?: string; agent?: string;
        action?: string; jobId?: string;
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

      // Every dispatch runs in the background. The synchronous path was
      // removed with the mode/timeoutSeconds parameters: it required the caller
      // to predict a duration, and losing that bet threw away a turn's work.
      // Node availability is still checked here so an offline node fails in
      // this turn with an actionable message, rather than costing a job record
      // and a wake to say the same thing.
      if (!runtime.isHealthy()) {
        log.warn(`execute: no usable node for sessionKey=${sessionKey}`);
        return {
          content: [{
            type: "text",
            text:
              "Error: ACP_BACKEND_UNAVAILABLE — no coding node is connected, so the task " +
              "was not started. Start one with `make node` in the overlay directory, then " +
              "retry. Tell the user the node is offline rather than reporting work as under way.",
          }],
        };
      }

      // Concurrent guardrail rather than a hard refusal: a caller that repeats
      // the request gets the running job back, which is what it needed to know.
      // This also replaces the old TURN_IN_FLIGHT rejection — with no sync path
      // there is no longer a second way to collide with a live turn.
      const active = jobStore.findActiveForSession(sessionKey);
      if (active) {
        log.info(`execute: repeat dispatch on ${sessionKey} — returning job ${active.jobId}`);
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
    },
  }));

  // Start prune interval after registration (uses lazy runtime getter)
  sessionMgr.resetPruneInterval(() => {
    const runtime = deps.getRuntime();
    if (runtime) sessionMgr.pruneStale(runtime);
  });
}
