import type { OpenClawPluginNodeInvokePolicy } from "openclaw/plugin-sdk/plugin-entry";
import { parseConfig } from "./config.js";
import { BACKEND, COMMAND, parseRequest } from "./protocol.js";

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
      // The request's authorization comes from current operator configuration,
      // never a model argument or the plugin's registration-time config snapshot.
      const entry = context.config.plugins?.entries?.[BACKEND];
      let config: ReturnType<typeof parseConfig>;
      try {
        config = parseConfig(entry?.config);
      } catch {
        return {
          ok: false,
          code: "REMOTE_ACP_CONFIG_INVALID",
          message: "Invalid remote ACP execution configuration.",
        };
      }
      if (config.executionApproval === "node-policy") {
        const target = config.targets[request.owner.agentId] ?? config.target;
        if (
          context.config.plugins?.enabled === false ||
          entry?.enabled === false ||
          target?.nodeId !== context.nodeId
        ) {
          return {
            ok: false,
            code: "REMOTE_ACP_TARGET_NOT_AUTHORIZED",
            message:
              "The current remote ACP configuration does not authorize this node for the session owner.",
          };
        }
        // This is configured node authority, not a human approval or Session Full.
        // The node's host capability independently enforces its live exec floor.
        return context.invokeNode({ params: { request, authorization: "node-policy" } });
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
