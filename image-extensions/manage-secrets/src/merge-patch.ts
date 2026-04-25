// Utilities for working with JSON merge-patch objects (RFC 7396 structure,
// but null/deletion is rejected by preflight — this system is append/update only).
//
// buildMergePatch — constructs a merge-patch from a dot-delimited path + value.
// Currently used only in tests. The agent constructs the equivalent JSON string
// directly when following the manage-config SKILL.md.
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

const MAX_DEPTH = 10;

export function extractLeafPaths(
  obj: Record<string, unknown>,
  prefix = "",
  depth = 0,
): string[] {
  if (depth > MAX_DEPTH) throw new RangeError("Patch nesting exceeds maximum depth");
  const paths: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      paths.push(...extractLeafPaths(value as Record<string, unknown>, path, depth + 1));
    } else {
      paths.push(path);
    }
  }
  return paths;
}
