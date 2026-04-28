// Agent management tools — ported from coding-assistant skill scripts.
// These tools let the LLM manage the agent roster (list / add / remove / sync)
// without needing to know filesystem paths or CLI invocations.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { log } from "./log.js";

type AgentEntry = {
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
function resolveConfigPath(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  const base = stateDir || path.join(os.homedir(), ".openclaw");
  return path.join(base, "openclaw.json");
}

function openclaw(...args: string[]): string {
  return execFileSync("openclaw", args, { encoding: "utf8", timeout: 30_000 }).trim();
}

function resolveEffectiveCwd(agent: AgentEntry): string {
  if (agent.runtime?.type === "acp" && agent.runtime.acp?.cwd) {
    return agent.runtime.acp.cwd;
  }
  return agent.workspace ?? "";
}

function readConfig(): { agents: { list: AgentEntry[] } } {
  return JSON.parse(fs.readFileSync(resolveConfigPath(), "utf8"));
}

function writeConfig(config: unknown): void {
  fs.writeFileSync(resolveConfigPath(), JSON.stringify(config, null, 2));
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function registerAgentTools(api: OpenClawPluginApi): void {
  // ── coding_agents_list ──────────────────────────────────────────────
  api.registerTool({
    name: "coding_agents_list",
    label: "List Coding Agents",
    description:
      "List all configured coding agents with their effective working directories. " +
      "Returns JSON array; each entry has id, cwd (effective), workspace (gateway-local), runtime info, and isDefault flag.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const agents: AgentEntry[] = JSON.parse(openclaw("agents", "list", "--json"));
        for (const agent of agents) {
          (agent as AgentEntry & { cwd: string }).cwd = resolveEffectiveCwd(agent);
        }
        return textResult(JSON.stringify(agents, null, 2));
      } catch (err) {
        const msg = err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
        log.error(`coding_agents_list failed: ${msg}`);
        return textResult(`Error: ${msg}`);
      }
    },
  });

  // ── coding_agent_add ────────────────────────────────────────────────
  api.registerTool({
    name: "coding_agent_add",
    label: "Add Coding Agent",
    description:
      "Add a new coding agent to the roster. " +
      "For remote ACP agents, provide nodeName to route via the paired node. " +
      "Use the agent parameter to specify the ACP agent variant (e.g. 'claude', 'codex'); defaults to 'claude'.",
    parameters: Type.Object({
      name: Type.String({ description: "Agent identifier (used as id)" }),
      path: Type.String({ description: "Workspace path (local) or remote cwd (when nodeName is set)" }),
      nodeName: Type.Optional(Type.String({ description: "Target node displayName for ACP routing" })),
      model: Type.Optional(Type.String({ description: "Model override for this agent" })),
      agent: Type.Optional(Type.String({ description: "ACP agent variant (default: 'claude')" })),
    }),
    async execute(_toolCallId, params) {
      const { name, path, nodeName, model, agent } = params as {
        name: string;
        path: string;
        nodeName?: string;
        model?: string;
        agent?: string;
      };
      try {
        const config = readConfig();
        const newAgent: AgentEntry = { id: name, name };

        if (nodeName) {
          newAgent.runtime = { type: "acp", acp: { agent: agent || "claude", cwd: path, nodeName } };
        } else {
          newAgent.workspace = path;
        }
        if (model) {
          newAgent.model = model;
        }

        config.agents.list.push(newAgent);
        writeConfig(config);
        log.info(`coding_agent_add: added "${name}" (ACP: ${nodeName || "no"})`);
        return textResult(`Added agent "${name}" (ACP: ${nodeName || "no"}).`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`coding_agent_add failed: ${msg}`);
        return textResult(`Error: ${msg}`);
      }
    },
  });

  // ── coding_agent_remove ─────────────────────────────────────────────
  api.registerTool({
    name: "coding_agent_remove",
    label: "Remove Coding Agent",
    description: "Remove a coding agent from the roster by its id.",
    parameters: Type.Object({
      id: Type.String({ description: "Agent id to remove" }),
    }),
    async execute(_toolCallId, params) {
      const { id } = params as { id: string };
      try {
        const result = openclaw("agents", "delete", id, "--force", "--json");
        log.info(`coding_agent_remove: removed "${id}"`);
        return textResult(result);
      } catch (err) {
        const msg = err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
        log.error(`coding_agent_remove failed: ${msg}`);
        return textResult(`Error: ${msg}`);
      }
    },
  });

  // ── coding_agent_sync ───────────────────────────────────────────────
  api.registerTool({
    name: "coding_agent_sync",
    label: "Sync Coding Agents",
    description:
      "Copy the workspace/runtime config from a source agent to a target agent, " +
      "making them share the same working directory and session context.",
    parameters: Type.Object({
      sourceId: Type.String({ description: "Source agent id (copy from)" }),
      targetId: Type.String({ description: "Target agent id (copy to)" }),
    }),
    async execute(_toolCallId, params) {
      const { sourceId, targetId } = params as { sourceId: string; targetId: string };
      try {
        const config = readConfig();
        const agents = config.agents.list;
        const source = agents.find((a) => a.id === sourceId);
        const target = agents.find((a) => a.id === targetId);
        if (!source) return textResult(`Error: source agent "${sourceId}" not found.`);
        if (!target) return textResult(`Error: target agent "${targetId}" not found.`);

        if (source.runtime) {
          target.runtime = JSON.parse(JSON.stringify(source.runtime));
          delete target.workspace;
        } else {
          target.workspace = source.workspace;
          delete target.runtime;
        }

        writeConfig(config);
        log.info(`coding_agent_sync: ${targetId} <- ${sourceId}`);
        return textResult(`Synced: ${targetId} now shares workspace with ${sourceId}.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`coding_agent_sync failed: ${msg}`);
        return textResult(`Error: ${msg}`);
      }
    },
  });
}
