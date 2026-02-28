import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * telegram-tools plugin — /telegram
 *
 * Manage Telegram webhook mode, channel pairing, group/channel config,
 * and mention patterns.
 *
 * Config writes delegate to `openclaw config set/unset` CLI so schema
 * validation is handled by OpenClaw itself — no hardcoded type mappings.
 * Array operations (mention patterns) use runtime.config.loadConfig/writeConfigFile.
 *
 * Subcommands:
 *   /telegram                             — show help
 *   /telegram webhook                     — webhook status
 *   /telegram webhook on|off|verify       — manage webhook
 *   /telegram pair                        — list pending pairing requests
 *   /telegram pair approve <code>         — approve a pairing request
 *   /telegram group                       — list configured groups
 *   /telegram group add|remove|set        — manage group config
 *   /telegram group show <id>             — show group details
 *   /telegram mention                     — list mention patterns
 *   /telegram mention add|remove|test     — manage mention patterns
 */

const OPENCLAW_DIR = "/root/.openclaw";
const PAIRING_TTL_MS = 60 * 60 * 1000; // 60 minutes
const CLI_TIMEOUT_MS = 10_000;
const BOT_TO_BOT_MENTION_PROMPT = "在群組中回應時，務必使用 @username 提及你正在對話的對象。";

// Captured at plugin registration time; gives access to OpenClaw runtime APIs.
let runtime: any;

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

// ── JSON file helpers (for pairing files only) ───────────────

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

// ── Value formatting ─────────────────────────────────────────

function formatValue(val: unknown): string {
  if (val === undefined) return "(not set)";
  if (val === null) return "(null)";
  if (typeof val === "object") return JSON.stringify(val, null, 2);
  return String(val);
}

// ── Config CLI helpers ───────────────────────────────────────

