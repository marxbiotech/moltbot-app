import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScan } from "./detector.js";
import type { ConvergenceConfig, OwnershipPolicy } from "./types.js";
import { writeFileSync } from "node:fs";

function buildConfig(extra: Partial<ConvergenceConfig> = {}): ConvergenceConfig {
  return {
    scanIntervalMs: 0,
    notification: { transport: "log-only" },
    dryRun: false,
    expectedSecretDriftNotify: false,
    ...extra,
  };
}

describe("runScan integration", () => {
  let dir: string;
  let queuePath: string;
  let desiredPath: string;
  let policyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rcc-detector-test-"));
    queuePath = join(dir, "queue.json");
    desiredPath = join(dir, "desired.json");
    policyPath = join(dir, "policy.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates new candidates for diffs and writes the queue", async () => {
    writeFileSync(desiredPath, JSON.stringify({ auth: { x: "desired" } }));
    const policy: OwnershipPolicy = { repoOwnedPaths: ["auth.x"] };
    writeFileSync(policyPath, JSON.stringify(policy));

    const live = { auth: { x: "live" } };
    const result = await runScan({
      queuePath,
      persona: "test",
      config: buildConfig({ desiredConfigPath: desiredPath, ownershipPolicyPath: policyPath }),
      loadLiveConfig: () => live,
    });

    expect(result.newCandidates).toBe(1);
    expect(result.active).toBe(1);
    expect(result.notificationFailures).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("re-running scan with same live/desired produces zero new candidates", async () => {
    writeFileSync(desiredPath, JSON.stringify({ auth: { x: "desired" } }));
    writeFileSync(policyPath, JSON.stringify({ repoOwnedPaths: ["auth.x"] } satisfies OwnershipPolicy));
    const config = buildConfig({ desiredConfigPath: desiredPath, ownershipPolicyPath: policyPath });

    const live = { auth: { x: "live" } };
    await runScan({ queuePath, persona: "test", config, loadLiveConfig: () => live });
    const second = await runScan({ queuePath, persona: "test", config, loadLiveConfig: () => live });
    expect(second.newCandidates).toBe(0);
    expect(second.active).toBe(1);
  });

  it("skips notification when desired config is missing (no diff possible)", async () => {
    const result = await runScan({
      queuePath,
      persona: "test",
      config: buildConfig(), // no desired path
      loadLiveConfig: () => ({ auth: { x: "live" } }),
    });
    expect(result.newCandidates).toBe(0);
    expect(result.active).toBe(0);
  });

  it("dryRun=true creates candidates but does not call adapter", async () => {
    writeFileSync(desiredPath, JSON.stringify({ auth: { x: "desired" } }));
    writeFileSync(policyPath, JSON.stringify({ repoOwnedPaths: ["auth.x"] } satisfies OwnershipPolicy));
    const adapterSend = vi.fn().mockResolvedValue({ ok: true });
    const adapter = {
      describe: () => "mock",
      ready: () => ({ ok: true as const }),
      send: adapterSend,
    };
    const result = await runScan({
      queuePath,
      persona: "test",
      config: buildConfig({
        desiredConfigPath: desiredPath,
        ownershipPolicyPath: policyPath,
        dryRun: true,
      }),
      loadLiveConfig: () => ({ auth: { x: "live" } }),
      adapter,
    });
    expect(result.newCandidates).toBe(1);
    expect(adapterSend).not.toHaveBeenCalled();
  });

  it("records adapter failure on the candidate without aborting", async () => {
    writeFileSync(desiredPath, JSON.stringify({ auth: { x: "desired" } }));
    writeFileSync(policyPath, JSON.stringify({ repoOwnedPaths: ["auth.x"] } satisfies OwnershipPolicy));
    const adapter = {
      describe: () => "mock",
      ready: () => ({ ok: true as const }),
      send: vi.fn().mockResolvedValue({ ok: false, error: "boom" }),
    };
    const result = await runScan({
      queuePath,
      persona: "test",
      config: buildConfig({ desiredConfigPath: desiredPath, ownershipPolicyPath: policyPath }),
      loadLiveConfig: () => ({ auth: { x: "live" } }),
      adapter,
    });
    expect(result.notificationFailures).toBe(1);
    expect(result.errors[0]).toContain("boom");
    expect(result.active).toBe(1); // candidate kept
  });

  it("returns malformed-queue error without overwriting", async () => {
    writeFileSync(queuePath, "{not json", "utf8");
    const result = await runScan({
      queuePath,
      persona: "test",
      config: buildConfig(),
      loadLiveConfig: () => ({}),
    });
    expect(result.errors[0]).toContain("queue parse error");
  });
});
