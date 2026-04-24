import { execFileSync } from "node:child_process";

const GITHUB_API = "https://api.github.com";
const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

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
  } catch (e: unknown) {
    // ENOENT = tailscale not installed, expected in non-Tailscale environments
    const isNotFound = e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT";
    if (!isNotFound) {
      console.warn(`[manage-secrets] Tailscale persona detection failed, falling back to HOSTNAME: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Fallback: HOSTNAME env var (K8s pod name pattern: moltbot-<persona>-<hash>-<hash>)
  const hostname = process.env.HOSTNAME || "";
  const match = hostname.match(/^moltbot-([a-z][\w-]*?)(?:-[a-f0-9]+-[a-z0-9]+)?$/);
  if (match) return match[1];

  return "";
}

const persona = getPersona();

async function resolveToken(): Promise<string | null> {
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
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[manage-secrets] github-apps token failed for "${appName}": ${message}`, e);
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
  let res: Response;
  try {
    res = await fetch(
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
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `GitHub API request failed: ${msg}` };
  }

  if (res.status === 204) {
    return { ok: true, message: "Workflow dispatched successfully." };
  }

  let body: string;
  try {
    body = await res.text();
  } catch {
    body = "(could not read response body)";
  }
  return { ok: false, message: `GitHub API error (${res.status}): ${body}` };
}

/** Pre-validated context shared by every tool's `run()` function. */
export interface ToolContext {
  token: string;
  repo: string;
  persona: string;
}

/**
 * Resolve token, repo, and persona -- the common preamble every tool needs.
 * Returns a validated context or an error string suitable for direct return.
 */
export async function resolveContext(): Promise<ToolContext | string> {
  const token = await resolveToken();
  if (!token) return "Error: AGENT_GITHUB_PAT is not set and github-apps fallback unavailable. Check logs for details.";

  const repo = process.env.MANAGE_SECRETS_GITHUB_REPO;
  if (!repo) return "Error: MANAGE_SECRETS_GITHUB_REPO is not set.";

  if (!persona) return "Error: Could not determine persona from hostname.";

  return { token, repo, persona };
}

/** Standard tool execute() return type. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: undefined;
}

export function toolResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: undefined };
}

export async function getLatestRuns(
  repo: string,
  token: string,
  workflowFile: string,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(
      `${GITHUB_API}/repos/${repo}/actions/workflows/${workflowFile}/runs?per_page=3`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...GITHUB_HEADERS,
        },
      },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Failed to fetch runs (network error: ${msg})`;
  }

  if (!res.ok) return `Failed to fetch runs (${res.status})`;

  let data: {
    workflow_runs: Array<{
      id: number;
      status: string;
      conclusion: string | null;
      html_url: string;
      created_at: string;
    }>;
  };
  try {
    data = await res.json();
  } catch {
    return "Failed to parse workflow runs response.";
  }
  if (!data.workflow_runs?.length) return "No recent runs found.";

  return data.workflow_runs
    .map(
      (r) =>
        `#${r.id} ${r.status}${r.conclusion ? ` (${r.conclusion})` : ""} — ${r.created_at}\n  ${r.html_url}`,
    )
    .join("\n");
}
