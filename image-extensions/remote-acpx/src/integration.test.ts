import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type {
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
} from "openclaw/plugin-sdk/acp-backend";
import { createPluginHarness } from "../test/helpers/plugin-harness.js";

const owner = { agentId: "main", sessionKey: "agent:main:integration" };
const ensureInput = { ...owner, agent: "fixture", mode: "persistent" as const };

async function start(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
  text: string,
  extra: Partial<AcpRuntimeTurnInput> = {},
) {
  assert.ok(runtime.startTurn, "the plugin must implement the current split stream/result API");
  return await runtime.startTurn({
    handle,
    text,
    mode: "prompt",
    requestId: randomUUID(),
    ...extra,
  });
}

async function collect(turn: AcpRuntimeTurn) {
  const events: AcpRuntimeEvent[] = [];
  for await (const event of turn.events) events.push(event);
  return {
    result: await turn.result,
    events,
    text: events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.text)
      .join(""),
  };
}

async function waitForWaiting(turn: AcpRuntimeTurn) {
  for await (const event of turn.events) {
    if (event.type === "text_delta" && event.text === "waiting") return;
  }
  assert.fail("fixture did not start the cancellable prompt");
}

test(
  "registered plugin runs on its paired node and resumes durable state after a plugin service restart",
  { timeout: 45_000 },
  async (t) => {
    const host = await createPluginHarness(t);
    const handle = await host.runtime.ensureSession(ensureInput);
    assert.equal(handle.backend, "remote-acpx");
    assert.equal(handle.agentId, owner.agentId);
    assert.equal(handle.cwd, host.cwd);
    const first = await start(host.runtime, handle, "first prompt");
    await first.promptStarted;
    const firstOutput = await collect(first);
    assert.equal(firstOutput.result.status, "completed");
    assert.equal(firstOutput.events.filter((event) => event.type === "text_delta").length, 2);
    const firstState = JSON.parse(firstOutput.text);
    assert.deepEqual(firstState.history, ["first prompt"]);
    assert.equal(firstState.cwd, host.cwd);

    const restarted = await host.restart();
    const resumed = await restarted.ensureSession({ ...ensureInput, persistedHandle: handle });
    assert.equal(resumed.acpxRecordId, handle.acpxRecordId);
    assert.equal(resumed.agentSessionId, handle.agentSessionId);
    const capabilities = await restarted.getCapabilities?.({ handle: resumed });
    assert.ok(capabilities?.controls.includes("session/set_mode"));
    await restarted.setMode?.({ handle: resumed, mode: "review" });
    const snapshot = await restarted.setConfigOption?.({
      handle: resumed,
      key: "tone",
      value: "brief",
    });
    assert.equal(
      snapshot?.configOptions.find((option) => option.id === "tone")?.currentValue,
      "brief",
    );
    const secondOutput = await collect(await start(restarted, resumed, "second prompt"));
    assert.equal(secondOutput.result.status, "completed");
    const secondState = JSON.parse(secondOutput.text);
    assert.equal(secondState.sessionId, firstState.sessionId);
    assert.deepEqual(secondState.history, ["first prompt", "second prompt"]);
    assert.equal(secondState.mode, "review");
    assert.equal(secondState.tone, "brief");
    assert.ok(host.authorizationChecks > 0);
    assert.equal(host.approvals.length, host.invocations.length);
    assert.ok(host.invocations.every((invocation) => invocation.nodeId === host.nodeId));
    const requests = await readFile(path.join(host.fixtureState, "requests.log"), "utf8");
    assert.equal(requests.split("\n").filter((method) => method === "session/new").length, 1);
    assert.ok(requests.includes("session/load"));
  },
);

for (const method of ["turn.cancel", "AbortSignal"] as const) {
  test(
    `${method} cancellation reaches the ACP process and the same session remains resumable`,
    { timeout: 30_000 },
    async (t) => {
      const host = await createPluginHarness(t);
      const handle = await host.runtime.ensureSession(ensureInput);
      const controller = new AbortController();
      const turn = await start(host.runtime, handle, "wait-for-cancel", {
        signal: controller.signal,
      });
      await turn.promptStarted;
      await waitForWaiting(turn);
      if (method === "turn.cancel") await turn.cancel({ reason: "user stopped the turn" });
      else controller.abort(new Error("user stopped the turn"));
      assert.equal((await turn.result).status, "cancelled");
      const resumed = await collect(await start(host.runtime, handle, "after cancellation"));
      assert.equal(resumed.result.status, "completed");
      assert.deepEqual(JSON.parse(resumed.text).history, ["wait-for-cancel", "after cancellation"]);
      assert.match(
        await readFile(path.join(host.fixtureState, "requests.log"), "utf8"),
        /session\/cancel/,
      );
    },
  );
}

test(
  "node disconnect fails the active turn without retrying or selecting another paired node",
  { timeout: 30_000 },
  async (t) => {
    const host = await createPluginHarness(t);
    const handle = await host.runtime.ensureSession(ensureInput);
    const turn = await start(host.runtime, handle, "wait-for-cancel");
    await turn.promptStarted;
    await waitForWaiting(turn);
    await host.disconnect();
    const result = await turn.result;
    assert.equal(result.status, "failed");
    if (result.status !== "failed") assert.fail("disconnect must report failure");
    assert.match(result.error.message, /disconnected/i);
    assert.equal(result.error.retryable, false);
    const dispatched = host.invocations.length;
    await assert.rejects(
      host.runtime.ensureSession({ ...ensureInput, persistedHandle: handle }),
      /offline|unavailable/i,
    );
    assert.equal(host.invocations.length, dispatched);
    assert.ok(host.invocations.every((invocation) => invocation.nodeId === host.nodeId));
  },
);

test(
  "approval denial and revoked node execution authority prevent process launch",
  { timeout: 20_000 },
  async (t) => {
    const host = await createPluginHarness(t);
    host.setApproval(false);
    await assert.rejects(host.runtime.ensureSession(ensureInput), /denied/i);
    assert.equal(host.invocations.length, 0);
    assert.equal(host.authorizationChecks, 0);
    host.setApproval(true);
    host.revokeAuthorization();
    await assert.rejects(host.runtime.ensureSession(ensureInput), /authority is closed/i);
    await assert.rejects(readFile(path.join(host.fixtureState, "requests.log")), {
      code: "ENOENT",
    });
  },
);

test(
  "paired-node elicitation is answered through the active turn's duplex channel",
  { timeout: 30_000 },
  async (t) => {
    const host = await createPluginHarness(t);
    const handle = await host.runtime.ensureSession(ensureInput);
    let questions = 0;
    const turn = await start(host.runtime, handle, "elicit", {
      onElicitation: async (request, context) => {
        questions++;
        assert.equal(request.mode, "form");
        assert.equal(context.signal.aborted, false);
        return { action: "accept", content: { answer: "node response" } };
      },
    });
    const output = await collect(turn);
    assert.equal(output.result.status, "completed");
    assert.equal(questions, 1);
    assert.deepEqual(JSON.parse(output.text), {
      answer: { action: "accept", content: { answer: "node response" } },
    });
  },
);
