import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { createRemoteAcpxNodeInvokePolicy } from "./policy.js";
import { COMMAND, type Request } from "./protocol.js";

const owner = { sessionKey: "agent:main:acp:test", agentId: "main" };
const ensure: Request = {
  op: "ensure",
  owner,
  input: { ...owner, agent: "codex", mode: "persistent" },
};
const handle = { ...owner, backend: "acpx", runtimeSessionName: "runtime-session" };

function context(params: unknown, decision: "allow-once" | "deny" | undefined = "allow-once") {
  const calls: unknown[] = [];
  let approvals = 0;
  const value: OpenClawPluginNodeInvokePolicyContext = {
    nodeId: "paired-node",
    command: COMMAND,
    params,
    config: {},
    approvals: {
      request: async () => {
        approvals++;
        return { decision };
      },
    },
    invokeNode: async (input) => {
      calls.push(input);
      return { ok: true };
    },
  };
  return { value, calls, approvals: () => approvals };
}

test("remote node policy constructs approval provenance only after a real approval", async () => {
  const ctx = context(ensure);
  const result = await createRemoteAcpxNodeInvokePolicy().handle(ctx.value);
  assert.equal(result.ok, true);
  assert.equal(ctx.approvals(), 1);
  assert.deepEqual(ctx.calls, [{ params: { request: ensure, authorization: "human-approved" } }]);
});

test("denied, absent and expired approval cannot dispatch a worker", async () => {
  for (const decision of ["deny", undefined] as const) {
    const ctx = context(ensure);
    ctx.value.approvals = { request: async () => ({ decision }) };
    assert.equal((await createRemoteAcpxNodeInvokePolicy().handle(ctx.value)).ok, false);
    assert.equal(ctx.calls.length, 0);
  }
  const ctx = context(ensure);
  ctx.value.approvals = undefined;
  assert.equal((await createRemoteAcpxNodeInvokePolicy().handle(ctx.value)).ok, false);
  assert.equal(ctx.calls.length, 0);
});

test("injected authorization and mismatched session owners are rejected before approval", async () => {
  for (const input of [
    { ...ensure, authorization: "human-approved" },
    { ...ensure, authorization: "node-policy" },
    { request: ensure, authorization: "node-policy" },
    { request: ensure, authorization: "human-approved" },
    { ...ensure, owner: { ...owner, agentId: "other" } },
  ]) {
    const ctx = context(input);
    assert.equal((await createRemoteAcpxNodeInvokePolicy().handle(ctx.value)).ok, false);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.approvals(), 0);
  }
});

function configure(ctx: ReturnType<typeof context>, config: Record<string, unknown>) {
  ctx.value.config = { plugins: { entries: { "remote-acpx": { enabled: true, config } } } };
}

test("configured node policy dispatches without a reviewer and does not claim human approval", async () => {
  const ctx = context(ensure);
  ctx.value.approvals = undefined;
  configure(ctx, {
    executionApproval: "node-policy",
    targets: { main: { nodeId: "paired-node" } },
  });
  assert.equal((await createRemoteAcpxNodeInvokePolicy().handle(ctx.value)).ok, true);
  assert.equal(ctx.approvals(), 0);
  assert.deepEqual(ctx.calls, [{ params: { request: ensure, authorization: "node-policy" } }]);
});

test("autonomous dispatch requires the current target for this owner", async () => {
  for (const config of [
    { executionApproval: "node-policy" },
    { executionApproval: "node-policy", target: { nodeId: "other-node" } },
    { executionApproval: "node-policy", targets: { other: { nodeId: "paired-node" } } },
    {
      executionApproval: "node-policy",
      target: { nodeId: "paired-node" },
      targets: { main: { nodeId: "other-node" } },
    },
  ]) {
    const ctx = context(ensure);
    configure(ctx, config);
    assert.equal((await createRemoteAcpxNodeInvokePolicy().handle(ctx.value)).ok, false);
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.approvals(), 0);
  }
});

test("changed configuration revokes autonomous authority despite a stale registration snapshot", async () => {
  const ctx = context(ensure);
  ctx.value.pluginConfig = { executionApproval: "node-policy", target: { nodeId: "paired-node" } };
  configure(ctx, { executionApproval: "always", target: { nodeId: "paired-node" } });
  const policy = createRemoteAcpxNodeInvokePolicy();
  assert.equal((await policy.handle(ctx.value)).ok, true);
  assert.equal(ctx.approvals(), 1);
  assert.deepEqual(ctx.calls, [{ params: { request: ensure, authorization: "human-approved" } }]);
  ctx.calls.length = 0;
  configure(ctx, ctx.value.pluginConfig);
  ctx.value.config.plugins!.entries!["remote-acpx"].enabled = false;
  assert.equal((await policy.handle(ctx.value)).ok, false);
  assert.equal(ctx.calls.length, 0);
});

test("cancellation only dispatches the non-spawning cancel envelope", async () => {
  const request: Request = { op: "cancel", owner, input: { handle } };
  const ctx = context(request);
  assert.equal((await createRemoteAcpxNodeInvokePolicy().handle(ctx.value)).ok, true);
  assert.equal(ctx.approvals(), 0);
  assert.deepEqual(ctx.calls, [{ params: { request, authorization: "cancel-only" } }]);
});
