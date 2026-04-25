import { describe, it, expect } from "vitest";
import { checkPatch } from "./preflight.ts";
import { buildMergePatch, extractLeafPaths } from "./merge-patch.ts";

// ---------------------------------------------------------------------------
// extractLeafPaths
// ---------------------------------------------------------------------------

describe("extractLeafPaths", () => {
  it("extracts single leaf path", () => {
    expect(extractLeafPaths({ enabled: true })).toEqual(["enabled"]);
  });

  it("extracts deeply nested leaf path", () => {
    expect(
      extractLeafPaths({ agents: { defaults: { model: { primary: "gemini" } } } }),
    ).toEqual(["agents.defaults.model.primary"]);
  });

  it("extracts multiple leaf paths from a multi-path patch", () => {
    const patch = {
      agents: { defaults: { model: { primary: "gemini", fallbacks: ["a", "b"] } } },
      channels: { telegram: { streaming: true } },
    };
    expect(extractLeafPaths(patch)).toEqual([
      "agents.defaults.model.primary",
      "agents.defaults.model.fallbacks",
      "channels.telegram.streaming",
    ]);
  });

  it("treats arrays as leaf values", () => {
    expect(extractLeafPaths({ list: [1, 2, 3] })).toEqual(["list"]);
  });

  it("treats null as leaf value", () => {
    expect(extractLeafPaths({ removed: null })).toEqual(["removed"]);
  });

  it("returns empty array for empty object", () => {
    expect(extractLeafPaths({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkPatch
// ---------------------------------------------------------------------------

describe("checkPatch", () => {
  it("accepts a valid single-path patch", () => {
    const result = checkPatch('{"agents":{"defaults":{"model":{"primary":"gemini"}}}}');
    expect(result).toEqual({
      leafPaths: ["agents.defaults.model.primary"],
    });
  });

  it("accepts a valid multi-path patch", () => {
    const patch = JSON.stringify({
      agents: { defaults: { model: { primary: "gemini", fallbacks: ["a"] } } },
      channels: { telegram: { streaming: true } },
    });
    const result = checkPatch(patch);
    expect(result).toEqual({
      leafPaths: [
        "agents.defaults.model.primary",
        "agents.defaults.model.fallbacks",
        "channels.telegram.streaming",
      ],
    });
  });

  it("accepts patches with boolean, number, string, array leaf values", () => {
    const patch = JSON.stringify({
      a: { str: "val", num: 42, bool: false, arr: [1, 2] },
    });
    const result = checkPatch(patch);
    expect("leafPaths" in result).toBe(true);
  });

  it("rejects invalid JSON", () => {
    expect(checkPatch("not-json")).toEqual({ error: "patch must be valid JSON" });
  });

  it("rejects non-object JSON (array)", () => {
    expect(checkPatch('[1,2]')).toEqual({ error: "patch must be a JSON object" });
  });

  it("rejects non-object JSON (string)", () => {
    expect(checkPatch('"hello"')).toEqual({ error: "patch must be a JSON object" });
  });

  it("rejects non-object JSON (null)", () => {
    expect(checkPatch("null")).toEqual({ error: "patch must be a JSON object" });
  });

  it("rejects null leaf values (deletion not supported)", () => {
    const patch = JSON.stringify({ agents: { defaults: { model: { primary: null } } } });
    const result = checkPatch(patch);
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/null.*not supported.*agents\.defaults\.model\.primary/);
  });

  it("rejects empty object (no leaf paths)", () => {
    expect(checkPatch("{}")).toEqual({ error: "patch must contain at least one config path" });
  });

  it("rejects nested empty objects (no leaf paths)", () => {
    expect(checkPatch('{"a":{"b":{}}}')).toEqual({
      error: "patch must contain at least one config path",
    });
  });

  it("rejects path segments starting with digits", () => {
    const patch = JSON.stringify({ agents: { "0bad": true } });
    const result = checkPatch(patch);
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/Unsupported path segment/);
  });

  it("rejects path segments with special characters", () => {
    const patch = JSON.stringify({ "foo[0]": true });
    const result = checkPatch(patch);
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/Unsupported path segment/);
  });

  it("rejects patches with too many leaf paths", () => {
    const obj: Record<string, boolean> = {};
    for (let i = 0; i < 21; i++) obj[`key_${i}`] = true;
    const result = checkPatch(JSON.stringify(obj));
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/21 leaf paths.*max 20/);
  });
});

// ---------------------------------------------------------------------------
// buildMergePatch (unchanged — regression tests)
// ---------------------------------------------------------------------------

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
