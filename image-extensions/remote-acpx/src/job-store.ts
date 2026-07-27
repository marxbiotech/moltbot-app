// Durable record of an async run_coder dispatch.
//
// A dispatch outlives the tool call that started it, so its result has to
// survive somewhere the next tool call can read. The plugin state store is
// keyed, TTL'd and backed by the state dir, which means a job also survives a
// gateway restart — the record does, at least. The turn behind it does not:
// the ACP event stream lives in memory, so a restart orphans the remote side
// and the job is finalised as `lost` on the next lookup rather than hanging.

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { CollectedResult } from "./output-collector.js";
import { log } from "./log.js";

export type JobStatus = "running" | "succeeded" | "failed" | "lost";

export type DispatchJob = {
  jobId: string;
  sessionKey: string;
  agentId?: string;
  agent: string;
  cwd: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  /** Instance that owns the in-memory turn. A record whose owner is not the
   * current process was orphaned by a restart. */
  ownerInstanceId: string;
  /** Latest progress snapshot, refreshed on the same cadence as the reporter. */
  progress?: {
    operationCount: number;
    latest?: string;
    at: number;
  };
  result?: {
    status: CollectedResult["status"];
    stopReason?: string;
    error?: string;
    message: string;
    operationCount: number;
  };
};

// A dispatch that has not been read within this window is almost certainly
// abandoned — the requester session moved on. Long enough to outlast any
// plausible turn plus the operator noticing.
const JOB_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_JOBS = 200;

/**
 * Identifies this gateway process. A job whose `ownerInstanceId` differs was
 * started by a previous process, so nothing is draining its event stream any
 * more however healthy the stored record looks.
 */
export const INSTANCE_ID = `${process.pid}-${Math.trunc(performance.timeOrigin)}`;

export type JobStore = {
  put: (job: DispatchJob) => Promise<void>;
  get: (jobId: string) => Promise<DispatchJob | undefined>;
  /** Active job for a session, if any — backs the concurrent guardrail. */
  findActiveForSession: (sessionKey: string) => Promise<DispatchJob | undefined>;
};

export function createJobStore(api: OpenClawPluginApi): JobStore {
  // Opened on first use rather than at registration. Registration runs for every
  // agent turn whether or not a dispatch happens, and most turns never touch a
  // job — so this keeps tool registration free of I/O setup, and keeps the
  // plugin registrable in contexts that do not expose the state runtime.
  let opened: ReturnType<typeof api.runtime.state.openKeyedStore<DispatchJob>> | undefined;
  const store = () => {
    opened ??= api.runtime.state.openKeyedStore<DispatchJob>({
      namespace: "remote-acpx.dispatch-jobs",
      maxEntries: MAX_JOBS,
      defaultTtlMs: JOB_TTL_MS,
    });
    return opened;
  };

  /**
   * Rewrites a record whose owner process is gone. Without this an orphaned job
   * reads as `running` for its whole TTL and the guardrail would refuse every
   * later dispatch on that session.
   */
  const reconcile = (job: DispatchJob | undefined): DispatchJob | undefined => {
    if (!job || job.status !== "running" || job.ownerInstanceId === INSTANCE_ID) {
      return job;
    }
    log.warn(
      `job ${job.jobId} was owned by a previous gateway instance — marking lost`,
    );
    return {
      ...job,
      status: "lost",
      endedAt: Date.now(),
      result: {
        status: "error",
        error:
          "The gateway restarted while this dispatch was running. The remote agent was left " +
          "unattended and its result is not recoverable — re-run the task.",
        message: "",
        operationCount: job.progress?.operationCount ?? 0,
      },
    };
  };

  return {
    async put(job) {
      await store().register(job.jobId, job);
    },
    async get(jobId) {
      const reconciled = reconcile(await store().lookup(jobId));
      if (reconciled?.status === "lost") {
        await store().register(reconciled.jobId, reconciled);
      }
      return reconciled;
    },
    async findActiveForSession(sessionKey) {
      for (const entry of await store().entries()) {
        const job = reconcile(entry.value);
        if (job && job.status === "running" && job.sessionKey === sessionKey) {
          return job;
        }
      }
      return undefined;
    },
  };
}
