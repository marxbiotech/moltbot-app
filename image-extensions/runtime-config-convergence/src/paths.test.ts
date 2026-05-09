import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildCandidateId, canonicalizePath, resolveQueuePath } from "./paths.js";

describe("resolveQueuePath", () => {
  it("uses the explicit override when provided", () => {
    expect(resolveQueuePath("/custom/queue.json")).toBe("/custom/queue.json");
  });

  it("falls back to OPENCLAW_HOME-derived path when not provided", () => {
    const previous = process.env.OPENCLAW_HOME;
    try {
      process.env.OPENCLAW_HOME = "/tmp/openclaw-home-test";
      const p = resolveQueuePath();
      expect(p.startsWith("/tmp/openclaw-home-test")).toBe(true);
      expect(p.endsWith("/runtime-config-convergence/queue.json")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = previous;
    }
  });

  it("falls back to homedir/.openclaw when OPENCLAW_HOME is unset", () => {
    const previous = process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_HOME;
    try {
      const p = resolveQueuePath();
      expect(p).toBe(join(homedir(), ".openclaw", "runtime-config-convergence", "queue.json"));
    } finally {
      if (previous !== undefined) process.env.OPENCLAW_HOME = previous;
    }
  });
});

describe("canonicalizePath", () => {
  it("strips a leading openclaw-helm.config. wrapper", () => {
    expect(canonicalizePath("openclaw-helm.config.auth.openai.model")).toBe("auth.openai.model");
  });
  it("returns input unchanged otherwise", () => {
    expect(canonicalizePath("auth.openai.model")).toBe("auth.openai.model");
  });
});

describe("buildCandidateId", () => {
  it("is deterministic for the same input", () => {
    const a = buildCandidateId("auth.openai.model", "abc123def456");
    const b = buildCandidateId("auth.openai.model", "abc123def456");
    expect(a).toBe(b);
  });
  it("differs for different paths or hashes", () => {
    expect(buildCandidateId("a", "h1")).not.toBe(buildCandidateId("a", "h2"));
    expect(buildCandidateId("a", "h1")).not.toBe(buildCandidateId("b", "h1"));
  });
});
