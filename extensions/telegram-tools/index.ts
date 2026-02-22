import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * telegram-tools plugin — /telegram
 *
 * Manage Telegram webhook mode and channel pairing.
 * Uses registerCommand() so commands execute WITHOUT the AI agent.
 *
 * Subcommands:
 *   /telegram                       — show help
 *   /telegram webhook               — webhook status
 *   /telegram webhook on|off|verify — manage webhook
 *   /telegram pair                  — list pending pairing requests
 *   /telegram pair list             — same as above
 *   /telegram pair approve <code>   — approve a pairing request
 */

const CONFIG_FILE = "/root/.openclaw/openclaw.json";
const OPENCLAW_DIR = "/root/.openclaw";
const PAIRING_TTL_MS = 60 * 60 * 1000; // 60 minutes

// ── Credential directory detection ───────────────────────────

function getCredDir(): string {
  const newer = `${OPENCLAW_DIR}/credentials`;
  if (existsSync(newer)) return newer;
  return `${OPENCLAW_DIR}/oauth`;
}

// ── Config helpers ───────────────────────────────────────────

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

// ── Telegram API helper ──────────────────────────────────────

async function telegramApi(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<any> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const opts: RequestInit = {
      signal: controller.signal,
      ...(body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : { method: "GET" }),
    };

    let resp: Response;
    try {
      resp = await fetch(url, opts);
    } catch (e: any) {
      if (e.name === "AbortError") {
        throw new Error(`Telegram API ${method}: request timed out (10s)`);
      }
      throw new Error(`Telegram API ${method}: network error: ${e.message}`);
    }

    let data: any;
    try {
      data = await resp.json();
    } catch {
      const text = await resp.text().catch(() => "(unreadable)");
      throw new Error(`Telegram API ${method}: invalid JSON (HTTP ${resp.status}): ${text.slice(0, 200)}`);
    }

    if (!data.ok) {
      throw new Error(`Telegram API ${method}: ${data.description || "unknown error"}`);
    }
    return data.result;
  } finally {
    clearTimeout(timeout);
  }
}

// ── JSON file helpers ────────────────────────────────────────

function readJsonFile(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, data: any): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ── Webhook subcommands ──────────────────────────────────────

function handleWebhookStatus(): string {
  const lines: string[] = [];

  lines.push(`TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? "set" : "NOT SET"}`);
  lines.push(`WORKER_URL: ${process.env.WORKER_URL || "NOT SET"}`);
  lines.push(`TELEGRAM_WEBHOOK_SECRET: ${process.env.TELEGRAM_WEBHOOK_SECRET ? "set" : "NOT SET"}`);

  const config = readConfig();
  const tg = config.channels?.telegram;
  const hasWebhookConfig = !!(tg?.webhookUrl && tg?.webhookSecret);
  lines.push("");
  lines.push(`Local config: ${hasWebhookConfig ? "webhook" : "polling"} mode`);
  if (tg?.webhookUrl) {
    lines.push(`  URL: ${tg.webhookUrl}`);
  }
  lines.push(`  Secret configured: ${tg?.webhookSecret ? "yes" : "no"}`);

  lines.push("");
  lines.push("Use /telegram webhook verify to query Telegram API status.");

  return lines.join("\n");
}

async function handleWebhookOn(): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const workerUrl = process.env.WORKER_URL;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!token) return "[FAIL] TELEGRAM_BOT_TOKEN is not set";
  if (!workerUrl) return "[FAIL] WORKER_URL is not set";
  if (!webhookSecret) return "[FAIL] TELEGRAM_WEBHOOK_SECRET is not set";

  const webhookUrl = workerUrl.replace(/\/+$/, "") + "/telegram/webhook";

  const lines: string[] = [];

  try {
    await telegramApi(token, "setWebhook", {
      url: webhookUrl,
      secret_token: webhookSecret,
    });
    lines.push("[PASS] Webhook registered with Telegram");
  } catch (e: any) {
    return `[FAIL] setWebhook failed: ${e.message}`;
  }

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

async function handleWebhookOff(): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return "[FAIL] TELEGRAM_BOT_TOKEN is not set";

  const lines: string[] = [];

  try {
    await telegramApi(token, "deleteWebhook");
    lines.push("[PASS] Webhook deleted from Telegram");
  } catch (e: any) {
    return `[FAIL] deleteWebhook failed: ${e.message}`;
  }

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

