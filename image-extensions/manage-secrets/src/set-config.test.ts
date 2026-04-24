import { describe, it, expect } from "vitest";
import { checkConfigPath, checkConfigValue } from "./preflight.ts";
import { buildMergePatch } from "./merge-patch.ts";

// These tests cover the transport-safety preflight checks, not authoritative
// schema validation (which belongs to openclaw core and the repo-side workflow).

describe("checkConfigPath (supported-subset gate)", () => {
  it("accepts valid dot-delimited paths", () => {
    expect(checkConfigPath("agents.defaults.model.primary")).toBeNull();
    expect(checkConfigPath("channels.telegram.enabled")).toBeNull();
    expect(checkConfigPath("singleSegment")).toBeNull();
    expect(checkConfigPath("a_b-c.d_e")).toBeNull();
  });

  it("rejects empty path", () => {
    expect(checkConfigPath("")).toMatch(/must not be empty/);
  });

  it("rejects segments starting with digits", () => {
    expect(checkConfigPath("agents.0bad")).toMatch(/Unsupported path segment/);
  });

  it("rejects segments with special characters", () => {
    expect(checkConfigPath("agents.foo[0]")).toMatch(/Unsupported path segment/);
    expect(checkConfigPath("agents.foo bar")).toMatch(/Unsupported path segment/);
    expect(checkConfigPath("agents.foo.bar.baz[id=main]")).toMatch(/Unsupported path segment/);
  });

  it("rejects paths with empty segments (consecutive dots)", () => {
    expect(checkConfigPath("agents..model")).toMatch(/Unsupported path segment/);
  });

  it("rejects segments starting with a hyphen", () => {
    expect(checkConfigPath("-bad")).toMatch(/Unsupported path segment/);
  });
});

describe("checkConfigValue (JSON transport safety)", () => {
  it("accepts valid JSON strings", () => {
    expect(checkConfigValue('"google/gemini-3-flash"')).toBeNull();
    expect(checkConfigValue("true")).toBeNull();
    expect(checkConfigValue("false")).toBeNull();
    expect(checkConfigValue("42")).toBeNull();
    expect(checkConfigValue('{"key":"val"}')).toBeNull();
    expect(checkConfigValue("[]")).toBeNull();
    expect(checkConfigValue('["a","b"]')).toBeNull();
  });

  it("rejects null", () => {
    expect(checkConfigValue("null")).toMatch(/must not be JSON null/);
  });

  it("rejects invalid JSON", () => {
    expect(checkConfigValue("not-json")).toMatch(/must be valid JSON/);
    expect(checkConfigValue("")).toMatch(/must be valid JSON/);
    expect(checkConfigValue("google/gemini-3-flash")).toMatch(/must be valid JSON/);
  });
});

describe("buildMergePatch (dot-path to nested object)", () => {
  it("builds nested object from multi-segment path", () => {
    expect(buildMergePatch("agents.defaults.model.primary", "google/gemini-3-flash")).toEqual({
      agents: { defaults: { model: { primary: "google/gemini-3-flash" } } },
    });
  });

  it("handles single-segment path", () => {
    expect(buildMergePatch("enabled", true)).toEqual({ enabled: true });
  });

  it("handles two-segment path", () => {
    expect(buildMergePatch("channels.telegram", { enabled: true, streaming: false })).toEqual({
      channels: { telegram: { enabled: true, streaming: false } },
    });
  });

  it("preserves array values (merge-patch replaces arrays wholesale)", () => {
    expect(buildMergePatch("agents.defaults.model.fallbacks", ["a", "b"])).toEqual({
      agents: { defaults: { model: { fallbacks: ["a", "b"] } } },
    });
  });

  it("handles numeric and boolean values", () => {
    expect(buildMergePatch("some.setting", 42)).toEqual({ some: { setting: 42 } });
    expect(buildMergePatch("some.flag", false)).toEqual({ some: { flag: false } });
  });
});
