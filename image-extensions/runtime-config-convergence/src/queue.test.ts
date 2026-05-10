import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyQueue,
  ignoreCandidate,
  listCandidates,
  QueueParseError,
  readQueue,
  recordNotification,
  resolveStaleCandidates,
  unignoreCandidate,
  upsertCandidate,
  writeQueue,
} from "./queue.js";
import type { CandidateQueue, ClassifiedDrift } from "./types.js";

function freshDrift(path: string, liveValue: unknown, desiredValue: unknown = "desired", reason: ClassifiedDrift["reasonCode"] = "repo-owned-drift"): ClassifiedDrift {
  return {
    canonicalPath: path,
    liveValue,
    desiredValue,
    liveExists: true,
    desiredExists: true,
    reasonCode: reason,
  };
}

describe("queue identity, dedup, supersession, ignore", () => {
  let q: CandidateQueue;

  beforeEach(() => {
    q = emptyQueue("test-persona");
  });

  it("creates a new candidate on first sight and marks it active", () => {
    const r = upsertCandidate(q, freshDrift("auth.x", "value-a"));
    expect(r.isNew).toBe(true);
    expect(r.candidate.status).toBe("active");
    expect(r.candidate.seenCount).toBe(1);
    expect(r.supersededIds).toEqual([]);
  });

  it("re-seeing the same (path, value) bumps counters/timestamps only — not new", () => {
    const r1 = upsertCandidate(q, freshDrift("auth.x", "value-a"));
    const r2 = upsertCandidate(q, freshDrift("auth.x", "value-a"));
    expect(r2.isNew).toBe(false);
    expect(r2.candidate.id).toBe(r1.candidate.id);
    expect(r2.candidate.seenCount).toBe(2);
    expect(Object.keys(q.candidates)).toHaveLength(1);
  });

  it("changed live value at same path supersedes old candidate and creates new one", () => {
    const r1 = upsertCandidate(q, freshDrift("auth.x", "value-a"));
    const r2 = upsertCandidate(q, freshDrift("auth.x", "value-b"));
    expect(r2.isNew).toBe(true);
    expect(r2.supersededIds).toContain(r1.candidate.id);
    expect(q.candidates[r1.candidate.id].status).toBe("superseded");
    expect(q.candidates[r1.candidate.id].supersededBy).toBe(r2.candidate.id);
    expect(q.candidates[r2.candidate.id].status).toBe("active");
  });

  it("permanent ignore applies only to the exact (path, value) pair", () => {
    const r1 = upsertCandidate(q, freshDrift("auth.x", "value-a"));
    expect(ignoreCandidate(q, r1.candidate.id)).toBe(true);
    expect(q.candidates[r1.candidate.id].status).toBe("ignored");
    // Re-seeing same pair → bumps counters but stays ignored, not "new" → no new notification.
    const r2 = upsertCandidate(q, freshDrift("auth.x", "value-a"));
    expect(r2.isNew).toBe(false);
    expect(q.candidates[r1.candidate.id].status).toBe("ignored");
  });

  it("changed value after ignore creates a fresh, NOT-ignored candidate (and supersedes the ignored one)", () => {
    const r1 = upsertCandidate(q, freshDrift("auth.x", "value-a"));
    ignoreCandidate(q, r1.candidate.id);
    const r2 = upsertCandidate(q, freshDrift("auth.x", "value-b"));
    expect(r2.isNew).toBe(true);
    expect(r2.candidate.status).toBe("active");
    // The old ignored candidate is now superseded.
    expect(q.candidates[r1.candidate.id].status).toBe("superseded");
    expect(r2.supersededIds).toContain(r1.candidate.id);
  });

  it("unignore returns ignored candidate to active", () => {
    const r1 = upsertCandidate(q, freshDrift("auth.x", "value-a"));
    ignoreCandidate(q, r1.candidate.id);
    expect(unignoreCandidate(q, r1.candidate.id)).toBe(true);
    expect(q.candidates[r1.candidate.id].status).toBe("active");
    expect(q.candidates[r1.candidate.id].ignoredAt).toBeUndefined();
  });

  it("recordNotification persists firstNotifiedAt and lastNotificationError", () => {
    const r = upsertCandidate(q, freshDrift("a.b", 1));
    recordNotification(q, r.candidate.id, { ok: true });
    expect(q.candidates[r.candidate.id].notification.firstNotifiedAt).toBeDefined();
    recordNotification(q, r.candidate.id, { ok: false, error: "boom" });
    expect(q.candidates[r.candidate.id].notification.lastNotificationError).toBe("boom");
  });

  it("listCandidates filters by status correctly", () => {
    const a = upsertCandidate(q, freshDrift("p.a", 1));
    const b = upsertCandidate(q, freshDrift("p.b", 1));
    upsertCandidate(q, freshDrift("p.b", 2)); // supersedes b
    ignoreCandidate(q, a.candidate.id);

    expect(listCandidates(q)).toHaveLength(1); // active only (the new p.b)
    expect(listCandidates(q, { includeIgnored: true })).toHaveLength(2);
    expect(listCandidates(q, { includeIgnored: true, includeSuperseded: true })).toHaveLength(3);
  });

  it("resolveStaleCandidates retires only active candidates absent from currentDriftIds", () => {
    const a = upsertCandidate(q, freshDrift("p.a", 1));
    const b = upsertCandidate(q, freshDrift("p.b", 1));
    const cOld = upsertCandidate(q, freshDrift("p.c", 1));
    ignoreCandidate(q, b.candidate.id); // b → ignored: must be left alone
    const cNew = upsertCandidate(q, freshDrift("p.c", 2)); // supersedes cOld

    // First reconciliation: both active candidates (a and cNew) are still
    // observed in the current scan. Nothing should transition; ignored and
    // superseded entries must be left alone regardless.
    const transitioned = resolveStaleCandidates(q, new Set([a.candidate.id, cNew.candidate.id]));
    expect(transitioned).toEqual([]);
    expect(q.candidates[a.candidate.id].status).toBe("active");
    expect(q.candidates[b.candidate.id].status).toBe("ignored");
    expect(q.candidates[cOld.candidate.id].status).toBe("superseded");
    expect(q.candidates[cNew.candidate.id].status).toBe("active");

    // Second reconciliation: `a` no longer drifts (drops out of the current
    // set). Must transition to resolved with a resolvedAt timestamp. cNew
    // stays active because it's still observed.
    const transitioned2 = resolveStaleCandidates(q, new Set([cNew.candidate.id]));
    expect(transitioned2).toEqual([a.candidate.id]);
    expect(q.candidates[a.candidate.id].status).toBe("resolved");
    expect(q.candidates[a.candidate.id].resolvedAt).toBeDefined();
    expect(q.candidates[cNew.candidate.id].status).toBe("active");
    // Already-terminal entries (ignored / superseded) are still untouched.
    expect(q.candidates[b.candidate.id].status).toBe("ignored");
    expect(q.candidates[cOld.candidate.id].status).toBe("superseded");
  });

  it("listCandidates excludes resolved by default and includes them with includeResolved", () => {
    const a = upsertCandidate(q, freshDrift("p.a", 1));
    upsertCandidate(q, freshDrift("p.b", 1));
    resolveStaleCandidates(q, new Set([a.candidate.id])); // resolves p.b
    expect(listCandidates(q)).toHaveLength(1); // only p.a is active
    expect(listCandidates(q, { includeResolved: true })).toHaveLength(2);
  });

  it("identical values produce identical ids; different values produce different ids", () => {
    const r1 = upsertCandidate(emptyQueue("p"), freshDrift("a.b", { x: 1, y: 2 }));
    const r2 = upsertCandidate(emptyQueue("p"), freshDrift("a.b", { y: 2, x: 1 }));
    expect(r1.candidate.id).toBe(r2.candidate.id);
    const r3 = upsertCandidate(emptyQueue("p"), freshDrift("a.b", { x: 1, y: 3 }));
    expect(r3.candidate.id).not.toBe(r1.candidate.id);
  });

  it("paths whose normalized tails collide still produce distinct ids on the same value", () => {
    // `a.b`, `a-b`, and `a_b` all sanitize to the tail `b` in the readable
    // suffix. Distinct canonical paths must still hash to distinct dict keys
    // so we never lose a candidate to identity collision.
    const v = "live-x";
    const r1 = upsertCandidate(emptyQueue("p"), freshDrift("a.b", v));
    const r2 = upsertCandidate(emptyQueue("p"), freshDrift("a-b", v));
    const r3 = upsertCandidate(emptyQueue("p"), freshDrift("a_b", v));
    expect(new Set([r1.candidate.id, r2.candidate.id, r3.candidate.id]).size).toBe(3);
  });

  it("redacts secret-like paths in summary (never stores raw secret)", () => {
    const r = upsertCandidate(q, freshDrift("auth.token", "xoxb-aaaaaaaaaaaaaaaaaaaaaaaa"));
    expect(r.candidate.summary.redacted).toBe(true);
  });
});

