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
import {
  permissionResponse,
  type PermissionHandler,
  type ElicitationHandler,
  type Owner,
  type Request,
  type ServerMessage,
  type WorkerStart,
} from "./protocol.js";

/** Only the physical acpx resource is encoded; the Gateway keeps its logical owner. */
export function sessionResource(owner: Owner): string {
  return `remote-acpx-v1-${createHash("sha256")
    .update(JSON.stringify([owner.agentId, owner.sessionKey]))
    .digest("hex")}`;
}

function invalid(message: string): never {
  throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", message);
}

function ownedStore(
  store: AcpSessionStore,
  resource: string,
  observe: (record: NonNullable<Awaited<ReturnType<AcpSessionStore["load"]>>>) => void,
): AcpSessionStore {
  const accepts = (id: string) =>
    id === resource || new RegExp(`^${resource}:oneshot:[a-f0-9-]+$`).test(id);
  return {
    async load(id) {
      if (!accepts(id)) invalid("ACP record belongs to another owner");
      const record = await store.load(id);
      if (record && (record.name !== resource || record.acpxRecordId !== id)) {
        invalid("ACP record ownership does not match its locator");
      }
      if (record) observe(record);
      return record;
    },
    async save(record) {
      if (!accepts(record.acpxRecordId) || record.name !== resource) {
        invalid("ACP record belongs to another owner");
      }
      await store.save(record);
      observe(record);
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
  onPermissionRequest?: PermissionHandler;
};

/** Preserve acpx ownership until the first prompt can make the harness session durable. */
export function createWorkerRuntime(start: WorkerStart) {
  const { request: initial, config } = start;
  let active: WorkerRuntimeContext | undefined;
  const resource = sessionResource(initial.owner);
  let observedMode: { recordId: string; value: unknown } | undefined;
  const store = ownedStore(
    createFileSessionStore({ stateDir: config.stateDir }),
    resource,
    (record) => {
      // This is only an observation of acpx's canonical checkpoint, not another
      // session/policy store. Copy the primitive so later record mutation is inert.
      observedMode = {
        recordId: record.acpxRecordId,
        value: record.acpx?.config_options?.find((option) => option.id === "mode")?.currentValue,
      };
    },
  );
  const registry = createAgentRegistry({ overrides: config.agents });
  const nativeMode = config.nativeModes?.[initial.owner.agentId];
  const runtime = createAcpRuntime({
    cwd: config.cwd,
    sessionStore: store,
    agentRegistry: registry,
    permissionMode: config.permissionMode,
    // The native harness owns tool authorization and execution. Advertising
    // client callbacks would introduce acpx's independent FS/terminal gates.
    fs: false,
    terminal: false,
    nonInteractivePermissions: "fail",
    // Requests outside the active turn have no human approval owner.
    onPermissionRequest: async () => ({ outcome: "cancel" }),
    elicitationModes: ["form", "url"],
    processLifecycle: {
      onBeforeSpawn: () => {
        if (!active) throw new Error("ACP process launch requires an active invocation");
        active.signal.throwIfAborted();
      },
      onSpawned: () => active?.signal.throwIfAborted(),
    },
  });
  async function pinNativeMode(handle: AcpRuntimeHandle): Promise<void> {
    if (!nativeMode) return;
    active?.signal.throwIfAborted();
    // A successful legacy set_mode response may be a no-op. Require the native
    // config snapshot to confirm the effective mode before admitting a prompt.
    const result = await runtime.setConfigOption({ handle, key: "mode", value: nativeMode });
    active?.signal.throwIfAborted();
    if (
      !result?.configOptions.some(
        (option) => option.id === "mode" && option.currentValue === nativeMode,
      )
    )
      invalid(`ACP agent did not confirm the configured native mode: ${nativeMode}`);
  }
  async function run(request: Request, context: WorkerRuntimeContext): Promise<ServerMessage> {
    if (active) throw new Error("ACP worker already has an active invocation");
    if (
      request.owner.agentId !== initial.owner.agentId ||
      request.owner.sessionKey !== initial.owner.sessionKey
    )
      throw new Error("ACP worker belongs to another session owner");
    active = context;
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
        await pinNativeMode(handle);
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
            await pinNativeMode(handle);
            let promptStarted = false;
            turn = runtime.startTurn({
              handle,
              text: request.input.text,
              attachments: request.input.attachments,
              mode: request.input.mode,
              requestId: request.input.requestId,
              signal: context.signal,
              assertActive: () => {
                context.signal.throwIfAborted();
                // acpx 0.19 checkpoints the actual reconnected client's config
                // before this synchronous prompt admission boundary. Preferences
                // alone may silently clamp/remove a mode; a pin must fail closed.
                if (
                  !promptStarted &&
                  nativeMode &&
                  (observedMode?.recordId !== handle.acpxRecordId ||
                    observedMode?.value !== nativeMode)
                )
                  invalid(`ACP prompt did not retain the configured native mode: ${nativeMode}`);
              },
              timeoutMs: 0,
              ...(request.input.elicitation ? { onElicitation: context.onElicitation } : {}),
              onPermissionRequest: async (permission, scope) => {
                if (
                  !request.input.permissions ||
                  !context.onPermissionRequest ||
                  context.signal.aborted ||
                  scope.signal.aborted ||
                  permission.sessionId !== handle.backendSessionId ||
                  permission.raw.sessionId !== permission.sessionId
                )
                  return { outcome: "cancel" };
                try {
                  const response = await context.onPermissionRequest(permission, scope);
                  if (context.signal.aborted || scope.signal.aborted) return { outcome: "cancel" };
                  return permissionResponse(permission, response);
                } catch {
                  // acpx falls back to permissionMode if the callback throws/returns undefined.
                  return { outcome: "cancel" };
                }
              },
            });
            const started = turn.promptStarted.then(() => {
              promptStarted = true;
              return context.send({ type: "started" });
            });
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
                controls: capabilities.controls.filter(
                  (control) => control !== "session/set_model",
                ),
              },
            };
            break;
          }
          case "setMode":
            if (nativeMode) {
              if (request.input.mode !== nativeMode)
                invalid("Native permission mode is pinned by node configuration");
              await pinNativeMode(handle);
            } else await runtime.setMode({ handle, mode: request.input.mode });
            terminal = { type: "value", value: null };
            break;
          case "setConfigOption":
            if (nativeMode) {
              const record = await store.load(handle.acpxRecordId!);
              const option = record?.acpx?.config_options?.find(
                (option) => option.id === request.input.key,
              );
              const safeCategory =
                option?.category === "model" || option?.category === "thought_level";
              if (request.input.key === "mode") {
                if (request.input.value !== nativeMode)
                  invalid("Native permission mode is pinned by node configuration");
              } else if (!safeCategory)
                invalid(
                  "Only model and reasoning controls may change while native permissions are pinned",
                );
            }
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
      if (cleanupError) {
        terminal = {
          type: "error",
          message: `ACP worker cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        };
      }
    }
    active = undefined;
    return terminal;
  }
  return { run, shutdown: () => runtime.shutdown() };
}

/** Disposable owner used by direct worker tests and single-invocation callers. */
export async function runWorker(start: WorkerStart, context: WorkerRuntimeContext): Promise<void> {
  const runtime = createWorkerRuntime(start);
  let terminal: ServerMessage;
  try {
    terminal = await runtime.run(start.request, context);
  } finally {
    await runtime.shutdown();
  }
  await context.send(terminal);
}
