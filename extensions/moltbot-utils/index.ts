import { execFile } from "node:child_process";

/**
 * moltbot-utils plugin — /ws_check, /sys_info, and /net_check commands.
 *
 * Uses registerCommand() so commands execute WITHOUT the AI agent.
 * The actual logic lives in /usr/local/bin/{ws_check,sys_info,net_check}
 * (installed by start-openclaw.sh from extensions/moltbot-utils/scripts/).
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
    name: "ws_check",
    description: "Workspace health — config, R2 sync, API keys, gateway, skills",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      return runScript("ws_check", [], 15_000);
    },
  });

  api.registerCommand({
    name: "sys_info",
    description: "System info — hostname, kernel, uptime, memory, disk",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      return runScript("sys_info", [], 10_000);
    },
  });

  api.registerCommand({
    name: "net_check",
    description: "Network connectivity — GitHub, Anthropic, OpenAI, Google endpoints",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      return runScript("net_check", [], 15_000);
    },
  });
}