async function handleWebhookVerify(): Promise<string> {
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

// ── Pairing subcommands ──────────────────────────────────────

interface PairingRequest {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, string>;
}

interface PairingFile {
  version: number;
  requests: PairingRequest[];
}

interface AllowFromFile {
  version: number;
  allowFrom: string[];
}

function getPairingFilePath(): string {
  return `${getCredDir()}/telegram-pairing.json`;
}

function getAllowFromFilePath(): string {
  return `${getCredDir()}/telegram-allowFrom.json`;
}

function readPairingFile(): PairingFile {
  const data = readJsonFile(getPairingFilePath());
  if (data && data.version === 1 && Array.isArray(data.requests)) {
    return data;
  }
  return { version: 1, requests: [] };
}

function writePairingFile(data: PairingFile): void {
  writeJsonFile(getPairingFilePath(), data);
}

function readAllowFromFile(): AllowFromFile {
  const data = readJsonFile(getAllowFromFilePath());
  if (data && data.version === 1 && Array.isArray(data.allowFrom)) {
    return data;
  }
  return { version: 1, allowFrom: [] };
}

function writeAllowFromFile(data: AllowFromFile): void {
  writeJsonFile(getAllowFromFilePath(), data);
}

function filterExpired(requests: PairingRequest[]): PairingRequest[] {
  const now = Date.now();
  return requests.filter((r) => {
    const created = new Date(r.createdAt).getTime();
    return now - created < PAIRING_TTL_MS;
  });
}

function handlePairList(): string {
  const pairing = readPairingFile();
  const active = filterExpired(pairing.requests);

  if (active.length === 0) {
    return "No pending pairing requests.";
  }

  const lines: string[] = [`Pending pairing requests (${active.length}):`, ""];

  for (const req of active) {
    const created = new Date(req.createdAt);
    const lastSeen = new Date(req.lastSeenAt);
    const ageMin = Math.round((Date.now() - created.getTime()) / 60000);
    const username = req.meta?.username ? ` (@${req.meta.username})` : "";
    const firstName = req.meta?.first_name ? ` ${req.meta.first_name}` : "";

    lines.push(`  Code: ${req.code}`);
    lines.push(`  User: ${req.id}${firstName}${username}`);
    lines.push(`  Created: ${ageMin}m ago (${created.toISOString()})`);
    lines.push(`  Last seen: ${lastSeen.toISOString()}`);
    lines.push("");
  }

  lines.push("Use /telegram pair approve <code> to approve.");
  return lines.join("\n");
}

async function handlePairApprove(code: string): Promise<string> {
  if (!code) {
    return "[FAIL] Usage: /telegram pair approve <code>";
  }

  const pairing = readPairingFile();
  const active = filterExpired(pairing.requests);
  const idx = active.findIndex((r) => r.code.toLowerCase() === code.toLowerCase());

  if (idx === -1) {
    return `[FAIL] No pending request with code "${code}". Use /telegram pair to list requests.`;
  }

  const req = active[idx];
  const userId = req.id;
  const username = req.meta?.username ? ` (@${req.meta.username})` : "";
  const firstName = req.meta?.first_name ? ` ${req.meta.first_name}` : "";

  // Remove from pairing requests
  active.splice(idx, 1);
  writePairingFile({ version: 1, requests: active });

  // Add to allowFrom
  const allowFrom = readAllowFromFile();
  if (!allowFrom.allowFrom.includes(userId)) {
    allowFrom.allowFrom.push(userId);
    writeAllowFromFile(allowFrom);
  }

  const lines: string[] = [
    `[PASS] Approved user ${userId}${firstName}${username}`,
    `[PASS] Added to allowFrom list`,
  ];

  // Try to notify user via Telegram
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
    try {
      await telegramApi(token, "sendMessage", {
        chat_id: userId,
        text: "Your pairing request has been approved! You can now send messages.",
      });
      lines.push("[PASS] Sent approval notification to user");
    } catch (e: any) {
      lines.push(`[WARN] Could not notify user: ${e.message}`);
    }
  }

  return lines.join("\n");
}

// ── Help text ────────────────────────────────────────────────

function showHelp(): string {
  return [
    "Usage: /telegram <subcommand>",
    "",
    "Webhook management:",
    "  /telegram webhook               — Show webhook status",
    "  /telegram webhook on             — Enable webhook mode",
    "  /telegram webhook off            — Disable webhook mode",
    "  /telegram webhook verify         — Query Telegram API for webhook info",
    "",
    "Pairing management:",
    "  /telegram pair                   — List pending pairing requests",
    "  /telegram pair list              — Same as above",
    "  /telegram pair approve <code>    — Approve a pairing request",
  ].join("\n");
}

// ── Plugin registration ──────────────────────────────────────

export default function register(api: any) {
  api.registerCommand({
    name: "telegram",
    description: "Telegram management — /telegram webhook|pair",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try {
        const args = ctx.args?.trim() ?? "";
        const parts = args.split(/\s+/).filter(Boolean);
        const group = parts[0] || "";
        const sub = parts[1] || "";
        const rest = parts.slice(2).join(" ");

        let text: string;

        switch (group) {
          case "webhook":
            switch (sub) {
              case "on":
                text = await handleWebhookOn();
                break;
              case "off":
                text = await handleWebhookOff();
                break;
              case "verify":
                text = await handleWebhookVerify();
                break;
              case "status":
              case "":
                text = handleWebhookStatus();
                break;
              default:
                text = `Unknown webhook subcommand: ${sub}\n\nUsage: /telegram webhook [status|on|off|verify]`;
            }
            break;

          case "pair":
            switch (sub) {
              case "approve":
                text = await handlePairApprove(rest);
                break;
              case "list":
              case "":
                text = handlePairList();
                break;
              default:
                text = `Unknown pair subcommand: ${sub}\n\nUsage: /telegram pair [list|approve <code>]`;
            }
            break;

          case "":
            text = showHelp();
            break;

          default:
            text = `Unknown subcommand: ${group}\n\n${showHelp()}`;
        }

        return { text };
      } catch (e: any) {
        return { text: `[FAIL] Unexpected error: ${e.message}` };
      }
    },
  });
}
