// Agent management tools — ported from coding-assistant skill scripts.
// These tools let the LLM manage the agent roster (list / add / remove / sync)
// without needing to know filesystem paths or CLI invocations.

import { Type } from "typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  type AgentEntry,
  openclaw,
  resolveEffectiveCwd,
  readConfig,
  writeConfig,
} from "./agent-roster.js";
import { log } from "./log.js";

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
        const enriched = agents.map((a) => ({ ...a, cwd: resolveEffectiveCwd(a) }));
        return textResult(JSON.stringify(enriched, null, 2));
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
      "Add or replace a coding agent in the roster. " +
      "For remote ACP agents, provide nodeName to route via the paired node. " +
      "Use the agent parameter to specify the ACP agent variant (e.g. 'claude', 'codex', 'gemini'); defaults to 'claude'.",
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
        const existing = config.agents.list.findIndex((a) => a.id === name);
        const newAgent: AgentEntry = { id: name, name };

        if (nodeName) {
          newAgent.runtime = { type: "acp", acp: { agent: agent || "claude", cwd: path, nodeName } };
        } else {
          newAgent.workspace = path;
        }
        if (model) {
          newAgent.model = model;
        }

        if (existing !== -1) {
          log.warn(`coding_agent_add: replacing existing agent "${name}"`);
          config.agents.list[existing] = newAgent;
        } else {
          config.agents.list.push(newAgent);
        }
        writeConfig(config);
        log.info(`coding_agent_add: added "${name}" (ACP: ${nodeName || "no"}, agent: ${newAgent.runtime?.acp?.agent ?? "n/a"})`);
        return textResult(`Added agent "${name}" (ACP: ${nodeName || "no"}, agent: ${newAgent.runtime?.acp?.agent ?? "local"}).`);
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
