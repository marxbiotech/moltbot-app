// Opt-in proof against a real stock Gateway and separately paired node process.
// Usage: node test/live-gateway.mjs
// It creates only temporary HOME/config/state, binds an unused loopback port,
// uses the synthetic ACP fixture and terminates only processes it started.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startGatewayModel } from "./fixtures/gateway-model.mjs";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(pluginRoot, "node_modules/openclaw/openclaw.mjs");
const root = await mkdtemp(path.join(os.tmpdir(), "remote-acpx-live-"));
const children = new Set();
const logs = new Map();
let client;
let approvalTimer;
let approvalRun = Promise.resolve();
const agentSpawn = process.argv.includes("--agent-spawn");
let model;
const token = randomBytes(24).toString("hex");
const port = await new Promise((resolve, reject) => {
  const reservation = net.createServer();
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", () => {
    const address = reservation.address();
    reservation.close(() => resolve(address.port));
  });
});
const url = `ws://127.0.0.1:${port}`;

async function environment(name) {
  const home = path.join(root, name);
  await mkdir(home, { recursive: true });
  return {
    PATH: [path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
      path.delimiter,
    ),
    HOME: home,
    TMPDIR: root,
    OPENCLAW_STATE_DIR: path.join(home, "state"),
    OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_SHELL: "exec",
    NO_COLOR: "1",
  };
}
const gatewayEnv = await environment("gateway");
const nodeEnv = await environment("node");

