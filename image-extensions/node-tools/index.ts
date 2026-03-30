/**
 * node-tools plugin — /node
 *
 * Manage paired node devices (Mac nodes connected via `make node`).
 * Uses openclaw plugin-sdk device-pair surface — runs in-process,
 * no WebSocket or CLI needed.
 *
 * Subcommands:
 *   /node                          — show help
 *   /node pair                     — list pending node pairing requests
 *   /node pair approve [id]        — approve a pending request (or approve all)
 *   /node list                     — list paired nodes
 */

import {
  listDevicePairing,
  approveDevicePairing,
} from "openclaw/plugin-sdk/device-bootstrap";

// ── Helpers ──────────────────────────────────────────────────

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function ago(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Handlers ─────────────────────────────────────────────────

async function handlePairList(): Promise<string> {
  const { pending } = await listDevicePairing();
  const nodeRequests = pending.filter(
    (r: any) => r.clientId === "node-host" || r.clientMode === "node",
  );

  if (nodeRequests.length === 0) {
    return "No pending node pairing requests.";
  }

  const lines: string[] = [`Pending node pairing requests (${nodeRequests.length}):`, ""];
  for (const req of nodeRequests) {
    lines.push(`  ${req.displayName || req.deviceId}`);
    lines.push(`  ID: ${req.requestId}`);
    lines.push(`  Platform: ${req.platform || "unknown"}`);
    if (req.remoteIp) lines.push(`  IP: ${req.remoteIp}`);
    lines.push(`  Requested: ${ago(req.ts)}`);
    lines.push("");
  }
  lines.push("Use /node pair approve <id> to approve.");
  lines.push("Use /node pair approve all to approve all.");

  return lines.join("\n");
}

async function handlePairApprove(idArg: string): Promise<string> {
  if (!idArg) {
    return "[FAIL] Usage: /node pair approve <requestId|all>";
  }

  const { pending } = await listDevicePairing();
  const nodeRequests = pending.filter(
    (r: any) => r.clientId === "node-host" || r.clientMode === "node",
  );

  if (nodeRequests.length === 0) {
    return "[FAIL] No pending node pairing requests.";
  }

  const allScopes = [
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.pairing",
    "node",
  ];

  if (idArg === "all") {
    const results: string[] = [];
    for (const req of nodeRequests) {
      const result: any = await approveDevicePairing(req.requestId, { callerScopes: allScopes });
      if (result?.status === "approved") {
        results.push(`[PASS] Approved: ${req.displayName || req.deviceId}`);
      } else {
        results.push(`[FAIL] Failed to approve: ${req.displayName || req.requestId} (${result?.status || "null"}: ${result?.missingScope || ""})`);
      }
    }
    return results.join("\n");
  }

  // Match by requestId prefix or full id
  const match = nodeRequests.find(
    (r: any) => r.requestId === idArg || r.requestId.startsWith(idArg),
  );
  if (!match) {
    return `[FAIL] No pending node request matching "${idArg}".\nUse /node pair to list requests.`;
  }

  const result: any = await approveDevicePairing(match.requestId, { callerScopes: allScopes });
  if (result?.status === "approved") {
    return `[PASS] Approved: ${match.displayName || match.deviceId}\nRun \`make node\` again to connect.`;
  }
  return `[FAIL] Failed to approve request ${match.requestId} (${result?.status || "null"}: ${result?.missingScope || ""}).`;
}

async function handleList(): Promise<string> {
  const { paired } = await listDevicePairing();
  const nodes = paired.filter(
    (d: any) => d.clientId === "node-host" || d.clientMode === "node",
  );

  if (nodes.length === 0) {
    return "No paired nodes.";
  }

  const lines: string[] = [`Paired nodes (${nodes.length}):`, ""];
  for (const node of nodes) {
    lines.push(`  ${node.displayName || node.deviceId}`);
    lines.push(`  Platform: ${node.platform || "unknown"}`);
    lines.push(`  Paired: ${formatTime(node.approvedAtMs)}`);
    if (node.lastConnectedAtMs) {
      lines.push(`  Last seen: ${ago(node.lastConnectedAtMs)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function showHelp(): string {
  return [
    "Node management commands:",
    "",
    "  /node pair              — List pending node pairing requests",
    "  /node pair approve <id> — Approve a pending request",
    "  /node pair approve all  — Approve all pending requests",
    "  /node list              — List paired nodes",
  ].join("\n");
}

// ── Plugin registration ──────────────────────────────────────

export default function register(api: any) {
  api.registerCommand({
    name: "node",
    description: "Node management — /node pair|list",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try {
        const args = ctx.args?.trim() ?? "";
        const parts = args.split(/\s+/).filter(Boolean);
        const group = parts[0] || "";
        const sub = parts[1] || "";
        const rest = parts.slice(2).join(" ");

        let text: string;

        switch (group) {
          case "pair":
            switch (sub) {
              case "approve":
                text = await handlePairApprove(rest);
                break;
              case "list":
              case "":
                text = await handlePairList();
                break;
              default:
                text = `Unknown pair subcommand: ${sub}\n\nUsage: /node pair [list|approve <id|all>]`;
            }
            break;

          case "list":
            text = await handleList();
            break;

          case "help":
          case "":
            text = showHelp();
            break;

          default:
            text = `Unknown subcommand: ${group}\n\n${showHelp()}`;
        }

        return { text };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[node-tools] command error: ${msg}`, err instanceof Error ? err.stack : undefined);
        return { text: `[ERROR] ${msg}` };
      }
    },
  });
}