async function configSet(
  path: string,
  value: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await runtime.system.runCommandWithTimeout(
      ["openclaw", "config", "set", path, value],
      CLI_TIMEOUT_MS,
    );
    if (result.code === 0) return { ok: true };
    return { ok: false, error: result.stderr?.trim() || result.stdout?.trim() || "Unknown error" };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

async function configUnset(
  path: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await runtime.system.runCommandWithTimeout(
      ["openclaw", "config", "unset", path],
      CLI_TIMEOUT_MS,
    );
    if (result.code === 0) return { ok: true };
    return { ok: false, error: result.stderr?.trim() || result.stdout?.trim() || "Unknown error" };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ── Webhook subcommands ──────────────────────────────────────

function handleWebhookStatus(config: any): string {
  const lines: string[] = [];

  lines.push(`TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? "set" : "NOT SET"}`);
  lines.push(`WORKER_URL: ${process.env.WORKER_URL || "NOT SET"}`);
  lines.push(`TELEGRAM_WEBHOOK_SECRET: ${process.env.TELEGRAM_WEBHOOK_SECRET ? "set" : "NOT SET"}`);

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

  const urlResult = await configSet("channels.telegram.webhookUrl", webhookUrl);
  const secretResult = await configSet("channels.telegram.webhookSecret", webhookSecret);

  if (urlResult.ok && secretResult.ok) {
    lines.push("[PASS] Config updated with webhook settings");
    lines.push("");
    lines.push("Webhook mode enabled. Restart gateway to apply.");
  } else {
    const errors = [urlResult.error, secretResult.error].filter(Boolean).join("; ");
    lines.push(`[WARN] Config write failed: ${errors}`);
    lines.push("");
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

  const urlResult = await configUnset("channels.telegram.webhookUrl");
  const secretResult = await configUnset("channels.telegram.webhookSecret");

  if (urlResult.ok && secretResult.ok) {
    lines.push("[PASS] Webhook fields removed from config");
  } else {
    const errors = [urlResult.error, secretResult.error].filter(Boolean).join("; ");
    lines.push(`[WARN] Could not update config: ${errors}`);
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

// ── Discipline state & file helpers ─────────────────────────

interface DisciplineGroupConfig {
  enabled: boolean;
  threshold: number;
}

interface DisciplineFile {
  version: 1;
  groups: Record<string, DisciplineGroupConfig>;
}

const disciplineTracker: Map<string, { count: number }> = new Map();
const disciplineTriggered: Set<string> = new Set();

function getDisciplineFilePath(): string {
  return `${getCredDir()}/telegram-discipline.json`;
}

function readDisciplineFile(): DisciplineFile {
  const data = readJsonFile(getDisciplineFilePath());
  if (data && data.version === 1 && data.groups) {
    return data;
  }
  return { version: 1, groups: {} };
}

function writeDisciplineFile(data: DisciplineFile): void {
  writeJsonFile(getDisciplineFilePath(), data);
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

function handleGroupList(config: any): string {
  const groups: Record<string, any> | undefined = config.channels?.telegram?.groups;

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

async function handleGroupAdd(id: string, flags: string): Promise<string> {
  if (!id) return "[FAIL] Usage: /telegram group add <id> [--bot-to-bot [<other-bot-id,...>]]";

  const isBotToBot = flags.includes("--bot-to-bot");

  if (isBotToBot) {
    // Extract comma-separated bot IDs (e.g. "--bot-to-bot 753,890")
    const botIdRaw = flags.replace("--bot-to-bot", "").trim();
    const botIds = botIdRaw
      ? botIdRaw.split(",").map((s: string) => s.trim()).filter(Boolean)
      : [];

    // Auto-include paired DM users (owners) so they can also interact in the channel
    const pairedUsers = readAllowFromFile().allowFrom;
    for (const uid of pairedUsers) {
      if (/^\d+$/.test(uid)) botIds.push(uid);
    }

    // Deduplicate
    const allIds = [...new Set(botIds)];

    const prefix = `channels.telegram.groups.${id}`;
    const sets: Array<[string, string]> = [
      [`${prefix}.enabled`, "true"],
      [`${prefix}.requireMention`, "true"],
      [`${prefix}.groupPolicy`, allIds.length > 0 ? "allowlist" : "open"],
      [`${prefix}.systemPrompt`, BOT_TO_BOT_MENTION_PROMPT],
    ];
    if (allIds.length > 0) {
      sets.push([`${prefix}.allowFrom`, JSON.stringify(allIds)]);
    }

    const errors: string[] = [];
    for (const [path, value] of sets) {
      const result = await configSet(path, value);
      if (!result.ok) errors.push(`${path}: ${result.error}`);
    }
    if (errors.length > 0) {
      return `[FAIL] Config write failed:\n${errors.join("\n")}`;
    }

    const lines = [
      `[PASS] Group ${id} added with bot-to-bot defaults:`,
      "  enabled: true",
      "  requireMention: true",
      `  systemPrompt: "${BOT_TO_BOT_MENTION_PROMPT}"`,
    ];
    if (allIds.length > 0) {
      lines.push(`  groupPolicy: allowlist`);
      lines.push(`  allowFrom: [${allIds.join(", ")}]`);
    } else {
      lines.push("  groupPolicy: open");
    }
    lines.push(
      "",
      "Tip: ensure both bots are Channel admins with Sign Messages ON.",
      "",
      "Restart gateway to apply.",
    );
    return lines.join("\n");
  }

  const result = await configSet(`channels.telegram.groups.${id}.enabled`, "true");
  if (!result.ok) {
    return `[FAIL] Config write failed: ${result.error}`;
  }

  return `[PASS] Group ${id} added\n\nRestart gateway to apply.`;
}

async function handleGroupRemove(id: string): Promise<string> {
  if (!id) return "[FAIL] Usage: /telegram group remove <id>";

  const result = await configUnset(`channels.telegram.groups.${id}`);
  if (!result.ok) {
    return `[FAIL] Config write failed: ${result.error}`;
  }

  return `[PASS] Group ${id} removed\n\nRestart gateway to apply.`;
}

function handleGroupJoin(id: string): string {
  if (!id) return "[FAIL] Usage: /telegram group join <group-id>";

  // Extract this bot's ID from its token (format: <bot_id>:<secret>)
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return "[FAIL] TELEGRAM_BOT_TOKEN is not set";

  const botId = token.split(":")[0];
  if (!botId || !/^\d+$/.test(botId)) {
    return "[FAIL] Could not parse bot ID from token";
  }

  const cmd = `/telegram group set ${id} +allowFrom ${botId}`;
  const lines = [
    "Copy this command and run it on the OTHER bot's OpenClaw,",
    "so that bot can see this bot's messages in the group:",
    "",
    cmd,
    "",
    `This bot's ID: ${botId}`,
  ];
  return lines.join("\n");
}

async function restartGateway(): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await runtime.system.runCommandWithTimeout(
      ["openclaw", "gateway", "restart"],
      CLI_TIMEOUT_MS,
    );
    if (result.code === 0) return { ok: true };
    return { ok: false, error: result.stderr?.trim() || result.stdout?.trim() || "Unknown error" };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

function extractGroupIdFromContext(ctx: any): string | undefined {
  // ctx.from format: "telegram:<chatId>" or "telegram:<chatId>:topic:<threadId>"
  const from = ctx.from as string | undefined;
  if (!from) return undefined;
  const match = from.match(/^telegram:(-\d+)/);
  return match?.[1];
}

function handleGroupShow(id: string, config: any): string {
  if (!id) return "[FAIL] Usage: /telegram group show <id>";

  const groups = config.channels?.telegram?.groups;
  if (!groups?.[id]) {
    return `[FAIL] Group ${id} not found. Use /telegram group list to see configured groups.`;
  }

  const cfg = groups[id];
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

async function handleGroupSet(id: string, keyAndValue: string): Promise<string> {
  if (!id) return "[FAIL] Usage: /telegram group set <id> <key> <value>";

  const spaceIdx = keyAndValue.indexOf(" ");
  if (spaceIdx === -1 || !keyAndValue.trim()) {
    return "[FAIL] Usage: /telegram group set <id> <key> <value>";
  }

  const rawKey = keyAndValue.substring(0, spaceIdx).trim();
  const rawValue = keyAndValue.substring(spaceIdx + 1).trim();

  // Detect +key / -key prefix for incremental array operations
  const ARRAY_KEYS = ["allowFrom", "groupAllowFrom", "skills"];
  const addMode = rawKey.startsWith("+");
  const removeMode = rawKey.startsWith("-") && !rawKey.startsWith("-1"); // avoid matching negative IDs
  const key = (addMode || removeMode) ? rawKey.slice(1) : rawKey;

  if (!rawValue) return `[FAIL] Missing value for key "${key}"`;

  if ((addMode || removeMode) && ARRAY_KEYS.includes(key)) {
    const items = rawValue.split(",").map((s: string) => s.trim()).filter(Boolean);
    const config = runtime.config.loadConfig();
    const existing: string[] =
      (config?.channels?.telegram?.groups?.[id]?.[key] ?? [])
        .map((v: unknown) => String(v));

    let updated: string[];
    if (addMode) {
      updated = [...new Set([...existing, ...items])];
    } else {
      const removeSet = new Set(items);
      updated = existing.filter((v: string) => !removeSet.has(v));
    }

    const jsonArray = JSON.stringify(updated);
    const result = await configSet(`channels.telegram.groups.${id}.${key}`, jsonArray);
    if (!result.ok) return `[FAIL] ${result.error}`;
    const op = addMode ? "Added" : "Removed";

    // Auto-enable requireMention + systemPrompt when adding a bot to allowFrom
    const extras: string[] = [];
    if (addMode && key === "allowFrom") {
      const pairedUsers = readAllowFromFile().allowFrom;
      const hasBotId = items.some((item: string) => !pairedUsers.includes(item));
      if (hasBotId) {
        const groupCfg = config?.channels?.telegram?.groups?.[id] ?? {};
        if (!groupCfg.requireMention) {
          await configSet(`channels.telegram.groups.${id}.requireMention`, "true");
          extras.push("  + requireMention: true");
        }
        if (!groupCfg.systemPrompt?.includes("@username")) {
          const prompt = groupCfg.systemPrompt
            ? `${groupCfg.systemPrompt}\n${BOT_TO_BOT_MENTION_PROMPT}`
            : BOT_TO_BOT_MENTION_PROMPT;
          await configSet(`channels.telegram.groups.${id}.systemPrompt`, prompt);
          extras.push(`  + systemPrompt: "${BOT_TO_BOT_MENTION_PROMPT}"`);
        }
      }
    }

    const extraInfo = extras.length > 0 ? `\n\nAuto-configured for bot-to-bot:\n${extras.join("\n")}` : "";
    return `[PASS] ${op} ${items.join(", ")} → ${key} = ${jsonArray}${extraInfo}\n\nRestart gateway to apply.`;
  }

  // Detect JSON array/object values — pass through to configSet (JSON5-aware)
  if (rawValue.startsWith("[") || rawValue.startsWith("{")) {
    const result = await configSet(`channels.telegram.groups.${id}.${key}`, rawValue);
    if (!result.ok) return `[FAIL] ${result.error}`;
    return `[PASS] Group ${id}: ${key} = ${rawValue}\n\nRestart gateway to apply.`;
  }

  // Detect comma-separated values for known array keys — auto-wrap as JSON array
  if (ARRAY_KEYS.includes(key) && !rawValue.startsWith("[")) {
    const items = rawValue.split(",").map((s: string) => s.trim()).filter(Boolean);
    const jsonArray = JSON.stringify(items);
    const result = await configSet(`channels.telegram.groups.${id}.${key}`, jsonArray);
    if (!result.ok) return `[FAIL] ${result.error}`;
    return `[PASS] Group ${id}: ${key} = ${jsonArray}\n\nRestart gateway to apply.`;
  }

  const result = await configSet(`channels.telegram.groups.${id}.${key}`, rawValue);
  if (!result.ok) {
    return `[FAIL] ${result.error}`;
  }

  return `[PASS] Group ${id}: ${key} = ${rawValue}\n\nRestart gateway to apply.`;
}

// ── Mention subcommands ──────────────────────────────────────

function handleMentionList(config: any): string {
  const patterns: string[] = config.messages?.groupChat?.mentionPatterns || [];

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

async function handleMentionAdd(pattern: string): Promise<string> {
  if (!pattern) return "[FAIL] Usage: /telegram mention add <regex>";

  try {
    new RegExp(pattern, "i");
  } catch (e: any) {
    return `[FAIL] Invalid regex: ${e.message}\n\nPattern: ${pattern}`;
  }

  try {
    const config = await runtime.config.loadConfig();
    config.messages ??= {};
    config.messages.groupChat ??= {};
    config.messages.groupChat.mentionPatterns ??= [];

    if (config.messages.groupChat.mentionPatterns.includes(pattern)) {
      return `[WARN] Pattern already exists: /${pattern}/`;
    }

    config.messages.groupChat.mentionPatterns.push(pattern);
    await runtime.config.writeConfigFile(config);
  } catch (e: any) {
    return `[FAIL] Config write failed: ${e.message}`;
  }

  return `[PASS] Pattern added: /${pattern}/\n\nRestart gateway to apply.`;
}

async function handleMentionRemove(target: string): Promise<string> {
  if (!target) return "[FAIL] Usage: /telegram mention remove <index|pattern>";

  try {
    const config = await runtime.config.loadConfig();
    const patterns: string[] = config.messages?.groupChat?.mentionPatterns || [];

    if (patterns.length === 0) {
      return "[FAIL] No patterns to remove.";
    }

    const idx = Number(target);
    if (!Number.isNaN(idx) && Number.isInteger(idx) && idx >= 0 && idx < patterns.length) {
      const removed = patterns.splice(idx, 1)[0];
      await runtime.config.writeConfigFile(config);
      return `[PASS] Removed pattern [${idx}]: /${removed}/\n\nRestart gateway to apply.`;
    }

    const strIdx = patterns.indexOf(target);
    if (strIdx !== -1) {
      patterns.splice(strIdx, 1);
      await runtime.config.writeConfigFile(config);
      return `[PASS] Removed pattern: /${target}/\n\nRestart gateway to apply.`;
    }

    return `[FAIL] Pattern not found: "${target}"\n\nUse /telegram mention list to see current patterns.`;
  } catch (e: any) {
    return `[FAIL] Config write failed: ${e.message}`;
  }
}

function handleMentionTest(text: string, config: any): string {
  if (!text) return "[FAIL] Usage: /telegram mention test <text>";

  const patterns: string[] = config.messages?.groupChat?.mentionPatterns || [];

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

// ── Chat ID subcommand ───────────────────────────────────────

function handleChatId(ctx: any): string {
  // ctx.to = "telegram:{chatId}" (most reliable for chat ID)
  // ctx.from = "telegram:{chatId}" (DM) or "telegram:group:{chatId}" or "telegram:group:{chatId}:topic:{threadId}" (group)
  const to = (ctx.to || "") as string;
  const chatId = to.replace(/^telegram:/, "");

  if (!chatId) {
    return [
      "[WARN] Could not detect chat ID from current context.",
      "",
      "Try sending this command in the group/channel you want to add.",
    ].join("\n");
  }

  const groups = ctx.config?.channels?.telegram?.groups;
  const isConfigured = groups?.[chatId];

  const lines: string[] = [
    `Chat ID: ${chatId}`,
  ];

  if (ctx.senderId) {
    lines.push(`Sender ID: ${ctx.senderId}`);
  }
  if (ctx.messageThreadId) {
    lines.push(`Thread/Topic ID: ${ctx.messageThreadId}`);
  }

  lines.push("");

  if (isConfigured) {
    lines.push("[OK] This chat is already in the allowlist.");
  } else {
    lines.push(
      "This chat is NOT in the allowlist.",
      "",
      "To add it, run:",
      `  /telegram group add ${chatId}`,
    );
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
    "",
    "Chat ID:",
    "  /telegram chatid                 — Show current chat/sender ID",
    "",
    "Group/channel management:",
    "  /telegram group                  — List configured groups",
    "  /telegram group add <id>         — Add a group config",
    "  /telegram group add <id> --bot-to-bot — Bot-to-bot (open policy)",
    "  /telegram group add <id> --bot-to-bot <id,...> — Bot-to-bot (allowlist + owner)",
    "  /telegram group join <id>        — Generate +allowFrom command with this bot's ID",
    "  /telegram group remove <id>      — Remove a group config",
    "  /telegram group show <id>        — Show group details",
    "  /telegram group set <id> <k> <v> — Set a per-group config key",
    "  /telegram group set <id> +<k> <v> — Append to array key",
    "  /telegram group set <id> -<k> <v> — Remove from array key",
    "    Array keys: allowFrom, groupAllowFrom, skills (comma-separated or JSON)",
    "",
    "Discipline (bot-to-bot loop prevention):",
    "  /telegram discipline <id> [threshold] — Enable discipline (default: 6)",
    "  /telegram discipline show [<id>]      — Show settings + current count",
    "  /telegram discipline off <id>         — Disable discipline",
    "",
    "Mention patterns:",
    "  /telegram mention                — List mention patterns",
    "  /telegram mention add <regex>    — Add a pattern",
    "  /telegram mention remove <i|pat> — Remove by index or pattern",
    "  /telegram mention test <text>    — Test text against patterns",
    "",
    "Telegram config:",
    "  Use /config show channels.telegram to view settings",
    "  Use /config set channels.telegram.<key> <value> to modify",
  ].join("\n");
}

// ── Discipline subcommands ───────────────────────────────────

function extractGroupIdFromHookCtx(event: any, ctx: any): string | undefined {
  if (ctx.channelId !== "telegram") return undefined;
  // conversationId / event.to format: "telegram:-1003645700926" (with prefix)
  const raw = String(ctx.conversationId ?? event.to ?? event.metadata?.to ?? "");
  const match = raw.match(/^(?:telegram:)?(-\d+)$/);
  return match?.[1];
}

async function handleDiscipline(channelId: string, threshold: number): Promise<string> {
  if (!channelId || !/^-\d+$/.test(channelId)) {
    return "[FAIL] Usage: /telegram discipline <channel-id> [threshold]";
  }

  const data = readDisciplineFile();
  data.groups[channelId] = { enabled: true, threshold };
  writeDisciplineFile(data);

  return [
    `[PASS] 已啟用 discipline (group: ${channelId}, threshold: ${threshold})`,
    `連續 ${threshold} 則 bot 訊息後自動停止回應。人類發言後重置。`,
    "每則 bot 訊息後會發送 discipline 狀態。",
  ].join("\n");
}

function handleDisciplineShow(channelId?: string): string {
  const data = readDisciplineFile();

  if (channelId) {
    const cfg = data.groups[channelId];
    if (!cfg) {
      return `[WARN] Discipline 未設定 (group: ${channelId})`;
    }
    const tracker = disciplineTracker.get(channelId);
    const count = tracker?.count ?? 0;
    const triggered = disciplineTriggered.has(channelId);
    const lines = [
      `Discipline 設定 (group: ${channelId}):`,
      `  enabled: ${cfg.enabled}`,
      `  threshold: ${cfg.threshold}`,
      `  current count: ${count}/${cfg.threshold}`,
    ];
    if (triggered) lines.push(`  status: ⚠️ TRIGGERED`);
    return lines.join("\n");
  }

  const entries = Object.entries(data.groups);
  if (entries.length === 0) {
    return "No discipline settings configured.";
  }

  const lines: string[] = [`Discipline 設定 (${entries.length} group(s)):`, ""];
  for (const [gid, cfg] of entries) {
    const tracker = disciplineTracker.get(gid);
    const count = tracker?.count ?? 0;
    const status = cfg.enabled ? "enabled" : "disabled";
    lines.push(`  ${gid}  [${status}, threshold: ${cfg.threshold}, count: ${count}/${cfg.threshold}]`);
  }
  return lines.join("\n");
}

async function handleDisciplineOff(channelId: string): Promise<string> {
  if (!channelId || !/^-\d+$/.test(channelId)) {
    return "[FAIL] Usage: /telegram discipline off <channel-id>";
  }

  const data = readDisciplineFile();
  if (!data.groups[channelId]) {
    return `[PASS] Discipline 未設定 (group: ${channelId})，無需停用。`;
  }

  delete data.groups[channelId];
  writeDisciplineFile(data);
  disciplineTracker.delete(channelId);
  disciplineTriggered.delete(channelId);

  return `[PASS] 已停用 discipline (group: ${channelId})`;
}

// ── Plugin registration ──────────────────────────────────────

export default function register(api: any) {
  runtime = api.runtime;

  api.registerCommand({
    name: "telegram",
    description: "Telegram management — /telegram webhook|pair|group|discipline|mention",
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
                text = handleWebhookStatus(ctx.config);
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
            const groupId = parts[2] || "";
            const groupRest = parts.slice(3).join(" ");
            switch (sub) {
              case "add":
                text = await handleGroupAdd(groupId, groupRest);
                break;
              case "remove":
                text = await handleGroupRemove(groupId);
                break;
              case "show":
                text = handleGroupShow(groupId, ctx.config);
                break;
              case "set":
                text = await handleGroupSet(groupId, groupRest);
                break;
              case "join":
                text = handleGroupJoin(groupId);
                break;
              case "list":
              case "":
                text = handleGroupList(ctx.config);
                break;
              default:
                // /telegram group <id> → shorthand for show
                text = handleGroupShow(sub, ctx.config);
            }
            break;
          }

          case "mention":
            switch (sub) {
              case "add":
                text = await handleMentionAdd(rest);
                break;
              case "remove":
                text = await handleMentionRemove(rest);
                break;
              case "test":
                text = handleMentionTest(rest, ctx.config);
                break;
              case "list":
              case "":
                text = handleMentionList(ctx.config);
                break;
              default:
                text = `Unknown mention subcommand: ${sub}\n\nUsage: /telegram mention [list|add|remove|test]`;
            }
            break;

          case "chatid":
            text = handleChatId(ctx);
            break;

          case "discipline": {
            // sub = first arg after "discipline"
            // /telegram discipline <channel-id> [threshold]
            // /telegram discipline show [<channel-id>]
            // /telegram discipline off <channel-id>
            if (sub === "show") {
              text = handleDisciplineShow(rest || undefined);
            } else if (sub === "off") {
              text = await handleDisciplineOff(rest);
            } else if (sub && /^-\d+$/.test(sub)) {
              const threshold = rest ? parseInt(rest, 10) : 6;
              if (Number.isNaN(threshold) || threshold < 1) {
                text = "[FAIL] Threshold must be a positive integer.";
              } else {
                text = await handleDiscipline(sub, threshold);
              }
            } else if (!sub) {
              text = handleDisciplineShow();
            } else {
              text = `Unknown discipline subcommand: ${sub}\n\nUsage:\n  /telegram discipline <channel-id> [threshold]\n  /telegram discipline show [<channel-id>]\n  /telegram discipline off <channel-id>`;
            }
            break;
          }

          case "config":
            text = [
              "The /telegram config subcommand has been removed.",
              "",
              "Use built-in config commands instead:",
              "  /config show channels.telegram",
              "  /config set channels.telegram.<key> <value>",
              "  /config unset channels.telegram.<key>",
            ].join("\n");
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

  // ── Discipline hooks ────────────────────────────────────────
  // Telegram streaming bypasses deliver.ts, so message_sending/message_sent
  // hooks never fire. We use message_received (which does fire) to track
  // consecutive bot messages. No messages are sent to the channel to avoid
  // polluting group history / AI context. On trigger, owner is notified via DM.

  api.on("message_received", async (event: any, ctx: any) => {
    const groupId = extractGroupIdFromHookCtx(event, ctx);
    if (!groupId) return;

    // Already triggered for this group — skip everything
    if (disciplineTriggered.has(groupId)) return;

    const monitorConfig = readDisciplineFile();
    const groupCfg = monitorConfig.groups?.[groupId];
    if (!groupCfg?.enabled) return;

    const senderId = String(event.metadata?.senderId ?? "");
    const pairedUsers = readAllowFromFile().allowFrom;

    if (pairedUsers.includes(senderId)) {
      disciplineTracker.delete(groupId);
      disciplineTriggered.delete(groupId);
      return;
    }

    // Bot message → increment
    const tracker = disciplineTracker.get(groupId) ?? { count: 0 };
    tracker.count++;
    disciplineTracker.set(groupId, tracker);

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const { count } = tracker;
    const { threshold } = groupCfg;

    if (count >= threshold) {
      // Mark as triggered to prevent re-entry
      disciplineTriggered.add(groupId);

      // Restrict allowFrom to humans only
      const config = runtime.config.loadConfig();
      const currentAllowFrom: string[] =
        (config?.channels?.telegram?.groups?.[groupId]?.allowFrom ?? []).map(String);
      const humanOnly = currentAllowFrom.filter((id: string) => pairedUsers.includes(id));
      const removedBotIds = currentAllowFrom.filter((id: string) => !pairedUsers.includes(id));

      await configSet(
        `channels.telegram.groups.${groupId}.allowFrom`,
        JSON.stringify(humanOnly),
      );

      // DM trigger notice to owner (paired users)
      if (token) {
        const restoreCmds = removedBotIds
          .map((id: string) => `/telegram group set ${groupId} +allowFrom ${id}`)
          .join("\n");
        const notice = [
          `⚠️ discipline: ${threshold}/${threshold} — 自律觸發，停止回應 (group: ${groupId})`,
          "",
          "恢復指令：",
          restoreCmds,
        ].join("\n");
        for (const userId of pairedUsers) {
          try {
            await telegramApi(token, "sendMessage", { chat_id: userId, text: notice });
          } catch {}
        }
      }

      // Immediate restart
      await restartGateway();
    }
  });
}
