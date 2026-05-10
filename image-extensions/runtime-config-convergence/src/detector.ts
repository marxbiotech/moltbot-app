// Detector orchestrator.
//
// Surface-aware design per issue #35 §5: the detector takes its inputs
// (live config, desired config, ownership policy) as injected dependencies so
// the same core function works from a service tick (uses captured
// `api.runtime.config.current()`), a command (uses `ctx.config`), or an HTTP
// route handler (uses captured `api.runtime`).
//
// Read-only with respect to live config — never calls `mutateConfigFile` or
// `replaceConfigFile`.
//
// Concurrency: runScan is NOT internally serialized. Callers that wire
// multiple scan entrypoints (service tick + command + HTTP route) must wrap
// it in a per-instance mutex to avoid the read-classify-notify-write race.
// See `index.ts` for the v1 wrapper.
//
// Notification persistence: the success path is "send → recordNotification
// (in-memory) → writeQueue at end of scan". If `writeQueue` fails after a
// successful send, the candidate's `firstNotifiedAt` mark is lost and the
// next scan will treat the same drift as new and re-send. v1 accepts this
// at-most-twice behavior as a pragmatic tradeoff: PVC write failures are
// rare, the duplicate notification is annoying but not unsafe, and the
// write error is surfaced via `result.errors[]` so the operator can act.

import { existsSync, readFileSync } from "node:fs";
import type {
  CandidateQueue,
  ConvergenceConfig,
  DriftCandidate,
  OwnershipPolicy,
} from "./types.js";
import { diffConfig } from "./diff.js";
import { classifyDiff } from "./classify.js";
import {
  readQueue,
  writeQueue,
  upsertCandidate,
  recordNotification,
  resolveStaleCandidates,
  QueueParseError,
} from "./queue.js";
import {
  buildAdapter,
  formatCandidateNotification,
  type NotificationAdapter,
} from "./notifications.js";

/**
 * Sentinel error thrown by `makeLoadLiveConfig` when the explicit
 * `liveConfigPath` is configured but the file cannot be read or parsed.
 * `runScan` recognises this and skips the diff stage to avoid producing a
 * flood of false-positive "missing live" candidates from `live === undefined`
 * vs a populated desired tree.
 */
