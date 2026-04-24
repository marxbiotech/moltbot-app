import { describe, it, expect } from "vitest";
import { validateConfigPath, validateConfigValue } from "./validate.ts";

describe("validateConfigPath", () => {
  it("accepts valid dot-delimited paths", () => {
    expect(validateConfigPath("agents.defaults.model.primary")).toBeNull();
    expect(validateConfigPath("channels.telegram.enabled")).toBeNull();
    expect(validateConfigPath("singleSegment")).toBeNull();
    expect(validateConfigPath("a_b-c.d_e")).toBeNull();
  });

  it("rejects empty path", () => {
    expect(validateConfigPath("")).toMatch(/must not be empty/);
  });

  it("rejects segments starting with digits", () => {
    expect(validateConfigPath("agents.0bad")).toMatch(/Invalid path segment/);
  });

  it("rejects segments with special characters", () => {
    expect(validateConfigPath("agents.foo[0]")).toMatch(/Invalid path segment/);
    expect(validateConfigPath("agents.foo bar")).toMatch(/Invalid path segment/);
    expect(validateConfigPath("agents.foo.bar.baz[id=main]")).toMatch(/Invalid path segment/);
  });

  it("rejects paths with empty segments (consecutive dots)", () => {
    expect(validateConfigPath("agents..model")).toMatch(/Invalid path segment/);
  });

  it("rejects segments starting with a hyphen", () => {
    expect(validateConfigPath("-bad")).toMatch(/Invalid path segment/);
  });
});

describe("validateConfigValue", () => {
  it("accepts valid JSON strings", () => {
    expect(validateConfigValue('"google/gemini-3-flash"')).toBeNull();
    expect(validateConfigValue("true")).toBeNull();
    expect(validateConfigValue("false")).toBeNull();
    expect(validateConfigValue("42")).toBeNull();
    expect(validateConfigValue('{"key":"val"}')).toBeNull();
    expect(validateConfigValue("[]")).toBeNull();
    expect(validateConfigValue('["a","b"]')).toBeNull();
  });

  it("rejects null", () => {
    expect(validateConfigValue("null")).toMatch(/must not be JSON null/);
  });

  it("rejects invalid JSON", () => {
    expect(validateConfigValue("not-json")).toMatch(/must be valid JSON/);
    expect(validateConfigValue("")).toMatch(/must be valid JSON/);
    expect(validateConfigValue("google/gemini-3-flash")).toMatch(/must be valid JSON/);
  });
});
