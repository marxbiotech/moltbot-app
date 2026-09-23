import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  tryDispatchAcpReplyHook,
} from "openclaw/plugin-sdk/acp-backend";
import { parseConfig } from "./src/config.js";
import { BACKEND } from "./src/protocol.js";
import { createRemoteAcpxRuntime } from "./src/runtime.js";
import { createRemoteAcpxNodeCommand } from "./src/node.js";
import { createRemoteAcpxNodeInvokePolicy } from "./src/policy.js";

export default {
  id: BACKEND,
  name: "Remote ACPX",
  description: "Run ACP sessions through acpx on an explicitly selected paired node.",
  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig);
    const node = createRemoteAcpxNodeCommand(config.node);
    api.registerNodeHostCommand(node);
    api.registerNodeInvokePolicy(createRemoteAcpxNodeInvokePolicy());
    let runtime: ReturnType<typeof createRemoteAcpxRuntime> | undefined;
    api.registerService({
      id: "remote-acpx-runtime",
      start() {
        if (runtime) return;
        runtime = createRemoteAcpxRuntime(api.runtime.nodes, config);
        registerAcpRuntimeBackend({ id: BACKEND, runtime });
      },
      async stop() {
        const owned = runtime;
        runtime = undefined;
        if (owned && getAcpRuntimeBackend(BACKEND)?.runtime === owned)
          unregisterAcpRuntimeBackend(BACKEND);
        await Promise.all([owned?.shutdown(), node.onDisconnect?.()]);
      },
    });
    api.on("reply_dispatch", tryDispatchAcpReplyHook, { eligibleDispatchKinds: ["acp"] });
  },
};
