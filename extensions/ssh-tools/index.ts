import { execFile } from "node:child_process";

/**
 * ssh-tools plugin — /ssh_setup and /ssh_check commands.
 *
 * Uses registerCommand() so commands execute WITHOUT the AI agent.
 * The actual logic lives in /usr/local/bin/{ssh_setup,ssh_check}
 * (installed by start-openclaw.sh from extensions/ssh-tools/scripts/).
 */

function runScript(
  bin: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ text: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, env: process.env }, (err, stdout, stderr) => {
      const output = (stdout || "") + (stderr ? `\n${stderr}` : "");
      if (err && !output.trim()) {
        resolve({ text: `❌ ${bin} failed: ${err.message}` });
      } else {
        resolve({ text: output.trim() || "✅ Done." });
      }
    });
  });
}

export default function register(api: any) {
  api.registerCommand({
    name: "ssh_setup",
    description: "Initialize SSH keys for GitHub access",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      return runScript("ssh_setup", [], 30_000);
    },
  });

  api.registerCommand({
    name: "ssh_check",
    description: "Check SSH key health and GitHub connectivity",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      return runScript("ssh_check", [], 15_000);
    },
  });
}
