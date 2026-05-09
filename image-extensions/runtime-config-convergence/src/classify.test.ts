import { describe, it, expect } from "vitest";
import { classifyDiff } from "./classify.js";
import type { DiffEntry, OwnershipPolicy } from "./types.js";

function entry(path: string, live: unknown, desired: unknown): DiffEntry {
  return {
    canonicalPath: path,
    liveValue: live,
    desiredValue: desired,
    liveExists: live !== undefined,
    desiredExists: desired !== undefined,
  };
}

describe("classifyDiff", () => {
  it("classifies repo-owned paths as repo-owned-drift", () => {
    const policy: OwnershipPolicy = { repoOwnedPaths: ["auth.openai.model"] };
    const result = classifyDiff([entry("auth.openai.model", "gpt-5", "gpt-4")], policy);
    expect(result).toHaveLength(1);
    expect(result[0].reasonCode).toBe("repo-owned-drift");
  });

  it("classifies unclassified paths as unknown-runtime-drift", () => {
    const result = classifyDiff([entry("messages.tone", "casual", "formal")], {});
    expect(result[0].reasonCode).toBe("unknown-runtime-drift");
  });

  it("classifies non-env-ref live values on secret paths as secret-shape-violation", () => {
    const policy: OwnershipPolicy = { secretRefPaths: ["auth.token"] };
    const result = classifyDiff(
      [entry("auth.token", "actual-secret-not-an-env-ref", "$ENV:TOKEN")],
      policy,
    );
    expect(result[0].reasonCode).toBe("secret-shape-violation");
  });

  it("treats env-ref drift on secret paths as repo-owned-drift", () => {
    const policy: OwnershipPolicy = { secretRefPaths: ["auth.token"] };
    const result = classifyDiff(
      [entry("auth.token", "$ENV:TOKEN_OLD", "$ENV:TOKEN_NEW")],
      policy,
    );
    expect(result[0].reasonCode).toBe("repo-owned-drift");
  });

  it("classifies expected-secret-drift before secret-shape-violation", () => {
    const policy: OwnershipPolicy = {
      expectedSecretDriftPaths: ["auth.session"],
      secretRefPaths: ["auth.session"],
    };
    const result = classifyDiff(
      [entry("auth.session", "rotated-token", "$ENV:SESSION")],
      policy,
    );
    expect(result[0].reasonCode).toBe("expected-secret-drift");
  });

  it("filters out top-level scalar drift (canonicalPath empty)", () => {
    const result = classifyDiff([entry("", "a", "b")], {});
    expect(result).toHaveLength(0);
  });
});
