// Test-only RPC ingress. The live harness enables this exclusively in an
// isolated, temporary Gateway; it is not part of the production plugin entry.
import { randomUUID } from "node:crypto";
import { getAcpRuntimeBackend, type AcpRuntimeHandle } from "openclaw/plugin-sdk/acp-backend";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export default {
  id: "remote-acpx-probe",
  name: "Remote ACP transport test probe",
  register(api: OpenClawPluginApi) {
    api.registerGatewayMethod(
      "remote-acpx-probe.invoke",
      async ({ params, respond }) => {
        try {
          const runtime = getAcpRuntimeBackend("remote-acpx")?.runtime;
          if (!runtime) throw new Error("Remote ACP backend was not registered by its service");
          const input = params as {
            op: string;
            handle?: AcpRuntimeHandle;
            text?: string;
            cancel?: boolean;
          };
          if (input.op === "managerInitialize" || input.op === "managerStatus") {
            // Private core access is confined to this fixture. Real chat.send
            // admission below owns runTurn and its unforgeable execution context.
            const { getAcpSessionManager } = await import("openclaw/plugin-sdk/acp-runtime");
            const manager = getAcpSessionManager();
            const target = {
              cfg: api.config,
              agentId: "main",
              sessionKey: "agent:main:acp:live-manager",
            };
            if (input.op === "managerInitialize") {
              const initialized = await manager.initializeSession({
                ...target,
                agent: "fixture",
                mode: "persistent",
                backendId: "remote-acpx",
              });
              respond(true, { sessionKey: target.sessionKey, handle: initialized.handle });
            } else {
              respond(true, await manager.resolveSession(target));
            }
            return;
          }
          if (input.op === "ensure") {
            const handle = await runtime.ensureSession({
              agentId: "main",
              sessionKey: "agent:main:live-transport",
              agent: "fixture",
              mode: "persistent",
              ...(input.handle ? { persistedHandle: input.handle } : {}),
            });
            respond(true, { handle });
            return;
          }
          if (!input.handle || !runtime.startTurn)
            throw new Error("Probe requires a persisted handle and startTurn");
          const turn = await runtime.startTurn({
            handle: input.handle,
            text: input.text ?? "live prompt",
            mode: "prompt",
            requestId: randomUUID(),
            onElicitation: async () => ({
              action: "accept",
              content: { answer: "live node response" },
            }),
          });
          let text = "";
          let chunks = 0;
          let cancellation: Promise<void> | undefined;
          for await (const event of turn.events) {
            if (event.type === "text_delta") {
              text += event.text;
              chunks++;
              if (input.cancel && !cancellation)
                cancellation = turn.cancel({ reason: "live transport test cancellation" });
            }
          }
          await cancellation;
          respond(true, { text, chunks, result: await turn.result });
        } catch (error) {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope: "operator.write" },
    );
  },
};
