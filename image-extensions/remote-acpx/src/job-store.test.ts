// Tests for the async dispatch job store: lookup, the per-session active-job
// query that backs the concurrent guardrail, and TTL pruning.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { createJobStore, resetJobStoreForTest } = await import("./job-store.js");
type Store = ReturnType<typeof createJobStore>;
type Job = Parameters<Store["put"]>[0];

const JOB_TTL_MS = 6 * 60 * 60 * 1000;

const job = (over: Partial<Job> = {}): Job => ({
  jobId: "rc-abc",
  sessionKey: "s1",
  agent: "claude",
  cwd: "/app",
  status: "running",
  startedAt: Date.now(),
  ...over,
});

describe("job store", () => {
  let store: Store;

  beforeEach(() => {
    resetJobStoreForTest();
    store = createJobStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetJobStoreForTest();
  });

  it("round-trips a job", () => {
    store.put(job());
    expect(store.get("rc-abc")?.status).toBe("running");
  });

  it("returns undefined for an id it never saw", () => {
    expect(store.get("rc-nope")).toBeUndefined();
  });

  it("shares state across separate createJobStore calls", () => {
    // jiti can load the module more than once; the Symbol.for map is what keeps
    // a status lookup from missing a job started by another copy.
    store.put(job());
    expect(createJobStore().get("rc-abc")?.jobId).toBe("rc-abc");
  });

  it("finds the active job for a session", () => {
    store.put(job({ jobId: "rc-1", sessionKey: "s1" }));
    store.put(job({ jobId: "rc-2", sessionKey: "s2" }));

    expect(store.findActiveForSession("s2")?.jobId).toBe("rc-2");
    expect(store.findActiveForSession("s3")).toBeUndefined();
  });

  it("ignores finished jobs when looking for an active one", () => {
    // Otherwise a completed dispatch would block its session's guardrail and
    // every later async call would be answered with a stale record.
    store.put(job({ status: "succeeded", endedAt: Date.now() }));
    expect(store.findActiveForSession("s1")).toBeUndefined();
  });

  it("prunes a terminal job once it is past the TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    store.put(job({ status: "succeeded", endedAt: Date.now() }));

    vi.advanceTimersByTime(JOB_TTL_MS + 1);
    store.put(job({ jobId: "rc-new" }));

    expect(store.get("rc-abc")).toBeUndefined();
    expect(store.get("rc-new")).toBeDefined();
  });

  it("never prunes a running job, however long it has run", () => {
    // The background turn still holds a reference and will finalise it; dropping
    // the record would strand the dispatch with nowhere to report.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    store.put(job());

    vi.advanceTimersByTime(JOB_TTL_MS * 3);
    store.put(job({ jobId: "rc-new" }));

    expect(store.get("rc-abc")?.status).toBe("running");
  });

  it("keeps a terminal job readable inside the TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    store.put(job({ status: "succeeded", endedAt: Date.now() }));

    vi.advanceTimersByTime(JOB_TTL_MS - 60_000);
    store.put(job({ jobId: "rc-new" }));

    expect(store.get("rc-abc")?.status).toBe("succeeded");
  });
});
