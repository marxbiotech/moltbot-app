// In-process record of an async run_coder dispatch.
//
// An async dispatch outlives the tool call that started it, so its result has
// to live somewhere the next tool call can read. That store is deliberately
// in-memory rather than durable.
//
// The obvious alternative, runtime.state.openKeyedStore, is gated:
//
//   if (record?.origin !== "bundled" && record?.trustedOfficialInstall !== true)
//     throw new Error("openKeyedStore is only available for trusted plugins…")
//
// and remote-acpx is a config-origin extension loaded from plugins.load.paths,
// so it qualifies as neither. Writing our own file under resolveStateDir() would
// route around that, but durability buys almost nothing here: the turn behind a
// job is an in-memory ACP event stream, so a gateway restart kills the work
// whatever the record says. Surviving the restart would only change the message
// from "no such job" to "job lost" — same conclusion for the caller, re-run —
// in exchange for hand-rolled TTL and pruning.
//
// Shared via Symbol.for for the same reason as the in-flight set: jiti can load
// a module more than once, and a module-local Map would give each copy its own
// empty view.

import type { CollectedResult } from "./output-collector.js";

export type JobStatus = "running" | "succeeded" | "failed";

export type DispatchJob = {
  jobId: string;
  sessionKey: string;
  agentId?: string;
  agent: string;
  cwd: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  /** Latest progress snapshot, refreshed on the reporter's cadence. */
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

// Long enough that a finished job is still readable when someone asks about it
// later in the conversation, short enough that abandoned records do not
// accumulate for the life of the process.
const JOB_TTL_MS = 6 * 60 * 60 * 1000;

const STATE_KEY = Symbol.for("remote-acpx.dispatchJobs");
const globalRef = globalThis as unknown as Record<symbol, Map<string, DispatchJob>>;
if (!globalRef[STATE_KEY]) {
  globalRef[STATE_KEY] = new Map<string, DispatchJob>();
}
const jobs = globalRef[STATE_KEY];

export type JobStore = {
  put: (job: DispatchJob) => void;
  get: (jobId: string) => DispatchJob | undefined;
  /** Active job for a session, if any — backs the concurrent guardrail. */
  findActiveForSession: (sessionKey: string) => DispatchJob | undefined;
};

/** Drops terminal jobs past their TTL. Running jobs are never pruned — the
 * background turn still holds a reference and will finalise them. */
function pruneExpired(now: number): void {
  for (const [jobId, job] of jobs) {
    if (job.status !== "running" && now - (job.endedAt ?? job.startedAt) > JOB_TTL_MS) {
      jobs.delete(jobId);
    }
  }
}

export function createJobStore(): JobStore {
  return {
    put(job) {
      pruneExpired(Date.now());
      jobs.set(job.jobId, job);
    },
    get(jobId) {
      return jobs.get(jobId);
    },
    findActiveForSession(sessionKey) {
      for (const job of jobs.values()) {
        if (job.status === "running" && job.sessionKey === sessionKey) {
          return job;
        }
      }
      return undefined;
    },
  };
}

/** Test seam — the module-level map is shared by Symbol.for, so suites that
 * create jobs must reset it between cases. */
export function resetJobStoreForTest(): void {
  jobs.clear();
}
