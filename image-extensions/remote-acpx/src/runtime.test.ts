import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteAcpxRuntime } from "./runtime.js";
import { COMMAND, decodeMessage, encodeMessage, parseRequest, type Request } from "./protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Nodes = Parameters<typeof createRemoteAcpxRuntime>[0];
type Channel = Awaited<ReturnType<Nodes["openDuplex"]>>;
const owner = { agentId: "main", sessionKey: "agent:main:acp:abort-proof" };
const nodeId = "paired-node";

function harness() {
  let phase: "normal" | "list" | "open" = "normal";
  const entered = deferred<void>();
  const releaseList = deferred<void>();
  const subscribed = deferred<void>();
  const closed = deferred<unknown>();
  const sent: unknown[] = [];
  let turnDispatches = 0;
  let earlyCloses = 0;
  let settled = false;
  let transportSignal: AbortSignal | undefined;
  const localHandle = {
    ...owner,
    backend: "acpx",
    runtimeSessionName: "fixture-record",
    cwd: "/fixture",
    acpxRecordId: "fixture-record",
    backendSessionId: "fixture-session",
  };
  const terminal = (payload: unknown) => ({ ok: true, nodeId, command: COMMAND, payload });
  const nodes: Nodes = {
    async list() {
      if (phase === "list") {
        entered.resolve();
        await releaseList.promise;
      }
      return {
        nodes: [{ nodeId, connected: true, commands: [COMMAND], invocableCommands: [COMMAND] }],
      };
    },
    async invoke() {
      throw new Error("unexpected invoke");
    },
    async openDuplex(params) {
      const request = parseRequest(params.params);
      if (request.op === "ensure") {
        return {
          send: async () => {},
          onMessage: () => () => {},
          closed: Promise.resolve(terminal({ type: "value", value: localHandle })),
          close: () => {},
        };
      }
      assert.equal(request.op, "turn");
      turnDispatches++;
      transportSignal = params.signal;
      if (phase === "open") {
        entered.resolve();
        return await new Promise<Channel>((_resolve, reject) => {
          const abort = () => reject(params.signal?.reason ?? new Error("dispatch cancelled"));
          if (params.signal?.aborted) abort();
          else params.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return {
        send: async (bytes) => {
          sent.push(decodeMessage(bytes));
        },
        onMessage(listener) {
          void listener(encodeMessage({ type: "started" }));
          subscribed.resolve();
          return () => {};
        },
        closed: closed.promise,
        close() {
          if (!settled) earlyCloses++;
        },
      };
    },
  };
  const runtime = createRemoteAcpxRuntime(nodes, {
    target: { nodeId, cwd: "/fixture" },
    targets: {},
  });
  return {
    runtime,
    entered: entered.promise,
    subscribed: subscribed.promise,
    sent,
    hold(next: typeof phase) {
      phase = next;
    },
    releaseList() {
      releaseList.resolve();
    },
    get turnDispatches() {
      return turnDispatches;
    },
    get earlyCloses() {
      return earlyCloses;
    },
    get signal() {
      return transportSignal;
    },
    finish() {
      settled = true;
      closed.resolve(terminal({ type: "result", result: { status: "cancelled" } }));
    },
    ensure() {
      return runtime.ensureSession({ ...owner, agent: "fixture", mode: "persistent" });
    },
  };
}

test(
  "caller cancellation during node lookup prevents turn dispatch",
  { timeout: 5_000 },
  async () => {
    const host = harness();
    const handle = await host.ensure();
    host.hold("list");
    const controller = new AbortController();
    const turn = host.runtime.startTurn!({
      handle,
      text: "never run",
      mode: "prompt",
      requestId: "before-dispatch",
      signal: controller.signal,
    });
    await host.entered;
    controller.abort();
    host.releaseList();
    assert.equal((await turn.result).status, "cancelled");
    assert.equal(host.turnDispatches, 0);
    // Leave promptStarted unobserved: the runtime must observe its own rejection.
    await host.runtime.shutdown();
  },
);

test(
  "caller cancellation aborts an invocation still waiting for duplex readiness",
  { timeout: 5_000 },
  async () => {
    const host = harness();
    const handle = await host.ensure();
    host.hold("open");
    const controller = new AbortController();
    const turn = host.runtime.startTurn!({
      handle,
      text: "awaiting admission",
      mode: "prompt",
      requestId: "pending-dispatch",
      signal: controller.signal,
    });
    await host.entered;
    controller.abort();
    const result = await turn.result;
    assert.equal(host.signal?.aborted, true);
    assert.equal(host.sent.length, 0);
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.retryable, false);
    await turn.cancel();
    await host.runtime.shutdown();
  },
);

test(
  "active caller cancellation keeps the transport until the worker terminal result",
  { timeout: 5_000 },
  async () => {
    const host = harness();
    const handle = await host.ensure();
    const controller = new AbortController();
    const turn = host.runtime.startTurn!({
      handle,
      text: "active",
      mode: "prompt",
      requestId: "active-dispatch",
      signal: controller.signal,
    });
    await host.subscribed;
    await turn.promptStarted;
    controller.abort();
    let cancelSettled = false;
    const cancelled = turn.cancel().then(() => {
      cancelSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(host.signal?.aborted, false);
    assert.equal(host.earlyCloses, 0);
    assert.equal(cancelSettled, false);
    assert.equal(host.sent.length, 1);
    assert.equal((host.sent[0] as { type: string }).type, "cancel");
    host.finish();
    await cancelled;
    assert.equal((await turn.result).status, "cancelled");
    await host.runtime.shutdown();
  },
);

test("core-reconciled native session IDs remain usable without weakening generation checks", async () => {
  const calls: Request[] = [];
  const localHandle = {
    ...owner,
    backend: "acpx",
    runtimeSessionName: "stable-generation-locator",
    cwd: "/fixture",
    acpxRecordId: "stable-record",
    backendSessionId: "stable-acp-session",
  };
  const nativeId = "native-session-learned-after-first-prompt";
  const nodes: Nodes = {
    async list() {
      return {
        nodes: [{ nodeId, connected: true, commands: [COMMAND], invocableCommands: [COMMAND] }],
      };
    },
    async invoke() {
      throw new Error("unexpected invoke");
    },
    async openDuplex(input) {
      const request = parseRequest(input.params);
      calls.push(request);
      const payload =
        request.op === "turn"
          ? { type: "result", result: { status: "completed" } }
          : {
              type: "value",
              value:
                request.op === "ensure"
                  ? {
                      ...localHandle,
                      agentSessionId: request.input.persistedHandle?.agentSessionId,
                    }
                  : { backendSessionId: localHandle.backendSessionId, agentSessionId: nativeId },
            };
      return {
        send: async () => {},
        onMessage(listener) {
          if (request.op === "turn") void listener(encodeMessage({ type: "started" }));
          return () => {};
        },
        closed: Promise.resolve({ ok: true, nodeId, command: COMMAND, payload }),
        close: () => {},
      };
    },
  };
  const runtime = createRemoteAcpxRuntime(nodes, { target: { nodeId }, targets: {} });
  try {
    const initial = await runtime.ensureSession({ ...owner, agent: "fixture", mode: "persistent" });
    assert.equal(initial.agentSessionId, undefined);
    const status = await runtime.getStatus!({ handle: initial });
    // The core manager copies observed identifiers onto its cached handle while
    // retaining runtimeSessionName; that observation must not invalidate affinity.
    const reconciled = { ...initial, agentSessionId: status.agentSessionId };
    assert.equal(reconciled.runtimeSessionName, initial.runtimeSessionName);
    const followup = runtime.startTurn!({
      handle: reconciled,
      text: "follow up",
      mode: "prompt",
      requestId: "native-id-followup",
    });
    assert.equal((await followup.result).status, "completed");
    const forwarded = calls.find((request) => request.op === "turn");
    assert.ok(forwarded?.op === "turn");
    assert.equal(forwarded.input.handle.agentSessionId, nativeId);
    assert.equal(forwarded.input.handle.runtimeSessionName, localHandle.runtimeSessionName);
    const resumed = await runtime.ensureSession({
      ...owner,
      agent: "fixture",
      mode: "persistent",
      persistedHandle: reconciled,
    });
    assert.equal(resumed.agentSessionId, nativeId);
    const count = calls.length;
    await assert.rejects(
      runtime.getStatus!({ handle: { ...reconciled, backendSessionId: "other-generation" } }),
      /backendSessionId does not match/,
    );
    assert.equal(calls.length, count, "a changed generation must fail before dispatch");
  } finally {
    await runtime.shutdown();
  }
});
