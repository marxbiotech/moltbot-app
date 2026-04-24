// Matches the workflow's path validation: each segment is [a-zA-Z_][a-zA-Z0-9_-]*
const PATH_SEGMENT_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

export function validateConfigPath(path: string): string | null {
  if (!path) return "config_path must not be empty";
  const segments = path.split(".");
  for (const seg of segments) {
    if (!PATH_SEGMENT_RE.test(seg)) {
      return `Invalid path segment: '${seg}'. Only simple dot-delimited identifiers are supported (no array selectors).`;
    }
  }
  return null;
}

export function validateConfigValue(value: string): string | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed === null) return "config_value must not be JSON null";
  } catch {
    return `config_value must be valid JSON (got: ${value})`;
  }
  return null;
}
