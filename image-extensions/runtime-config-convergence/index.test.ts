import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `typebox` is bundled into the plugin runtime by openclaw; not present in
// dev deps. Mirror the mock pattern used in set-config-orchestration.test.ts.
vi.mock("typebox", () => ({
  Type: { Object: (s: unknown) => s, String: (opts?: unknown) => opts ?? {} },
}));

import plugin from "./index.ts";

interface RegisteredCommand {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: { args?: string; config: unknown }) => Promise<{ text: string }> | { text: string };
}
interface RegisteredService {
  id: string;
  start: (ctx: unknown) => void | Promise<void>;
  stop?: (ctx: unknown) => void | Promise<void>;
}
interface RegisteredRoute {
  path: string;
  auth: "gateway" | "plugin";
  handler: (req: unknown, res: unknown) => Promise<void> | void;
}

function makeStubApi(opts: {
  pluginConfig?: Record<string, unknown>;
  liveConfig?: unknown;
} = {}) {
  const tools: unknown[] = [];
  const commands: RegisteredCommand[] = [];
  const services: RegisteredService[] = [];
  const routes: RegisteredRoute[] = [];
  const logs: { level: "info" | "warn" | "error"; msg: string }[] = [];
  const api = {
    pluginConfig: opts.pluginConfig,
    runtime: { config: { current: () => opts.liveConfig ?? {} } },
    logger: {
      info: (m: string) => logs.push({ level: "info", msg: m }),
      warn: (m: string) => logs.push({ level: "warn", msg: m }),
      error: (m: string) => logs.push({ level: "error", msg: m }),
    },
    registerTool: (t: unknown) => { tools.push(t); },
    registerCommand: (c: RegisteredCommand) => { commands.push(c); },
    registerService: (s: RegisteredService) => { services.push(s); },
    registerHttpRoute: (r: RegisteredRoute) => { routes.push(r); },
  };
  return { api, tools, commands, services, routes, logs };
}

function makeStubResponse() {
  let body = "";
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    setHeader: (k: string, v: string) => { headers[k] = v; },
    end: (b?: string) => { body = b ?? ""; },
  };
  return { res, getBody: () => body, getHeaders: () => headers, getStatus: () => res.statusCode };
}

