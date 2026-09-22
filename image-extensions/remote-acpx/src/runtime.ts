import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
} from "openclaw/plugin-sdk/acp-backend";
import { normalizeAgentId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import type { Config, Target } from "./config.js";
import {
  BACKEND,
  COMMAND,
  MAX_BUFFER_BYTES,
  MAX_MESSAGE_BYTES,
  decodeMessage,
  encodeMessage,
  handleSchema,
  parseRequest,
  serverMessageSchema,
  type ClientMessage,
  type Owner,
  type Request,
  type ServerMessage,
} from "./protocol.js";

type Nodes = OpenClawPluginApi["runtime"]["nodes"];
type Channel = Awaited<ReturnType<Nodes["openDuplex"]>>;
const locatorSchema = z.strictObject({
  v: z.literal(1),
  nodeId: z.string().min(1),
  handle: handleSchema,
});
const PREFIX = "remote-acpx:v1:";
const capabilitiesSchema = z.object({
  controls: z.array(z.enum(["session/set_mode", "session/set_config_option", "session/status"])),
  configOptionKeys: z.array(z.string()).optional(),
});
const statusSchema = z.object({
  summary: z.string().optional(),
  acpxRecordId: z.string().optional(),
  backendSessionId: z.string().optional(),
  agentSessionId: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
const option = z.object({ value: z.string() });
const configResultSchema = z
  .object({
    configOptions: z.array(
      z.object({
        id: z.string(),
        category: z.string().nullable().optional(),
        currentValue: z.union([z.string(), z.boolean()]),
        options: z
          .union([z.array(option), z.array(z.object({ options: z.array(option) }))])
          .optional(),
      }),
    ),
  })
  .optional();

function ownerOf(input: { sessionKey: string; agentId?: string }): Owner {
  const sessionKey = input.sessionKey.trim().toLowerCase();
  const encoded = parseAgentSessionKey(sessionKey)?.agentId;
  const agentId = input.agentId?.trim() ? normalizeAgentId(input.agentId) : encoded;
  if (!sessionKey || !agentId || (encoded && encoded !== agentId)) {
    throw new Error(
      "Remote ACP requires the session's OpenClaw agentId; it must agree with the session key",
    );
  }
  return { sessionKey, agentId };
}
function decodeHandle(handle: AcpRuntimeHandle) {
  if (handle.backend !== BACKEND || !handle.runtimeSessionName.startsWith(PREFIX)) {
    throw new Error("Remote ACP handle is not from this backend; start a new session");
  }
  const locator = locatorSchema.parse(
    JSON.parse(
      Buffer.from(handle.runtimeSessionName.slice(PREFIX.length), "base64url").toString("utf8"),
    ),
  );
  for (const key of ["sessionKey", "agentId", "cwd", "acpxRecordId", "backendSessionId"] as const) {
    if (handle[key] !== locator.handle[key])
      throw new Error(`Remote ACP handle ${key} does not match its locator`);
  }
  ownerOf(handle);
  // Core reconciles the harness's native session ID after status without rewriting
  // runtimeSessionName. It is an observation, not node affinity or generation authority.
  return { ...locator, handle: { ...locator.handle, agentSessionId: handle.agentSessionId } };
}
function encodeHandle(handle: AcpRuntimeHandle, nodeId: string): AcpRuntimeHandle {
  return {
    ...handle,
    backend: BACKEND,
    runtimeSessionName:
      PREFIX + Buffer.from(JSON.stringify({ v: 1, nodeId, handle })).toString("base64url"),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Optional promptStarted/event consumers must not cause unhandled rejections.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
class EventQueue implements AsyncIterable<AcpRuntimeEvent> {
  private items: Array<{ event: AcpRuntimeEvent; bytes: number }> = [];
  private bytes = 0;
  private ended = false;
  private wake = deferred<void>();
  push(event: AcpRuntimeEvent) {
    if (this.ended) return;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (this.bytes + bytes > MAX_BUFFER_BYTES)
      throw new Error("Remote ACP event consumer exceeded the 16 MiB buffer; turn cancelled");
    this.items.push({ event, bytes });
    this.bytes += bytes;
    this.wake.resolve();
  }
  end(discard = false) {
    this.ended = true;
    if (discard) {
      this.items = [];
      this.bytes = 0;
    }
    this.wake.resolve();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const item = this.items.shift();
      if (item) {
        this.bytes -= item.bytes;
        yield item.event;
        continue;
      }
      if (this.ended) return;
      this.wake = deferred<void>();
      await this.wake.promise;
    }
  }
}
function terminal(value: unknown, nodeId: string): ServerMessage {
  const failure = z
    .object({
      ok: z.literal(false),
      error: z.object({ message: z.string(), code: z.string().optional() }),
    })
    .safeParse(value);
  if (failure.success) throw new Error(failure.data.error.message);
  const response = z
    .object({
      ok: z.literal(true),
      nodeId: z.string(),
      command: z.literal(COMMAND),
      payload: z.unknown().optional(),
      payloadJSON: z.string().nullable().optional(),
    })
    .parse(value);
  if (response.nodeId !== nodeId) throw new Error("Remote ACP response came from another node");
  return serverMessageSchema.parse(
    response.payloadJSON ? JSON.parse(response.payloadJSON) : response.payload,
  );
}

export function createRemoteAcpxRuntime(
  nodes: Nodes,
  config: Config,
): AcpRuntime & { shutdown(): Promise<void> } {
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
    return work;
  }
  function targetFor(owner: Owner): Target {
    const target = config.targets[owner.agentId] ?? config.target;
    if (!target)
      throw new Error(`Configure remote-acpx target.nodeId or targets.${owner.agentId}.nodeId`);
    return target;
  }
  async function open(
    nodeId: string,
    request: Request,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ) {
    lifetime.signal.throwIfAborted();
    encodeMessage(request);
    const selected = (await nodes.list({ connected: true })).nodes.find(
      (node) => node.nodeId === nodeId,
    );
    if (!selected)
      throw new Error(
        `Paired node ${nodeId} is offline or unavailable; reconnect the same node before retrying`,
      );
    if (!selected.commands?.includes(COMMAND) || !selected.invocableCommands?.includes(COMMAND)) {
      throw new Error(
        `Enable remote-acpx on node ${nodeId} and allow ${COMMAND} in gateway.nodes.commands.allow`,
      );
    }
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    combined.throwIfAborted();
    onDispatch?.();
    return await nodes.openDuplex({
      nodeId,
      command: COMMAND,
      params: parseRequest(request),
      sessionKey: request.owner.sessionKey,
      idempotencyKey: randomUUID(),
      timeoutMs: 0,
      signal: combined,
      maxMessageBytes: MAX_MESSAGE_BYTES,
      maxOutstandingDeliveryBytes: MAX_BUFFER_BYTES,
    });
  }
  async function call(nodeId: string, request: Request, signal?: AbortSignal): Promise<unknown> {
    return track(
      (async () => {
        const channel = await open(nodeId, request, signal);
        const unsubscribe = channel.onMessage(() => {
          channel.close();
          throw new Error("Unexpected streamed message during remote ACP control operation");
        });
        try {
          const message = terminal(await channel.closed, nodeId);
          if (message.type === "error") throw new Error(message.message);
          if (message.type !== "value")
            throw new Error("Remote ACP control completed without a value");
          return message.value;
        } finally {
          unsubscribe();
          channel.close();
        }
      })(),
    );
  }
  function handleRequest<
    T extends "status" | "capabilities" | "setMode" | "setConfigOption" | "close" | "cancel",
  >(op: T, input: { handle: AcpRuntimeHandle; [key: string]: unknown }) {
    const { nodeId, handle } = decodeHandle(input.handle);
    const request = parseRequest({ op, owner: ownerOf(handle), input: { ...input, handle } });
    return { nodeId, request };
  }
  const runtime: AcpRuntime & { shutdown(): Promise<void> } = {
    ownerAwareSessions: 1,
    async shutdown() {
      lifetime.abort(new Error("Remote ACP plugin stopped"));
      await Promise.allSettled([...pending]);
    },
    async ensureSession(input) {
      const owner = ownerOf(input);
      const persisted = input.persistedHandle ? decodeHandle(input.persistedHandle) : undefined;
      if (
        persisted &&
        (persisted.handle.agentId !== owner.agentId ||
          persisted.handle.sessionKey !== owner.sessionKey)
      )
        throw new Error("Remote ACP persisted handle belongs to another session");
      const target = persisted
        ? { nodeId: persisted.nodeId, cwd: persisted.handle.cwd }
        : targetFor(owner);
      const request = parseRequest({
        op: "ensure",
        owner,
        input: {
          ...input,
          ...owner,
          persistedHandle: persisted?.handle,
          cwd: input.cwd ?? target.cwd,
        },
      });
      const handle = handleSchema.parse(await call(target.nodeId, request));
      if (handle.sessionKey !== owner.sessionKey || handle.agentId !== owner.agentId)
        throw new Error("Remote ACP node returned a different session owner");
      return encodeHandle(handle, target.nodeId);
    },
    startTurn(input) {
      return startTurn(input);
    },
    async *runTurn(input) {
      const turn = startTurn(input);
      try {
        yield* turn.events;
        const result = await turn.result;
        if (result.status === "failed") yield { type: "error", ...result.error };
        else yield { type: "done", status: result.status, stopReason: result.stopReason };
      } finally {
        await turn.closeStream();
      }
    },
    async getCapabilities(input) {
      if (!input.handle)
        return { controls: ["session/set_mode", "session/set_config_option", "session/status"] };
      const { nodeId, request } = handleRequest("capabilities", { handle: input.handle });
      return capabilitiesSchema.parse(await call(nodeId, request));
    },
    async getStatus(input) {
      const { nodeId, request } = handleRequest("status", { handle: input.handle });
      return statusSchema.parse(await call(nodeId, request, input.signal));
    },
    async setMode(input) {
      const { nodeId, request } = handleRequest("setMode", input);
      await call(nodeId, request);
    },
    async setConfigOption(input) {
      const { nodeId, request } = handleRequest("setConfigOption", input);
      return configResultSchema.parse(await call(nodeId, request));
    },
    async cancel(input) {
      const { nodeId, request } = handleRequest("cancel", input);
      await call(nodeId, request);
    },
    async close(input) {
      const { nodeId, request } = handleRequest("close", input);
      await call(nodeId, request);
    },
    async prepareFreshSession(input) {
      const owner = ownerOf(input);
      const persisted = input.persistedHandle ? decodeHandle(input.persistedHandle) : undefined;
      const nodeId = persisted?.nodeId ?? targetFor(owner).nodeId;
      await call(
        nodeId,
        parseRequest({
          op: "fresh",
          owner,
          input: { ...owner, persistedHandle: persisted?.handle },
        }),
      );
    },
    async doctor() {
      try {
        const configured = [config.target, ...Object.values(config.targets)].filter(
          (target): target is Target => !!target,
        );
        if (!configured.length)
          throw new Error("Configure a stable paired nodeId in remote-acpx target or targets");
        const connected = (await nodes.list({ connected: true })).nodes;
        for (const target of configured) {
          if (
            !connected.some(
              (node) => node.nodeId === target.nodeId && node.invocableCommands?.includes(COMMAND),
            )
          )
            throw new Error(`Node ${target.nodeId} is unavailable or ${COMMAND} is not allowed`);
        }
        return {
          ok: true,
          message:
            "Configured paired nodes advertise remote ACP; execution is checked at invocation time",
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
  function startTurn(input: AcpRuntimeTurnInput): AcpRuntimeTurn {
    const queue = new EventQueue();
    const started = deferred<void>();
    const local = new AbortController();
    const signal = AbortSignal.any([local.signal, lifetime.signal]);
    let dispatchAttempted = false;
    let cancelRequested = false;
    let channel: Channel | undefined;
    let finished = false;
    let cancellation: Promise<void> | undefined;
    const elicitationIds = new Set<string>();
    const onCallerAbort = () => {
      void cancel({ reason: "Caller cancelled the remote ACP turn" });
    };
    input.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const result = track(
      (async () => {
        let unsubscribe: (() => void) | undefined;
        try {
          if (input.signal?.aborted) return { status: "cancelled" as const };
          const { nodeId, handle } = decodeHandle(input.handle);
          const request = parseRequest({
            op: "turn",
            owner: ownerOf(handle),
            input: {
              handle,
              text: input.text,
              attachments: input.attachments,
              mode: input.mode,
              requestId: input.requestId,
              elicitation: !!input.onElicitation,
            },
          });
          channel = await open(nodeId, request, signal, () => {
            dispatchAttempted = true;
          });
          unsubscribe = channel.onMessage((bytes) => {
            const message = serverMessageSchema.parse(decodeMessage(bytes));
            if (message.type === "started") {
              started.resolve();
              return;
            }
            if (message.type === "event") {
              queue.push(message.event);
              return;
            }
            if (message.type === "elicitation") {
              if (elicitationIds.has(message.id))
                throw new Error("Duplicate remote ACP elicitation request");
              if (elicitationIds.size >= 32)
                throw new Error("Too many pending remote ACP elicitation requests");
              elicitationIds.add(message.id);
              // Do not await UI input in the delivery callback: cancellation and later frames must flow.
              void (async () => {
                const response = input.onElicitation
                  ? await input.onElicitation(message.request, { requestId: message.id, signal })
                  : { action: "cancel" as const };
                if (!finished && !signal.aborted)
                  await channel?.send(
                    encodeMessage({ type: "elicitation_response", id: message.id, response }),
                  );
              })()
                .catch((error) => local.abort(error))
                .finally(() => elicitationIds.delete(message.id));
              return;
            }
            throw new Error("Unexpected remote ACP turn frame");
          });
          if (input.signal?.aborted)
            void cancel({ reason: "Caller cancelled the remote ACP turn" });
          const message = terminal(await channel.closed, nodeId);
          if (message.type === "error") throw new Error(message.message);
          if (message.type !== "result")
            throw new Error(
              "Remote ACP turn ended without a terminal result; check the session before retrying",
            );
          return message.result;
        } catch (error) {
          if (cancelRequested && !dispatchAttempted) return { status: "cancelled" as const };
          return {
            status: "failed" as const,
            error: {
              message: `${error instanceof Error ? error.message : String(error)}. The prompt may have started; inspect this session before retrying.`,
              code: "ACP_TURN_FAILED",
              retryable: false,
            },
          };
        } finally {
          finished = true;
          input.signal?.removeEventListener("abort", onCallerAbort);
          started.reject(new Error("Remote ACP turn ended before confirming prompt submission"));
          queue.end();
          unsubscribe?.();
          channel?.close();
          local.abort(new Error("Remote ACP turn settled"));
        }
      })(),
    );
    async function cancel(args?: { reason?: string }) {
      if (finished) return;
      cancelRequested = true;
      cancellation ??= (async () => {
        try {
          if (channel)
            await channel.send(
              encodeMessage({ type: "cancel", reason: args?.reason } satisfies ClientMessage),
            );
          else
            local.abort(
              new Error(args?.reason ?? "Remote ACP cancelled before the channel was ready"),
            );
        } catch (error) {
          if (!finished) local.abort(error);
        }
        await result;
      })();
      await cancellation;
    }
    return {
      requestId: input.requestId,
      promptStarted: started.promise,
      events: queue,
      result,
      cancel,
      async closeStream(args) {
        queue.end(true);
        await cancel(args);
      },
    };
  }
  return runtime;
}
