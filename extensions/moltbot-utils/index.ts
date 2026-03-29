import { sysInfo } from "./src/sys-info.ts";
import { netCheck } from "./src/net-check.ts";
import { wsCheck } from "./src/ws-check.ts";

export default function register(api: any) {
  api.registerCommand({
    name: "ws_check",
    description: "Workspace health — config, API keys, gateway, skills",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => wsCheck(),
  });

  api.registerCommand({
    name: "sys_info",
    description: "System info — hostname, kernel, uptime, memory, disk",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => sysInfo(),
  });

  api.registerCommand({
    name: "net_check",
    description: "Network connectivity — GitHub, Anthropic, OpenAI, Google endpoints",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => netCheck(),
  });
}
