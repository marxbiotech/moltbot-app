// Path-level diff between live and desired OpenClaw config trees.
//
// The diff walks both objects and produces a flat list of DiffEntries keyed by
// canonical (dot-joined) path. Each entry records both sides plus existence
// flags so the classifier can distinguish "differs" from "added" / "removed".
//
// Path-construction rules:
//   - Object keys are joined with `.`. Keys with awkward characters (e.g.
//     `auth.profiles.openai-codex:user@example.com`) are kept verbatim as a
//     single segment; we never re-split a constructed path.
//   - Arrays are compared as a single value at the parent path (we do not
//     descend into array indexes for v1). Whole-array drift is a single entry.

import type { DiffEntry } from "./types.js";
import { canonicalizePath } from "./paths.js";
import { canonicalStringify } from "./canonical-json.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function joinPath(prefix: string, key: string): string {
  return prefix.length === 0 ? key : `${prefix}.${key}`;
}

/**
 * Walk both trees, collecting paths that differ. Recurses into plain objects
 * only; arrays and primitives are leaf comparisons.
 */
export function diffConfig(live: unknown, desired: unknown): DiffEntry[] {
  const out: DiffEntry[] = [];
  walk(live, desired, "", out);
  return out;
}

function walk(
  live: unknown,
  desired: unknown,
  prefix: string,
  out: DiffEntry[],
): void {
  // Both objects → recurse on the union of keys.
  if (isPlainObject(live) && isPlainObject(desired)) {
    const keys = new Set<string>([...Object.keys(live), ...Object.keys(desired)]);
    for (const k of keys) {
      walk(
        Object.prototype.hasOwnProperty.call(live, k) ? live[k] : undefined,
        Object.prototype.hasOwnProperty.call(desired, k) ? desired[k] : undefined,
        joinPath(prefix, k),
        out,
      );
    }
    return;
  }

  // One side is missing → record the leaf at this prefix as a single drift.
  const liveExists = live !== undefined;
  const desiredExists = desired !== undefined;
  if (!liveExists && !desiredExists) return;
  if (liveExists && desiredExists) {
    // Same canonical JSON => identical, no drift.
    if (canonicalStringify(live) === canonicalStringify(desired)) return;
  }

  if (prefix.length === 0) {
    // Top-level scalar drift: rare; record under "" so downstream can ignore.
    out.push({
      canonicalPath: "",
      liveValue: live,
      desiredValue: desired,
      liveExists,
      desiredExists,
    });
    return;
  }

  out.push({
    canonicalPath: canonicalizePath(prefix),
    liveValue: live,
    desiredValue: desired,
    liveExists,
    desiredExists,
  });
}
