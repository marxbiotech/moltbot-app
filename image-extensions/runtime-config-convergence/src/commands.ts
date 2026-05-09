// /config-drift command surface.
//
// Subcommands per issue #35 §7:
//   status, scan, list [--all], show <id>, ignore <id>, unignore <id>,
//   patch <id...>, notify-test
//
// Patch generation (`patch <id...>`) is intentionally a v1 stub that produces
// a structurally-correct JSON patch but does NOT auto-dispatch to the
// set-config workflow. See issue #35 §9.

import { existsSync } from "node:fs";
import type { ConvergenceConfig, DriftCandidate } from "./types.js";
import {
  ignoreCandidate as queueIgnore,
  listCandidates,
  readQueue,
  unignoreCandidate as queueUnignore,
  writeQueue,
  QueueParseError,
} from "./queue.js";
import {
  buildAdapter,
  formatCandidateNotification,
  type NotificationAdapter,
} from "./notifications.js";
import { runScan, type DetectorDeps } from "./detector.js";

export interface CommandDeps {
  /** Resolved at register time. */
  queuePath: string;
  persona: string;
  config: ConvergenceConfig;
  /**
   * For commands, the live config snapshot is provided per-call via
   * `ctx.config` from PluginCommandContext. The command handler passes it
   * through `loadLiveConfigForScan` when a `scan` subcommand fires.
   */
  loadLiveConfigForScan: (ctxConfig: unknown) => () => unknown;
  /** Optional shared notification adapter (so notify-test reuses the same one). */
  adapter?: NotificationAdapter;
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

export interface CommandHandlerCtx {
  /** PluginCommandContext.args. */
  args?: string;
  /**
   * PluginCommandContext.config — live runtime config snapshot.
   * Required for `scan`; ignored by all other subcommands. Marked optional
   * here so non-scan callers don't need to fabricate one.
   */
  config?: unknown;
}

export interface CommandResult {
  text: string;
}

function showHelp(): string {
  return [
    "Usage: /config-drift <subcommand>",
    "",
    "  status                — show queue path, inputs, and counts",
    "  scan                  — run one detection pass and report counts",
    "  list [--all]          — list active candidates (--all includes ignored/superseded)",
    "  show <id>             — show a candidate's full record",
    "  ignore <id>           — permanently ignore this exact (path, value) pair",
    "  unignore <id>         — return an ignored candidate to active",
    "  patch <id...>         — generate a JSON patch (does not auto-dispatch)",
    "  notify-test           — send a test notification through the configured transport",
  ].join("\n");
}

function formatCandidateLine(c: DriftCandidate): string {
  const status = c.status === "active" ? "" : ` [${c.status}]`;
  return `  ${c.id}  ${c.canonicalPath}  reason=${c.reasonCode}${status}  seen=${c.seenCount}`;
}

function formatCandidateDetails(c: DriftCandidate): string {
  const lines = [
    `id:               ${c.id}`,
    `canonicalPath:    ${c.canonicalPath}`,
    `reasonCode:       ${c.reasonCode}`,
    `status:           ${c.status}`,
    `firstSeenAt:      ${c.firstSeenAt}`,
    `lastSeenAt:       ${c.lastSeenAt}`,
    `seenCount:        ${c.seenCount}`,
    `liveValueHash:    ${c.liveValueHash}`,
  ];
  if (c.desiredValueHash) lines.push(`desiredValueHash: ${c.desiredValueHash}`);
  if (c.supersededBy) lines.push(`supersededBy:     ${c.supersededBy}`);
  if (c.ignoredAt) lines.push(`ignoredAt:        ${c.ignoredAt} (${c.ignoreScope ?? "exact-pair"})`);
  if (c.notification.firstNotifiedAt) lines.push(`firstNotifiedAt:  ${c.notification.firstNotifiedAt}`);
  if (c.notification.lastNotificationError) lines.push(`lastNotificationError: ${c.notification.lastNotificationError}`);
  lines.push(`summary:          kind=${c.summary.valueKind}, redacted=${c.summary.redacted}`);
  return lines.join("\n");
}

function dryRunPatchForCandidate(c: DriftCandidate): { patch: Record<string, unknown>; reason?: string } | { error: string } {
  if (c.reasonCode === "secret-shape-violation") {
    return { error: `Refusing to patch secret-shape-violation: ${c.canonicalPath}` };
  }
  if (c.summary.redacted) {
    return { error: `Refusing to patch redacted/secret-like path: ${c.canonicalPath}` };
  }
  // v1: stub. Producing the actual patch requires the live value, which is
  // not stored in the queue (we only keep the hash + redacted summary). The
  // operator should re-fetch the live value at apply time. We emit a marker
  // patch shape and a clear note.
  const segments = c.canonicalPath.split(".");
  let cursor: Record<string, unknown> = {};
  const root = cursor;
  for (let i = 0; i < segments.length - 1; i++) {
    const next: Record<string, unknown> = {};
    cursor[segments[i]] = next;
    cursor = next;
  }
  cursor[segments[segments.length - 1]] = `<placeholder for ${c.canonicalPath}; live value not stored>`;
  return { patch: root };
}

export async function handleCommand(
  deps: CommandDeps,
  ctx: CommandHandlerCtx,
): Promise<CommandResult> {
  const args = (ctx.args ?? "").trim();
  const parts = args.split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? "";
  const rest = parts.slice(1);
  const adapter = deps.adapter ?? buildAdapter(deps.config.notification);

  let queue;
  try {
    queue = readQueue(deps.queuePath, deps.persona);
  } catch (e: unknown) {
    if (e instanceof QueueParseError) {
      return { text: `[FAIL] ${e.message}\n\nThe queue file is malformed and was NOT overwritten. Inspect/repair manually before retrying.` };
    }
    throw e;
  }

  switch (sub) {
    case "":
    case "help":
      return { text: showHelp() };

    case "status": {
      const counts = listCandidates(queue, { includeIgnored: true, includeSuperseded: true });
      const active = counts.filter((c) => c.status === "active").length;
      const ignored = counts.filter((c) => c.status === "ignored").length;
      const superseded = counts.filter((c) => c.status === "superseded").length;
      const desiredAvailable = !!deps.config.desiredConfigPath && existsSync(deps.config.desiredConfigPath);
      const policyAvailable = !!deps.config.ownershipPolicyPath && existsSync(deps.config.ownershipPolicyPath);
      const liveSource = deps.config.liveConfigPath ? `file:${deps.config.liveConfigPath}` : "ctx.config / runtime.config.current()";
      const lines = [
        `queuePath:        ${deps.queuePath}`,
        `persona:          ${deps.persona || "(unset)"}`,
        `live source:      ${liveSource}`,
        `desired source:   ${deps.config.desiredConfigPath ?? "(unset)"} (${desiredAvailable ? "available" : "missing"})`,
        `policy source:    ${deps.config.ownershipPolicyPath ?? "(unset)"} (${policyAvailable ? "available" : "missing"})`,
        `notification:     ${adapter.describe()}`,
        `last queue write: ${queue.updatedAt}`,
        `counts:           active=${active}, ignored=${ignored}, superseded=${superseded}`,
      ];
      return { text: lines.join("\n") };
    }

    case "scan": {
      const detectorDeps: DetectorDeps = {
        queuePath: deps.queuePath,
        persona: deps.persona,
        config: deps.config,
        logger: deps.logger,
        loadLiveConfig: deps.loadLiveConfigForScan(ctx.config),
        adapter,
      };
      const result = await runScan(detectorDeps);
      const lines = [
        `Scan complete.`,
        `  active=${result.active}, ignored=${result.ignored}, superseded=${result.superseded}`,
        `  new this scan=${result.newCandidates}`,
        `  notification failures=${result.notificationFailures}`,
        `  adapter=${result.adapter}`,
      ];
      if (!result.inputs.desiredConfigAvailable) lines.push("  warning: desired config not available — diff was empty");
      if (!result.inputs.ownershipPolicyAvailable) lines.push("  warning: ownership policy not available — all drift classified as unknown-runtime-drift");
      if (result.errors.length > 0) {
        lines.push("", "Errors:");
        for (const e of result.errors) lines.push(`  - ${e}`);
      }
      return { text: lines.join("\n") };
    }

    case "list": {
      const all = rest.includes("--all");
      const items = listCandidates(queue, { includeIgnored: all, includeSuperseded: all });
      if (items.length === 0) {
        return { text: all ? "No candidates." : "No active candidates. (Use --all to include ignored/superseded.)" };
      }
      const lines = [`Candidates (${items.length}):`];
      for (const c of items) lines.push(formatCandidateLine(c));
      return { text: lines.join("\n") };
    }

    case "show": {
      const id = rest[0];
      if (!id) return { text: "Usage: /config-drift show <id>" };
      const c = queue.candidates[id];
      if (!c) return { text: `[FAIL] No candidate with id ${id}` };
      return { text: formatCandidateDetails(c) };
    }

    case "ignore": {
      const id = rest[0];
      if (!id) return { text: "Usage: /config-drift ignore <id>" };
      if (!queue.candidates[id]) return { text: `[FAIL] No candidate with id ${id}` };
      const ok = queueIgnore(queue, id);
      if (!ok) return { text: `[FAIL] Cannot ignore ${id} (status: ${queue.candidates[id].status})` };
      writeQueue(deps.queuePath, queue);
      return { text: `[PASS] Ignored ${id}. The exact (path, value) pair will not notify again.` };
    }

    case "unignore": {
      const id = rest[0];
      if (!id) return { text: "Usage: /config-drift unignore <id>" };
      if (!queue.candidates[id]) return { text: `[FAIL] No candidate with id ${id}` };
      const ok = queueUnignore(queue, id);
      if (!ok) return { text: `[FAIL] Cannot unignore ${id} (status: ${queue.candidates[id].status})` };
      writeQueue(deps.queuePath, queue);
      return { text: `[PASS] Unignored ${id}.` };
    }

    case "notify-test": {
      const ready = adapter.ready();
      if (!ready.ok) return { text: `[FAIL] notify-test: ${ready.reason}\nAdapter: ${adapter.describe()}` };
      const result = await adapter.send(`/config-drift notify-test from ${deps.persona || "unknown"} at ${new Date().toISOString()}`);
      if (!result.ok) return { text: `[FAIL] ${adapter.describe()}: ${result.error ?? "(no error)"}` };
      if (result.noSend) return { text: `[OK] ${adapter.describe()} — no-send mode (transport=${deps.config.notification.transport}); test path exercised.` };
      return { text: `[PASS] Sent test message via ${adapter.describe()}.` };
    }

    case "patch": {
      if (rest.length === 0) return { text: "Usage: /config-drift patch <id...>" };
      const lines: string[] = [];
      const combinedPatch: Record<string, unknown> = {};
      let compatible = true;
      for (const id of rest) {
        const c = queue.candidates[id];
        if (!c) { lines.push(`[SKIP] ${id}: not found`); continue; }
        if (c.status !== "active") { lines.push(`[SKIP] ${id}: status=${c.status}`); continue; }
        const r = dryRunPatchForCandidate(c);
        if ("error" in r) { lines.push(`[SKIP] ${id}: ${r.error}`); compatible = false; continue; }
        // Merge naively (deep-merge would be needed for production patch generation).
        Object.assign(combinedPatch, r.patch);
        // Mark incompatible if path contains characters not allowed by current
        // apply-config-patch.sh (issue #35 §9 / set-config preflight gate).
        if (!/^[a-zA-Z_][\w.-]*(?:\.[a-zA-Z_][\w.-]*)*$/.test(c.canonicalPath)) {
          compatible = false;
          lines.push(`[NOTE] ${id}: path "${c.canonicalPath}" contains characters not supported by current set-config.yml`);
        }
      }
      lines.push("");
      lines.push("v1 stub: patch generation produces a placeholder shape only — live values are not stored in the queue.");
      lines.push("Re-fetch the live value at apply time and substitute, then dispatch through manage-secrets/set-config.yml.");
      lines.push("");
      lines.push(`compatible with current set-config.yml: ${compatible ? "yes" : "no"}`);
      lines.push("");
      lines.push("Patch (placeholder):");
      lines.push(JSON.stringify(combinedPatch, null, 2));
      return { text: lines.join("\n") };
    }

    default:
      return { text: `Unknown subcommand: ${sub}\n\n${showHelp()}` };
  }
}
