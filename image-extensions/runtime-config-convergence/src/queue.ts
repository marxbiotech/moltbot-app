// Candidate queue read/write + identity/dedup/supersession/ignore logic.
//
// On-disk format: a single JSON file at the resolved queue path. Atomic
// writes via temp + rename. Failure modes:
//   - Missing file → initialize a fresh empty queue.
//   - Malformed file → throw QueueParseError. Callers (commands/detector) must
//     surface this to the operator and refuse to overwrite silently.
//
// Identity rules per issue #35 §3:
//   - Key by `(canonicalPath, liveValueHash)`.
//   - Re-seeing the same pair: bump seenCount + lastSeenAt; refresh
//     reasonCode and desiredValueHash from the latest scan (these can change
//     if the desired side or ownership policy was edited).
//   - New (canonicalPath, *different* liveValueHash): create a new candidate;
//     mark all prior `active`/`ignored` candidates for the same path as
//     `superseded` and link via `supersededBy`.
//   - Permanent ignore applies only to the exact pair. If the live value
//     later changes, the prior ignored candidate is *superseded* and a fresh
//     active candidate is created; "unignored" status is reserved for the
//     explicit `unignoreCandidate` operation.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  CandidateQueue,
  ClassifiedDrift,
  DriftCandidate,
  Mutable,
} from "./types.js";
import { hashValue } from "./canonical-json.js";
import { buildCandidateId } from "./paths.js";
import { summarizeValue } from "./redact.js";

export class QueueParseError extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`Queue file at ${path} is malformed: ${msg}`);
    this.name = "QueueParseError";
    this.path = path;
  }
}

export function emptyQueue(persona: string): CandidateQueue {
  return {
    schemaVersion: 1,
    persona,
    updatedAt: new Date().toISOString(),
    candidates: {},
  };
}

function isQueueShape(value: unknown): value is CandidateQueue {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === 1
    && typeof v.persona === "string"
    && typeof v.updatedAt === "string"
    && v.candidates !== null
    && typeof v.candidates === "object"
    && !Array.isArray(v.candidates)
  );
}

export function readQueue(queuePath: string, persona: string): CandidateQueue {
  if (!existsSync(queuePath)) {
    return emptyQueue(persona);
  }
  let raw: string;
  try {
    raw = readFileSync(queuePath, "utf8");
  } catch (e: unknown) {
    throw new QueueParseError(queuePath, e);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    throw new QueueParseError(queuePath, e);
  }
  if (!isQueueShape(parsed)) {
    throw new QueueParseError(queuePath, new Error("not a valid CandidateQueue"));
  }
  return parsed;
}

/**
 * Atomic write: write to a sibling temp file, fsync, then rename over the
 * target. On rename failure the temp file is cleaned up.
 */
