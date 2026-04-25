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

  return `Saving config ${config_path} — deployment in progress.\n\nRecent deployments:\n${runs}`;
}

export const setConfigTool = {
  name: "set_config",
  label: "Set Config",
  description:
    "Save a confirmed config change permanently for this agent. " +
    "Use only after the user has confirmed a live config change works correctly (Phase 2 of apply-then-save). " +
    "Performs transport-safety preflight checks (well-formed path/JSON); " +
    "authoritative schema validation is handled by the gateway tool in Phase 1.",
  parameters: Type.Object({
    config_path: Type.String({
      description:
        'Dot-delimited config path (e.g., "agents.defaults.model.primary"). ' +
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
