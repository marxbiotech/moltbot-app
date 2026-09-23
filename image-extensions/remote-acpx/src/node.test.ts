import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import { createRemoteAcpxNodeCommand } from "./node.js";
import type { NodeConfig } from "./config.js";
import { encodeMessage, type Request, type ServerMessage } from "./protocol.js";

type Io = NonNullable<Parameters<OpenClawPluginNodeHostCommand["handle"]>[1]>;
type Context = NonNullable<Parameters<OpenClawPluginNodeHostCommand["handle"]>[2]>;
const owner = { sessionKey: "agent:main:acp:node-test", agentId: "main" };
const handle = { ...owner, backend: "acpx", runtimeSessionName: "runtime-session" };
const config: NodeConfig = {
  cwd: "/tmp",
  stateDir: "/tmp/remote-acpx-unused",
  agents: {},
  permissionMode: "deny-all",
};
const ensure: Request = {
  op: "ensure",
  owner,
  input: { ...owner, agent: "codex", mode: "persistent" },
};
const workerUrl = new URL("../test/fixtures/node-host-worker.mjs", import.meta.url);
const fixtureCommands = new Set<OpenClawPluginNodeHostCommand>();
afterEach(async () => {
  const owned = [...fixtureCommands];
  fixtureCommands.clear();
  await Promise.all(owned.map((command) => command.onDisconnect?.()));
});

function harness(
  command: OpenClawPluginNodeHostCommand,
  request: Request,
  contextOverride: Partial<Context> = {},
  authorization: "human-approved" | "node-policy" = "human-approved",
) {
  fixtureCommands.add(command);
  let listener: ((bytes: Uint8Array) => void | Promise<void>) | undefined;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const frames: ServerMessage[] = [];
  const controller = new AbortController();
  const io: Io = {
    signal: controller.signal,
    emitChunk: async () => {},
    onInput: () => {},
    frames: {
      send: async (bytes) => {
        const message = JSON.parse(Buffer.from(bytes).toString()) as ServerMessage;
        frames.push(message);
        if (message.type === "started") resolveStarted();
      },
      onMessage: (receiver) => {
        listener = receiver;
        return () => {
          listener = undefined;
        };
      },
    },
  };
  let checks = 0;
  const context: Context = {
    sessionKey: request.owner.sessionKey,
    sendNodeEvent: async () => {},
    prepareExecAuthorization: () => () => {
      checks++;
    },
    ...contextOverride,
  };
  const result = command.handle(
    JSON.stringify({
      request,
      authorization: request.op === "cancel" ? "cancel-only" : authorization,
    }),
    io,
    context,
  );
  void result.catch(() => {});
  return {
    result,
    started,
    frames,
    controller,
    checks: () => checks,
    send: async (message: unknown) => {
      assert.ok(listener, "node registered its frame receiver");
      await listener(encodeMessage(message));
    },
  };
}

function turn(text: string): Request {
  return { op: "turn", owner, input: { handle, text, mode: "prompt", requestId: "turn-1" } };
}

test(
  "node launches only after the final authorization guard and uses its local configuration",
  { timeout: 15_000 },
  async () => {
    const command = createRemoteAcpxNodeCommand(config, { workerUrl });
    const run = harness(command, ensure);
    assert.deepEqual(JSON.parse(await run.result), {
      type: "value",
      value: { op: "ensure", config },
    });
    assert.equal(run.checks(), 1);
  },
);

test("node rejects session mismatch and revoked spawn authority", { timeout: 15_000 }, async () => {
  const command = createRemoteAcpxNodeCommand(config, { workerUrl });
  const mismatch = harness(command, ensure, { sessionKey: "agent:main:another" });
  await assert.rejects(mismatch.result, /session does not match/);
  assert.equal(mismatch.checks(), 0);
  const revoked = harness(command, ensure, {
    prepareExecAuthorization: () => () => {
      throw new Error("authority closed");
    },
  });
  await assert.rejects(revoked.result, /authority closed/);
  assert.equal(revoked.frames.length, 0);
});

test("node policy fails closed on old hosts and never falls back to human approval", async () => {
  const command = createRemoteAcpxNodeCommand(config, { workerUrl });
  const run = harness(command, ensure, {}, "node-policy");
  await assert.rejects(run.result, /upgrade the node host/);
  assert.equal(run.checks(), 0);
  assert.equal(run.frames.length, 0);
});

test("configured authorization is renewed before reusing a setup worker", async () => {
  const command = createRemoteAcpxNodeCommand(config, { workerUrl });
  let prepared = 0;
  let guarded = 0;
  let permitted = true;
  const context = {
    prepareConfiguredExecAuthorization: () => {
      prepared++;
      return () => {
        guarded++;
        if (!permitted) throw new Error("node policy revoked");
      };
    },
  };
  const setup = harness(command, ensure, context, "node-policy");
  assert.equal(JSON.parse(await setup.result).type, "value");
  assert.equal(setup.checks(), 0);
  permitted = false;
  const turnAfterRevocation = harness(command, turn("next"), context, "node-policy");
  await assert.rejects(turnAfterRevocation.result, /node policy revoked/);
  assert.equal(prepared, 2);
  assert.equal(guarded, 2);
  assert.equal(turnAfterRevocation.frames.length, 0);
});

