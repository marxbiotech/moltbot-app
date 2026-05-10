// Shared types for runtime-config-convergence v1.
// See moltbot-app issue #35 for the full design.

export type ReasonCode =
  | "repo-owned-drift"
  | "unknown-runtime-drift"
  | "secret-shape-violation"
  | "expected-secret-drift";

export type CandidateStatus = "active" | "ignored" | "superseded" | "resolved";

export type ValueKind =
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "array"
  | "object";

export interface CandidateSummary {
  valueKind: ValueKind;
  redacted: boolean;
}

export interface CandidateNotification {
  firstNotifiedAt?: string;
  lastNotificationError?: string;
}

export interface DriftCandidate {
  /** Stable short id derived from canonicalPath + liveValueHash. */
  id: string;
  canonicalPath: string;
  liveValueHash: string;
  desiredValueHash?: string;
  reasonCode: ReasonCode;
  // State-machine fields are readonly externally so only queue.ts mutators
  // (ignore/unignore/upsert supersession) can change them. queue.ts uses
  // `Mutable<DriftCandidate>` casts at the mutation sites.
  readonly status: CandidateStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  readonly supersededBy?: string;
  readonly ignoredAt?: string;
  readonly ignoreScope?: "exact-pair";
  readonly resolvedAt?: string;
  notification: CandidateNotification;
  summary: CandidateSummary;
}

/** Strip readonly modifiers; used inside queue.ts at state-mutation sites. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface CandidateQueue {
  schemaVersion: 1;
  persona: string;
  updatedAt: string;
  candidates: Record<string, DriftCandidate>;
}

/** Notification transport variants. */
export type NotificationConfig =
  | { transport: "telegram"; botTokenEnv?: string; chatIdEnv?: string }
  | { transport: "slack"; botTokenEnv?: string; channelIdEnv?: string }
  | { transport: "log-only" }
  | { transport: "none" };

export interface HttpRouteConfig {
  path: string;
  auth: "gateway" | "plugin";
}

export interface ConvergenceConfig {
  liveConfigPath?: string;
  queuePath?: string;
  desiredConfigPath?: string;
  ownershipPolicyPath?: string;
  scanIntervalMs: number;
  notification: NotificationConfig;
  dryRun: boolean;
  expectedSecretDriftNotify: boolean;
  httpRoute?: HttpRouteConfig;
}

/**
 * Ownership policy file shape.
 *
 * v1 minimal contract:
 *   - repoOwnedPaths: paths whose desired value comes from the repo and any
 *     mismatch is real drift.
 *   - secretRefPaths: paths expected to hold an env-ref shape (e.g. `$ENV:NAME`)
 *     so the live value not matching that shape is a `secret-shape-violation`.
 *   - expectedSecretDriftPaths: paths known to drift in expected ways
 *     (e.g. generated credentials) — informational, suppressed by default.
 *
 * `moltbot-env` owns generation of this file. The plugin treats it as
 * read-only and tolerates a missing file.
 */
export interface OwnershipPolicy {
  repoOwnedPaths?: string[];
  secretRefPaths?: string[];
  expectedSecretDriftPaths?: string[];
}

/** A single drift entry produced by the diff stage, before classification. */
export interface DiffEntry {
  canonicalPath: string;
  liveValue: unknown;
  desiredValue: unknown;
  liveExists: boolean;
  desiredExists: boolean;
}

/**
 * A classified drift entry — diff + a reason code.
 * Becomes a queue candidate after upsert.
 */
export interface ClassifiedDrift extends DiffEntry {
  reasonCode: ReasonCode;
}
