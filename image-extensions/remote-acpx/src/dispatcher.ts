// Background execution for async run_coder dispatches.
//
// The synchronous path is bounded by the Codex app-server's item/tool/call RPC
// deadline (600s), because the tool call cannot answer until the turn is done.
// Here the tool answers immediately with an async-started result and the turn
// keeps running out of band, so that deadline never applies. Completion is
// pushed back through the same session-queued path the runtime uses for its own
// background work: enqueue a system event, then wake the heartbeat.

import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { RemoteAcpxRuntime } from "./runtime.js";
import type { SessionManager } from "./session-manager.js";
import { collectTurnOutput, type ProgressSnapshot } from "./output-collector.js";
import { type DispatchJob, type JobStore, INSTANCE_ID } from "./job-store.js";
import { inFlightSessions } from "./in-flight.js";
import { log } from "./log.js";

// Matches the synchronous reporter's cadence. Each tick is a state-store write,
// so it is deliberately coarser than the ~1e3 events a turn produces.
const JOB_PROGRESS_INTERVAL_MS = 5_000;

export type StartDispatchParams = {
  api: OpenClawPluginApi;
  runtime: RemoteAcpxRuntime;
  sessionMgr: SessionManager;
  jobStore: JobStore;
  sessionKey: string;
  deliveryContext?: unknown;
  agentId?: string;
  agent: string;
  cwd: string;
  prompt: string;
  maxOutputChars: number;
};

function summariseForNotice(job: DispatchJob): string {
  const who = job.agentId ? `agentId=${job.agentId}` : `agent=${job.agent}`;
  if (job.status === "succeeded") {
    return (
      `run_coder job ${job.jobId} (${who}) finished successfully after ` +
      `${Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000)}s with ` +
      `${job.result?.operationCount ?? 0} operation(s). Call run_coder with ` +
      `action="status" and jobId="${job.jobId}" to read the full result, then report it.`
    );
  }
  return (
    `run_coder job ${job.jobId} (${who}) ended as ${job.status}: ` +
    `${job.result?.error ?? "unknown error"}. Call run_coder with action="status" and ` +
    `jobId="${job.jobId}" for detail before deciding whether to retry.`
  );
}

/**
 * Creates the job record, starts the turn in the background, and returns the
 * record without waiting for it. The returned promise resolves as soon as the
 * job is registered — never when the dispatch completes.
 */
export async function startDispatch(params: StartDispatchParams): Promise<DispatchJob> {
  const jobId = `rc-${randomUUID().slice(0, 8)}`;
  const job: DispatchJob = {
    jobId,
    sessionKey: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    agent: params.agent,
    cwd: params.cwd,
    status: "running",
    startedAt: Date.now(),
    ownerInstanceId: INSTANCE_ID,
  };
  await params.jobStore.put(job);

  // Held for the whole background turn, not just the tool call. Without it the
  // session-manager idle sweeper would reclaim a session that is dispatching —
  // which is exactly the case the TTL guard exists for.
  inFlightSessions.add(params.sessionKey);

  void runInBackground(params, job).catch((err) => {
    // runInBackground already funnels failures into the job record; this is the
    // last resort so a bug there cannot surface as an unhandled rejection.
    log.error(
      `dispatch ${jobId}: background runner threw — ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  return job;
}

async function runInBackground(params: StartDispatchParams, job: DispatchJob): Promise<void> {
  let current = job;
  let lastProgressAt = 0;

  const onProgress = (snapshot: ProgressSnapshot): void => {
    const now = Date.now();
    if (now - lastProgressAt < JOB_PROGRESS_INTERVAL_MS) {
      return;
    }
    lastProgressAt = now;
    current = {
      ...current,
      progress: {
        operationCount: snapshot.operationCount,
        ...(snapshot.latest ? { latest: snapshot.latest.tool } : {}),
        at: now,
      },
    };
    log.info(
      `dispatch ${job.jobId}: progress ops=${snapshot.operationCount} ` +
        `latest=${snapshot.latest?.tool ?? "-"}`,
    );
    void params.jobStore.put(current).catch((err) => {
      log.warn(
        `dispatch ${job.jobId}: progress write failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };

  try {
    log.info(
      `dispatch ${job.jobId}: start sessionKey=${params.sessionKey} agent=${params.agent} cwd=${params.cwd}`,
    );
    const handle = await params.sessionMgr.getOrCreate(params.sessionKey, params.runtime, {
      agent: params.agent,
      cwd: params.cwd,
    });
    const events = params.runtime.runTurn({
      handle,
      text: params.prompt,
      mode: "prompt",
      requestId: randomUUID(),
    });
    const result = await collectTurnOutput(events, {
      maxOutputChars: params.maxOutputChars,
      onProgress,
    });

    if (result.status === "error") {
      params.sessionMgr.invalidate(params.sessionKey);
    }

    current = {
      ...current,
      status: result.status === "error" ? "failed" : "succeeded",
      endedAt: Date.now(),
      result: {
        status: result.status,
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
        ...(result.error ? { error: result.error } : {}),
        message: result.message,
        operationCount: result.operationCount,
      },
    };
    log.info(
      `dispatch ${job.jobId}: done status=${current.status} ops=${result.operationCount} ` +
        `msgLen=${result.message.length}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    params.sessionMgr.invalidate(params.sessionKey);
    current = {
      ...current,
      status: "failed",
      endedAt: Date.now(),
      result: { status: "error", error: message, message: "", operationCount: 0 },
    };
    log.error(`dispatch ${job.jobId}: failed — ${message}`);
  } finally {
    inFlightSessions.delete(params.sessionKey);
  }

  await params.jobStore.put(current);
  notifyRequester(params, current);
}

/**
 * Session-queued delivery: the event lands in the requester's session and the
 * heartbeat wake makes it surface immediately rather than on the next tick.
 * Delivery failures are logged, never thrown — the result is already durable in
 * the job store, so a missed wake degrades to "the model has to ask" rather
 * than losing the work.
 */
function notifyRequester(params: StartDispatchParams, job: DispatchJob): void {
  try {
    const enqueued = params.api.runtime.system.enqueueSystemEvent(summariseForNotice(job), {
      sessionKey: params.sessionKey,
      ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
    } as Parameters<typeof params.api.runtime.system.enqueueSystemEvent>[1]);
    if (!enqueued) {
      log.warn(`dispatch ${job.jobId}: system event not enqueued for ${params.sessionKey}`);
    }
    params.api.runtime.system.requestHeartbeat({
      source: "background-task",
      intent: "event",
      reason: `remote-acpx dispatch ${job.jobId} ${job.status}`,
      sessionKey: params.sessionKey,
    });
    log.info(`dispatch ${job.jobId}: requester notified (${params.sessionKey})`);
  } catch (err) {
    log.error(
      `dispatch ${job.jobId}: notify failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