test(
  "node serializes session writers and cancellation drains the active worker",
  { timeout: 15_000 },
  async () => {
    const command = createRemoteAcpxNodeCommand(config, { workerUrl });
    const run = harness(command, turn("wait"));
    await run.started;
    await assert.rejects(harness(command, ensure).result, /ACP_SESSION_BUSY/);
    const cancel: Request = { op: "cancel", owner, input: { handle } };
    const cancellation = harness(command, cancel);
    assert.deepEqual(JSON.parse(await cancellation.result), {
      type: "value",
      value: { cancelled: true },
    });
    assert.equal(cancellation.checks(), 0);
    assert.equal(JSON.parse(await run.result).result.status, "cancelled");
    assert.equal(JSON.parse(await harness(command, ensure).result).type, "value");
  },
);

test(
  "fresh waits for the previous turn to stop before starting its worker",
  { timeout: 15_000 },
  async () => {
    const command = createRemoteAcpxNodeCommand(config, { workerUrl });
    const run = harness(command, turn("wait"));
    await run.started;
    const fresh: Request = { op: "fresh", owner, input: owner };
    assert.equal(JSON.parse(await harness(command, fresh).result).value.op, "fresh");
    assert.equal(JSON.parse(await run.result).result.status, "cancelled");
  },
);

test(
  "status and capabilities can read during a turn without replacing its writer owner",
  { timeout: 15_000 },
  async () => {
    const command = createRemoteAcpxNodeCommand(config, { workerUrl });
    const run = harness(command, turn("wait"));
    await run.started;
    for (const op of ["status", "capabilities"] as const) {
      const read: Request = { op, owner, input: { handle } };
      assert.equal(JSON.parse(await harness(command, read).result).value.op, op);
    }
    await assert.rejects(harness(command, ensure).result, /ACP_SESSION_BUSY/);
    const cancel: Request = { op: "cancel", owner, input: { handle } };
    assert.equal(JSON.parse(await harness(command, cancel).result).value.cancelled, true);
    assert.equal(JSON.parse(await run.result).result.status, "cancelled");
  },
);

test(
  "a stale handle cannot cancel or close a newer turn of the same logical session",
  { timeout: 15_000 },
  async () => {
    const command = createRemoteAcpxNodeCommand(config, { workerUrl });
    const run = harness(command, turn("wait"));
    await run.started;
    const stale = { ...handle, runtimeSessionName: "previous-runtime-session" };
    const cancel: Request = { op: "cancel", owner, input: { handle: stale } };
    await assert.rejects(harness(command, cancel).result, /does not match the active turn/);
    const close: Request = { op: "close", owner, input: { handle: stale, reason: "done" } };
    await assert.rejects(harness(command, close).result, /does not match its active worker/);
    await run.send({ type: "cancel" });
    assert.equal(JSON.parse(await run.result).result.status, "cancelled");
  },
);

test(
  "abort and disconnect terminate a worker even when it ignores cancellation",
  { timeout: 15_000 },
  async () => {
    for (const kind of ["abort", "disconnect"] as const) {
      const command = createRemoteAcpxNodeCommand(config, {
        workerUrl,
        cancelGraceMs: 20,
        killGraceMs: 20,
      });
      const run = harness(command, turn("ignore-cancel"));
      await run.started;
      if (kind === "abort") run.controller.abort(new Error("caller closed"));
      else await command.onDisconnect?.();
      await assert.rejects(run.result, kind === "abort" ? /caller closed/ : /worker exited/);
      assert.equal(JSON.parse(await harness(command, ensure).result).type, "value");
    }
  },
);

test(
  "duplex input cannot replace the admitted request or worker configuration",
  { timeout: 15_000 },
  async () => {
    const command = createRemoteAcpxNodeCommand(config, { workerUrl });
    const run = harness(command, turn("wait"));
    await run.started;
    await assert.rejects(run.send({ type: "start", request: ensure, config }));
    await assert.rejects(run.result);
  },
);

test(
  "forced cleanup kills descendants even when the worker leader exits first",
  { timeout: 15_000 },
  async () => {
    const command = createRemoteAcpxNodeCommand(config, {
      workerUrl,
      cancelGraceMs: 20,
      killGraceMs: 20,
    });
    const run = harness(command, turn("orphan-child"));
    await run.started;
    for (let i = 0; i < 100 && !run.frames.some((message) => message.type === "event"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const event = run.frames.find((message) => message.type === "event");
    assert.ok(event?.type === "event" && event.event.type === "status");
    const pid = Number(event.event.text);
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    process.kill(pid, 0);
    run.controller.abort(new Error("caller closed"));
    await assert.rejects(run.result, /caller closed/);
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(alive, false, "the child process must not survive its worker group");
  },
);

test(
  "reusing session setup needs fresh authority, ignores a settled invocation abort, and drains on disconnect",
  { timeout: 15_000 },
  async () => {
    const command = createRemoteAcpxNodeCommand(config, { workerUrl });
    const request: Request = { ...ensure, input: { ...ensure.input, agent: "report-pid" } };
    const first = harness(command, request);
    const pid = JSON.parse(await first.result).value.pid;
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    first.controller.abort(new Error("settled invocation closed"));
    const second = harness(command, request);
    assert.equal(JSON.parse(await second.result).value.pid, pid);
    assert.equal(second.checks(), 1);
    const denied = harness(command, request, {
      prepareExecAuthorization: () => () => {
        throw new Error("authority closed");
      },
    });
    await assert.rejects(denied.result, /authority closed/);
    process.kill(pid, 0);
    await command.onDisconnect?.();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);
