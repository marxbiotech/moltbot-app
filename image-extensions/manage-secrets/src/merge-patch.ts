// Utilities for working with RFC 7396 merge-patch objects.
//
// buildMergePatch — constructs a merge-patch from a dot-delimited path + value.
// Used by the manage-config skill (Phase 1) when calling the gateway tool's
// config.patch action.  The gateway tool expects a `raw` JSON string containing
// a nested object where only the targeted leaf is set.
//
// extractLeafPaths — walks a parsed merge-patch and returns dot-delimited paths
// to every leaf (primitives, arrays, and nulls).  Used by preflight validation
// and status-message generation.

export function buildMergePatch(
  dotPath: string,
  value: unknown,
): Record<string, unknown> {
  const segments = dotPath.split(".");
  let patch: Record<string, unknown> = {};
  let cursor = patch;
  for (let i = 0; i < segments.length - 1; i++) {
    const next: Record<string, unknown> = {};
    cursor[segments[i]] = next;
    cursor = next;
  }
  cursor[segments.at(-1)!] = value;
  return patch;
}

export function extractLeafPaths(
  obj: Record<string, unknown>,
  prefix = "",
): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      paths.push(...extractLeafPaths(value as Record<string, unknown>, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}