export class LiveConfigReadError extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to read explicit liveConfigPath ${path}: ${causeMsg}`);
    this.name = "LiveConfigReadError";
    this.path = path;
  }
}

export interface DetectorDeps {
  /** Path where the queue file lives (resolved at register time). */
  queuePath: string;
  /** Persona detected at register time. */
  persona: string;
  /** Plugin config snapshot. */
  config: ConvergenceConfig;
  /** Optional logger; defaults to console. */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  /**
   * Per-call live config provider — different per surface:
   *   - service tick → `() => api.runtime.config.current()`
   *   - command      → `() => ctx.config`
   *   - HTTP route   → `() => api.runtime.config.current()` (closure)
   *   - explicit file (`config.liveConfigPath`) → reads file
   */
  loadLiveConfig: () => unknown;
  /** Notification adapter; defaults to one built from `config.notification`. */
  adapter?: NotificationAdapter;
}

/** Result of a single scan, suitable for chat/HTTP responses. */
export interface ScanResult {
  active: number;
  ignored: number;
  superseded: number;
  resolved: number;
  newCandidates: number;
  /**
   * Candidates that crossed the active→resolved boundary on this specific
   * scan because the drift disappeared (live now matches desired, or the
   * desired side caught up). Distinct from the cumulative `resolved` count
   * which includes prior resolutions. Useful for "how many issues did this
   * scan close out" reporting in command output.
   */
  resolvedThisScan: number;
  notificationFailures: number;
  /** Adapter description (provider/target) used for this scan. */
  adapter: string;
  /** Queue path used. */
  queuePath: string;
  /** Whether desired config and ownership policy were available. */
  inputs: {
    desiredConfigAvailable: boolean;
    ownershipPolicyAvailable: boolean;
  };
  /** Errors that the detector collected without aborting (e.g. notification failures). */
  errors: string[];
}

/**
 * Unwrap the Helm-rendered `openclaw-helm.config.*` wrapper so the desired
 * config tree aligns with the live runtime tree. The chart renders deployment
 * config under that namespace; live config is unwrapped already. Diff/classify
 * compare path-by-path so both sides must share the same root shape.
 */
function unwrapHelmConfig(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  const helm = obj["openclaw-helm"];
  if (helm && typeof helm === "object" && !Array.isArray(helm)) {
    const inner = (helm as Record<string, unknown>).config;
    if (inner && typeof inner === "object") return inner;
  }
  return value;
}

function loadDesiredConfig(
  path: string | undefined,
  logger: DetectorDeps["logger"],
): { value: unknown | undefined; parseError?: string } {
  if (!path) return { value: undefined };
  if (!existsSync(path)) {
    logger?.warn(`desired config not found at ${path}; treating as no-desired-config`);
    return { value: undefined };
  }
  try {
    return { value: unwrapHelmConfig(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (e: unknown) {
    return { value: undefined, parseError: `failed to parse desired config at ${path}: ${e instanceof Error ? e.message : e}` };
  }
}

function loadOwnershipPolicy(
  path: string | undefined,
  logger: DetectorDeps["logger"],
): { value: OwnershipPolicy; parseError?: string } {
  if (!path) return { value: {} };
  if (!existsSync(path)) {
    logger?.warn(`ownership policy not found at ${path}; treating as empty policy`);
    return { value: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object") return { value: parsed as OwnershipPolicy };
    return { value: {} };
  } catch (e: unknown) {
    return { value: {}, parseError: `failed to parse ownership policy at ${path}: ${e instanceof Error ? e.message : e}` };
  }
}

/**
 * Parse-aware view of detector inputs shared by `runScan` and surfaces that
 * report availability (e.g. `/config-drift status`). `*Available` is true
 * only when the file is configured, present, AND parses successfully — so a
 * corrupt desired or policy file cannot be reported as "available" on one
 * surface and "missing" on another.
 */
export interface ResolvedInputs {
  desired: unknown | undefined;
  policy: OwnershipPolicy;
  desiredConfigAvailable: boolean;
  ownershipPolicyAvailable: boolean;
  parseErrors: string[];
}

export function resolveInputs(
  config: ConvergenceConfig,
  logger?: DetectorDeps["logger"],
): ResolvedInputs {
  const desiredResult = loadDesiredConfig(config.desiredConfigPath, logger);
  const policyResult = loadOwnershipPolicy(config.ownershipPolicyPath, logger);
  const parseErrors: string[] = [];
  if (desiredResult.parseError) {
    logger?.error(desiredResult.parseError);
    parseErrors.push(desiredResult.parseError);
  }
  if (policyResult.parseError) {
    logger?.error(policyResult.parseError);
    parseErrors.push(policyResult.parseError);
  }
  return {
    desired: desiredResult.value,
    policy: policyResult.value,
    desiredConfigAvailable: !!config.desiredConfigPath && existsSync(config.desiredConfigPath) && !desiredResult.parseError,
    ownershipPolicyAvailable: !!config.ownershipPolicyPath && existsSync(config.ownershipPolicyPath) && !policyResult.parseError,
    parseErrors,
  };
}

function countByStatus(queue: CandidateQueue): { active: number; ignored: number; superseded: number; resolved: number } {
  let active = 0, ignored = 0, superseded = 0, resolved = 0;
  for (const c of Object.values(queue.candidates)) {
    if (c.status === "active") active++;
    else if (c.status === "ignored") ignored++;
    else if (c.status === "superseded") superseded++;
    else if (c.status === "resolved") resolved++;
  }
  return { active, ignored, superseded, resolved };
}

function shouldNotifyForReason(c: DriftCandidate, expectedSecretDriftNotify: boolean): boolean {
  if (c.reasonCode === "expected-secret-drift" && !expectedSecretDriftNotify) return false;
  return true;
}

/** Run one detection pass. Returns a structured result; never throws on transient I/O. */
export async function runScan(deps: DetectorDeps): Promise<ScanResult> {
  const logger = deps.logger ?? {
    info: (m: string) => console.log(`[runtime-config-convergence] ${m}`),
    warn: (m: string) => console.warn(`[runtime-config-convergence] ${m}`),
    error: (m: string) => console.error(`[runtime-config-convergence] ${m}`),
  };
  const adapter = deps.adapter ?? buildAdapter(deps.config.notification);

  const errors: string[] = [];
  let queue: CandidateQueue;
  try {
    queue = readQueue(deps.queuePath, deps.persona);
  } catch (e: unknown) {
    if (e instanceof QueueParseError) {
      // Fail closed: surface the error, do not overwrite the queue.
      const msg = `queue parse error: ${e.message}`;
      logger.error(msg);
      errors.push(msg);
      return {
        active: 0, ignored: 0, superseded: 0, resolved: 0,
        newCandidates: 0, resolvedThisScan: 0, notificationFailures: 0,
        adapter: adapter.describe(),
        queuePath: deps.queuePath,
        inputs: {
          desiredConfigAvailable: !!deps.config.desiredConfigPath && existsSync(deps.config.desiredConfigPath),
          ownershipPolicyAvailable: !!deps.config.ownershipPolicyPath && existsSync(deps.config.ownershipPolicyPath),
        },
        errors,
      };
    }
    throw e;
  }

  // Refresh persona on the queue if it was previously unset.
  if (!queue.persona) queue.persona = deps.persona;

  const inputs = resolveInputs(deps.config, logger);
  for (const e of inputs.parseErrors) errors.push(e);
  const { desired, policy } = inputs;

  let live: unknown;
  let liveReadFailed = false;
  try {
    live = deps.loadLiveConfig();
  } catch (e: unknown) {
    if (e instanceof LiveConfigReadError) {
      // Explicit liveConfigPath read failed — running diff against an undefined
      // live config would mark every desired key as missing-in-live and spam
      // notifications. Surface the error and skip diff for this scan.
      const msg = `live config read error: ${e.message}`;
      logger.error(msg);
      errors.push(msg);
      liveReadFailed = true;
    } else {
      throw e;
    }
  }
  const diff = (desired === undefined || liveReadFailed)
    ? [] // no desired config or live read failed = no diff this scan
    : diffConfig(live, desired);
  const classified = classifyDiff(diff, policy);

  // Build the current scan's candidate-id set in lockstep with the upsert
  // loop so reconciliation can later transition any active candidate that
  // is no longer present (drift resolved) to the `resolved` terminal status.
  const currentDriftIds = new Set<string>();
  let newCount = 0;
  let notifFailures = 0;
  for (const drift of classified) {
    const result = upsertCandidate(queue, drift);
    currentDriftIds.add(result.candidate.id);
    if (!result.isNew) continue;
    if (result.candidate.status === "ignored") continue; // shouldn't happen for new, but defensive
    // Count BEFORE notification-suppression checks so command/HTTP scan
    // output reflects all newly-inserted queue entries, not just the ones
    // that were eligible to be notified. Otherwise an `expected-secret-drift`
    // entry with `expectedSecretDriftNotify=false` lands in the queue but
    // the result reports `newCandidates=0`, which contradicts `/config-drift
    // list` showing the new candidate.
    newCount++;
    if (!shouldNotifyForReason(result.candidate, deps.config.expectedSecretDriftNotify)) continue;
    if (deps.config.dryRun) continue;
    const sendResult = await adapter.send(formatCandidateNotification(result.candidate));
    if (!sendResult.ok) {
      notifFailures++;
      recordNotification(queue, result.candidate.id, { ok: false, error: sendResult.error });
      errors.push(`notification for ${result.candidate.id}: ${sendResult.error}`);
    } else if (!sendResult.noSend) {
      recordNotification(queue, result.candidate.id, { ok: true });
    }
  }

  // Reconcile resolved drift. Only safe to do this when we actually computed
  // a real diff — if desired was missing or live read failed, `classified`
  // is `[]` and every active candidate would look "missing" through the
  // narrow lens of this scan. We must not retire candidates based on a
  // scan that didn't actually observe the live/desired pair.
  let resolvedThisScan = 0;
  if (desired !== undefined && !liveReadFailed) {
    resolvedThisScan = resolveStaleCandidates(queue, currentDriftIds).length;
  }

  // Persist queue. If write fails, surface the error but don't lose what we
  // already learned in-memory — the next scan will retry.
  try {
    writeQueue(deps.queuePath, queue);
  } catch (e: unknown) {
    const msg = `queue write error: ${e instanceof Error ? e.message : e}`;
    logger.error(msg);
    errors.push(msg);
  }

  const counts = countByStatus(queue);
  return {
    ...counts,
    newCandidates: newCount,
    resolvedThisScan,
    notificationFailures: notifFailures,
    adapter: adapter.describe(),
    queuePath: deps.queuePath,
    inputs: {
      desiredConfigAvailable: inputs.desiredConfigAvailable,
      ownershipPolicyAvailable: inputs.ownershipPolicyAvailable,
    },
    errors,
  };
}