describe("runtime-config-convergence index.ts wiring", () => {
  let dir: string;
  let queuePath: string;
  let desiredPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rcc-index-test-"));
    queuePath = join(dir, "queue.json");
    desiredPath = join(dir, "desired.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers manage-secrets tools and the /config-drift command on every register", () => {
    const { api, tools, commands } = makeStubApi({
      pluginConfig: { queuePath, scanIntervalMs: 0 },
    });
    plugin.register(api);
    expect(tools).toHaveLength(2);
    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe("config-drift");
    expect(commands[0].acceptsArgs).toBe(true);
    expect(commands[0].requireAuth).toBe(true);
  });

  it("does NOT register a service when scanIntervalMs=0", () => {
    const { api, services } = makeStubApi({
      pluginConfig: { queuePath, scanIntervalMs: 0 },
    });
    plugin.register(api);
    expect(services).toHaveLength(0);
  });

  it("registers a service when scanIntervalMs>0", () => {
    const { api, services } = makeStubApi({
      pluginConfig: { queuePath, scanIntervalMs: 60_000 },
    });
    plugin.register(api);
    expect(services).toHaveLength(1);
    expect(services[0].id).toBe("runtime-config-convergence-scan");
  });

  it("does NOT register an HTTP route when httpRoute is unset", () => {
    const { api, routes } = makeStubApi({
      pluginConfig: { queuePath, scanIntervalMs: 0 },
    });
    plugin.register(api);
    expect(routes).toHaveLength(0);
  });

  it("registers an HTTP route when httpRoute is configured", () => {
    const { api, routes } = makeStubApi({
      pluginConfig: {
        queuePath,
        scanIntervalMs: 0,
        httpRoute: { path: "/__convergence/scan", auth: "plugin" },
      },
    });
    plugin.register(api);
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe("/__convergence/scan");
    expect(routes[0].auth).toBe("plugin");
  });

  it("HTTP handler returns 200 + ScanResult JSON on a successful scan", async () => {
    writeFileSync(desiredPath, JSON.stringify({ auth: { x: "desired" } }));
    const { api, routes } = makeStubApi({
      liveConfig: { auth: { x: "live" } },
      pluginConfig: {
        queuePath,
        scanIntervalMs: 0,
        desiredConfigPath: desiredPath,
        httpRoute: { path: "/__convergence/scan", auth: "plugin" },
      },
    });
    plugin.register(api);
    const { res, getBody, getStatus, getHeaders } = makeStubResponse();
    await routes[0].handler({}, res);
    expect(getStatus()).toBe(200);
    expect(getHeaders()["Content-Type"]).toBe("application/json");
    const result = JSON.parse(getBody());
    expect(typeof result.active).toBe("number");
    expect(typeof result.newCandidates).toBe("number");
    expect(result.queuePath).toBe(queuePath);
  });

  it("HTTP handler returns 500 + JSON error when the scan throws", async () => {
    const { api, routes } = makeStubApi({
      pluginConfig: {
        queuePath,
        scanIntervalMs: 0,
        httpRoute: { path: "/__convergence/scan", auth: "plugin" },
      },
    });
    // Force runtime.config.current() to throw — propagates out of runScan.
    api.runtime.config.current = () => { throw new Error("runtime exploded"); };
    plugin.register(api);
    const { res, getBody, getStatus } = makeStubResponse();
    await routes[0].handler({}, res);
    expect(getStatus()).toBe(500);
    const body = JSON.parse(getBody());
    expect(body.error).toContain("runtime exploded");
  });

  it("service tick, command, and HTTP route share one serializedScan (no concurrent reads of the same queue)", async () => {
    // Wiring-level race regression: if any surface bypassed the shared mutex
    // (e.g. by calling runScan directly), two parallel scans on the same drift
    // would each notify. The tick/command/route should all serialize together.
    writeFileSync(desiredPath, JSON.stringify({ auth: { x: "desired" } }));
    const { api, routes } = makeStubApi({
      liveConfig: { auth: { x: "live" } },
      pluginConfig: {
        queuePath,
        scanIntervalMs: 0, // no service in this test (it would set its own timer)
        desiredConfigPath: desiredPath,
        notification: { transport: "log-only" },
        httpRoute: { path: "/__convergence/scan", auth: "plugin" },
      },
    });
    plugin.register(api);
    const r1 = makeStubResponse();
    const r2 = makeStubResponse();
    await Promise.all([
      routes[0].handler({}, r1.res),
      routes[0].handler({}, r2.res),
    ]);
    // Both succeed; with serialization, the second sees the first's queue
    // write so it reports newCandidates: 0 and active: 1.
    const a = JSON.parse(r1.getBody());
    const b = JSON.parse(r2.getBody());
    const newCandidatesTotal = a.newCandidates + b.newCandidates;
    expect(newCandidatesTotal).toBe(1);
    const activeMax = Math.max(a.active, b.active);
    expect(activeMax).toBe(1);
  });

  it("service.start fires an immediate scan and schedules an interval", async () => {
    writeFileSync(desiredPath, JSON.stringify({ auth: { x: "desired" } }));
    vi.useFakeTimers();
    try {
      const { api, services } = makeStubApi({
        liveConfig: { auth: { x: "live" } },
        pluginConfig: {
          queuePath,
          scanIntervalMs: 60_000,
          desiredConfigPath: desiredPath,
          notification: { transport: "log-only" },
        },
      });
      plugin.register(api);
      await services[0].start({});
      // Allow the immediate `void tick()` microtask chain to settle.
      await vi.runOnlyPendingTimersAsync();
      // One queue file should have been written by the immediate tick.
      const { existsSync } = await import("node:fs");
      expect(existsSync(queuePath)).toBe(true);
      await services[0].stop?.({});
    } finally {
      vi.useRealTimers();
    }
  });
});
