// Path resolution helpers.
//
// Two distinct concerns:
//  1. Module-scoped queue path resolution at register(api) time.
//     Per issue #35, ctx.stateDir is only available on OpenClaw service
//     contexts — command and HTTP route handlers don't have it. So the
//     queue path must be resolved before any of those surfaces fire.
//     Strategy: $OPENCLAW_HOME (or ~/.openclaw)/runtime-config-convergence/queue.json,
//     overridable by the `queuePath` plugin config.
//  2. Canonical config path normalization (e.g. for keys with awkward characters).

import { homedir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "./canonical-json.js";

const PLUGIN_QUEUE_SUBDIR = "runtime-config-convergence";
const PLUGIN_QUEUE_FILE = "queue.json";

function getOpenclawHome(): string {
  return process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw");
}

/**
 * Resolve the queue file path.
 *
 * @param override Explicit `queuePath` from plugin config, if any.
 */
export function resolveQueuePath(override?: string): string {
  if (override && override.length > 0) return override;
  return join(getOpenclawHome(), PLUGIN_QUEUE_SUBDIR, PLUGIN_QUEUE_FILE);
}

/**
 * Normalize a runtime OpenClaw config path. v1 strips a leading
 * `openclaw-helm.config.` wrapper if present (this is the Helm-rendered
 * desired-config namespace) and otherwise returns the input verbatim.
 *
 * Path keys that contain awkward characters (e.g. colons in
 * `auth.profiles.openai-codex:user@example.com`) must remain valid as a
 * single segment — we do NOT split-and-rejoin on `.`, since that would
 * misparse such keys. The diff stage walks structured JSON and constructs
 * paths via dot-join of pre-extracted segments, so the canonical path is
 * the concatenated, post-stripped string.
 */
export function canonicalizePath(path: string): string {
  const HELM_PREFIX = "openclaw-helm.config.";
  if (path.startsWith(HELM_PREFIX)) {
    return path.slice(HELM_PREFIX.length);
  }
  return path;
}

/**
 * Build a candidate id from `(canonicalPath, liveValueHash)`.
 * Format: `<pair-hash-prefix>-<path-tail>` for human-readability in logs/chat.
 *
 * The hash prefix is computed over BOTH the canonical path and the live value
 * hash, using a length-prefix on the path so concatenation is unambiguous for
 * any path contents. This means two distinct pairs cannot collide on the dict
 * key even when their normalized path tails match (e.g. `a.b`, `a-b`, and
 * `a_b` all sanitize to the same suffix). The 12-hex prefix gives ~48 bits of
 * collision space, far more than the queue is ever expected to hold.
 */
export function buildCandidateId(canonicalPath: string, liveValueHash: string): string {
  const pairHash = sha256Hex(`${canonicalPath.length}:${canonicalPath}:${liveValueHash}`).slice(0, 12);
  const tail = canonicalPath.replace(/[^a-zA-Z0-9]+/g, "-").slice(-32).replace(/^-|-$/g, "");
  return tail.length > 0 ? `${pairHash}-${tail}` : pairHash;
}
