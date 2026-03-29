import type { OpenClawPluginApi } from "openclaw/plugin-sdk/remote-acpx";
import { createRemoteAcpxService } from "./src/service.js";

const plugin = {
  id: "remote-acpx",
  name: "Remote ACPX",
  description: "ACP runtime backend dispatching to a paired Mac node via WebSocket.",
  register(api: OpenClawPluginApi) {
    api.registerService(
      createRemoteAcpxService({
        pluginConfig: api.pluginConfig,
      }),
    );
  },
};

export default plugin;
