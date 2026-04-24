// Preflight checks for set_config tool inputs.
//
// These are transport-safety guards — they reject malformed requests before
// they reach the GitHub Actions workflow dispatch API.  They are NOT
// authoritative config-schema validation; that belongs to:
//   - Phase 1: openclaw core via gateway tool (config.schema.lookup, config.patch)
//   - Phase 2: repo-side validation in set-config.yml / config-patch.mjs
//
// Keep checks here minimal and unlikely to drift from upstream contracts.

// Gate to the supported path subset: simple dot-delimited identifiers only.
// Mirrors the workflow's own path validation so we fail fast on obviously
// unsupported input (array selectors, empty segments, etc.) rather than
// burning a workflow dispatch round-trip.
const PATH_SEGMENT_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

export function checkConfigPath(path: string): string | null {
  if (!path) return "config_path must not be empty";
  const segments = path.split(".");
  for (const seg of segments) {
    if (!PATH_SEGMENT_RE.test(seg)) {
      return `Unsupported path segment: '${seg}'. Only simple dot-delimited identifiers are accepted (no array selectors).`;
    }
  }
  return null;
}

// Verify the value string is parseable JSON and not null, so the workflow
// receives a well-formed payload.  Whether the value is schema-valid for the
// target path is determined by openclaw core (Phase 1) and the repo-side
// workflow (Phase 2), not here.
export function checkConfigValue(value: string): string | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed === null) return "config_value must not be JSON null";
  } catch {
    return `config_value must be valid JSON (got: ${value})`;
  }
  return null;
}
