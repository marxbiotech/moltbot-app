import { Type } from "@sinclair/typebox";
import { persona, resolveToken, dispatchWorkflow, getLatestRuns } from "./shared.ts";

const WORKFLOW_FILE = "set-secret.yml";

async function run(secret_key: string, secret_value: string): Promise<string> {
  const token = await resolveToken();
  if (!token) return "Error: AGENT_GITHUB_PAT is not set and github-apps fallback unavailable. Check logs for details.";

  const repo = process.env.MANAGE_SECRETS_GITHUB_REPO;
  if (!repo) return "Error: MANAGE_SECRETS_GITHUB_REPO is not set.";

  if (!persona) return "Error: Could not determine persona from hostname.";

  if (!/^[A-Z][A-Z0-9_]*$/.test(secret_key)) {
    return `Error: secret_key must match ^[A-Z][A-Z0-9_]*$ (got "${secret_key}")`;
  }

  const result = await dispatchWorkflow(repo, token, WORKFLOW_FILE, {
    persona,
    secret_key,
    secret_value,
  });
  if (!result.ok) return result.message;

  // Wait briefly then fetch latest run status
  await new Promise((r) => setTimeout(r, 3000));
  const runs = await getLatestRuns(repo, token, WORKFLOW_FILE);

  return `Workflow dispatched: setting ${secret_key} for persona '${persona}'\n\nRecent runs:\n${runs}`;
}

export const setSecretTool = {
  name: "set_secret",
  label: "Set Secret",
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
  async execute(
    _toolCallId: string,
    params: { secret_key: string; secret_value: string },
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
    const text = await run(params.secret_key, params.secret_value);
    return { content: [{ type: "text", text }], details: undefined };
  },
};
