import type { OpenClawPluginApi } from "openclaw/plugin-sdk/remote-acpx";
import { createRemoteAcpxService, resolveConfig, type ServiceState } from "./src/service.js";
import { registerCodingTool } from "./src/tool.js";

// Persist state across jiti module reloads using Symbol.for (same pattern as
// session-manager and event-router). Without this, a plugin reload creates a
// fresh state object with runtime=null while the service (which already started)
// still holds a reference to the old state.
const STATE_KEY = Symbol.for("remote-acpx.serviceState");
const globalRef = globalThis as unknown as Record<symbol, ServiceState>;

function getOrCreateState(pluginConfig: unknown): ServiceState {
  if (!globalRef[STATE_KEY]) {
    globalRef[STATE_KEY] = {
      runtime: null,
      config: resolveConfig(pluginConfig),
    };
  }
  return globalRef[STATE_KEY];
}

const plugin = {
  id: "remote-acpx",
  name: "Remote ACPX",
  description: "ACP runtime backend dispatching to a paired Mac node via WebSocket, with LLM-invocable Claude Code tool.",
  register(api: OpenClawPluginApi) {
    const state = getOrCreateState(api.pluginConfig);

    // Register service (sets state.runtime on start)
    api.registerService(
      createRemoteAcpxService({
        pluginConfig: api.pluginConfig,
        state,
      }),
    );

    // Register claude_code tool now (register phase) with lazy deps.
    // Tool execute() reads runtime/config from state at call time.
    registerCodingTool(api, {
      getRuntime: () => state.runtime,
      getConfig: () => state.config,
    });
  },
};

export default plugin;
