import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { getAcpRuntimeBackend, type AcpRuntime } from "openclaw/plugin-sdk/acp-backend";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
  OpenClawPluginService,
} from "openclaw/plugin-sdk/plugin-entry";
import plugin from "../../index.js";
import { BACKEND, COMMAND, parseRequest, type Request } from "../../src/protocol.js";
import { parseConfig } from "../../src/config.js";

type Nodes = OpenClawPluginApi["runtime"]["nodes"];
type Channel = Awaited<ReturnType<Nodes["openDuplex"]>>;
type Listener = Parameters<Channel["onMessage"]>[0];
type Approval = NonNullable<OpenClawPluginNodeInvokePolicyContext["approvals"]>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mailbox() {
  let listener: Listener | undefined;
  const pending: Uint8Array[] = [];
  let delivery = Promise.resolve();
  return {
    send(message: Uint8Array): Promise<void> {
      const bytes = Uint8Array.from(message);
      if (!listener) {
        pending.push(bytes);
        return Promise.resolve();
      }
      const current = listener;
      delivery = delivery.then(() => current(bytes));
      return delivery;
    },
    onMessage(next: Listener): () => void {
      assert.equal(listener, undefined, "one consumer owns each side of the channel");
      listener = next;
      for (const message of pending.splice(0)) delivery = delivery.then(() => next(message));
      return () => {
        listener = undefined;
      };
    },
    drained: () => delivery,
  };
}

/**
 * Runs the published plugin registration, policy, node command, worker and acpx.
 * Only the host's paired-node inventory, approval decision and binary transport
 * are in-process stand-ins; this does not claim WebSocket/pairing coverage.
 */
