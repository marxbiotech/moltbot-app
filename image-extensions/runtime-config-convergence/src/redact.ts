// Value redaction and summarization.
//
// Issue #35 §4 / acceptance criteria require that secret-like values are NEVER
// stored raw in the queue, notifications, logs, or generated patches. We err
// on the side of redacting too much rather than too little.
//
// "Secret-like" v1 heuristics:
//   1. Path matches well-known secret tokens (tokens, secrets, passwords, keys, ...)
//   2. Value matches an env-ref shape (`$ENV:NAME`, `${NAME}`)
//   3. Value is a long opaque string suggesting an access token

import type { ValueKind } from "./types.js";

const SECRET_PATH_TOKENS = [
  "secret",
  "secrets",
  "token",
  "tokens",
  "apikey",
  "apiKey",
  "api_key",
  "password",
  "passwd",
  "credential",
  "credentials",
  "privatekey",
  "private_key",
  "client_secret",
  "auth",
];

const ENV_REF_RE = /^\$(\{[A-Z_][A-Z0-9_]*\}|ENV:[A-Z_][A-Z0-9_]*)$/;
const TOKEN_LIKE_RE = /^[A-Za-z0-9_\-+/=.]{32,}$/;

export function isSecretLikePath(path: string): boolean {
  const lower = path.toLowerCase();
  return SECRET_PATH_TOKENS.some((tok) => lower.includes(tok.toLowerCase()));
}

export function isEnvRefShape(value: unknown): boolean {
  return typeof value === "string" && ENV_REF_RE.test(value);
}

export function isSecretLikeValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (isEnvRefShape(value)) return false; // env-ref is a shape, not the secret itself
  return TOKEN_LIKE_RE.test(value);
}

export function shouldRedact(path: string, value: unknown): boolean {
  if (isSecretLikePath(path)) return true;
  if (isSecretLikeValue(value)) return true;
  return false;
}

export function valueKindOf(value: unknown): ValueKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    case "object":
      return "object";
    default:
      // bigint / symbol / function are coerced to "string" in error logs etc.
      return "string";
  }
}

export interface ValueSummary {
  valueKind: ValueKind;
  redacted: boolean;
  /** Human-safe display string for chat/logs. NEVER the raw secret. */
  display: string;
}

/**
 * Produce a redacted-and-bounded display string for a value.
 *
 * - Secret-like paths/values: replaced with `<redacted:KIND>`.
 * - Env-ref shapes: kept verbatim (it's already a reference, not a secret).
 * - Long strings: truncated.
 * - Objects/arrays: shape-only summary (never the full structure).
 */
export function summarizeValue(path: string, value: unknown): ValueSummary {
  const kind = valueKindOf(value);
  if (shouldRedact(path, value)) {
    return { valueKind: kind, redacted: true, display: `<redacted:${kind}>` };
  }
  if (value === null) return { valueKind: kind, redacted: false, display: "null" };
  if (typeof value === "boolean") return { valueKind: kind, redacted: false, display: String(value) };
  if (typeof value === "number") return { valueKind: kind, redacted: false, display: String(value) };
  if (typeof value === "string") {
    const truncated = value.length > 80 ? `${value.slice(0, 77)}...` : value;
    return { valueKind: kind, redacted: false, display: JSON.stringify(truncated) };
  }
  if (Array.isArray(value)) {
    return { valueKind: kind, redacted: false, display: `<array len=${value.length}>` };
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value as object).slice(0, 5);
    const more = Object.keys(value as object).length > keys.length ? "..." : "";
    return { valueKind: kind, redacted: false, display: `<object keys=[${keys.join(",")}${more}]>` };
  }
  return { valueKind: kind, redacted: false, display: "<unknown>" };
}
