import { sshCheck } from "./src/ssh-check.ts";

export default function register(api: any) {
  api.registerCommand({
    name: "ssh_check",
    description: "Check SSH key health and GitHub connectivity",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => sshCheck(),
  });
}