/**
 * Wrap a scan-like function so all invocations against this instance run
 * sequentially. The detector's read-classify-notify-write sequence is not
 * internally serialized; if the service tick overlaps a command-issued or
 * HTTP-triggered scan, both sides can read the same pre-update queue, both
 * decide a candidate is new, both notify, and the last write wins. Wrapping
 * with this helper at the surface boundary fixes the cross-surface race.
 *
 * A scan-failure on the chain is swallowed for chaining purposes (so the
 * lock doesn't latch into a permanent rejected state) but is still propagated
 * to the caller via the returned promise.
 */
export function makeSerializedScan<D, R>(scan: (deps: D) => Promise<R>): (deps: D) => Promise<R> {
  let lock: Promise<unknown> = Promise.resolve();
  return (deps) => {
    const next = lock.catch(() => undefined).then(() => scan(deps));
    lock = next.catch(() => undefined);
    return next;
  };
}

/**
 * Build a default `loadLiveConfig` for callers that should read the explicit
 * file (when `config.liveConfigPath` is set), falling back to the provided
 * runtime-config getter otherwise. On read/parse failure, throws
 * `LiveConfigReadError` so `runScan` can short-circuit with a single error
 * entry rather than diffing against `undefined` and spamming notifications.
 */
export function makeLoadLiveConfig(
  config: ConvergenceConfig,
  runtimeConfig: () => unknown,
): () => unknown {
  if (config.liveConfigPath) {
    const path = config.liveConfigPath;
    return () => {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch (e: unknown) {
        throw new LiveConfigReadError(path, e);
      }
    };
  }
  return runtimeConfig;
}
