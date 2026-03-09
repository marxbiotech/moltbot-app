import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * github-apps plugin — /gh_apps command for GitHub App token management.
 *
 * Uses registerCommand() so the command executes WITHOUT the AI agent.
 * Subcommands:
 *   list          — list available GitHub Apps in ~/.github-apps/
 *   token <name>  — get an installation token for the named app
 *
 * The token subcommand delegates to /usr/local/bin/gh_app_token
 * (installed by start-openclaw.sh from extensions/github-apps/scripts/).
 */

const APPS_DIR = join(process.env.HOME || "/root", ".github-apps");

function runScript(
  bin: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ text: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, env: process.env }, (err, stdout, stderr) => {
      const output = (stdout || "") + (stderr ? `\n${stderr}` : "");
      if (err) {
        const detail = output.trim() || err.message;
        resolve({ text: `❌ ${bin} failed: ${detail}` });
      } else {
        resolve({ text: output.trim() || "✅ Done." });
      }
    });
  });
}

function listApps(): { text: string } {
  try {
    const entries = readdirSync(APPS_DIR, { withFileTypes: true });
    const apps = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const appIdFile = join(APPS_DIR, e.name, "app-id");
        try {
          const appId = readFileSync(appIdFile, "utf-8").trim();
          return `  ${e.name}  (app-id: ${appId})`;
        } catch (err: any) {
          if (err?.code === "ENOENT") {
            return `  ${e.name}  (app-id: missing)`;
          }
          return `  ${e.name}  (app-id: error — ${err?.code || err?.message})`;
        }
      });
    if (apps.length === 0) {
      return { text: "No GitHub Apps configured in ~/.github-apps/" };
    }
    return { text: `GitHub Apps:\n${apps.join("\n")}` };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { text: "No GitHub Apps configured (directory ~/.github-apps/ not found)" };
    }
    return { text: `Error listing GitHub Apps: ${err?.message || err}` };
  }
}

export default function register(api: any) {
  api.registerCommand({
    name: "gh_apps",
    description: "GitHub App token management (list / token <name>)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const args = ctx.args?.trim() || "";
      const parts = args.split(/\s+/);
      const sub = parts[0]?.toLowerCase();

      if (!sub || sub === "list") {
        return listApps();
      }

      if (sub === "token") {
        const appName = parts[1];
        if (!appName) {
          return { text: "Usage: /gh_apps token <app-name>" };
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(appName)) {
          return { text: "Invalid app name. Use only alphanumeric characters, hyphens, and underscores." };
        }
        return runScript("gh_app_token", [appName], 30_000);
      }

      return { text: "Usage: /gh_apps list | /gh_apps token <app-name>" };
    },
  });
}
