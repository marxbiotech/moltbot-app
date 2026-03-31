// Service lifecycle for remote-acpx extension.
// Registers the AcpRuntime backend and the node event handler on start.
// Unregisters all on stop.
// claude_code tool is registered in register() phase (index.ts) with lazy deps.

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
import type { CodingToolConfig } from "./tool.js";

type FullConfig = RemoteAcpxConfig & CodingToolConfig;

export function resolveConfig(rawConfig: unknown): FullConfig {
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

/** Shared mutable state — set by service start(), read by claude_code tool execute(). */
export type ServiceState = {
  runtime: RemoteAcpxRuntime | null;
  config: FullConfig;
};

export function createRemoteAcpxService(params: {
  pluginConfig?: unknown;
  state: ServiceState;
}): OpenClawPluginService {
  return {
    id: "remote-acpx-runtime",
    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      const config = resolveConfig(params.pluginConfig);
      // Update shared state so claude_code tool can access runtime and config
      Object.assign(params.state, { config });

      const runtime = new RemoteAcpxRuntime(config, { logger: ctx.logger });
      params.state.runtime = runtime;

      registerAcpRuntimeBackend({
        id: REMOTE_ACPX_BACKEND_ID,
        runtime,
        healthy: () => runtime?.isHealthy() ?? false,
      });

      registerAcpNodeEventHandler(routeNodeEvent);

      ctx.logger.info(
        `remote-acpx backend registered (node=${config.nodeName || "(auto)"}, agent=${config.agentCommand}, default=${config.defaultAgent})`,
      );
    },
    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      drainAllSessions();
      unregisterAcpRuntimeBackend(REMOTE_ACPX_BACKEND_ID);
      unregisterAcpNodeEventHandler();
      clearNodeCache();
      params.state.runtime = null;
    },
  };
}
