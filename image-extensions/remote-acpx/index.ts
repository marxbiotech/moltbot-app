import type { OpenClawPluginApi } from "openclaw/plugin-sdk/remote-acpx";
import { createRemoteAcpxService, resolveConfig, type ServiceState } from "./src/service.js";
import { registerCodingTool } from "./src/tool.js";

const plugin = {
  id: "remote-acpx",
  name: "Remote ACPX",
  description: "ACP runtime backend dispatching to a paired Mac node via WebSocket, with LLM-invocable Claude Code tool.",
  register(api: OpenClawPluginApi) {
    // Shared state: runtime is null until service starts, config has defaults.
    const state: ServiceState = {
      runtime: null,
      config: resolveConfig(api.pluginConfig),
    };

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
