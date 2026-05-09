import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand } from "./commands.js";
import { emptyQueue, upsertCandidate, writeQueue } from "./queue.js";
import type { ConvergenceConfig } from "./types.js";

function buildConfig(extra: Partial<ConvergenceConfig> = {}): ConvergenceConfig {
  return {
    scanIntervalMs: 0,
    notification: { transport: "log-only" },
    dryRun: false,
    expectedSecretDriftNotify: false,
    ...extra,
  };
}

const okAdapter = {
  describe: () => "mock-adapter",
  ready: () => ({ ok: true as const }),
  send: vi.fn().mockResolvedValue({ ok: true }),
};

describe("/config-drift command surface", () => {
  let dir: string;
  let queuePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rcc-cmd-test-"));
    queuePath = join(dir, "queue.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    okAdapter.send.mockClear();
  });

  it("help/empty subcommand prints the subcommand index", async () => {
    const r = await handleCommand(
      {
        queuePath,
        persona: "p",
        config: buildConfig(),
        loadLiveConfigForScan: () => () => ({}),
        adapter: okAdapter,
      },
      { args: "" },
    );
    expect(r.text).toContain("Usage: /config-drift");
    expect(r.text).toContain("status");
    expect(r.text).toContain("notify-test");
  });

  it("status reports queue path, counts, and adapter description", async () => {
    const q = emptyQueue("p");
    upsertCandidate(q, {
      canonicalPath: "auth.x",
      liveValue: "live",
      desiredValue: "desired",
      liveExists: true,
      desiredExists: true,
      reasonCode: "repo-owned-drift",
    });
    writeQueue(queuePath, q);

    const r = await handleCommand(
      {
        queuePath,
        persona: "agent-a",
        config: buildConfig(),
        loadLiveConfigForScan: () => () => ({}),
        adapter: okAdapter,
      },
      { args: "status" },
    );
    expect(r.text).toContain(queuePath);
    expect(r.text).toContain("agent-a");
    expect(r.text).toContain("active=1");
    expect(r.text).toContain("mock-adapter");
  });

  it("list shows active candidates, --all includes superseded/ignored", async () => {
    const q = emptyQueue("p");
    upsertCandidate(q, {
      canonicalPath: "auth.x", liveValue: "v1", desiredValue: "v0",
      liveExists: true, desiredExists: true, reasonCode: "unknown-runtime-drift",
    });
    upsertCandidate(q, {
      canonicalPath: "auth.x", liveValue: "v2", desiredValue: "v0",
      liveExists: true, desiredExists: true, reasonCode: "unknown-runtime-drift",
    });
    writeQueue(queuePath, q);

    const list = await handleCommand(
      { queuePath, persona: "p", config: buildConfig(), loadLiveConfigForScan: () => () => ({}), adapter: okAdapter },
      { args: "list" },
    );
    // Only one is active
    expect((list.text.match(/auth\.x/g) ?? []).length).toBe(1);

    const all = await handleCommand(
      { queuePath, persona: "p", config: buildConfig(), loadLiveConfigForScan: () => () => ({}), adapter: okAdapter },
      { args: "list --all" },
    );
    expect((all.text.match(/auth\.x/g) ?? []).length).toBe(2);
  });

  it("show <id> renders candidate details; missing id returns FAIL", async () => {
    const q = emptyQueue("p");
    const r1 = upsertCandidate(q, {
      canonicalPath: "auth.x", liveValue: "v", desiredValue: "v0",
      liveExists: true, desiredExists: true, reasonCode: "repo-owned-drift",
    });
    writeQueue(queuePath, q);

    const ok = await handleCommand(
      { queuePath, persona: "p", config: buildConfig(), loadLiveConfigForScan: () => () => ({}), adapter: okAdapter },
      { args: `show ${r1.candidate.id}` },
    );
    expect(ok.text).toContain("canonicalPath:    auth.x");
    expect(ok.text).toContain("reasonCode:       repo-owned-drift");

    const miss = await handleCommand(
      { queuePath, persona: "p", config: buildConfig(), loadLiveConfigForScan: () => () => ({}), adapter: okAdapter },
      { args: "show no-such-id" },
    );
    expect(miss.text).toContain("[FAIL]");
  });

  it("ignore/unignore round-trips and persists to disk", async () => {
    const q = emptyQueue("p");
    const r1 = upsertCandidate(q, {
      canonicalPath: "auth.x", liveValue: "v", desiredValue: "v0",
      liveExists: true, desiredExists: true, reasonCode: "repo-owned-drift",
    });
    writeQueue(queuePath, q);

    const ig = await handleCommand(
      { queuePath, persona: "p", config: buildConfig(), loadLiveConfigForScan: () => () => ({}), adapter: okAdapter },
      { args: `ignore ${r1.candidate.id}` },
    );
    expect(ig.text).toContain("[PASS]");

    const status = await handleCommand(
      { queuePath, persona: "p", config: buildConfig(), loadLiveConfigForScan: () => () => ({}), adapter: okAdapter },
      { args: "status" },
    );
    expect(status.text).toContain("ignored=1");

    const un = await handleCommand(
      { queuePath, persona: "p", config: buildConfig(), loadLiveConfigForScan: () => () => ({}), adapter: okAdapter },
      { args: `unignore ${r1.candidate.id}` },
    );
    expect(un.text).toContain("[PASS]");
  });

  it("notify-test reports the adapter ready status and exercises the send path", async () => {
    const r = await handleCommand(
      { queuePath, persona: "p", config: buildConfig(), loadLiveConfigForScan: () => () => ({}), adapter: okAdapter },
      { args: "notify-test" },
    );
    expect(okAdapter.send).toHaveBeenCalledTimes(1);
    expect(r.text).toMatch(/\[PASS\]|\[OK\]/);
  });

  it("notify-test reports failure clearly when adapter not ready", async () => {
    const notReady = {
      describe: () => "telegram (token=X(unset))",
      ready: () => ({ ok: false as const, reason: "X is not set" }),
      send: vi.fn(),
    };
    const r = await handleCommand(
      { queuePath, persona: "p", config: buildConfig(), loadLiveConfigForScan: () => () => ({}), adapter: notReady },
      { args: "notify-test" },
    );
    expect(r.text).toContain("[FAIL]");
    expect(r.text).toContain("X is not set");
    expect(notReady.send).not.toHaveBeenCalled();
  });

  it("patch refuses secret-shape-violation candidates and reports incompatibility for awkward keys", async () => {
    const q = emptyQueue("p");
    const secret = upsertCandidate(q, {
      canonicalPath: "auth.token",
      liveValue: "raw-secret-not-an-env-ref",
      desiredValue: "$ENV:TOKEN",
      liveExists: true,
      desiredExists: true,
      reasonCode: "secret-shape-violation",
    });
    const awkward = upsertCandidate(q, {
      canonicalPath: "auth.profiles.openai-codex:user@example.com.x",
      liveValue: "v",
      desiredValue: "v0",
      liveExists: true,
      desiredExists: true,
      reasonCode: "repo-owned-drift",
    });
    writeQueue(queuePath, q);

    const r = await handleCommand(
      { queuePath, persona: "p", config: buildConfig(), loadLiveConfigForScan: () => () => ({}), adapter: okAdapter },
      { args: `patch ${secret.candidate.id} ${awkward.candidate.id}` },
    );
    expect(r.text).toContain("[SKIP]");
    expect(r.text).toContain("secret-shape-violation");
    expect(r.text).toContain("compatible with current set-config.yml: no");
  });

  it("scan invokes runScan with live config provider and returns counts", async () => {
    // Build desired config inline; reuse runScan via the command path.
    const desiredPath = join(dir, "d.json");
    const policyPath = join(dir, "p.json");
    writeFileSync(desiredPath, JSON.stringify({ auth: { x: "desired" } }));
    writeFileSync(policyPath, JSON.stringify({ repoOwnedPaths: ["auth.x"] }));

    const r = await handleCommand(
      {
        queuePath,
        persona: "p",
        config: buildConfig({ desiredConfigPath: desiredPath, ownershipPolicyPath: policyPath }),
        loadLiveConfigForScan: (ctxConfig) => () => ctxConfig,
        adapter: okAdapter,
      },
      { args: "scan", config: { auth: { x: "live" } } },
    );
    expect(r.text).toContain("Scan complete");
    expect(r.text).toContain("active=1");
    expect(r.text).toContain("new this scan=1");
  });

  it("status reports queue parse error without overwriting", async () => {
    writeFileSync(queuePath, "{not json", "utf8");
    const r = await handleCommand(
      { queuePath, persona: "p", config: buildConfig(), loadLiveConfigForScan: () => () => ({}), adapter: okAdapter },
      { args: "status" },
    );
    expect(r.text).toContain("[FAIL]");
    expect(r.text).toContain("malformed");
  });
});
