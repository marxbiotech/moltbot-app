import { execFileSync } from "node:child_process";

const GITHUB_API = "https://api.github.com";
const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

export function getPersona(): string {
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

export const persona = getPersona();

export async function resolveToken(): Promise<string | null> {
  // 1. Explicit PAT takes priority
  if (process.env.AGENT_GITHUB_PAT) return process.env.AGENT_GITHUB_PAT;

  // 2. Fall back to GitHub App via github-apps plugin (Symbol.for registry)
  const appName = process.env.MANAGE_SECRETS_GITHUB_APP;
  if (appName) {
    const gh = (globalThis as any)[Symbol.for("openclaw.github-apps")] as
      | { getInstallationToken: (name: string) => Promise<string> }
      | undefined;
    if (!gh) {
      console.error(`[manage-secrets] MANAGE_SECRETS_GITHUB_APP="${appName}" but github-apps plugin is not loaded`);
      return null;
    }
    try {
      return await gh.getInstallationToken(appName);
    } catch (e: any) {
      console.error(`[manage-secrets] github-apps token failed for "${appName}": ${e.message}`);
      return null;
    }
  }

  return null;
}

export async function dispatchWorkflow(
  repo: string,
  token: string,
  workflowFile: string,
  inputs: Record<string, string>,
): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(
    `${GITHUB_API}/repos/${repo}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...GITHUB_HEADERS,
      },
      body: JSON.stringify({ ref: "main", inputs }),
    },
  );

  if (res.status === 204) {
    return { ok: true, message: "Workflow dispatched successfully." };
  }

  const body = await res.text();
  return { ok: false, message: `GitHub API error (${res.status}): ${body}` };
}

export async function getLatestRuns(
  repo: string,
  token: string,
  workflowFile: string,
): Promise<string> {
  const res = await fetch(
    `${GITHUB_API}/repos/${repo}/actions/workflows/${workflowFile}/runs?per_page=3`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        ...GITHUB_HEADERS,
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