export async function createPluginHarness(
  t: TestContext,
  options: { persistOnPrompt?: boolean } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-acpx-integration-"));
  const cwd = path.join(root, "node-workspace");
  const fixtureState = path.join(root, "fixture-state");
  await Promise.all([mkdir(cwd), mkdir(fixtureState)]);
  const nodeId = "paired-node-a";
  const config = parseConfig({
    target: { nodeId, cwd },
    node: {
      cwd,
      stateDir: path.join(root, "acpx-state"),
      agents: {
        fixture: [
          process.execPath,
          fileURLToPath(new URL("../fixtures/agent.mjs", import.meta.url)),
          fixtureState,
          ...(options.persistOnPrompt ? ["--persist-on-prompt"] : []),
        ],
      },
      permissionMode: "deny-all",
    },
  });
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const services: OpenClawPluginService[] = [];
  const commands: OpenClawPluginNodeHostCommand[] = [];
  const policies: OpenClawPluginNodeInvokePolicy[] = [];
  const active = new Set<{
    abort: AbortController;
    closed: Promise<unknown>;
    fail: (error: Error) => void;
  }>();
  const invocations: Array<{ nodeId: string; request: Request }> = [];
  const approvals: Array<Parameters<Approval["request"]>[0]> = [];
  let connected = true;
  let approve = true;
  let authorizationValid = true;
  let authorizationChecks = 0;

  const nodes: Nodes = {
    list: async (params) => ({
      nodes: [
        { nodeId, connected, commands: [COMMAND], invocableCommands: [COMMAND] },
        {
          nodeId: "paired-node-b",
          connected: true,
          commands: [COMMAND],
          invocableCommands: [COMMAND],
        },
      ].filter((node) => !params?.connected || node.connected),
    }),
    invoke: async () => {
      throw new Error("Remote ACP must use its duplex command");
    },
    openDuplex: async (params) => {
      assert.equal(params.nodeId, nodeId, "the adapter must never fall back to another node");
      assert.equal(params.command, COMMAND);
      assert.equal(params.timeoutMs, 0, "ACP turns must not inherit node.invoke's short timeout");
      if (!connected) throw new Error("Selected paired node disconnected");
      assert.equal(commands.length, 1);
      assert.equal(policies.length, 1);
      const command = commands[0]!;
      const policy = policies[0]!;
      assert.equal(command.duplex, true);
      assert.equal(command.dangerous, true);
      assert.deepEqual(policy.commands, [COMMAND]);
      const nodeInbox = mailbox();
      const gatewayInbox = mailbox();
      const abort = new AbortController();
      const abortFromCaller = () => abort.abort(params.signal?.reason);
      if (params.signal?.aborted) abortFromCaller();
      else params.signal?.addEventListener("abort", abortFromCaller, { once: true });
      const ready = deferred<Channel>();
      const completion = deferred<unknown>();
      // Rejections belong to the caller, but can precede its onMessage binding.
      void completion.promise.catch(() => {});
      const invocation = { abort, closed: completion.promise, fail: completion.reject };
      active.add(invocation);
      let dispatched = false;
      const channel: Channel = {
        send: async (bytes) => {
          if (abort.signal.aborted) throw abort.signal.reason;
          await nodeInbox.send(bytes);
        },
        onMessage: gatewayInbox.onMessage,
        closed: completion.promise,
        close: () => abort.abort(new Error("Gateway closed the invocation")),
      };
      void Promise.resolve()
        .then(() =>
          policy.handle({
            nodeId,
            command: COMMAND,
            params: params.params,
            config: {},
            pluginConfig: config,
            timeoutMs: params.timeoutMs,
            idempotencyKey: params.idempotencyKey,
            node: { nodeId, commands: [COMMAND] },
            approvals: {
              request: async (request) => {
                approvals.push(request);
                return { decision: approve ? "allow-once" : "deny" };
              },
            },
            invokeNode: async (override = {}) => {
              dispatched = true;
              invocations.push({ nodeId, request: parseRequest(params.params) });
              ready.resolve(channel);
              const payloadJSON = await command.handle(
                JSON.stringify(override.params ?? params.params),
                {
                  signal: abort.signal,
                  frames: { send: gatewayInbox.send, onMessage: nodeInbox.onMessage },
                  emitChunk: async () => {
                    throw new Error("Legacy chunk transport used");
                  },
                  onInput: () => {
                    throw new Error("Legacy input transport used");
                  },
                },
                {
                  sessionKey: params.sessionKey,
                  signal: abort.signal,
                  sendNodeEvent: async () => {
                    throw new Error("Legacy global node events used");
                  },
                  prepareExecAuthorization: (source) => {
                    assert.equal(source, "human-approved");
                    return () => {
                      authorizationChecks++;
                      if (!authorizationValid || abort.signal.aborted)
                        throw new Error("Execution authority is closed");
                    };
                  },
                },
              );
              return { ok: true, payloadJSON };
            },
          }),
        )
        .then(async (result) => {
          await gatewayInbox.drained();
          if (!result.ok) throw new Error(result.message);
          if (!dispatched) throw new Error("Policy allowed an invocation without dispatching it");
          completion.resolve({ ...result, nodeId, command: COMMAND });
        })
        .catch((error: unknown) => {
          ready.reject(error);
          completion.reject(error);
        })
        .finally(() => {
          active.delete(invocation);
          params.signal?.removeEventListener("abort", abortFromCaller);
        });
      return ready.promise;
    },
  };

  // Fail on unexpected host use instead of furnishing no-op APIs that could
  // conceal accidental dependencies on private OpenClaw runtime capabilities.
  const registrationApi = {
    id: BACKEND,
    name: "Remote ACPX",
    source: "integration-test",
    registrationMode: "full",
    config: {},
    pluginConfig: config,
    logger,
    runtime: { nodes },
    registerService: (service: OpenClawPluginService) => {
      services.push(service);
    },
    registerNodeHostCommand: (command: OpenClawPluginNodeHostCommand) => {
      commands.push(command);
    },
    registerNodeInvokePolicy: (policy: OpenClawPluginNodeInvokePolicy) => {
      policies.push(policy);
    },
    on: ((hook, handler, options) => {
      assert.equal(hook, "reply_dispatch");
      assert.equal(typeof handler, "function");
      assert.deepEqual(options, { eligibleDispatchKinds: ["acp"] });
    }) satisfies OpenClawPluginApi["on"],
  };
  const api = new Proxy(registrationApi, {
    get(target, key) {
      if (!(key in target)) throw new Error(`Unexpected host API: ${String(key)}`);
      return Reflect.get(target, key);
    },
  }) as unknown as OpenClawPluginApi;
  const serviceContext = { config: {}, stateDir: path.join(root, "gateway-state"), logger };
  t.after(async () => {
    for (const service of [...services].reverse()) await service.stop?.(serviceContext);
    for (const invocation of active) invocation.abort.abort(new Error("Test shutdown"));
    await Promise.allSettled([...active].map((invocation) => invocation.closed));
    for (const command of commands) await command.onDisconnect?.();
    await rm(root, { recursive: true, force: true });
  });
  await plugin.register(api);
  for (const service of services) await service.start(serviceContext);
  const runtime = getAcpRuntimeBackend(BACKEND)?.runtime;
  assert.ok(runtime, "plugin service must register the ACP backend");
  return {
    runtime,
    root,
    cwd,
    fixtureState,
    nodeId,
    invocations,
    approvals,
    get authorizationChecks() {
      return authorizationChecks;
    },
    setApproval(value: boolean) {
      approve = value;
    },
    revokeAuthorization() {
      authorizationValid = false;
    },
    setConnected(value: boolean) {
      connected = value;
    },
    async restart(): Promise<AcpRuntime> {
      for (const service of [...services].reverse()) await service.stop?.(serviceContext);
      for (const service of services) await service.start(serviceContext);
      const restarted = getAcpRuntimeBackend(BACKEND)?.runtime;
      assert.ok(restarted);
      return restarted;
    },
    async disconnect() {
      connected = false;
      for (const invocation of active) {
        const error = new Error("Selected paired node disconnected");
        invocation.fail(error);
        invocation.abort.abort(error);
      }
      for (const command of commands) await command.onDisconnect?.();
    },
  };
}
