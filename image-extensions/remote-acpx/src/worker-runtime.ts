import { createHash } from "node:crypto";
import path from "node:path";
import {
  AcpRuntimeError,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
  isRequestedModelUnsupportedError,
  type AcpRuntimeHandle,
  type AcpRuntimeTurn,
  type AcpSessionStore,
} from "acpx/runtime";
import type { ElicitationHandler, Owner, ServerMessage, WorkerStart } from "./protocol.js";

/** Only the physical acpx resource is encoded; the Gateway keeps its logical owner. */
export function sessionResource(owner: Owner): string {
  return `remote-acpx-v1-${createHash("sha256")
    .update(JSON.stringify([owner.agentId, owner.sessionKey]))
    .digest("hex")}`;
}

function invalid(message: string): never {
  throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", message);
}

function ownedStore(store: AcpSessionStore, resource: string): AcpSessionStore {
  const accepts = (id: string) =>
    id === resource || new RegExp(`^${resource}:oneshot:[a-f0-9-]+$`).test(id);
  return {
    async load(id) {
      if (!accepts(id)) invalid("ACP record belongs to another owner");
      const record = await store.load(id);
      if (record && (record.name !== resource || record.acpxRecordId !== id)) {
        invalid("ACP record ownership does not match its locator");
      }
      return record;
    },
    async save(record) {
      if (!accepts(record.acpxRecordId) || record.name !== resource) {
        invalid("ACP record belongs to another owner");
      }
      await store.save(record);
    },
  };
}

async function localHandle(
  handle: AcpRuntimeHandle,
  owner: Owner,
  store: AcpSessionStore,
  allowReset = false,
): Promise<AcpRuntimeHandle> {
  const resource = sessionResource(owner);
  const decoded = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
  if (
    !decoded ||
    decoded.name !== resource ||
    handle.sessionKey !== owner.sessionKey ||
    handle.backend !== "acpx"
  ) {
    invalid("ACP handle belongs to another owner or backend");
  }
  if (
    !handle.acpxRecordId ||
    !handle.backendSessionId ||
    decoded.acpxRecordId !== handle.acpxRecordId ||
    decoded.backendSessionId !== handle.backendSessionId
  ) {
    invalid("ACP handle has an inconsistent session locator");
  }
  const record = await store.load(handle.acpxRecordId);
  if (
    !record ||
    record.acpSessionId !== handle.backendSessionId ||
    path.resolve(record.cwd) !== path.resolve(decoded.cwd) ||
    !handle.cwd ||
    path.resolve(handle.cwd) !== path.resolve(record.cwd) ||
    (!allowReset && record.acpx?.reset_on_next_ensure === true)
  ) {
    invalid("ACP handle is stale; ensure the session again before using it");
  }
  return { ...handle, sessionKey: resource };
}

export type WorkerRuntimeContext = {
  signal: AbortSignal;
  send: (message: ServerMessage) => Promise<void>;
  onElicitation: ElicitationHandler;
};

