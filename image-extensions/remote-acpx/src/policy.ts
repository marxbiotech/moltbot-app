import type { OpenClawPluginNodeInvokePolicy } from "openclaw/plugin-sdk/plugin-entry";
import { COMMAND, parseRequest } from "./protocol.js";

/** The Gateway owns approval; callers cannot supply their own authorization marker. */
export function createRemoteAcpxNodeInvokePolicy(): OpenClawPluginNodeInvokePolicy {
  return {
    commands: [COMMAND],
    dangerous: true,
    classifyRisk: ({ params }) => ({
      level: parseRequest(params).op === "cancel" ? "ordinary" : "high",
      family: "remote-acpx.execution",
    }),
    async handle(context) {
      let request: ReturnType<typeof parseRequest>;
      try {
        request = parseRequest(context.params);
      } catch {
        return {
          ok: false,
          code: "INVALID_PARAMS",
          message: "Invalid remote ACP request or session owner.",
        };
      }
      if (request.op === "cancel") {
        return context.invokeNode({ params: { request, authorization: "cancel-only" } });
      }
      if (!context.approvals) {
        return {
          ok: false,
          code: "REMOTE_ACP_APPROVAL_REQUIRED",
          message: "Remote ACP execution requires an available approval reviewer.",
        };
      }
      const approval = await context.approvals.request({
        title: "Run ACP on the paired node",
        description: `Allows coding-agent processes and filesystem access as the node account. Operation: ${request.op}. Node: ${context.node?.displayName ?? context.nodeId}. Session: ${request.owner.sessionKey}`,
        severity: "critical",
        allowedDecisions: ["allow-once"],
      });
      if (approval.decision !== "allow-once") {
        return {
          ok: false,
          code:
            approval.decision === "deny"
              ? "REMOTE_ACP_APPROVAL_DENIED"
              : "REMOTE_ACP_APPROVAL_EXPIRED",
          message:
            approval.decision === "deny"
              ? "Remote ACP execution was denied."
              : "Remote ACP approval expired. Retry to request a new approval.",
        };
      }
      // Reconstruct the envelope from parsed values, never a caller's approval claim.
      return context.invokeNode({ params: { request, authorization: "human-approved" } });
    },
  };
}
