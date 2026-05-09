// Plugin configuration parsing for runtime-config-convergence.
// Parses the raw `api.pluginConfig` shape (as declared in openclaw.plugin.json)
// into a normalized ConvergenceConfig with explicit defaults.

import type { ConvergenceConfig, NotificationConfig, HttpRouteConfig } from "./types.js";

const DEFAULT_SCAN_INTERVAL_MS = 0; // 0 = disabled (commands/HTTP only)
const DEFAULT_HTTP_PATH = "/runtime-config-convergence/scan";

function parseNotification(raw: unknown): NotificationConfig {
  if (raw == null || typeof raw !== "object") {
    return { transport: "log-only" };
  }
  const obj = raw as Record<string, unknown>;
  const t = typeof obj.transport === "string" ? obj.transport : "log-only";
  switch (t) {
    case "telegram":
      return {
        transport: "telegram",
        botTokenEnv: typeof obj.botTokenEnv === "string" ? obj.botTokenEnv : "TELEGRAM_BOT_TOKEN",
        chatIdEnv: typeof obj.chatIdEnv === "string" ? obj.chatIdEnv : "TELEGRAM_LIFECYCLE_CHAT_ID",
      };
    case "slack":
      return {
        transport: "slack",
        botTokenEnv: typeof obj.botTokenEnv === "string" ? obj.botTokenEnv : "SLACK_BOT_TOKEN",
        channelIdEnv: typeof obj.channelIdEnv === "string" ? obj.channelIdEnv : "SLACK_LIFECYCLE_CHANNEL_ID",
      };
    case "none":
      return { transport: "none" };
    case "log-only":
    default:
      return { transport: "log-only" };
  }
}

function parseHttpRoute(raw: unknown): HttpRouteConfig | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const auth = obj.auth === "gateway" ? "gateway" : "plugin";
  const path = typeof obj.path === "string" && obj.path.startsWith("/")
    ? obj.path
    : DEFAULT_HTTP_PATH;
  return { path, auth };
}

export function parseConvergenceConfig(raw: unknown): ConvergenceConfig {
  const obj = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};
  return {
    liveConfigPath: typeof obj.liveConfigPath === "string" ? obj.liveConfigPath : undefined,
    queuePath: typeof obj.queuePath === "string" ? obj.queuePath : undefined,
    desiredConfigPath: typeof obj.desiredConfigPath === "string" ? obj.desiredConfigPath : undefined,
    ownershipPolicyPath: typeof obj.ownershipPolicyPath === "string" ? obj.ownershipPolicyPath : undefined,
    scanIntervalMs: typeof obj.scanIntervalMs === "number" && obj.scanIntervalMs >= 0
      ? obj.scanIntervalMs
      : DEFAULT_SCAN_INTERVAL_MS,
    notification: parseNotification(obj.notification),
    dryRun: obj.dryRun === true,
    expectedSecretDriftNotify: obj.expectedSecretDriftNotify === true,
    httpRoute: parseHttpRoute(obj.httpRoute),
  };
}