/** One admitted invocation owns this runtime and joins cleanup before publishing its outcome. */
export async function runWorker(start: WorkerStart, context: WorkerRuntimeContext): Promise<void> {
  const { request, config } = start;
  const resource = sessionResource(request.owner);
  const store = ownedStore(createFileSessionStore({ stateDir: config.stateDir }), resource);
  const registry = createAgentRegistry({ overrides: config.agents });
  const runtime = createAcpRuntime({
    cwd: config.cwd,
    sessionStore: store,
    agentRegistry: registry,
    permissionMode: config.permissionMode,
    nonInteractivePermissions: "fail",
    elicitationModes: request.op === "turn" && request.input.elicitation ? ["form", "url"] : [],
    processLifecycle: {
      onBeforeSpawn: () => context.signal.throwIfAborted(),
      onSpawned: () => context.signal.throwIfAborted(),
    },
  });
  let turn: AcpRuntimeTurn | undefined;
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    // Turn cancellation must settle through the turn result. Other operations
    // have no cancellation API, so shutdown prevents late process admission.
    cancellation = turn
      ? turn.cancel({ reason: "remote invocation cancelled" })
      : runtime.shutdown();
    void cancellation.catch(() => {});
  };
  context.signal.addEventListener("abort", abort, { once: true });
  let terminal: ServerMessage;
  try {
    context.signal.throwIfAborted();
    if (request.op === "ensure") {
      const input = request.input;
      if (input.cwd && !path.isAbsolute(input.cwd)) {
        invalid("Remote ACP cwd must be an absolute node-local path");
      }
      if (!registry.list().includes(input.agent))
        invalid("Unknown node ACP agent; configure its argv on the node");
      if (input.env && Object.keys(input.env).length > 0)
        invalid("Remote ACP environment must be configured on the node");
      if (input.thinking && input.thinkingExplicit === true) {
        throw new AcpRuntimeError(
          "ACP_INVALID_RUNTIME_OPTION",
          "This ACP agent does not support an explicit thinking option",
        );
      }
      if (input.persistedHandle)
        await localHandle(input.persistedHandle, request.owner, store, true);
      const ensure = (model: string | undefined) =>
        runtime.ensureSession({
          sessionKey: resource,
          agent: input.agent,
          mode: input.mode,
          cwd: input.cwd ?? config.cwd,
          resumeSessionId: input.resumeSessionId,
          ...(model ? { sessionOptions: { model } } : {}),
        });
      let appliedModel: { kind: "dropped" } | undefined;
      let handle: AcpRuntimeHandle;
      try {
        handle = await ensure(input.model);
      } catch (error) {
        // Match core ACPX semantics: only an inherited model on a harness with
        // no model control can fall back. Invalid model IDs remain failures.
        if (
          input.modelExplicit ||
          !input.model ||
          !isRequestedModelUnsupportedError(error) ||
          error.reason !== "missing-capability"
        )
          throw error;
        handle = await ensure(undefined);
        appliedModel = { kind: "dropped" };
      }
      context.signal.throwIfAborted();
      terminal = {
        type: "value",
        value: {
          ...handle,
          ...request.owner,
          ...(appliedModel ? { appliedModel } : {}),
          ...(input.thinking ? { appliedThinking: { kind: "dropped" } } : {}),
        },
      };
    } else if (request.op === "fresh") {
      const handle = request.input.persistedHandle
        ? await localHandle(request.input.persistedHandle, request.owner, store, true)
        : await runtime.findSession({ sessionKey: resource, agent: "remote-acpx" });
      if (handle) await runtime.prepareFreshSession({ handle });
      terminal = { type: "value", value: null };
    } else {
      const handle = await localHandle(request.input.handle, request.owner, store);
      context.signal.throwIfAborted();
      switch (request.op) {
        case "turn": {
          turn = runtime.startTurn({
            handle,
            text: request.input.text,
            attachments: request.input.attachments,
            mode: request.input.mode,
            requestId: request.input.requestId,
            signal: context.signal,
            timeoutMs: 0,
            ...(request.input.elicitation ? { onElicitation: context.onElicitation } : {}),
          });
          const started = turn.promptStarted.then(() => context.send({ type: "started" }));
          void started.catch(() => {});
          void turn.result.catch(() => {});
          for await (const event of turn.events) await context.send({ type: "event", event });
          const result = await turn.result;
          await started.catch(() => {});
          terminal = { type: "result", result };
          break;
        }
        case "status":
          terminal = { type: "value", value: await runtime.getStatus({ handle }) };
          break;
        case "capabilities": {
          const capabilities = await runtime.getCapabilities({ handle });
          terminal = {
            type: "value",
            value: {
              ...capabilities,
              controls: capabilities.controls.filter((control) => control !== "session/set_model"),
            },
          };
          break;
        }
        case "setMode":
          await runtime.setMode({ handle, mode: request.input.mode });
          terminal = { type: "value", value: null };
          break;
        case "setConfigOption":
          terminal = {
            type: "value",
            value: await runtime.setConfigOption({
              handle,
              key: request.input.key,
              value: request.input.value,
            }),
          };
          break;
        case "close":
          await runtime.close({
            handle,
            reason: request.input.reason,
            discardPersistentState: request.input.discardPersistentState,
          });
          terminal = { type: "value", value: null };
          break;
        case "cancel":
          // Live cancellation belongs to the node's active worker map. Reaching
          // this branch means no turn remains owned by a worker on the node.
          terminal = { type: "value", value: null };
          break;
      }
    }
  } catch (error) {
    terminal = {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof AcpRuntimeError ? { code: error.code } : {}),
    };
  } finally {
    context.signal.removeEventListener("abort", abort);
    let cleanupError: unknown;
    try {
      await cancellation;
    } catch (error) {
      cleanupError = error;
    }
    try {
      await runtime.shutdown();
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      terminal = {
        type: "error",
        message: `ACP worker cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      };
    }
  }
  await context.send(terminal);
}
