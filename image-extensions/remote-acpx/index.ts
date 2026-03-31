import type { OpenClawPluginApi } from "openclaw/plugin-sdk/remote-acpx";
import { createRemoteAcpxService } from "./src/service.js";
import { registerCodingTool } from "./src/tool.js";

const plugin = {
  id: "remote-acpx",
  name: "Remote ACPX",
  description: "ACP runtime backend dispatching to a paired Mac node via WebSocket, with LLM-invocable Claude Code tool.",
  register(api: OpenClawPluginApi) {
    api.registerService(
      createRemoteAcpxService({
        pluginConfig: api.pluginConfig,
        api,
      }),
    );
    registerCodingTool(api);
  },
};

export default plugin;
