// Shared agent roster types and helpers — used by both agent-tools.ts and tool.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type AgentEntry = {
  id: string;
  name?: string;
  workspace?: string;
  model?: string;
  isDefault?: boolean;
  runtime?: {
    type: string;
    acp?: { agent?: string; cwd?: string; nodeName?: string };
  };
};

/** Resolve openclaw config path: $OPENCLAW_STATE_DIR/openclaw.json or ~/.openclaw/openclaw.json */
export function resolveConfigPath(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  const base = stateDir || path.join(os.homedir(), ".openclaw");
  return path.join(base, "openclaw.json");
}

export function openclaw(...args: string[]): string {
  return execFileSync("openclaw", args, { encoding: "utf8", timeout: 30_000 }).trim();
}

/** Prefer runtime.acp.cwd for ACP agents; fall back to gateway-local workspace. */
export function resolveEffectiveCwd(agent: AgentEntry): string {
  if (agent.runtime?.type === "acp" && agent.runtime.acp?.cwd) {
    return agent.runtime.acp.cwd;
  }
  return agent.workspace ?? "";
}

export function readConfig(): { agents: { list: AgentEntry[] } } {
  return JSON.parse(fs.readFileSync(resolveConfigPath(), "utf8"));
}

export function writeConfig(config: unknown): void {
  fs.writeFileSync(resolveConfigPath(), JSON.stringify(config, null, 2));
}

/** Look up an agent by id and resolve its effective cwd + variant. Returns null if not found. */
export function resolveAgentById(agentId: string): { cwd: string; agent: string } | null {
  try {
    const config = readConfig();
    const entry = config.agents.list.find((a) => a.id === agentId);
    if (!entry) return null;
    return {
      cwd: resolveEffectiveCwd(entry),
      agent: entry.runtime?.acp?.agent ?? "",
    };
  } catch {
    return null;
  }
}
