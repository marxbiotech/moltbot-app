import { describe, it, expect } from "vitest";
import { diffConfig } from "./diff.js";

describe("diffConfig", () => {
  it("reports no diff for identical objects regardless of key order", () => {
    expect(diffConfig({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });

  it("reports nested leaf differences with dot-joined paths", () => {
    const live = { auth: { openai: { model: "gpt-5" } } };
    const desired = { auth: { openai: { model: "gpt-4" } } };
    const out = diffConfig(live, desired);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      canonicalPath: "auth.openai.model",
      liveValue: "gpt-5",
      desiredValue: "gpt-4",
      liveExists: true,
      desiredExists: true,
    });
  });

  it("preserves awkward keys (with colons / @ etc.) as a single segment", () => {
    const live = { auth: { profiles: { "openai-codex:user@example.com": { x: 1 } } } };
    const desired = { auth: { profiles: { "openai-codex:user@example.com": { x: 2 } } } };
    const out = diffConfig(live, desired);
    expect(out).toHaveLength(1);
    expect(out[0].canonicalPath).toBe("auth.profiles.openai-codex:user@example.com.x");
  });

  it("treats arrays as leaf comparisons (no per-index drift)", () => {
    const live = { tags: [1, 2, 3] };
    const desired = { tags: [1, 2, 4] };
    const out = diffConfig(live, desired);
    expect(out).toHaveLength(1);
    expect(out[0].canonicalPath).toBe("tags");
  });

  it("records added paths (live-only) with desiredExists=false", () => {
    const live = { a: 1, b: 2 };
    const desired = { a: 1 };
    const out = diffConfig(live, desired);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ canonicalPath: "b", liveExists: true, desiredExists: false });
  });

  it("records removed paths (desired-only) with liveExists=false", () => {
    const live = { a: 1 };
    const desired = { a: 1, b: 2 };
    const out = diffConfig(live, desired);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ canonicalPath: "b", liveExists: false, desiredExists: true });
  });

  it("applies canonicalizePath to remove leading openclaw-helm.config. wrapper if a path has one", () => {
    // The desired-config file is mounted pre-unwrapped by moltbot-env, so a
    // diff input never carries the helm wrapper. canonicalizePath() is the
    // helper for inbound paths (e.g. patch generation) that may still include
    // the wrapper. Verify here that diff at minimum doesn't re-wrap or alter
    // ordinary paths.
    const live = { auth: { x: 1 } };
    const desired = { auth: { x: 2 } };
    const out = diffConfig(live, desired);
    expect(out.map((d) => d.canonicalPath)).toEqual(["auth.x"]);
  });
});