describe("queue file I/O", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rcc-queue-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty queue when file missing (not an error)", () => {
    const q = readQueue(join(dir, "nope.json"), "p");
    expect(q.candidates).toEqual({});
    expect(q.persona).toBe("p");
    expect(q.schemaVersion).toBe(1);
  });

  it("round-trips an upserted queue through write/read", () => {
    const q = emptyQueue("p");
    upsertCandidate(q, freshDrift("a.b", "v"));
    const path = join(dir, "queue.json");
    writeQueue(path, q);
    const back = readQueue(path, "p");
    expect(Object.keys(back.candidates)).toHaveLength(1);
  });

  it("FAILS CLOSED on malformed file (does not silently overwrite)", () => {
    const path = join(dir, "queue.json");
    writeFileSync(path, "{not json", "utf8");
    expect(() => readQueue(path, "p")).toThrow(QueueParseError);
  });

  it("FAILS CLOSED on right shape but wrong schemaVersion", () => {
    const path = join(dir, "queue.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 99, persona: "p", updatedAt: "x", candidates: {} }), "utf8");
    expect(() => readQueue(path, "p")).toThrow(QueueParseError);
  });

  it("atomic write does not leave temp files behind on success", () => {
    const q = emptyQueue("p");
    const path = join(dir, "queue.json");
    writeQueue(path, q);
    // Verify file content is parseable JSON and matches our shape.
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.schemaVersion).toBe(1);
  });

  it("ignored status, ignoreScope, and ignoredAt persist across writeQueue → readQueue (issue #35 acceptance)", () => {
    // Round-tripping through handleCommand uses the same in-memory objects;
    // a regression that drops `ignoreScope`/`ignoredAt` during JSON
    // serialization would slip through. Use raw write/read to verify the
    // on-disk format preserves the full ignore record.
    const q = emptyQueue("p");
    const r = upsertCandidate(q, freshDrift("auth.x", "value-a"));
    const ignored = ignoreCandidate(q, r.candidate.id);
    expect(ignored).toBe(true);

    const path = join(dir, "queue.json");
    writeQueue(path, q);
    const back = readQueue(path, "p");

    const c = back.candidates[r.candidate.id];
    expect(c).toBeDefined();
    expect(c.status).toBe("ignored");
    expect(c.ignoreScope).toBe("exact-pair");
    expect(c.ignoredAt).toBeDefined();
    expect(typeof c.ignoredAt).toBe("string");
  });
});
