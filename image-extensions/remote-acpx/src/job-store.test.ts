// Tests for the async dispatch job store, focused on restart reconciliation:
// a record that says "running" is only trustworthy if this process is the one
// draining its event stream.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createJobStore, INSTANCE_ID } = await import("./job-store.js");
type DispatchJob = Awaited<ReturnType<ReturnType<typeof createJobStore>["get"]>>;

function fakeApi(): { api: OpenClawPluginApi; openCount: () => number } {
  const entries = new Map<string, unknown>();
  let opens = 0;
  const api = {
    runtime: {
      state: {
        openKeyedStore: () => {
          opens += 1;
          return {
            register: async (k: string, v: unknown) => void entries.set(k, v),
            lookup: async (k: string) => entries.get(k),
            entries: async () =>
              [...entries].map(([key, value]) => ({ key, value, createdAt: 0 })),
          };
        },
      },
    },
  } as unknown as OpenClawPluginApi;
  return { api, openCount: () => opens };
}

const runningJob = (over: Record<string, unknown> = {}) => ({
  jobId: "rc-abc",
  sessionKey: "s1",
  agent: "claude",
  cwd: "/app",
  status: "running",
  startedAt: Date.now() - 1000,
  ownerInstanceId: INSTANCE_ID,
  ...over,
}) as NonNullable<DispatchJob>;

describe("job store", () => {
  let store: ReturnType<typeof createJobStore>;
  let openCount: () => number;

  beforeEach(() => {
    const f = fakeApi();
    store = createJobStore(f.api);
    openCount = f.openCount;
  });

  it("does not touch the state runtime until a job is actually used", () => {
    // Registration happens on every agent turn; most never dispatch.
    expect(openCount()).toBe(0);
  });

  it("round-trips a job owned by this process", async () => {
    await store.put(runningJob());
    const got = await store.get("rc-abc");
    expect(got?.status).toBe("running");
  });

  it("finalises a job left running by a previous gateway instance as lost", async () => {
    await store.put(runningJob({ ownerInstanceId: "1-999999" }));

    const got = await store.get("rc-abc");

    expect(got?.status).toBe("lost");
    expect(got?.result?.error).toContain("gateway restarted");
    expect(got?.endedAt).toBeDefined();
  });

  it("persists the lost verdict so it is not re-derived on every read", async () => {
    await store.put(runningJob({ ownerInstanceId: "1-999999" }));
    await store.get("rc-abc");

    // Second read sees a record that is already terminal, not a running one.
    const again = await store.get("rc-abc");
    expect(again?.status).toBe("lost");
  });

  it("leaves an already-terminal job alone regardless of owner", async () => {
    await store.put(runningJob({
      ownerInstanceId: "1-999999",
      status: "succeeded",
      endedAt: Date.now(),
      result: { status: "success", message: "done", operationCount: 3 },
    }));

    const got = await store.get("rc-abc");
    expect(got?.status).toBe("succeeded");
    expect(got?.result?.message).toBe("done");
  });

  it("finds the active job for a session", async () => {
    await store.put(runningJob({ jobId: "rc-1", sessionKey: "s1" }));
    await store.put(runningJob({ jobId: "rc-2", sessionKey: "s2" }));

    expect((await store.findActiveForSession("s2"))?.jobId).toBe("rc-2");
    expect(await store.findActiveForSession("s3")).toBeUndefined();
  });

  it("does not report an orphaned job as active — it would block the session forever", async () => {
    await store.put(runningJob({ sessionKey: "s1", ownerInstanceId: "1-999999" }));

    expect(await store.findActiveForSession("s1")).toBeUndefined();
  });

  it("ignores finished jobs when looking for an active one", async () => {
    await store.put(runningJob({
      sessionKey: "s1",
      status: "succeeded",
      endedAt: Date.now(),
    }));

    expect(await store.findActiveForSession("s1")).toBeUndefined();
  });
});
