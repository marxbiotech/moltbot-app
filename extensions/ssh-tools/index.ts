import { sshSetup } from "./src/ssh-setup.ts";
import { sshCheck } from "./src/ssh-check.ts";

export default function register(api: any) {
  api.registerCommand({
    name: "ssh_setup",
    description: "Initialize SSH keys for GitHub access",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => sshSetup(),
  });

  api.registerCommand({
    name: "ssh_check",
    description: "Check SSH key health and GitHub connectivity",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => sshCheck(),
  });
}
