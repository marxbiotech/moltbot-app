import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AcpRuntimeHandle } from "acpx/runtime";
import type { NodeConfig } from "./config.js";
import { parseRequest, type Owner, type Request, type ServerMessage } from "./protocol.js";
import { runWorker } from "./worker-runtime.js";

const fixture = fileURLToPath(new URL("../test/fixtures/agent.mjs", import.meta.url));
const owner: Owner = { sessionKey: "agent:main:acp:worker-test", agentId: "main" };

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "remote-acpx-worker-"));
  const peer = path.join(directory, "peer");
  await fs.mkdir(peer);
  const config: NodeConfig = {
    cwd: directory,
    stateDir: path.join(directory, "state"),
    agents: { fixture: [process.execPath, fixture, peer] },
    permissionMode: "deny-all",
  };
  async function call(
    request: Request,
    controller = new AbortController(),
    onMessage?: (message: ServerMessage) => void,
  ) {
    const messages: ServerMessage[] = [];
    await runWorker(
      { type: "start", config, request: parseRequest(request) },
      {
        signal: controller.signal,
        send: async (message) => {
          messages.push(message);
          onMessage?.(message);
        },
        onElicitation: async () => ({ action: "cancel" }),
      },
    );
    return { messages, terminal: messages.at(-1)! };
  }
  async function ensure(target = owner) {
    const { terminal } = await call({
      op: "ensure",
      owner: target,
      input: { ...target, agent: "fixture", mode: "persistent" },
    });
    assert.equal(terminal.type, "value", JSON.stringify(terminal));
    return (terminal as { type: "value"; value: AcpRuntimeHandle & Owner }).value;
  }
  return {
    directory,
    peer,
    call,
    ensure,
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
}

test("worker namespaces owners and rejects forged/stale handles before sending a prompt", async () => {
  const state = await setup();
  try {
    const first = await state.ensure();
    const secondOwner = { ...owner, agentId: "other" };
    const second = await state.ensure(secondOwner);
    assert.notEqual(first.acpxRecordId, second.acpxRecordId);
    assert.notEqual(first.backendSessionId, second.backendSessionId);
    const forged = await state.call({
      op: "turn",
      owner: secondOwner,
      input: {
        handle: { ...first, ...secondOwner },
        text: "forged",
        requestId: "forged",
        mode: "prompt",
      },
    });
    assert.equal(forged.terminal.type, "error");
    assert.equal(
      (await state.call({ op: "fresh", owner, input: { ...owner, persistedHandle: first } }))
        .terminal.type,
      "value",
    );
    const fresh = await state.ensure();
    assert.notEqual(fresh.backendSessionId, first.backendSessionId);
    const stale = await state.call({
      op: "turn",
      owner,
      input: { handle: first, text: "stale", requestId: "stale", mode: "prompt" },
    });
    assert.equal(stale.terminal.type, "error");
    const log = await fs.readFile(path.join(state.peer, "requests.log"), "utf8");
    assert.ok(!log.includes("session/prompt"));
  } finally {
    await state.cleanup();
  }
});

test("worker refuses unknown executable strings, remote environment, and explicit thinking", async () => {
  const state = await setup();
  try {
    for (const extra of [
      { agent: "node --version" },
      { env: { NODE_OPTIONS: "--eval=unexpected" } },
      { thinking: "high", thinkingExplicit: true },
    ]) {
      const { terminal } = await state.call({
        op: "ensure",
        owner,
        input: { ...owner, agent: "fixture", mode: "persistent", ...extra },
      });
      assert.equal(terminal.type, "error");
    }
    await assert.rejects(fs.access(path.join(state.peer, "requests.log")));
  } finally {
    await state.cleanup();
  }
});

test("worker cancellation publishes a settled cancelled result and leaves persistent history resumable", async () => {
  const state = await setup();
  try {
    const handle = await state.ensure();
    const controller = new AbortController();
    const { terminal } = await state.call(
      {
        op: "turn",
        owner,
        input: { handle, text: "wait-for-cancel", requestId: "cancel", mode: "prompt" },
      },
      controller,
      (message) => {
        if (message.type === "event" && message.event.type === "text_delta") controller.abort();
      },
    );
    assert.equal(terminal.type, "result", JSON.stringify(terminal));
    assert.equal(
      (terminal as Extract<ServerMessage, { type: "result" }>).result.status,
      "cancelled",
    );
    const resumed = await state.ensure();
    assert.equal(resumed.backendSessionId, handle.backendSessionId);
    const next = await state.call({
      op: "turn",
      owner,
      input: { handle: resumed, text: "after-cancel", requestId: "next", mode: "prompt" },
    });
    assert.equal(next.terminal.type, "result", JSON.stringify(next.terminal));
    const output = next.messages
      .flatMap((message) =>
        message.type === "event" && message.event.type === "text_delta" ? [message.event.text] : [],
      )
      .join("");
    assert.deepEqual(JSON.parse(output).history, ["wait-for-cancel", "after-cancel"]);
  } finally {
    await state.cleanup();
  }
});
