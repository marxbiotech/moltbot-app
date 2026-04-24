// Utility for constructing RFC 7396 merge-patch objects from a dot-delimited
// config path and a parsed value.
//
// Used by the manage-config skill (Phase 1) when calling the gateway tool's
// config.patch action.  The gateway tool expects a `raw` JSON string containing
// a nested object where only the targeted leaf is set.
//
// Example:
//   buildMergePatch("agents.defaults.model.primary", "google/gemini-3-flash")
//   => { agents: { defaults: { model: { primary: "google/gemini-3-flash" } } } }

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
  cursor[segments[segments.length - 1]] = value;
  return patch;
}
