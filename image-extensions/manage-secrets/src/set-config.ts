import { Type } from "typebox";
import { resolveContext, dispatchWorkflow, fetchRunsSection, toolResult, type ToolResult } from "./shared.ts";
import { checkPatch } from "./preflight.ts";

const WORKFLOW_FILE = "set-config.yml";

async function run(patch: string): Promise<string> {
  const ctx = await resolveContext();
  if (typeof ctx === "string") return ctx;

  // Preflight: reject obviously malformed inputs before dispatching workflow.
  // Authoritative validation happens in openclaw core (Phase 1) and repo-side (Phase 2).
  const check = checkPatch(patch);
  if ("error" in check) return `Error: ${check.error}`;

  const result = await dispatchWorkflow(ctx.repo, ctx.token, WORKFLOW_FILE, {
    persona: ctx.persona,
    patch,
  });
  if (!result.ok) return result.message;

  const runsSection = await fetchRunsSection(ctx.repo, ctx.token, WORKFLOW_FILE);

  const pathsSummary = check.leafPaths.join(", ");
  return `Saving config [${pathsSummary}] — deployment in progress.${runsSection}`;
}

export const setConfigTool = {
  name: "set_config",
  label: "Set Config",
  description:
    "Save a confirmed config change permanently for this agent. " +
    "Use only after the user has confirmed a live config change works correctly (Phase 2 of apply-then-save). " +
    "Pass the same merge-patch JSON string used in the gateway config.patch call. " +
    "Performs transport-safety preflight checks; " +
    "authoritative schema validation is handled by the gateway tool in Phase 1.",
  parameters: Type.Object({
    patch: Type.String({
      description:
        "JSON merge-patch string — the same value passed as `raw` to the gateway config.patch action. " +
        'Example: \'{"agents":{"defaults":{"model":{"primary":"google/gemini-3-flash"}}}}\'',
    }),
  }),
  async execute(
    _toolCallId: string,
    params: { patch: string },
  ): Promise<ToolResult> {
    try {
      const text = await run(params.patch);
      return toolResult(text);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[manage-secrets] set_config unexpected error:`, e);
      return toolResult(`Error: Unexpected failure in set_config: ${msg}`);
    }
  },
};
