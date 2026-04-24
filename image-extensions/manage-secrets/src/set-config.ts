import { Type } from "@sinclair/typebox";
import { resolveContext, dispatchWorkflow, getLatestRuns, toolResult, type ToolResult } from "./shared.ts";
import { checkConfigPath, checkConfigValue } from "./preflight.ts";

const WORKFLOW_FILE = "set-config.yml";

async function run(config_path: string, config_value: string): Promise<string> {
  const ctx = await resolveContext();
  if (typeof ctx === "string") return ctx;

  // Preflight: reject obviously malformed inputs before dispatching workflow.
  // Authoritative validation happens in openclaw core (Phase 1) and repo-side (Phase 2).
  const pathError = checkConfigPath(config_path);
  if (pathError) return `Error: ${pathError}`;

  const valueError = checkConfigValue(config_value);
  if (valueError) return `Error: ${valueError}`;

  const result = await dispatchWorkflow(ctx.repo, ctx.token, WORKFLOW_FILE, {
    persona: ctx.persona,
    config_path,
    config_value,
  });
  if (!result.ok) return result.message;

  // Wait briefly then fetch latest run status
  await new Promise((r) => setTimeout(r, 3000));
  const runs = await getLatestRuns(ctx.repo, ctx.token, WORKFLOW_FILE);

  return `Workflow dispatched: setting config ${config_path} for persona '${ctx.persona}'\n\nRecent runs:\n${runs}`;
}

export const setConfigTool = {
  name: "set_config",
  label: "Set Config",
  description:
    "Persist a config change to the GitOps repo for this persona (Phase 2 of the two-phase flow). " +
    "Triggers the set-config GitHub Actions workflow, which patches the persona's values.yaml " +
    "with a single config path+value, commits, and pushes — triggering a deploy. " +
    "This tool performs only transport-safety preflight checks (well-formed path/JSON); " +
    "authoritative schema validation is handled by the gateway tool (Phase 1) and " +
    "the repo-side workflow. " +
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
  ): Promise<ToolResult> {
    const text = await run(params.config_path, params.config_value);
    return toolResult(text);
  },
};
