import { readFileSync, writeFileSync } from "node:fs";

/**
 * telegram-webhook plugin — /telegram_webhook
 *
 * Manage Telegram webhook mode (status/on/off/verify).
 * Uses registerCommand() so commands execute WITHOUT the AI agent.
 */

const CONFIG_FILE = "/root/.openclaw/openclaw.json";

// ── Helpers ──────────────────────────────────────────────────

function readConfig(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, any>): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function telegramApi(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<any> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : { method: "GET" };

  const resp = await fetch(url, opts);
  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`Telegram API ${method}: ${data.description || "unknown error"}`);
  }
  return data.result;
}

// ── Subcommands ──────────────────────────────────────────────

async function handleStatus(): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return "[FAIL] TELEGRAM_BOT_TOKEN is not set";
  }

  const lines: string[] = [];

  // Read local config
  const config = readConfig();
  const tg = config.channels?.telegram;
  const hasWebhookConfig = !!(tg?.webhookUrl && tg?.webhookSecret);
  lines.push(`Local config: ${hasWebhookConfig ? "webhook" : "polling"} mode`);
  if (tg?.webhookUrl) {
    lines.push(`  URL: ${tg.webhookUrl}`);
  }
  lines.push(`  Secret configured: ${tg?.webhookSecret ? "yes" : "no"}`);

  // Get live status from Telegram
  try {
    const info = await telegramApi(token, "getWebhookInfo");
    lines.push("");
    lines.push(`Telegram API: ${info.url ? "webhook" : "polling"} mode`);
    if (info.url) {
      lines.push(`  URL: ${info.url}`);
    }
    lines.push(`  Pending updates: ${info.pending_update_count ?? 0}`);
    if (info.last_error_message) {
      const errorDate = info.last_error_date
        ? new Date(info.last_error_date * 1000).toISOString()
        : "unknown";
      lines.push(`  Last error (${errorDate}): ${info.last_error_message}`);
    }
  } catch (e: any) {
    lines.push(`[WARN] Could not query Telegram API: ${e.message}`);
  }

  return lines.join("\n");
}

async function handleOn(): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const workerUrl = process.env.WORKER_URL;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!token) return "[FAIL] TELEGRAM_BOT_TOKEN is not set";
  if (!workerUrl) return "[FAIL] WORKER_URL is not set";
  if (!webhookSecret) return "[FAIL] TELEGRAM_WEBHOOK_SECRET is not set";

  const webhookUrl = workerUrl.replace(/\/+$/, "") + "/telegram/webhook";

  const lines: string[] = [];

  // Register webhook with Telegram
  try {
    await telegramApi(token, "setWebhook", {
      url: webhookUrl,
      secret_token: webhookSecret,
    });
    lines.push("[PASS] Webhook registered with Telegram");
  } catch (e: any) {
    return `[FAIL] setWebhook failed: ${e.message}`;
  }

  // Verify
  try {
    const info = await telegramApi(token, "getWebhookInfo");
    if (info.url === webhookUrl) {
      lines.push(`[PASS] Verified: ${info.url}`);
    } else {
      lines.push(`[WARN] URL mismatch: expected ${webhookUrl}, got ${info.url}`);
    }
  } catch (e: any) {
    lines.push(`[WARN] Could not verify: ${e.message}`);
  }

  // Update local config
  try {
    const config = readConfig();
    config.channels ??= {};
    config.channels.telegram ??= {};
    config.channels.telegram.webhookUrl = webhookUrl;
    config.channels.telegram.webhookSecret = webhookSecret;
    writeConfig(config);
    lines.push("[PASS] Config updated with webhook settings");
  } catch (e: any) {
    lines.push(`[WARN] Could not update config: ${e.message}`);
  }

  lines.push("");
  lines.push("Webhook mode enabled. Restart gateway to apply.");
  return lines.join("\n");
}

async function handleOff(): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return "[FAIL] TELEGRAM_BOT_TOKEN is not set";

  const lines: string[] = [];

  // Delete webhook from Telegram
  try {
    await telegramApi(token, "deleteWebhook");
    lines.push("[PASS] Webhook deleted from Telegram");
  } catch (e: any) {
    return `[FAIL] deleteWebhook failed: ${e.message}`;
  }

  // Verify
  try {
    const info = await telegramApi(token, "getWebhookInfo");
    if (!info.url) {
      lines.push("[PASS] Verified: no webhook set");
    } else {
      lines.push(`[WARN] Webhook still active: ${info.url}`);
    }
  } catch (e: any) {
    lines.push(`[WARN] Could not verify: ${e.message}`);
  }

  // Remove webhook fields from config
  try {
    const config = readConfig();
    if (config.channels?.telegram) {
      delete config.channels.telegram.webhookUrl;
      delete config.channels.telegram.webhookSecret;
      writeConfig(config);
      lines.push("[PASS] Webhook fields removed from config");
    }
  } catch (e: any) {
    lines.push(`[WARN] Could not update config: ${e.message}`);
  }

  lines.push("");
  lines.push("Webhook mode disabled. Will revert to polling on next restart.");
  return lines.join("\n");
}

async function handleVerify(): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return "[FAIL] TELEGRAM_BOT_TOKEN is not set";

  try {
    const info = await telegramApi(token, "getWebhookInfo");
    const lines: string[] = [
      `URL: ${info.url || "(none)"}`,
      `Has custom certificate: ${info.has_custom_certificate ?? false}`,
      `Pending updates: ${info.pending_update_count ?? 0}`,
      `Max connections: ${info.max_connections ?? "default"}`,
      `Allowed updates: ${info.allowed_updates?.join(", ") || "(all)"}`,
    ];
    if (info.ip_address) {
      lines.push(`IP address: ${info.ip_address}`);
    }
    if (info.last_error_date) {
      const errorDate = new Date(info.last_error_date * 1000).toISOString();
      lines.push(`Last error (${errorDate}): ${info.last_error_message}`);
    }
    if (info.last_synchronization_error_date) {
      const syncDate = new Date(info.last_synchronization_error_date * 1000).toISOString();
      lines.push(`Last sync error (${syncDate})`);
    }
    return lines.join("\n");
  } catch (e: any) {
    return `[FAIL] getWebhookInfo failed: ${e.message}`;
  }
}

// ── Plugin registration ──────────────────────────────────────

export default function register(api: any) {
  api.registerCommand({
    name: "telegram_webhook",
    description: "Manage Telegram webhook — /telegram_webhook status|on|off|verify",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const args = ctx.args?.trim() ?? "";
      const subcommand = args.split(/\s+/)[0] || "status";

      let text: string;
      switch (subcommand) {
        case "status":
          text = await handleStatus();
          break;
        case "on":
          text = await handleOn();
          break;
        case "off":
          text = await handleOff();
          break;
        case "verify":
          text = await handleVerify();
          break;
        default:
          text = [
            `Unknown subcommand: ${subcommand}`,
            "",
            "Usage: /telegram_webhook [status|on|off|verify]",
            "  status  — Show current webhook configuration (default)",
            "  on      — Enable webhook mode",
            "  off     — Disable webhook mode (revert to polling)",
            "  verify  — Show detailed webhook info from Telegram",
          ].join("\n");
      }

      return { text };
    },
  });
}
