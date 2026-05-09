// runtime-config-convergence — register(api) entry point.
//
// Step 2: this plugin is now a complete drop-in replacement for the
// manage-secrets plugin (set_config, set_secret, manage-config skill,
// manage-secrets skill — all activated from sources copied verbatim by
// Step 1) plus the v1 drift / convergence surface (/config-drift command,
// optional service tick, optional HTTP route).
//
// Wires the trigger surfaces and resolves all shared dependencies (queue
// path, persona, runtime accessor, notification adapter) at register time
// so command and HTTP handlers do not depend on the service having
// ticked. This addresses the surface-aware constraint from issue #35 §5
// (`ctx.stateDir` only exists on `OpenClawPluginServiceContext`).

import { setSecretTool } from "./src/set-secret.ts";
import { setConfigTool } from "./src/set-config.ts";
import { getPersona } from "./src/shared.ts";
import { parseConvergenceConfig } from "./src/config.js";
import { resolveQueuePath } from "./src/paths.js";
import { runScan, makeLoadLiveConfig, makeSerializedScan } from "./src/detector.js";
import { handleCommand } from "./src/commands.js";
import { buildAdapter } from "./src/notifications.js";

// Design Decision: this is a deliberately narrow local re-declaration of the
// surface we use from openclaw's PluginApi (only the four register* methods
// plus runtime/logger). openclaw's plugin-sdk does NOT currently expose a
// `runtime-config-convergence` subpath that re-exports `OpenClawPluginApi`,
// and v1 explicitly does not change openclaw core. Keeping this seam local
// also makes the unit tests independent of openclaw-internal type churn.
// When openclaw publishes a subpath barrel for this plugin (or the SDK
// stabilises a generic re-export), import `OpenClawPluginApi` from there
// and replace this interface — see how `remote-acpx/index.ts` does it.
interface PluginApi {
  pluginConfig?: Record<string, unknown>;
  runtime: { config: { current: () => unknown } };
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  registerTool: (tool: unknown) => void;
  registerCommand: (def: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: { args?: string; config: unknown }) => Promise<{ text: string }> | { text: string };
  }) => void;
  registerService: (svc: {
    id: string;
    start: (ctx: unknown) => void | Promise<void>;
    stop?: (ctx: unknown) => void | Promise<void>;
  }) => void;
  registerHttpRoute: (params: {
    path: string;
    auth: "gateway" | "plugin";
    handler: (req: unknown, res: unknown) => Promise<void> | void;
  }) => void;
}

const PLUGIN_ID = "runtime-config-convergence";

function safeLogger(api: PluginApi) {
  return api.logger ?? {
    info: (m: string) => console.log(`[${PLUGIN_ID}] ${m}`),
    warn: (m: string) => console.warn(`[${PLUGIN_ID}] ${m}`),
    error: (m: string) => console.error(`[${PLUGIN_ID}] ${m}`),
  };
}

const plugin = {
  id: PLUGIN_ID,
  name: "Runtime Config Convergence",
  description: "Set/update runtime config and env secrets via GitOps workflows; detect drift between live runtime OpenClaw config and repo-rendered desired config; surfaces /config-drift and one-shot notifications.",
  register(api: PluginApi) {
    // ── manage-secrets surfaces (carried over from Step 1, activated here) ─
    api.registerTool(setSecretTool);
    api.registerTool(setConfigTool);

    // ── drift / convergence surface ──────────────────────────────────────
    const config = parseConvergenceConfig(api.pluginConfig);
    const queuePath = resolveQueuePath(config.queuePath);
    const persona = getPersona();
    const logger = safeLogger(api);
    const adapter = buildAdapter(config.notification);

    // Captured here so all three surfaces close over the same instances.
    const runtimeConfigGetter = () => api.runtime.config.current();

    // Per-instance scan mutex. See `makeSerializedScan` for the rationale.
    const serializedScan = makeSerializedScan(runScan);

    logger.info(`registered (queue=${queuePath}, persona=${persona || "(unset)"}, transport=${config.notification.transport})`);

    // ── /config-drift command ─────────────────────────────────────────────
    api.registerCommand({
      name: "config-drift",
      description: "Runtime config drift candidates — /config-drift status|scan|list|show|ignore|unignore|patch|notify-test",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => handleCommand(
        {
          queuePath,
          persona,
          config,
          // Commands receive `ctx.config` per-call (PluginCommandContext.config);
          // wrap it as a getter so the detector signature stays uniform.
          loadLiveConfigForScan: (ctxConfig) => makeLoadLiveConfig(config, () => ctxConfig),
          adapter,
          logger,
          runScanFn: serializedScan,
        },
        ctx,
      ),
    });

    // ── Service mode: interval scan loop ─────────────────────────────────
    if (config.scanIntervalMs > 0) {
      let timer: ReturnType<typeof setInterval> | undefined;
      let running = false;

      const tick = async () => {
        if (running) return; // overlap guard for back-to-back ticks
        running = true;
        try {
          // Use the shared mutex so a tick cannot overlap a command-issued
          // or HTTP-triggered scan on the same instance.
          await serializedScan({
            queuePath,
            persona,
            config,
            logger,
            loadLiveConfig: makeLoadLiveConfig(config, runtimeConfigGetter),
            adapter,
          });
        } catch (e: unknown) {
          logger.error(`service tick error: ${e instanceof Error ? e.message : e}`);
        } finally {
          running = false;
        }
      };

      api.registerService({
        id: `${PLUGIN_ID}-scan`,
        async start(_ctx) {
          // Note: ctx.stateDir is intentionally NOT used here — queue path was
          // already resolved at register time via OPENCLAW_HOME so commands
          // and HTTP handlers can find it without depending on this service.
          logger.info(`service starting; scanIntervalMs=${config.scanIntervalMs}`);
          // Fire one scan immediately so initial state is populated.
          void tick();
          timer = setInterval(() => { void tick(); }, config.scanIntervalMs);
        },
        async stop(_ctx) {
          if (timer) { clearInterval(timer); timer = undefined; }
          logger.info("service stopped");
        },
      });
    }

    // ── HTTP route trigger (optional) ────────────────────────────────────
    if (config.httpRoute) {
      const route = config.httpRoute;
      api.registerHttpRoute({
        path: route.path,
        auth: route.auth,
        // HTTP handlers receive raw (req, res) — no plugin context, no
        // ctx.config, no stateDir. Everything must come from this closure.
        handler: async (_req, res) => {
          const r = res as { statusCode: number; setHeader: (k: string, v: string) => void; end: (body?: string) => void };
          try {
            const result = await serializedScan({
              queuePath,
              persona,
              config,
              logger,
              loadLiveConfig: makeLoadLiveConfig(config, runtimeConfigGetter),
              adapter,
            });
            r.statusCode = 200;
            r.setHeader("Content-Type", "application/json");
            r.end(JSON.stringify(result));
          } catch (e: unknown) {
            r.statusCode = 500;
            r.setHeader("Content-Type", "application/json");
            r.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          }
        },
      });
      logger.info(`http trigger registered at ${route.path} (auth=${route.auth})`);
    }
  },
};

export default plugin;
