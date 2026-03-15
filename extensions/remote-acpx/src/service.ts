// Service lifecycle for remote-acpx extension.
// Registers the AcpRuntime backend and the node event handler on start,
// unregisters both on stop.

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
import { routeNodeEvent } from "./event-router.js";
import { clearNodeCache } from "./node-resolver.js";

function resolveConfig(rawConfig: unknown): RemoteAcpxConfig {
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
  };
}

export function createRemoteAcpxService(params: {
  pluginConfig?: unknown;
}): OpenClawPluginService {
  let runtime: RemoteAcpxRuntime | null = null;

  return {
    id: "remote-acpx-runtime",
    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      const config = resolveConfig(params.pluginConfig);
      if (!config.nodeName) {
        ctx.logger.warn("remote-acpx: nodeName not configured, backend will not be registered");
        return;
      }

      runtime = new RemoteAcpxRuntime(config, { logger: ctx.logger });

      // Diagnostic: log bridge state on health check via plugin logger (writes to gateway log file)
      const diagHealthy = () => {
        const bridgeKey = Symbol.for("openclaw.acpNodeEventBridgeState");
        const state = (globalThis as any)[bridgeKey];
        const nodeId = resolveNodeId(config.nodeName);
        const connected = nodeId ? isAcpNodeConnected(nodeId) : false;
        const h = runtime?.isHealthy() ?? false;
        const msg = `[${new Date().toISOString()}] healthy=${h} nodeName=${config.nodeName} nodeId=${nodeId} connected=${connected} bridge={sender=${!!state?.sender},checker=${!!state?.nodeChecker},listProvider=${!!state?.nodeListProvider}}\n`;
        try { require("fs").appendFileSync("/tmp/remote-acpx-diag.log", msg); } catch {};
        return h;
      };

      registerAcpRuntimeBackend({
        id: REMOTE_ACPX_BACKEND_ID,
        runtime,
        healthy: diagHealthy,
      });

      registerAcpNodeEventHandler(routeNodeEvent);

      ctx.logger.info(
        `remote-acpx backend registered (node=${config.nodeName}, agent=${config.agentCommand}, default=${config.defaultAgent})`,
      );
    },
    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      unregisterAcpRuntimeBackend(REMOTE_ACPX_BACKEND_ID);
      unregisterAcpNodeEventHandler();
      clearNodeCache();
      runtime = null;
    },
  };
}
