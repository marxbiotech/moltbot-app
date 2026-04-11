import { createAppAuth } from "@octokit/auth-app";

/**
 * github-apps plugin — GitHub App token management.
 *
 * Parses GITHUB_APPS env var (JSON) at load time and provides:
 *   /gh_apps list          — list configured apps
 *   /gh_apps token <name>  — get an installation token
 *
 * Also exports getInstallationToken() for other plugins.
 *
 * GITHUB_APPS format:
 * {
 *   "<name>": {
 *     "appId": "123456",
 *     "installationId": "789",
 *     "privateKey": "<base64-encoded PEM>"
 *   }
 * }
 */

interface AppConfig {
  appId: string;
  installationId: string;
  privateKey: string;
}

const apps = new Map<string, AppConfig>();

function loadApps(): void {
  const raw = process.env.GITHUB_APPS;
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw);
    for (const [name, cfg] of Object.entries(parsed) as [string, any][]) {
      if (!cfg.appId || !cfg.installationId || !cfg.privateKey) {
        console.error(`[github-apps] "${name}" missing required fields (appId, installationId, privateKey)`);
        continue;
      }
      apps.set(name, {
        appId: cfg.appId,
        installationId: cfg.installationId,
        privateKey: Buffer.from(cfg.privateKey, "base64").toString(),
      });
    }
    if (apps.size > 0) {
      console.log(`[github-apps] loaded: ${[...apps.keys()].join(", ")}`);
    }
  } catch (e: any) {
    console.error(`[github-apps] failed to parse GITHUB_APPS: ${e.message}`);
  }
}

export async function getInstallationToken(appName: string): Promise<string> {
  const cfg = apps.get(appName);
  if (!cfg) {
    throw new Error(`GitHub App "${appName}" not configured. Available: ${[...apps.keys()].join(", ") || "(none)"}`);
  }

  const auth = createAppAuth({
    appId: cfg.appId,
    privateKey: cfg.privateKey,
    installationId: cfg.installationId,
  });

  const { token } = await auth({ type: "installation" });
  return token;
}

// Load apps at import time
loadApps();

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
        if (apps.size === 0) {
          return { text: "No GitHub Apps configured (GITHUB_APPS env var not set or empty)" };
        }
        const lines = [...apps.entries()].map(([name, cfg]) => `  ${name}  (app-id: ${cfg.appId})`);
        return { text: `GitHub Apps:\n${lines.join("\n")}` };
      }

      if (sub === "token") {
        const appName = parts[1];
        if (!appName) {
          return { text: "Usage: /gh_apps token <app-name>" };
        }
        try {
          const token = await getInstallationToken(appName);
          return { text: token };
        } catch (e: any) {
          return { text: `❌ ${e.message}` };
        }
      }

      return { text: "Usage: /gh_apps list | /gh_apps token <app-name>" };
    },
  });
}
