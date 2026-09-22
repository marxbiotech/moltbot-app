// Synthetic ACP peer. It never contacts a provider or reads authentication files.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const directory = process.argv[2];
const sessions = new Map();
const pending = new Map();
const clientRequests = new Map();
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const file = (id) => path.join(directory, `${id}.json`);
const save = (id) => fs.writeFile(file(id), JSON.stringify(sessions.get(id)));
const describe = (state) => ({
  modes: {
    currentModeId: state.mode,
    availableModes: [
      { id: "normal", name: "Normal" },
      { id: "review", name: "Review" },
    ],
  },
  models: {
    currentModelId: state.model,
    availableModels: [
      { modelId: "fixture-model", name: "Fixture" },
      { modelId: "other-model", name: "Other" },
    ],
  },
  configOptions: [
    {
      id: "tone",
      name: "Tone",
      type: "select",
      currentValue: state.tone,
      options: [
        { value: "plain", name: "Plain" },
        { value: "brief", name: "Brief" },
      ],
    },
  ],
});
const chunk = (sessionId, text) =>
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
const askClient = (method, params) =>
  new Promise((resolve, reject) => {
    const id = randomUUID();
    clientRequests.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });

async function dispatch(method, params = {}) {
  await fs.appendFile(path.join(directory, "requests.log"), `${method}\n`);
  if (method === "initialize") {
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
      authMethods: [],
    };
  }
  if (method === "session/new") {
    const sessionId = randomUUID();
    const state = {
      history: [],
      mode: "normal",
      model: "fixture-model",
      tone: "plain",
      cwd: params.cwd,
    };
    sessions.set(sessionId, state);
    await save(sessionId);
    return { sessionId, ...describe(state) };
  }
  if (method === "session/load") {
    const state = JSON.parse(await fs.readFile(file(params.sessionId), "utf8"));
    sessions.set(params.sessionId, state);
    return describe(state);
  }
  if (method === "session/cancel") {
    pending.get(params.sessionId)?.();
    return {};
  }
  const state = sessions.get(params.sessionId);
  if (method === "session/close") {
    sessions.delete(params.sessionId);
    await fs.rm(file(params.sessionId), { force: true });
    return {};
  }
  if (!state) throw new Error("unknown session");
  if (method === "session/set_mode") {
    state.mode = params.modeId;
    await save(params.sessionId);
    return {};
  }
  if (method === "session/set_model") {
    state.model = params.modelId;
    await save(params.sessionId);
    return {};
  }
  if (method === "session/set_config_option") {
    if (params.configId !== "tone") throw new Error("unknown option");
    state.tone = params.value;
    await save(params.sessionId);
    return { configOptions: describe(state).configOptions };
  }
  if (method === "session/prompt") {
    const text = params.prompt
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    state.history.push(text);
    await save(params.sessionId);
    if (text === "long-turn") await new Promise((resolve) => setTimeout(resolve, 35_000));
    if (text === "wait-for-cancel") {
      await new Promise((resolve) => {
        pending.set(params.sessionId, resolve);
        chunk(params.sessionId, "waiting");
      });
      pending.delete(params.sessionId);
      return { stopReason: "cancelled" };
    }
    if (text === "elicit") {
      const answer = await askClient("elicitation/create", {
        sessionId: params.sessionId,
        mode: "form",
        message: "Choose a fixture answer",
        requestedSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      });
      chunk(params.sessionId, JSON.stringify({ answer }));
      return { stopReason: "end_turn" };
    }
    const output = JSON.stringify({ sessionId: params.sessionId, ...state });
    const midpoint = Math.floor(output.length / 2);
    chunk(params.sessionId, output.slice(0, midpoint));
    chunk(params.sessionId, output.slice(midpoint));
    return { stopReason: "end_turn" };
  }
  throw new Error(`unsupported method: ${method}`);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (!request.method) {
    const callback = clientRequests.get(request.id);
    clientRequests.delete(request.id);
    if (request.error) callback?.reject(new Error(request.error.message));
    else callback?.resolve(request.result);
    return;
  }
  void dispatch(request.method, request.params).then(
    (result) => {
      if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result });
    },
    (error) => {
      if (request.id !== undefined)
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error.message } });
    },
  );
});
