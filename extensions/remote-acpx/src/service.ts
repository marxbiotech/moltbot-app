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

      // Diagnostic: log bridge state on health check
      const diagHealthy = () => {
        try {
          const bridgeKey = Symbol.for("openclaw.acpNodeEventBridgeState");
          const state = (globalThis as any)[bridgeKey];
          let nodeId: string | null = null;
          let connected = false;
          let resolveErr = "";
          try {
            nodeId = resolveNodeId(config.nodeName);
            connected = nodeId ? isAcpNodeConnected(nodeId) : false;
          } catch (e: any) { resolveErr = e?.message ?? String(e); }
          let h = false;
          let healthErr = "";
          try { h = runtime?.isHealthy() ?? false; } catch (e: any) { healthErr = e?.message ?? String(e); }
          const msg = `[${new Date().toISOString()}] healthy=${h} nodeName=${config.nodeName} nodeId=${nodeId} connected=${connected} resolveErr=${resolveErr} healthErr=${healthErr} bridge={sender=${!!state?.sender},checker=${!!state?.nodeChecker},listProvider=${!!state?.nodeListProvider}}\n`;
          require("fs").appendFileSync("/tmp/remote-acpx-diag.log", msg);
          return h;
        } catch (e: any) {
          require("fs").appendFileSync("/tmp/remote-acpx-diag.log", `[${new Date().toISOString()}] OUTER ERROR: ${e?.message ?? e}\n`);
          return false;
        }
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
