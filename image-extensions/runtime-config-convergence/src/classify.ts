// Reason-code classification for diff entries.
//
// v1 fixed reason-code set per issue #35 §6:
//   - repo-owned-drift          : path is repo-owned and live differs from desired
//   - unknown-runtime-drift     : path differs but no ownership classification
//   - secret-shape-violation    : path is secret-ref-owned but live value isn't an env-ref shape
//   - expected-secret-drift     : path is on the expected-drift list (informational)
//
// Adding new reason codes here is intentionally a code change + tests + help-text update.

import type { ClassifiedDrift, DiffEntry, OwnershipPolicy, ReasonCode } from "./types.js";
import { isEnvRefShape } from "./redact.js";

function pathMatches(pattern: string, canonicalPath: string): boolean {
  // v1: exact-match only. Path-glob is explicitly out of scope.
  return pattern === canonicalPath;
}

function classifySingle(entry: DiffEntry, policy: OwnershipPolicy): ReasonCode {
  const isExpectedSecretDrift = (policy.expectedSecretDriftPaths ?? []).some((p) =>
    pathMatches(p, entry.canonicalPath),
  );
  if (isExpectedSecretDrift) return "expected-secret-drift";

  const isSecretRef = (policy.secretRefPaths ?? []).some((p) =>
    pathMatches(p, entry.canonicalPath),
  );
  if (isSecretRef) {
    // Live value must be an env-ref shape. If it isn't (and the path exists
    // live), this is a shape violation regardless of desired value match.
    if (entry.liveExists && !isEnvRefShape(entry.liveValue)) {
      return "secret-shape-violation";
    }
    // Otherwise treat as repo-owned drift on the env-ref reference itself.
    return "repo-owned-drift";
  }

  const isRepoOwned = (policy.repoOwnedPaths ?? []).some((p) =>
    pathMatches(p, entry.canonicalPath),
  );
  if (isRepoOwned) return "repo-owned-drift";

  return "unknown-runtime-drift";
}

export function classifyDiff(
  diff: DiffEntry[],
  policy: OwnershipPolicy,
): ClassifiedDrift[] {
  return diff
    .filter((d) => d.canonicalPath.length > 0) // skip top-level scalar drift
    .map((d) => ({ ...d, reasonCode: classifySingle(d, policy) }));
}
