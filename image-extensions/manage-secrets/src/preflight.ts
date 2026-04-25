// Preflight checks for set_config tool inputs.
//
// These are transport-safety guards — they reject malformed requests before
// they reach the GitHub Actions workflow dispatch API.  They are NOT
// authoritative config-schema validation; that belongs to:
//   - Phase 1: openclaw core via gateway tool (config.schema.lookup, config.patch)
//   - Phase 2: repo-side validation in set-config.yml
//
// Keep checks here minimal and unlikely to drift from upstream contracts.

import { extractLeafPaths } from "./merge-patch.ts";

// Gate to the supported path subset: simple dot-delimited identifiers only.
const PATH_SEGMENT_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

const MAX_PATCH_LEAVES = 20;

export type PatchPreflightOk = { leafPaths: string[] };

export function checkPatch(patch: string): PatchPreflightOk | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(patch);
  } catch {
    return { error: "patch must be valid JSON" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "patch must be a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;

  // Reject null leaf values — deletion is not supported via config patches.
  const nullPath = findNullLeaf(obj);
  if (nullPath) {
    return { error: `null values (key deletion) are not supported: ${nullPath}` };
  }

  const leafPaths = extractLeafPaths(obj);

  if (leafPaths.length === 0) {
    return { error: "patch must contain at least one config path" };
  }
  if (leafPaths.length > MAX_PATCH_LEAVES) {
    return { error: `patch has ${leafPaths.length} leaf paths (max ${MAX_PATCH_LEAVES})` };
  }

  // Validate every leaf path against the supported-subset gate.
  for (const lp of leafPaths) {
    const segments = lp.split(".");
    for (const seg of segments) {
      if (!PATH_SEGMENT_RE.test(seg)) {
        return {
          error: `Unsupported path segment '${seg}' in '${lp}'. Only simple dot-delimited identifiers are accepted (no array selectors).`,
        };
      }
    }
  }

  return { leafPaths };
}

function findNullLeaf(obj: Record<string, unknown>, prefix = ""): string | null {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === null) return path;
    if (typeof value === "object" && !Array.isArray(value)) {
      const found = findNullLeaf(value as Record<string, unknown>, path);
      if (found) return found;
    }
  }
  return null;
}
