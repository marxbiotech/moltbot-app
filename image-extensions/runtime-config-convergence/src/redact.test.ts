import { describe, it, expect } from "vitest";
import {
  isEnvRefShape,
  isSecretLikePath,
  isSecretLikeValue,
  shouldRedact,
  summarizeValue,
  valueKindOf,
} from "./redact.js";

describe("isSecretLikePath", () => {
  it("matches well-known secret tokens", () => {
    expect(isSecretLikePath("auth.openai.apiKey")).toBe(true);
    expect(isSecretLikePath("providers.tokens.foo")).toBe(true);
    expect(isSecretLikePath("messaging.password")).toBe(true);
    expect(isSecretLikePath("auth.profiles.codex")).toBe(true); // contains "auth"
  });
  it("does not match unrelated paths", () => {
    expect(isSecretLikePath("messages.groupChat.mentionPatterns")).toBe(false);
    expect(isSecretLikePath("channels.telegram.groups")).toBe(false);
  });
});

describe("isEnvRefShape", () => {
  it("recognizes env-ref shapes", () => {
    expect(isEnvRefShape("$ENV:FOO")).toBe(true);
    expect(isEnvRefShape("${BAR}")).toBe(true);
  });
  it("rejects raw secret-looking strings", () => {
    expect(isEnvRefShape("AKIA" + "0".repeat(40))).toBe(false);
  });
});

describe("isSecretLikeValue", () => {
  it("flags long opaque strings", () => {
    // Synthetic long opaque string (NOT a real provider prefix — see push-protection note).
    expect(isSecretLikeValue("X".repeat(48))).toBe(true);
  });
  it("does not flag env-ref shapes", () => {
    expect(isSecretLikeValue("$ENV:FOO")).toBe(false);
  });
  it("does not flag short strings", () => {
    expect(isSecretLikeValue("hello")).toBe(false);
  });
});

describe("shouldRedact", () => {
  it("redacts secret-like paths regardless of value", () => {
    expect(shouldRedact("auth.openai.apiKey", "x")).toBe(true);
  });
  it("redacts long token-looking values on neutral paths", () => {
    expect(shouldRedact("messages.x", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
  });
});

describe("summarizeValue", () => {
  it("returns redacted display for secret paths and never the raw value", () => {
    const r = summarizeValue("auth.openai.apiKey", "sk-XXXXXXXXXXXXXXXXXXXXXXXX");
    expect(r.redacted).toBe(true);
    expect(r.display).not.toContain("sk-");
    expect(r.display).toBe("<redacted:string>");
  });
  it("summarizes objects/arrays without dumping content", () => {
    expect(summarizeValue("groups.x", { a: 1, b: 2, c: 3 }).display).toContain("keys=");
    expect(summarizeValue("groups.x", [1, 2, 3]).display).toContain("len=3");
  });
  it("redacts long opaque strings (token-like) even on neutral paths", () => {
    const long = "a".repeat(200);
    const r = summarizeValue("messages.x", long);
    expect(r.redacted).toBe(true);
    expect(r.display).toBe("<redacted:string>");
  });

  it("truncates long human-readable strings without redacting them", () => {
    const long = "Lorem ipsum dolor sit amet, ".repeat(20); // contains spaces/punctuation
    const r = summarizeValue("messages.x", long);
    expect(r.redacted).toBe(false);
    expect(r.display.length).toBeLessThan(long.length);
  });
});

describe("valueKindOf", () => {
  it("classifies primitives correctly", () => {
    expect(valueKindOf(null)).toBe("null");
    expect(valueKindOf(true)).toBe("boolean");
    expect(valueKindOf(1)).toBe("number");
    expect(valueKindOf("")).toBe("string");
    expect(valueKindOf([])).toBe("array");
    expect(valueKindOf({})).toBe("object");
  });
});
