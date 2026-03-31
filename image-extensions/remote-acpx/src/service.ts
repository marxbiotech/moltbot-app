// Service lifecycle for remote-acpx extension.
// Registers the AcpRuntime backend, the node event handler, and the claude_code tool on start.
// Unregisters all on stop.

import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/remote-acpx";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  registerAcpNodeEventHandler,
  unregisterAcpNodeEventHandler,
} from "openclaw/plugin-sdk/remote-acpx";
import { REMOTE_ACPX_BACKEND_ID, RemoteAcpxRuntime, type RemoteAcpxConfig } from "./runtime.js";
import { routeNodeEvent, drainAllSessions } from "./event-router.js";
import { clearNodeCache } from "./node-resolver.js";
import { registerCodingTool, type CodingToolConfig } from "./tool.js";

type FullConfig = RemoteAcpxConfig & CodingToolConfig;

function resolveConfig(rawConfig: unknown): FullConfig {
  const obj = typeof rawConfig === "object" && rawConfig !== null
    ? (rawConfig as Record<string, unknown>)
    : {};
  return {
    nodeName: typeof obj.nodeName === "string" ? obj.nodeName : "",
    agentCommand: typeof obj.agentCommand === "string" ? obj.agentCommand : "acpx",
    defaultAgent: typeof obj.defaultAgent === "string" ? obj.defaultAgent : "claude",
    cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
    permissionMode: typeof obj.permissionMode === "string" ? obj.permissionMode : "approve-all",
    turnTimeoutMs: typeof obj.turnTimeoutMs === "number" ? obj.turnTimeoutMs : 300_000,
    maxOutputChars: typeof obj.maxOutputChars === "number" ? obj.maxOutputChars : 6000,
  };
}

export function createRemoteAcpxService(params: {
  pluginConfig?: unknown;
  api: import("openclaw/plugin-sdk").OpenClawPluginApi;
}): OpenClawPluginService {
  let runtime: RemoteAcpxRuntime | null = null;

  return {
    id: "remote-acpx-runtime",
    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      const config = resolveConfig(params.pluginConfig);

      runtime = new RemoteAcpxRuntime(config, { logger: ctx.logger });

      // Entry 1: ACP control plane (/acp spawn, /acp turn)
      registerAcpRuntimeBackend({
        id: REMOTE_ACPX_BACKEND_ID,
        runtime,
        healthy: () => runtime?.isHealthy() ?? false,
      });

      registerAcpNodeEventHandler(routeNodeEvent);

      // Entry 2: LLM tool (claude_code)
      registerCodingTool(params.api, runtime, {
        defaultAgent: config.defaultAgent,
        maxOutputChars: config.maxOutputChars,
      });

      ctx.logger.info(
        `remote-acpx backend registered (node=${config.nodeName || "(auto)"}, agent=${config.agentCommand}, default=${config.defaultAgent})`,
      );
    },
    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      drainAllSessions();
      unregisterAcpRuntimeBackend(REMOTE_ACPX_BACKEND_ID);
      unregisterAcpNodeEventHandler();
      clearNodeCache();
      runtime = null;
    },
  };
}
