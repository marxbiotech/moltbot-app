import { Type } from "@sinclair/typebox";
import { resolveContext, dispatchWorkflow, getLatestRuns, toolResult, type ToolResult } from "./shared.ts";

const WORKFLOW_FILE = "set-secret.yml";

async function run(secret_key: string, secret_value: string): Promise<string> {
  const ctx = await resolveContext();
  if (typeof ctx === "string") return ctx;

  if (!/^[A-Z][A-Z0-9_]*$/.test(secret_key)) {
    return `Error: secret_key must match ^[A-Z][A-Z0-9_]*$ (got "${secret_key}")`;
  }

  const result = await dispatchWorkflow(ctx.repo, ctx.token, WORKFLOW_FILE, {
    persona: ctx.persona,
    secret_key,
    secret_value,
  });
  if (!result.ok) return result.message;

  // Wait briefly then fetch latest run status
  await new Promise((r) => setTimeout(r, 3000));
  const runs = await getLatestRuns(ctx.repo, ctx.token, WORKFLOW_FILE);
  const runsSection = runs.startsWith("Failed") || runs.startsWith("No recent")
    ? "\n\nNote: Could not fetch deployment status. The save was still initiated successfully."
    : `\n\nRecent deployments:\n${runs}`;

  return `Saving secret ${secret_key} — deployment in progress.${runsSection}`;
}

export const setSecretTool = {
  name: "set_secret",
  label: "Set Secret",
  description:
    "Set or update an environment secret for this agent. " +
    "Securely saves the secret and triggers a deploy so the new value takes effect. " +
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
  ): Promise<ToolResult> {
    const text = await run(params.secret_key, params.secret_value);
    return toolResult(text);
  },
};
