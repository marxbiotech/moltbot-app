// Canonical JSON serialization + SHA-256 hashing.
//
// Stability requirements per issue #35 acceptance criteria:
//   - Object keys are sorted lexicographically at every depth so the same
//     logical value always serializes to the same bytes.
//   - Arrays preserve insertion order (semantic order is part of the value).
//   - Undefined values are stripped from objects (matching JSON semantics) but
//     null is preserved (null is a meaningful value in OpenClaw configs).

import { createHash } from "node:crypto";

export function canonicalStringify(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null"; // top-level undefined → null for hashing stability
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      // JSON.stringify handles NaN/Infinity by producing null; we do the same
      // to avoid emitting non-JSON tokens.
      if (!Number.isFinite(value)) return "null";
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map(serialize).join(",")}]`;
      }
      return serializeObject(value as Record<string, unknown>);
    default:
      // bigint / symbol / function are not valid JSON values
      return "null";
  }
}

function serializeObject(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${JSON.stringify(k)}:${serialize(obj[k])}`);
  }
  return `{${parts.join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Convenience: hash a value via canonical JSON + SHA-256. */
export function hashValue(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}
