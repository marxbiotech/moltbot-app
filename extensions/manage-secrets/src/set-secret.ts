import { execFileSync } from "node:child_process";
import { Type } from "@sinclair/typebox";

function getPersona(): string {
  // Try Tailscale hostname first (strip "moltbot-" prefix)
  try {
    const raw = execFileSync("tailscale", ["status", "--self", "--json"], {
      timeout: 5000,
      env: process.env,
    });
    const hostname = JSON.parse(raw.toString()).Self?.HostName || "";
    if (hostname.startsWith("moltbot-")) {
      return hostname.slice("moltbot-".length);
    }
  } catch {
    // fall through
  }

  // Fallback: HOSTNAME env var (K8s pod name pattern: moltbot-<persona>-<hash>-<hash>)
  const hostname = process.env.HOSTNAME || "";
  const match = hostname.match(/^moltbot-([a-z][\w-]*?)(?:-[a-f0-9]+-[a-z0-9]+)?$/);
  if (match) return match[1];

  return "";
}

async function triggerWorkflow(
  repo: string,
  token: string,
  persona: string,
  secretKey: string,
  secretValue: string,
): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/set-secret.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: { persona, secret_key: secretKey, secret_value: secretValue },
      }),
    },
  );

  if (res.status === 204) {
    return { ok: true, message: `Workflow dispatched: setting ${secretKey} for persona '${persona}'` };
  }

  const body = await res.text();
  return { ok: false, message: `GitHub API error (${res.status}): ${body}` };
}

async function getLatestRuns(repo: string, token: string): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/set-secret.yml/runs?per_page=3`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!res.ok) return `Failed to fetch runs (${res.status})`;

  const data = (await res.json()) as {
    workflow_runs: Array<{
      id: number;
      status: string;
      conclusion: string | null;
      html_url: string;
      created_at: string;
    }>;
  };
  if (!data.workflow_runs?.length) return "No recent runs found.";

  return data.workflow_runs
    .map(
      (r) =>
        `#${r.id} ${r.status}${r.conclusion ? ` (${r.conclusion})` : ""} — ${r.created_at}\n  ${r.html_url}`,
    )
    .join("\n");
}

const persona = getPersona();

export const setSecretTool = {
  name: "set_secret",
  description:
    "Set or update an environment secret for this persona. " +
    "Triggers the set-secret GitHub Actions workflow, which decrypts the SOPS-encrypted secrets.yaml, " +
    "injects the key/value under envSecrets, re-encrypts, commits, and pushes — triggering a deploy. " +
    "Use when the user asks to update, rotate, or set a secret, token, or API key.",
  parameters: Type.Object({
    secret_key: Type.String({
      description:
        "Uppercase env var name (e.g., TELEGRAM_BOT_TOKEN, GOOGLE_API_KEY). Must match ^[A-Z][A-Z0-9_]*$.",
    }),
    secret_value: Type.String({
      description: "The secret value to set.",
    }),
  }),
  async execute(params: { secret_key: string; secret_value: string }): Promise<string> {
    const { secret_key, secret_value } = params;

    const token = process.env.AGENT_GITHUB_PAT;
    if (!token) return "Error: AGENT_GITHUB_PAT is not set.";

    const repo = process.env.MANAGE_SECRETS_GITHUB_REPO;
    if (!repo) return "Error: MANAGE_SECRETS_GITHUB_REPO is not set.";

    if (!persona) return "Error: Could not determine persona from hostname.";

    if (!/^[A-Z][A-Z0-9_]*$/.test(secret_key)) {
      return `Error: secret_key must match ^[A-Z][A-Z0-9_]*$ (got "${secret_key}")`;
    }

    const result = await triggerWorkflow(repo, token, persona, secret_key, secret_value);
    if (!result.ok) return result.message;

    // Wait briefly then fetch latest run status
    await new Promise((r) => setTimeout(r, 3000));
    const runs = await getLatestRuns(repo, token);

    return `${result.message}\n\nRecent runs:\n${runs}`;
  },
};
