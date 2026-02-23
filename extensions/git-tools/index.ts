import { execFile } from "node:child_process";

/**
 * git-tools plugin — /git_check, /git_sync, and /git_repos commands.
 *
 * Uses registerCommand() so commands execute WITHOUT the AI agent.
 * The actual logic lives in /usr/local/bin/{git_check,git_sync,git_repos}
 * (installed by start-openclaw.sh from extensions/git-tools/scripts/).
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
    name: "git_check",
    description: "Pre-push safety check (sensitive files, diff size, branch)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const args = ctx.args?.trim();
      return runScript("git_check", args ? [args] : [], 15_000);
    },
  });

  api.registerCommand({
    name: "git_sync",
    description: "Pull all workspace repos or clone a new one by URL",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const args = ctx.args?.trim();
      return runScript("git_sync", args ? [args] : [], 60_000);
    },
  });

  api.registerCommand({
    name: "git_repos",
    description: "Scan workspace git repos — branch and dirty status",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      return runScript("git_repos", [], 15_000);
    },
  });
}