export function writeQueue(queuePath: string, queue: CandidateQueue): void {
  mkdirSync(dirname(queuePath), { recursive: true });
  queue.updatedAt = new Date().toISOString();
  const json = `${JSON.stringify(queue, null, 2)}\n`;
  const tmp = join(dirname(queuePath), `.${Date.now()}.${process.pid}.queue.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "w", 0o600);
    writeSync(fd, json);
    fsyncSync(fd);
  } catch (e) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
    try { unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
  try { closeSync(fd); } catch { /* best-effort */ }
  try {
    renameSync(tmp, queuePath);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
}

/**
 * Result of an upsert operation, returned to the caller so it can decide
 * whether to send a notification.
 */
export interface UpsertResult {
  candidate: DriftCandidate;
  isNew: boolean;
  /** Ids of candidates that were superseded by this upsert. */
  supersededIds: string[];
}

/**
 * Insert a fresh classified drift entry into the queue, applying identity,
 * dedup, supersession, and ignore-preservation rules.
 */
export function upsertCandidate(
  queue: CandidateQueue,
  drift: ClassifiedDrift,
  now: () => Date = () => new Date(),
): UpsertResult {
  const liveValueHash = hashValue(drift.liveValue);
  const desiredValueHash = drift.desiredExists ? hashValue(drift.desiredValue) : undefined;
  const id = buildCandidateId(drift.canonicalPath, liveValueHash);
  const existing = queue.candidates[id];
  const nowIso = now().toISOString();

  if (existing) {
    // Same pair → bump counters/timestamps only. Status (incl. ignored) preserved.
    existing.lastSeenAt = nowIso;
    existing.seenCount += 1;
    existing.reasonCode = drift.reasonCode;
    if (desiredValueHash !== undefined) existing.desiredValueHash = desiredValueHash;
    return { candidate: existing, isNew: false, supersededIds: [] };
  }

  // New candidate for this pair. Supersede other active/ignored candidates
  // that share the same canonicalPath but different liveValueHash.
  const supersededIds: string[] = [];
  for (const [otherId, other] of Object.entries(queue.candidates)) {
    if (otherId === id) continue;
    if (other.canonicalPath !== drift.canonicalPath) continue;
    if (other.status === "superseded") continue;
    const m = other as Mutable<DriftCandidate>;
    m.status = "superseded";
    m.supersededBy = id;
    supersededIds.push(otherId);
  }

  const summary = summarizeValue(drift.canonicalPath, drift.liveValue);
  const fresh: DriftCandidate = {
    id,
    canonicalPath: drift.canonicalPath,
    liveValueHash,
    desiredValueHash,
    reasonCode: drift.reasonCode,
    status: "active",
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    seenCount: 1,
    notification: {},
    summary: { valueKind: summary.valueKind, redacted: summary.redacted },
  };
  queue.candidates[id] = fresh;
  return { candidate: fresh, isNew: true, supersededIds };
}

/** Permanently ignore the exact pair represented by `id`. Returns true if applied. */
export function ignoreCandidate(queue: CandidateQueue, id: string, now: () => Date = () => new Date()): boolean {
  const c = queue.candidates[id];
  if (!c) return false;
  if (c.status === "superseded") return false;
  const m = c as Mutable<DriftCandidate>;
  m.status = "ignored";
  m.ignoreScope = "exact-pair";
  m.ignoredAt = now().toISOString();
  return true;
}

/** Move an ignored candidate back to active. */
export function unignoreCandidate(queue: CandidateQueue, id: string): boolean {
  const c = queue.candidates[id];
  if (!c) return false;
  if (c.status !== "ignored") return false;
  const m = c as Mutable<DriftCandidate>;
  m.status = "active";
  m.ignoreScope = undefined;
  m.ignoredAt = undefined;
  return true;
}

/**
 * Reconcile active candidates against the current scan's drift set: any
 * active candidate whose `(canonicalPath, liveValueHash)` id is no longer
 * present in `currentDriftIds` has had its drift resolved (live now matches
 * desired, or live changed in a way that no longer produces a diff entry —
 * e.g. the desired side caught up).
 *
 * Marked candidates move to the terminal `resolved` status with a
 * `resolvedAt` timestamp. We deliberately do not delete them: keeping the
 * record preserves audit history (firstSeenAt → resolvedAt duration, total
 * seenCount, and any notification trail). Default `listCandidates` /
 * `countByStatus` callers filter resolved out so `/config-drift list` and
 * the `active` ScanResult counter no longer surface stale entries.
 *
 * Only operates on `active` — `ignored` stays ignored (the operator's choice
 * persists), `superseded` stays superseded (it has a successor), `resolved`
 * is already terminal.
 *
 * Returns the ids that were transitioned, suitable for logging/test
 * assertions.
 */
export function resolveStaleCandidates(
  queue: CandidateQueue,
  currentDriftIds: ReadonlySet<string>,
  now: () => Date = () => new Date(),
): string[] {
  const transitioned: string[] = [];
  const nowIso = now().toISOString();
  for (const [id, c] of Object.entries(queue.candidates)) {
    if (c.status !== "active") continue;
    if (currentDriftIds.has(id)) continue;
    const m = c as Mutable<DriftCandidate>;
    m.status = "resolved";
    m.resolvedAt = nowIso;
    transitioned.push(id);
  }
  return transitioned;
}

/** Record notification success/failure for telemetry. */
export function recordNotification(
  queue: CandidateQueue,
  id: string,
  result: { ok: true } | { ok: false; error: string },
  now: () => Date = () => new Date(),
): void {
  const c = queue.candidates[id];
  if (!c) return;
  if (result.ok) {
    c.notification.firstNotifiedAt ??= now().toISOString();
    c.notification.lastNotificationError = undefined;
  } else {
    c.notification.lastNotificationError = result.error;
  }
}

export function listCandidates(
  queue: CandidateQueue,
  opts: { includeIgnored?: boolean; includeSuperseded?: boolean; includeResolved?: boolean } = {},
): DriftCandidate[] {
  const out: DriftCandidate[] = [];
  for (const c of Object.values(queue.candidates)) {
    if (c.status === "ignored" && !opts.includeIgnored) continue;
    if (c.status === "superseded" && !opts.includeSuperseded) continue;
    if (c.status === "resolved" && !opts.includeResolved) continue;
    out.push(c);
  }
  return out.sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath));
}
