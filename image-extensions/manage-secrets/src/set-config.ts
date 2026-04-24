import { Type } from "@sinclair/typebox";
import { persona, resolveToken, dispatchWorkflow, getLatestRuns } from "./shared.ts";

const WORKFLOW_FILE = "set-config.yml";

// Matches the workflow's path validation: each segment is [a-zA-Z_][a-zA-Z0-9_-]*
const PATH_SEGMENT_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

function validateConfigPath(path: string): string | null {
  if (!path) return "config_path must not be empty";
  const segments = path.split(".");
  for (const seg of segments) {
    if (!PATH_SEGMENT_RE.test(seg)) {
      return `Invalid path segment: '${seg}'. Only simple dot-delimited identifiers are supported (no array selectors).`;
    }
  }
  return null;
}

function validateConfigValue(value: string): string | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed === null) return "config_value must not be JSON null";
  } catch {
    return `config_value must be valid JSON (got: ${value})`;
  }
  return null;
}

async function run(config_path: string, config_value: string): Promise<string> {
  const token = await resolveToken();
  if (!token) return "Error: AGENT_GITHUB_PAT is not set and github-apps fallback unavailable. Check logs for details.";

  const repo = process.env.MANAGE_SECRETS_GITHUB_REPO;
  if (!repo) return "Error: MANAGE_SECRETS_GITHUB_REPO is not set.";

  if (!persona) return "Error: Could not determine persona from hostname.";

  const pathError = validateConfigPath(config_path);
  if (pathError) return `Error: ${pathError}`;

  const valueError = validateConfigValue(config_value);
  if (valueError) return `Error: ${valueError}`;

  const result = await dispatchWorkflow(repo, token, WORKFLOW_FILE, {
    persona,
    config_path,
    config_value,
  });
  if (!result.ok) return result.message;

  // Wait briefly then fetch latest run status
  await new Promise((r) => setTimeout(r, 3000));
  const runs = await getLatestRuns(repo, token, WORKFLOW_FILE);

  return `Workflow dispatched: setting config ${config_path} for persona '${persona}'\n\nRecent runs:\n${runs}`;
}

export const setConfigTool = {
  name: "set_config",
  label: "Set Config",
  description:
    "Persist a config change to the GitOps repo for this persona. " +
    "Triggers the set-config GitHub Actions workflow, which patches the persona's values.yaml " +
    "with a single config path+value, commits, and pushes — triggering a deploy. " +
    "This is the persistence step of the two-phase config update flow: " +
    "runtime apply first (via config.patch), user confirmation, then this tool to persist. " +
    "Use only after the user has confirmed a runtime config change works correctly.",
  parameters: Type.Object({
    config_path: Type.String({
      description:
        'Dot-delimited path relative to openclaw-helm.config (e.g., "agents.defaults.model.primary"). ' +
        "Only simple dot-delimited identifiers — no array selectors.",
    }),
    config_value: Type.String({
      description:
        'JSON-encoded value (e.g., \'"google/gemini-3-flash"\', "true", "42", \'{"key":"val"}\').',
    }),
  }),
  async execute(
    _toolCallId: string,
    params: { config_path: string; config_value: string },
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
    const text = await run(params.config_path, params.config_value);
    return { content: [{ type: "text", text }], details: undefined };
  },
};