function launch(args, env, label) {
  const child = spawn(process.execPath, [cli, ...args], {
    env,
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  logs.set(child, "");
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      logs.set(child, (logs.get(child) + bytes.toString()).slice(-100_000));
    });
  child.label = label;
  child.once("exit", () => children.delete(child));
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await Promise.race([closed, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    await closed;
  }
}
async function command(args, env = gatewayEnv) {
  const child = launch(args, env, args.slice(0, 3).join(" "));
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const output = logs.get(child);
  if (exit !== 0) throw new Error(`${child.label} failed: ${output}`);
  // CLI diagnostics precede machine output on some startup paths.
  for (const offset of [...output.matchAll(/^[{[]/gm)].map((match) => match.index)) {
    try {
      return JSON.parse(output.slice(offset));
    } catch {}
  }
  throw new Error(`Missing JSON from ${child.label}: ${output}`);
}
async function until(label, fn, timeout = 40_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      if (error.fatal) throw error;
      last = error;
    }
    await delay(350);
  }
  throw new Error(`Timed out waiting for ${label}: ${last?.message ?? "not ready"}`);
}

try {
  await writeFile(
    nodeEnv.OPENCLAW_CONFIG_PATH,
    JSON.stringify({
      gateway: { mode: "local", auth: { mode: "token", token } },
      plugins: { enabled: false },
      browser: { enabled: false },
      discovery: { mdns: { mode: "off" } },
      logging: { file: path.join(root, "gateway.log") },
    }),
  );
  const identityHost = launch(
    ["node", "run", "--host", "127.0.0.1", "--port", String(port)],
    nodeEnv,
    "Node identity bootstrap",
  );
  const identity = await until("node identity creation", () =>
    command(["node", "identity", "--json"], nodeEnv),
  );
  await stop(identityHost);
  assert.equal(typeof identity.deviceId, "string");
  const nodeId = identity.deviceId;
  const cwd = path.join(root, "node-workspace");
  const fixtureState = path.join(root, "fixture-state");
  await Promise.all([mkdir(cwd), mkdir(fixtureState)]);
  if (agentSpawn)
    model = await startGatewayModel({
      cwd,
      skillPath: path.join(pluginRoot, "skills/remote-acp-router/SKILL.md"),
    });
  const nodeConfig = {
    cwd,
    stateDir: path.join(root, "acpx-state"),
    permissionMode: "deny-all",
    agents: {
      fixture: [process.execPath, path.join(pluginRoot, "test/fixtures/agent.mjs"), fixtureState],
    },
  };
  // Keep the test plugin outside the production plugin's captured source tree.
  const probeRoot = path.join(root, "probe-plugin");
  await cp(path.join(pluginRoot, "test/fixtures/gateway-probe"), probeRoot, { recursive: true });
  await symlink(path.join(pluginRoot, "node_modules"), path.join(probeRoot, "node_modules"));
  const baseConfig = {
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token },
      controlUi: { enabled: false },
      nodes: { commands: { allow: ["remote-acpx.execute"] }, pairing: { sshVerify: false } },
    },
    discovery: { mdns: { mode: "off" } },
    logging: { file: path.join(root, "gateway.log") },
    browser: { enabled: false },
    cron: { enabled: false },
    ...(agentSpawn ? { tools: { profile: "full", exec: { security: "full", ask: "off" } } } : {}),
    acp: {
      enabled: true,
      backend: "remote-acpx",
      defaultAgent: "fixture",
      allowedAgents: ["fixture"],
      dispatch: { enabled: true },
    },
    agents: {
      ...(agentSpawn
        ? {
            ownership: "explicit",
            entries: {
              main: {},
              fixture: {
                runtime: { type: "acp", acp: { agent: "fixture", backend: "remote-acpx", cwd } },
              },
            },
          }
        : {}),
      defaults: {
        ...(agentSpawn ? { systemAgent: { agentId: "main" } } : {}),
        workspace: path.join(root, "gateway-workspace"),
        model: { primary: "fixture/noop" },
      },
    },
    models: {
      providers: {
        fixture: {
          baseUrl: model?.baseUrl ?? "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "unused-synthetic-key",
          models: [{ id: "noop", name: "Unused synthetic default" }],
        },
      },
    },
    plugins: {
      allow: ["remote-acpx", "remote-acpx-probe"],
      load: { paths: [pluginRoot, probeRoot] },
      entries: {
        "remote-acpx": {
          enabled: true,
          config: {
            target: { nodeId, cwd },
            targets: {},
            node: nodeConfig,
            ...(agentSpawn ? { executionApproval: "node-policy" } : {}),
          },
        },
        "remote-acpx-probe": { enabled: true },
      },
    },
  };
  await Promise.all([
    writeFile(gatewayEnv.OPENCLAW_CONFIG_PATH, JSON.stringify(baseConfig)),
    writeFile(nodeEnv.OPENCLAW_CONFIG_PATH, JSON.stringify(baseConfig)),
  ]);
  if (agentSpawn) {
    await mkdir(nodeEnv.OPENCLAW_STATE_DIR, { recursive: true });
    await writeFile(
      path.join(nodeEnv.OPENCLAW_STATE_DIR, "exec-approvals.json"),
      JSON.stringify({ version: 1, defaults: { security: "full", ask: "off" } }),
    );
  }
  const gateway = launch(
    ["gateway", "run", "--port", String(port), "--bind", "loopback"],
    gatewayEnv,
    "Gateway",
  );
  console.log(`Starting isolated Gateway on ${url}; synthetic state: ${root}`);
  await until("Gateway", async () => {
    if (gateway.exitCode !== null)
      throw Object.assign(new Error(logs.get(gateway)), { fatal: true });
    return await command(["gateway", "call", "health", "--json", "--timeout", "2000"]);
  });

  // The public client shares only this test Gateway's temporary operator identity.
  Object.assign(process.env, gatewayEnv);
  const { GatewayClient } = await import("openclaw/plugin-sdk/gateway-runtime");
  const ready = Promise.withResolvers();
  client = new GatewayClient({
    url,
    token,
    clientName: "cli",
    clientDisplayName: "Isolated remote ACP proof",
    mode: "cli",
    scopes: [
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.pairing",
      "operator.approvals",
    ],
    caps: ["approvals"],
    onHelloOk: () => ready.resolve(),
    onConnectError: ready.reject,
  });
  client.start();
  await ready.promise;
  const request = (method, params = {}, timeoutMs = 60_000) =>
    client.request(method, params, { timeoutMs });
  let node = launch(
    [
      "node",
      "run",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--commands",
      "remote-acpx.execute",
      "--display-name",
      "Remote ACP synthetic node",
    ],
    nodeEnv,
    "Node",
  );
  const device = await until("node device pairing", async () => {
    if (node.exitCode !== null || node.signalCode !== null)
      throw Object.assign(new Error(`Node exited: ${logs.get(node)}`), { fatal: true });
    const list = await request("device.pair.list");
    const pending = list.pending?.find((entry) => entry.deviceId === nodeId);
    if (pending) return pending;
    if (list.paired?.some((entry) => entry.deviceId === nodeId)) return { alreadyPaired: true };
  });
  if (!device.alreadyPaired) {
    await request("device.pair.approve", { requestId: device.requestId });
    await stop(node);
    node = launch(
      [
        "node",
        "run",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--commands",
        "remote-acpx.execute",
        "--display-name",
        "Remote ACP synthetic node",
      ],
      nodeEnv,
      "Node",
    );
  }
  await until("node command approval", async () => {
    const pending = (await request("node.pair.list")).pending?.find(
      (entry) => entry.nodeId === nodeId,
    );
    if (pending) await request("node.pair.approve", { requestId: pending.requestId });
    return (await request("node.list")).nodes?.find(
      (entry) =>
        entry.nodeId === nodeId &&
        entry.connected &&
        entry.commands?.includes("remote-acpx.execute"),
    );
  });
  console.log("Device and remote ACP command surface paired through stock Gateway RPC.");

  let approvals = 0;
  let approvalError;
  if (!agentSpawn)
    approvalTimer = setInterval(() => {
      approvalRun = approvalRun
        .then(async () => {
          const pending = await request("plugin.approval.list");
          for (const entry of pending.requests ?? pending.pending ?? pending) {
            if (entry.request?.pluginId !== "remote-acpx") continue;
            await request("plugin.approval.resolve", { id: entry.id, decision: "allow-once" });
            approvals++;
          }
        })
        .catch((error) => {
          approvalError = error;
        });
    }, 250);
  const invoke = (params) => request("remote-acpx-probe.invoke", params, 90_000);
  if (!process.argv.includes("--manager-only") && !agentSpawn) {
    const { handle } = await invoke({ op: "ensure" });
    const first = await invoke({ op: "turn", handle, text: "live first prompt" });
    assert.equal(first.result.status, "completed");
    assert.equal(first.chunks, 2);
    const firstState = JSON.parse(first.text);
    assert.equal(firstState.cwd, cwd);
    assert.deepEqual(firstState.history, ["live first prompt"]);
    console.log(
      "Remote fixture process received its node-local cwd and streamed two result chunks.",
    );
    const started = Date.now();
    const long = await invoke({ op: "turn", handle, text: "long-turn" });
    assert.equal(long.result.status, "completed");
    assert.ok(Date.now() - started >= 35_000);
    assert.deepEqual(JSON.parse(long.text).history, ["live first prompt", "long-turn"]);
    console.log(
      "Silent 35-second ACP turn survived stock duplex heartbeat and returned its result.",
    );
    const cancelled = await invoke({ op: "turn", handle, text: "wait-for-cancel", cancel: true });
    assert.equal(cancelled.result.status, "cancelled");
    const elicited = await invoke({ op: "turn", handle, text: "elicit" });
    assert.equal(elicited.result.status, "completed");
    assert.deepEqual(JSON.parse(elicited.text), {
      answer: { action: "accept", content: { answer: "live node response" } },
    });
    assert.ok(approvals >= 5);
    if (approvalError) throw approvalError;
    const requests = await readFile(path.join(fixtureState, "requests.log"), "utf8");
    assert.equal(requests.split("\n").filter((method) => method === "session/new").length, 1);
    assert.match(requests, /session\/load/);
    assert.match(requests, /session\/cancel/);
    console.log(
      JSON.stringify({
        ok: true,
        nodeId,
        approvals,
        transport: "stock paired-node WebSocket duplex",
        durationMs: Date.now() - started,
      }),
    );
  }

  if (agentSpawn) {
    const parentKey = "agent:main:main";
    const admitted = await request("chat.send", {
      sessionKey: parentKey,
      message:
        "Delegate repository investigation to the configured remote ACP coding agent and report the result.",
      idempotencyKey: randomUUID(),
      timeoutMs: 90_000,
    });
    const waited = await request(
      "agent.wait",
      { runId: admitted.runId, timeoutMs: 90_000 },
      95_000,
    );
    assert.equal(waited.status, "ok", JSON.stringify(waited));
    await until(
      "agent-owned remote completion",
      async () => {
        if (model.state.errors.length)
          throw Object.assign(new Error(model.state.errors.join("\n")), { fatal: true });
        const history = await request("chat.history", { sessionKey: parentKey, limit: 30 });
        return history.messages.some(
          (message) =>
            message.role === "assistant" &&
            JSON.stringify(message.content).includes("REMOTE-ACP-PARENT-RESULT"),
        );
      },
      90_000,
    );
    assert.equal(model.state.skillRead, true);
    assert.equal(model.state.spawned, true);
    assert.equal(model.state.completed, true);
    const pending = await request("plugin.approval.list");
    assert.equal(
      (pending.requests ?? pending.pending ?? pending).length,
      0,
      "no per-operation approval was requested",
    );
    console.log(
      JSON.stringify({
        ok: true,
        ingress: "Gateway agent → sessions_spawn → remote ACP node → parent completion",
        skill: "remote-acp-router",
        approvals: 0,
        model: "deterministic test peer",
      }),
    );
  } else {
    const managed = await invoke({ op: "managerInitialize" });
    const admitted = await request("chat.send", {
      sessionKey: managed.sessionKey,
      message: "manager-owned prompt",
      idempotencyKey: randomUUID(),
      timeoutMs: 60_000,
    });
    assert.equal(typeof admitted.runId, "string");
    const waited = await request(
      "agent.wait",
      { runId: admitted.runId, timeoutMs: 60_000 },
      65_000,
    );
    assert.equal(
      waited.status,
      "ok",
      `Standard ACP chat turn did not complete: ${JSON.stringify(waited)}`,
    );
    const managedSession = await invoke({ op: "managerStatus" });
    assert.equal(managedSession.kind, "ready");
    assert.equal(managedSession.meta.backend, "remote-acpx");
    assert.equal(managedSession.meta.state, "idle");
    const savedAgents = await Promise.all(
      (await readdir(fixtureState))
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => JSON.parse(await readFile(path.join(fixtureState, file), "utf8"))),
    );
    const managerAgent = savedAgents.filter((agent) =>
      agent.history.some((text) => text.includes("manager-owned prompt")),
    );
    assert.equal(managerAgent.length, 1);
    assert.equal(managerAgent[0].cwd, cwd);
    console.log(
      JSON.stringify({
        ok: true,
        manager: "canonical ACP manager",
        ingress: "chat.send → admitted run → remote paired node",
        state: managedSession.meta.state,
      }),
    );
  }
} catch (error) {
  for (const [child, output] of logs)
    if (child.label === "Gateway" || child.label === "Node")
      console.error(`\n${child.label} log:\n${output}`);
  throw error;
} finally {
  clearInterval(approvalTimer);
  await approvalRun.catch(() => {});
  await client?.stopAndWait().catch(() => client.stop());
  await Promise.all([...children].map(stop));
  await model?.close();
  if (process.env.REMOTE_ACPX_KEEP_LIVE_TEST_STATE === "1")
    console.log(`Retained isolated test state: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
