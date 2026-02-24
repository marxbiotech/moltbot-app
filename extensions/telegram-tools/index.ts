import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * telegram-tools plugin — /telegram
 *
 * Manage Telegram webhook mode, channel pairing, group/channel config,
 * mention patterns, and account-level settings.
 * Uses registerCommand() so commands execute WITHOUT the AI agent.
 *
 * Subcommands:
 *   /telegram                             — show help
 *   /telegram webhook                     — webhook status
 *   /telegram webhook on|off|verify       — manage webhook
 *   /telegram pair                        — list pending pairing requests
 *   /telegram pair approve <code>         — approve a pairing request
 *   /telegram group                       — list configured groups/channels
 *   /telegram group add|remove|show|set   — manage group config
 *   /telegram mention                     — list mention patterns
 *   /telegram mention add|remove|test     — manage mention patterns
 *   /telegram config                      — show telegram config
 *   /telegram config set <key> <value>    — set account-level config
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

    const text = await resp.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
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
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    console.error(`[telegram-tools] Failed to read ${path}: ${e.message}`);
    throw new Error(`Cannot read ${path}: ${e.message}`);
  }
}

function writeJsonFile(path: string, data: any): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ── Value parsing helpers ────────────────────────────────────

function parseCommaSeparated(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatValue(val: unknown): string {
  if (val === undefined) return "(not set)";
  if (val === null) return "(null)";
  if (typeof val === "object") return JSON.stringify(val, null, 2);
  return String(val);
}

function readTelegramConfig(): [any, any] {
  const config = readJsonFile(CONFIG_FILE) ?? {};
  config.channels ??= {};
  config.channels.telegram ??= {};
  return [config, config.channels.telegram];
}

// ── Webhook subcommands ──────────────────────────────────────

function handleWebhookStatus(): string {
  const lines: string[] = [];

  lines.push(`TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? "set" : "NOT SET"}`);
  lines.push(`WORKER_URL: ${process.env.WORKER_URL || "NOT SET"}`);
  lines.push(`TELEGRAM_WEBHOOK_SECRET: ${process.env.TELEGRAM_WEBHOOK_SECRET ? "set" : "NOT SET"}`);

  const config = readJsonFile(CONFIG_FILE) ?? {};
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

  let configWritten = false;
  try {
    const config = readJsonFile(CONFIG_FILE) ?? {};
    config.channels ??= {};
    config.channels.telegram ??= {};
    config.channels.telegram.webhookUrl = webhookUrl;
    config.channels.telegram.webhookSecret = webhookSecret;
    writeJsonFile(CONFIG_FILE, config);
    lines.push("[PASS] Config updated with webhook settings");
    configWritten = true;
  } catch (e: any) {
    lines.push(`[WARN] Could not update config: ${e.message}`);
  }

  lines.push("");
  if (configWritten) {
    lines.push("Webhook mode enabled. Restart gateway to apply.");
  } else {
    lines.push("[WARN] Webhook registered with Telegram, but config write failed. Do NOT restart until config is fixed.");
  }
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
    const config = readJsonFile(CONFIG_FILE) ?? {};
    if (config.channels?.telegram) {
      delete config.channels.telegram.webhookUrl;
      delete config.channels.telegram.webhookSecret;
      writeJsonFile(CONFIG_FILE, config);
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
  version: 1;
  requests: PairingRequest[];
}

interface AllowFromFile {
  version: 1;
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
    if (Number.isNaN(created)) return true; // keep requests with invalid dates visible
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

  // Add to allowFrom FIRST (critical operation)
  const allowFrom = readAllowFromFile();
  if (!allowFrom.allowFrom.includes(userId)) {
    allowFrom.allowFrom.push(userId);
    writeAllowFromFile(allowFrom);
  }

  // Only remove from pairing AFTER allowFrom succeeds
  active.splice(idx, 1);
  writePairingFile({ version: 1, requests: active });

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

// ── Group subcommands ────────────────────────────────────────

const GROUP_SET_KEYS: Record<string, "boolean" | "string" | "enum" | "array"> = {
  requireMention: "boolean",
  groupPolicy: "enum",
  enabled: "boolean",
  systemPrompt: "string",
  allowFrom: "array",
};

const GROUP_POLICY_VALUES = ["open", "disabled", "allowlist"];

function handleGroupList(): string {
  const [, tg] = readTelegramConfig();
  const groups: Record<string, any> | undefined = tg.groups;

  if (!groups || Object.keys(groups).length === 0) {
    return "No groups configured.\n\nUse /telegram group add <id> to add one.";
  }

  const lines: string[] = [`Configured groups (${Object.keys(groups).length}):`, ""];

  for (const [id, cfg] of Object.entries(groups)) {
    const flags: string[] = [];
    if ((cfg as any).enabled === true) flags.push("enabled");
    if ((cfg as any).enabled === false) flags.push("disabled");
    if ((cfg as any).requireMention === false) flags.push("no-mention");
    if ((cfg as any).requireMention === true) flags.push("mention-required");
    if ((cfg as any).groupPolicy) flags.push(`policy:${(cfg as any).groupPolicy}`);
    if ((cfg as any).systemPrompt) flags.push("has-prompt");
    if ((cfg as any).topics && Object.keys((cfg as any).topics).length > 0)
      flags.push(`${Object.keys((cfg as any).topics).length} topic(s)`);

    lines.push(`  ${id}  [${flags.join(", ") || "default"}]`);
  }

  lines.push("");
  lines.push("Use /telegram group show <id> for details.");
  return lines.join("\n");
}

function handleGroupAdd(id: string, flags: string): string {
  if (!id) return "[FAIL] Usage: /telegram group add <id> [--bot-to-bot]";

  const [config, tg] = readTelegramConfig();
  tg.groups ??= {};

  if (tg.groups[id]) {
    return `[WARN] Group ${id} already exists. Use /telegram group set to modify.`;
  }

  const isBotToBot = flags.includes("--bot-to-bot");

  if (isBotToBot) {
    tg.groups[id] = {
      enabled: true,
      requireMention: false,
      groupPolicy: "open",
    };
  } else {
    tg.groups[id] = {};
  }

  writeJsonFile(CONFIG_FILE, config);

  const lines = [`[PASS] Group ${id} added`];
  if (isBotToBot) {
    lines.push("[PASS] Bot-to-bot defaults applied:");
    lines.push("  enabled: true");
    lines.push("  requireMention: false");
    lines.push("  groupPolicy: open");
    lines.push("");
    lines.push("Tip: ensure both bots are Channel admins with Sign Messages ON.");
  }
  lines.push("");
  lines.push("Restart gateway to apply: POST /api/admin/gateway/restart");
  return lines.join("\n");
}

function handleGroupRemove(id: string): string {
  if (!id) return "[FAIL] Usage: /telegram group remove <id>";

  const [config, tg] = readTelegramConfig();

  if (!tg.groups?.[id]) {
    return `[FAIL] Group ${id} not found. Use /telegram group list to see configured groups.`;
  }

  delete tg.groups[id];
  writeJsonFile(CONFIG_FILE, config);

  return `[PASS] Group ${id} removed\n\nRestart gateway to apply: POST /api/admin/gateway/restart`;
}

function handleGroupShow(id: string): string {
  if (!id) return "[FAIL] Usage: /telegram group show <id>";

  const [, tg] = readTelegramConfig();

  if (!tg.groups?.[id]) {
    return `[FAIL] Group ${id} not found. Use /telegram group list to see configured groups.`;
  }

  const cfg = tg.groups[id];
  const lines: string[] = [`Group: ${id}`, ""];

  const knownKeys = [
    "enabled",
    "requireMention",
    "groupPolicy",
    "allowFrom",
    "systemPrompt",
    "topics",
    "tools",
    "toolsBySender",
    "skills",
  ];

  for (const key of knownKeys) {
    if (cfg[key] !== undefined) {
      lines.push(`  ${key}: ${formatValue(cfg[key])}`);
    }
  }

  for (const key of Object.keys(cfg)) {
    if (!knownKeys.includes(key)) {
      lines.push(`  ${key}: ${formatValue(cfg[key])}`);
    }
  }

  if (Object.keys(cfg).length === 0) {
    lines.push("  (empty — using defaults)");
  }

  return lines.join("\n");
}

function handleGroupSet(id: string, keyAndValue: string): string {
  if (!id) return "[FAIL] Usage: /telegram group set <id> <key> <value>";

  const spaceIdx = keyAndValue.indexOf(" ");
  if (spaceIdx === -1 || !keyAndValue.trim()) {
    return (
      "[FAIL] Usage: /telegram group set <id> <key> <value>\n\nKeys: " +
      Object.keys(GROUP_SET_KEYS).join(", ")
    );
  }

  const key = keyAndValue.substring(0, spaceIdx).trim();
  const rawValue = keyAndValue.substring(spaceIdx + 1).trim();

  if (!rawValue) return `[FAIL] Missing value for key "${key}"`;

  if (!GROUP_SET_KEYS[key]) {
    return `[FAIL] Unknown key: ${key}\n\nValid keys: ${Object.keys(GROUP_SET_KEYS).join(", ")}`;
  }

  const [config, tg] = readTelegramConfig();
  tg.groups ??= {};
  if (!tg.groups[id]) {
    return `[FAIL] Group ${id} not found. Use /telegram group add <id> first.`;
  }

  let value: any;
  const expectedType = GROUP_SET_KEYS[key];

  if (expectedType === "boolean") {
    if (rawValue.toLowerCase() !== "true" && rawValue.toLowerCase() !== "false") {
      return `[FAIL] ${key} must be true or false`;
    }
    value = rawValue.toLowerCase() === "true";
  } else if (expectedType === "enum") {
    if (!GROUP_POLICY_VALUES.includes(rawValue)) {
      return `[FAIL] ${key} must be one of: ${GROUP_POLICY_VALUES.join(", ")}`;
    }
    value = rawValue;
  } else if (expectedType === "array") {
    value = parseCommaSeparated(rawValue);
  } else {
    value = rawValue;
  }

  tg.groups[id][key] = value;
  writeJsonFile(CONFIG_FILE, config);

  return `[PASS] Group ${id}: ${key} = ${formatValue(value)}\n\nRestart gateway to apply.`;
}

// ── Mention subcommands ──────────────────────────────────────

function readMentionPatterns(): [any, string[]] {
  const config = readJsonFile(CONFIG_FILE) ?? {};
  config.messages ??= {};
  config.messages.groupChat ??= {};
  config.messages.groupChat.mentionPatterns ??= [];
  return [config, config.messages.groupChat.mentionPatterns];
}

function handleMentionList(): string {
  const [, patterns] = readMentionPatterns();

  if (patterns.length === 0) {
    return "No mention patterns configured.\n\nUse /telegram mention add <regex> to add one.";
  }

  const lines: string[] = [`Mention patterns (${patterns.length}):`, ""];
  for (let i = 0; i < patterns.length; i++) {
    let valid = true;
    try {
      new RegExp(patterns[i], "i");
    } catch {
      valid = false;
    }
    const mark = valid ? "" : " [INVALID]";
    lines.push(`  [${i}] /${patterns[i]}/${mark}`);
  }

  lines.push("");
  lines.push("Use /telegram mention test <text> to test patterns.");
  return lines.join("\n");
}

function handleMentionAdd(pattern: string): string {
  if (!pattern) return "[FAIL] Usage: /telegram mention add <regex>";

  try {
    new RegExp(pattern, "i");
  } catch (e: any) {
    return `[FAIL] Invalid regex: ${e.message}\n\nPattern: ${pattern}`;
  }

  const [config, patterns] = readMentionPatterns();

  if (patterns.includes(pattern)) {
    return `[WARN] Pattern already exists: /${pattern}/`;
  }

  patterns.push(pattern);
  writeJsonFile(CONFIG_FILE, config);

  return `[PASS] Pattern added: /${pattern}/\n\nRestart gateway to apply.`;
}

function handleMentionRemove(target: string): string {
  if (!target) return "[FAIL] Usage: /telegram mention remove <index|pattern>";

  const [config, patterns] = readMentionPatterns();

  if (patterns.length === 0) {
    return "[FAIL] No patterns to remove.";
  }

  const idx = Number(target);
  if (!Number.isNaN(idx) && Number.isInteger(idx) && idx >= 0 && idx < patterns.length) {
    const removed = patterns.splice(idx, 1)[0];
    writeJsonFile(CONFIG_FILE, config);
    return `[PASS] Removed pattern [${idx}]: /${removed}/\n\nRestart gateway to apply.`;
  }

  const strIdx = patterns.indexOf(target);
  if (strIdx !== -1) {
    patterns.splice(strIdx, 1);
    writeJsonFile(CONFIG_FILE, config);
    return `[PASS] Removed pattern: /${target}/\n\nRestart gateway to apply.`;
  }

  return `[FAIL] Pattern not found: "${target}"\n\nUse /telegram mention list to see current patterns.`;
}

function handleMentionTest(text: string): string {
  if (!text) return "[FAIL] Usage: /telegram mention test <text>";

  const [, patterns] = readMentionPatterns();

  if (patterns.length === 0) {
    return "[WARN] No patterns configured. Nothing to test against.";
  }

  const lines: string[] = [`Testing: "${text}"`, ""];
  let anyMatch = false;

  for (let i = 0; i < patterns.length; i++) {
    let match = false;
    try {
      const re = new RegExp(patterns[i], "i");
      match = re.test(text);
    } catch {
      lines.push(`  [${i}] /${patterns[i]}/  => [INVALID REGEX]`);
      continue;
    }
    const mark = match ? "MATCH" : "no match";
    lines.push(`  [${i}] /${patterns[i]}/  => ${mark}`);
    if (match) anyMatch = true;
  }

  lines.push("");
  lines.push(
    anyMatch
      ? "[PASS] Message WOULD trigger mention detection."
      : "[WARN] Message would NOT trigger mention detection.",
  );

  return lines.join("\n");
}

// ── Config subcommands ───────────────────────────────────────

const CONFIG_SET_KEYS: Record<string, { type: "string" | "number" | "boolean" | "enum"; values?: string[] }> = {
  groupPolicy: { type: "enum", values: ["open", "disabled", "allowlist"] },
  historyLimit: { type: "number" },
  dmPolicy: { type: "enum", values: ["pairing", "allowlist", "open", "disabled"] },
  reactionLevel: { type: "enum", values: ["off", "ack", "minimal", "extensive"] },
  reactionNotifications: { type: "enum", values: ["off", "own", "all"] },
  streaming: { type: "enum", values: ["off", "partial", "block", "progress"] },
  replyToMode: { type: "enum", values: ["off", "first", "all"] },
  ackReaction: { type: "string" },
  linkPreview: { type: "boolean" },
};

function handleConfigShow(): string {
  const [, tg] = readTelegramConfig();

  const lines: string[] = ["Telegram configuration:", ""];

  lines.push("  botToken: " + (tg.botToken ? "(set)" : "(not set)"));
  lines.push("  enabled: " + formatValue(tg.enabled));

  const displayKeys = [
    "dmPolicy",
    "groupPolicy",
    "groupAllowFrom",
    "historyLimit",
    "reactionLevel",
    "reactionNotifications",
    "streaming",
    "replyToMode",
    "ackReaction",
    "linkPreview",
  ];

  for (const key of displayKeys) {
    if (tg[key] !== undefined) {
      lines.push(`  ${key}: ${formatValue(tg[key])}`);
    }
  }

  if (tg.webhookUrl) {
    lines.push("");
    lines.push("Webhook:");
    lines.push(`  url: ${tg.webhookUrl}`);
    lines.push(`  secret: ${tg.webhookSecret ? "(set)" : "(not set)"}`);
    lines.push(`  host: ${tg.webhookHost || "(default)"}`);
  }

  if (tg.groups && Object.keys(tg.groups).length > 0) {
    lines.push("");
    lines.push(`Groups: ${Object.keys(tg.groups).length} configured`);
    lines.push("  Use /telegram group list for details.");
  }

  if (tg.allowFrom) {
    const count = Array.isArray(tg.allowFrom) ? tg.allowFrom.length : "?";
    lines.push("");
    lines.push(`DM allowFrom: ${count} entries`);
  }

  lines.push("");
  lines.push("Use /telegram config set <key> <value> to modify.");
  lines.push("Valid keys: " + Object.keys(CONFIG_SET_KEYS).join(", "));
  return lines.join("\n");
}

function handleConfigSet(keyAndValue: string): string {
  const spaceIdx = keyAndValue.indexOf(" ");
  if (spaceIdx === -1 || !keyAndValue.trim()) {
    return (
      "[FAIL] Usage: /telegram config set <key> <value>\n\nValid keys: " +
      Object.keys(CONFIG_SET_KEYS).join(", ")
    );
  }

  const key = keyAndValue.substring(0, spaceIdx).trim();
  const rawValue = keyAndValue.substring(spaceIdx + 1).trim();

  if (!rawValue) return `[FAIL] Missing value for key "${key}"`;

  const schema = CONFIG_SET_KEYS[key];
  if (!schema) {
    return `[FAIL] Unknown key: ${key}\n\nValid keys: ${Object.keys(CONFIG_SET_KEYS).join(", ")}`;
  }

  let value: any;
  if (schema.type === "boolean") {
    if (rawValue.toLowerCase() !== "true" && rawValue.toLowerCase() !== "false") {
      return `[FAIL] ${key} must be true or false`;
    }
    value = rawValue.toLowerCase() === "true";
  } else if (schema.type === "number") {
    value = Number(rawValue);
    if (Number.isNaN(value)) return `[FAIL] ${key} must be a number`;
  } else if (schema.type === "enum") {
    if (!schema.values!.includes(rawValue)) {
      return `[FAIL] ${key} must be one of: ${schema.values!.join(", ")}`;
    }
    value = rawValue;
  } else {
    value = rawValue;
  }

  const [config, tg] = readTelegramConfig();
  tg[key] = value;
  writeJsonFile(CONFIG_FILE, config);

  return `[PASS] ${key} = ${formatValue(value)}\n\nRestart gateway to apply.`;
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
    "",
    "Group/channel management:",
    "  /telegram group                  — List configured groups",
    "  /telegram group add <id>         — Add a group config",
    "  /telegram group add <id> --bot-to-bot — Bot-to-bot defaults",
    "  /telegram group remove <id>      — Remove a group config",
    "  /telegram group show <id>        — Show group details",
    "  /telegram group set <id> <k> <v> — Set a per-group config key",
    "",
    "Mention patterns:",
    "  /telegram mention                — List mention patterns",
    "  /telegram mention add <regex>    — Add a pattern",
    "  /telegram mention remove <i|pat> — Remove by index or pattern",
    "  /telegram mention test <text>    — Test text against patterns",
    "",
    "Telegram config:",
    "  /telegram config                 — Show config summary",
    "  /telegram config set <key> <val> — Set account-level config",
  ].join("\n");
}

// ── Plugin registration ──────────────────────────────────────

export default function register(api: any) {
  api.registerCommand({
    name: "telegram",
    description: "Telegram management — /telegram webhook|pair|group|mention|config",
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

          case "group": {
            const groupParts = rest.split(/\s+/);
            const groupId = groupParts[0] || "";
            const groupRest = groupParts.slice(1).join(" ");
            switch (sub) {
              case "add":
                text = handleGroupAdd(groupId, groupRest);
                break;
              case "remove":
                text = handleGroupRemove(groupId);
                break;
              case "show":
                text = handleGroupShow(groupId);
                break;
              case "set":
                text = handleGroupSet(groupId, groupRest);
                break;
              case "list":
              case "":
                text = handleGroupList();
                break;
              default:
                // /telegram group <id> → shorthand for show
                text = handleGroupShow(sub);
            }
            break;
          }

          case "mention":
            switch (sub) {
              case "add":
                text = handleMentionAdd(rest);
                break;
              case "remove":
                text = handleMentionRemove(rest);
                break;
              case "test":
                text = handleMentionTest(rest);
                break;
              case "list":
              case "":
                text = handleMentionList();
                break;
              default:
                text = `Unknown mention subcommand: ${sub}\n\nUsage: /telegram mention [list|add|remove|test]`;
            }
            break;

          case "config":
            switch (sub) {
              case "set":
                text = handleConfigSet(rest);
                break;
              case "show":
              case "":
                text = handleConfigShow();
                break;
              default:
                text = `Unknown config subcommand: ${sub}\n\nUsage: /telegram config [show|set <key> <value>]`;
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
        console.error("[telegram-tools] Unexpected error:", e);
        return { text: `[FAIL] Unexpected error: ${e.message}` };
      }
    },
  });
}
