import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * slack-tools plugin — /slack
 *
 * Manage Slack channel pairing, per-channel config, and bot discipline.
 *
 * Config writes delegate to `openclaw config set/unset` CLI so schema
 * validation is handled by OpenClaw itself — no hardcoded type mappings.
 * Array operations use runtime.config.loadConfig to read current values.
 *
 * Subcommands:
 *   /slack                                 — show help
 *   /slack pair                            — list pending pairing requests
 *   /slack pair approve <code>             — approve a pairing request
 *   /slack channel                         — list configured channels
 *   /slack channel add|remove|set          — manage channel config
 *   /slack channel show <id>               — show channel details
 *   /slack channel join <id>               — generate +users command with this bot's ID
 *   /slack prompt [<id>]                   — view system prompt for channel
 *   /slack prompt [<id>] <text>            — set system prompt
 *   /slack prompt [<id>] --clear           — clear system prompt
 *   /slack chatid                          — show current channel/user ID
 *   /slack discipline <id> [threshold]     — enable bot loop prevention
 *   /slack discipline show [<id>]          — show settings + current count
 *   /slack discipline off <id>             — disable discipline
 */

const OPENCLAW_DIR = "/root/.openclaw";
const PAIRING_TTL_MS = 60 * 60 * 1000; // 60 minutes
const CLI_TIMEOUT_MS = 10_000;
const BOT_TO_BOT_MENTION_PROMPT = [
  "在群組中回應時，務必使用 @username 提及你正在對話的對象。",
  "",
  "## 對話狀態協議",
  "",
  "你參與的是一場多回合持續對話。為了在有限的訊息記憶中保持上下文連貫，你必須遵守以下協議：",
  "",
  "每則回覆的末尾附加 <conversation-state> 區塊，格式：",
  "",
  "<conversation-state>",
  "<turn>回合數</turn>",
  "<topic>當前主題（一句話）</topic>",
  "<key-points>",
  "- [發言者] 論點或結論（最多 5 條）",
  "</key-points>",
  "<pending>待回應的問題（可空）</pending>",
  "</conversation-state>",
  "",
  "規則：",
  "1. 先正常回覆，再在末尾附加狀態區塊",
  "2. 讀取前一則訊息的 <conversation-state> 作為上下文",
  "3. 更新 turn +1，更新 topic（如有變化），新增本輪 key-points，移除已解決的",
  "4. key-points 保留最近且最重要的 5 條",
  "5. 若前一則無狀態區塊，自行建立（turn 從 1 開始）",
  "6. 整個狀態區塊不超過 300 字",
].join("\n");

// Captured at plugin registration time; gives access to OpenClaw runtime APIs.
let runtime: any;

// ── Credential directory detection ───────────────────────────

function getCredDir(): string {
  const newer = `${OPENCLAW_DIR}/credentials`;
  if (existsSync(newer)) return newer;
  return `${OPENCLAW_DIR}/oauth`;
}

// ── Slack API helper ─────────────────────────────────────────

async function slackApi(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<any> {
  const url = `https://slack.com/api/${method}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const opts: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    };

    let resp: Response;
    try {
      resp = await fetch(url, opts);
    } catch (e: any) {
      if (e.name === "AbortError") {
        throw new Error(`Slack API ${method}: request timed out (10s)`);
      }
      throw new Error(`Slack API ${method}: network error: ${e.message}`);
    }

    const text = await resp.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Slack API ${method}: invalid JSON (HTTP ${resp.status}): ${text.slice(0, 200)}`);
    }

    if (!data.ok) {
      throw new Error(`Slack API ${method}: ${data.error || "unknown error"}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/** Best-effort Telegram notification to lifecycle chat (fire-and-forget) */
async function notifyTelegramLifecycle(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_LIFECYCLE_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_notification: true }),
    });
    if (!res.ok) console.warn(`[slack-tools] Telegram lifecycle notification failed: ${res.status}`);
  } catch {} // best-effort
}

// ── JSON file helpers (pairing, discipline, allowFrom) ───────

function readJsonFile(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    console.error(`[slack-tools] Failed to read ${path}: ${e.message}`);
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
  return `${getCredDir()}/slack-pairing.json`;
}

function getAllowFromFilePath(): string {
  return `${getCredDir()}/slack-allowFrom.json`;
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

interface DisciplineChannelConfig {
  enabled: boolean;
  threshold: number;
}

interface DisciplineFile {
  version: 1;
  channels: Record<string, DisciplineChannelConfig>;
}

const disciplineTracker: Map<string, { count: number }> = new Map();
const disciplineTriggered: Set<string> = new Set();

function getDisciplineFilePath(): string {
  return `${getCredDir()}/slack-discipline.json`;
}

function readDisciplineFile(): DisciplineFile {
  const data = readJsonFile(getDisciplineFilePath());
  if (data && data.version === 1 && data.channels) {
    return data;
  }
  return { version: 1, channels: {} };
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
    const displayName = req.meta?.display_name ? ` (${req.meta.display_name})` : "";
    const realName = req.meta?.real_name ? ` ${req.meta.real_name}` : "";

    lines.push(`  Code: ${req.code}`);
    lines.push(`  User: ${req.id}${realName}${displayName}`);
    lines.push(`  Created: ${ageMin}m ago (${created.toISOString()})`);
    lines.push(`  Last seen: ${lastSeen.toISOString()}`);
    lines.push("");
  }

  lines.push("Use /slack pair approve <code> to approve.");
  return lines.join("\n");
}

async function handlePairApprove(code: string): Promise<string> {
  if (!code) {
    return "[FAIL] Usage: /slack pair approve <code>";
  }

  const pairing = readPairingFile();
  const active = filterExpired(pairing.requests);
  const idx = active.findIndex((r) => r.code.toLowerCase() === code.toLowerCase());

  if (idx === -1) {
    return `[FAIL] No pending request with code "${code}". Use /slack pair to list requests.`;
  }

  const req = active[idx];
  const userId = req.id;
  const displayName = req.meta?.display_name ? ` (${req.meta.display_name})` : "";
  const realName = req.meta?.real_name ? ` ${req.meta.real_name}` : "";

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
    `[PASS] Approved user ${userId}${realName}${displayName}`,
    `[PASS] Added to allowFrom list`,
  ];

  // Try to notify user via Slack DM
  const token = process.env.SLACK_BOT_TOKEN;
  if (token) {
    try {
      await slackApi(token, "chat.postMessage", {
        channel: userId,
        text: "Your pairing request has been approved! You can now send messages.",
      });
      lines.push("[PASS] Sent approval notification to user");
    } catch (e: any) {
      lines.push(`[WARN] Could not notify user: ${e.message}`);
    }
  }

  return lines.join("\n");
}

// ── Channel subcommands ──────────────────────────────────────

function handleChannelList(config: any): string {
  const channels: Record<string, any> | undefined = config.channels?.slack?.channels;

  if (!channels || Object.keys(channels).length === 0) {
    return "No channels configured.\n\nUse /slack channel add <id> to add one.";
  }

  const lines: string[] = [`Configured channels (${Object.keys(channels).length}):`, ""];

  for (const [id, cfg] of Object.entries(channels)) {
    const c = cfg as Record<string, unknown>;
    const flags: string[] = [];
    if (c.enabled === true) flags.push("enabled");
    if (c.enabled === false) flags.push("disabled");
    if (c.requireMention === false) flags.push("no-mention");
    if (c.requireMention === true) flags.push("mention-required");
    if (c.allowBots === true) flags.push("allow-bots");
    if (c.systemPrompt) flags.push("has-prompt");
    if (Array.isArray(c.users) && c.users.length > 0)
      flags.push(`${c.users.length} user(s)`);

    lines.push(`  ${id}  [${flags.join(", ") || "default"}]`);
  }

  lines.push("");
  lines.push("Use /slack channel show <id> for details.");
  return lines.join("\n");
}

async function handleChannelAdd(id: string, flags: string): Promise<string> {
  if (!id) return "[FAIL] Usage: /slack channel add <id> [--bot-to-bot [<other-bot-id,...>]]";

  const isBotToBot = flags.includes("--bot-to-bot");

  if (isBotToBot) {
    // Extract comma-separated bot user IDs (e.g. "--bot-to-bot U123,U456")
    const botIdRaw = flags.replace("--bot-to-bot", "").trim();
    const botIds = botIdRaw
      ? botIdRaw.split(",").map((s: string) => s.trim()).filter(Boolean)
      : [];

    // Auto-include paired DM users (owners) so they can also interact in the channel
    const pairedUsers = readAllowFromFile().allowFrom;
    for (const uid of pairedUsers) {
      botIds.push(uid);
    }

    // Deduplicate
    const allIds = [...new Set(botIds)];

    const prefix = `channels.slack.channels.${id}`;
    const sets: Array<[string, string]> = [
      [`${prefix}.enabled`, "true"],
      [`${prefix}.requireMention`, "true"],
      [`${prefix}.allowBots`, "true"],
      [`${prefix}.systemPrompt`, BOT_TO_BOT_MENTION_PROMPT],
    ];
    if (allIds.length > 0) {
      sets.push([`${prefix}.users`, JSON.stringify(allIds)]);
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
      `[PASS] Channel ${id} added with bot-to-bot defaults:`,
      "  enabled: true",
      "  requireMention: true",
      "  allowBots: true",
      `  systemPrompt: "${BOT_TO_BOT_MENTION_PROMPT}"`,
    ];
    if (allIds.length > 0) {
      lines.push(`  users: [${allIds.join(", ")}]`);
    }
    lines.push(
      "",
      "Tip: invite both bots to the channel in Slack.",
      "",
      "Restart gateway to apply.",
    );
    return lines.join("\n");
  }

  const result = await configSet(`channels.slack.channels.${id}.enabled`, "true");
  if (!result.ok) {
    return `[FAIL] Config write failed: ${result.error}`;
  }

  return `[PASS] Channel ${id} added\n\nRestart gateway to apply.`;
}

async function handleChannelRemove(id: string): Promise<string> {
  if (!id) return "[FAIL] Usage: /slack channel remove <id>";

  const result = await configUnset(`channels.slack.channels.${id}`);
  if (!result.ok) {
    return `[FAIL] Config write failed: ${result.error}`;
  }

  return `[PASS] Channel ${id} removed\n\nRestart gateway to apply.`;
}

async function handleChannelJoin(id: string): Promise<string> {
  if (!id) return "[FAIL] Usage: /slack channel join <channel-id>";

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return "[FAIL] SLACK_BOT_TOKEN is not set";

  try {
    const authInfo = await slackApi(token, "auth.test");
    const botUserId = authInfo.user_id;

    const cmd = `/slack channel set ${id} +users ${botUserId}`;
    const lines = [
      "Copy this command and run it on the OTHER bot's OpenClaw,",
      "so that bot can see this bot's messages in the channel:",
      "",
      cmd,
      "",
      `This bot's user ID: ${botUserId}`,
    ];
    return lines.join("\n");
  } catch (e: any) {
    return `[FAIL] Could not get bot user ID: ${e.message}`;
  }
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

function extractChannelIdFromContext(ctx: any): string | undefined {
  // ctx.to = "channel:C12345" (channel) or "user:U12345" (DM)
  // ctx.from = "slack:channel:C12345" | "slack:group:C12345" | "slack:U12345" (DM)
  const to = (ctx.to || "") as string;
  const toMatch = to.match(/^channel:(C[A-Z0-9]+)$/i);
  if (toMatch) return toMatch[1];

  const from = (ctx.from || "") as string;
  const fromMatch = from.match(/^slack:(?:channel:|group:)?(C[A-Z0-9]+)/i);
  return fromMatch?.[1];
}

function handleChannelShow(id: string, config: any): string {
  if (!id) return "[FAIL] Usage: /slack channel show <id>";

  const channels = config.channels?.slack?.channels;
  if (!channels?.[id]) {
    return `[FAIL] Channel ${id} not found. Use /slack channel list to see configured channels.`;
  }

  const cfg = channels[id];
  const lines: string[] = [`Channel: ${id}`, ""];

  const knownKeys = [
    "enabled",
    "allow",
    "requireMention",
    "allowBots",
    "users",
    "skills",
    "systemPrompt",
    "tools",
    "toolsBySender",
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

async function handleChannelSet(id: string, keyAndValue: string): Promise<string> {
  if (!id) return "[FAIL] Usage: /slack channel set <id> <key> <value>";

  const spaceIdx = keyAndValue.indexOf(" ");
  if (spaceIdx === -1 || !keyAndValue.trim()) {
    return "[FAIL] Usage: /slack channel set <id> <key> <value>";
  }

  const rawKey = keyAndValue.substring(0, spaceIdx).trim();
  const rawValue = keyAndValue.substring(spaceIdx + 1).trim();

  // Detect +key / -key prefix for incremental array operations
  const ARRAY_KEYS = ["users", "skills"];
  const addMode = rawKey.startsWith("+");
  const removeMode = rawKey.startsWith("-") && !rawKey.startsWith("-1");
  const key = (addMode || removeMode) ? rawKey.slice(1) : rawKey;

  if (!rawValue) return `[FAIL] Missing value for key "${key}"`;

  if ((addMode || removeMode) && ARRAY_KEYS.includes(key)) {
    const items = rawValue.split(",").map((s: string) => s.trim()).filter(Boolean);
    const config = runtime.config.loadConfig();
    const existing: string[] =
      (config?.channels?.slack?.channels?.[id]?.[key] ?? [])
        .map((v: unknown) => String(v));

    let updated: string[];
    if (addMode) {
      updated = [...new Set([...existing, ...items])];
    } else {
      const removeSet = new Set(items);
      updated = existing.filter((v: string) => !removeSet.has(v));
    }

    const jsonArray = JSON.stringify(updated);
    const result = await configSet(`channels.slack.channels.${id}.${key}`, jsonArray);
    if (!result.ok) return `[FAIL] ${result.error}`;
    const op = addMode ? "Added" : "Removed";

    // Auto-enable allowBots + requireMention + systemPrompt when adding a bot to users
    const extras: string[] = [];
    if (addMode && key === "users") {
      const pairedUsers = readAllowFromFile().allowFrom;
      const hasBotId = items.some((item: string) => !pairedUsers.includes(item));
      if (hasBotId) {
        // Reset discipline state so threshold re-arms for new conversation
        disciplineTracker.delete(id);
        disciplineTriggered.delete(id);

        const channelCfg = config?.channels?.slack?.channels?.[id] ?? {};
        if (!channelCfg.allowBots) {
          const r = await configSet(`channels.slack.channels.${id}.allowBots`, "true");
          if (r.ok) extras.push("  + allowBots: true");
          else { extras.push(`  ✗ allowBots: ${r.error}`); await notifyTelegramLifecycle(`⚠️ [slack] auto-config failed (channel: ${id}): allowBots — ${r.error}`); }
        }
        if (!channelCfg.requireMention) {
          const r = await configSet(`channels.slack.channels.${id}.requireMention`, "true");
          if (r.ok) extras.push("  + requireMention: true");
          else { extras.push(`  ✗ requireMention: ${r.error}`); await notifyTelegramLifecycle(`⚠️ [slack] auto-config failed (channel: ${id}): requireMention — ${r.error}`); }
        }
        if (!channelCfg.systemPrompt?.includes("conversation-state")) {
          const prompt = channelCfg.systemPrompt
            ? `${channelCfg.systemPrompt}\n${BOT_TO_BOT_MENTION_PROMPT}`
            : BOT_TO_BOT_MENTION_PROMPT;
          const r = await configSet(`channels.slack.channels.${id}.systemPrompt`, prompt);
          if (r.ok) extras.push(`  + systemPrompt: "${BOT_TO_BOT_MENTION_PROMPT}"`);
          else { extras.push(`  ✗ systemPrompt: ${r.error}`); await notifyTelegramLifecycle(`⚠️ [slack] auto-config failed (channel: ${id}): systemPrompt — ${r.error}`); }
        }
      }
    }

    const extraInfo = extras.length > 0 ? `\n\nAuto-configured for bot-to-bot:\n${extras.join("\n")}` : "";
    return `[PASS] ${op} ${items.join(", ")} → ${key} = ${jsonArray}${extraInfo}\n\nRestart gateway to apply.`;
  }

  // Detect JSON array/object values — pass through to configSet
  if (rawValue.startsWith("[") || rawValue.startsWith("{")) {
    const result = await configSet(`channels.slack.channels.${id}.${key}`, rawValue);
    if (!result.ok) return `[FAIL] ${result.error}`;
    return `[PASS] Channel ${id}: ${key} = ${rawValue}\n\nRestart gateway to apply.`;
  }

  // Detect comma-separated values for known array keys — auto-wrap as JSON array
  if (ARRAY_KEYS.includes(key) && !rawValue.startsWith("[")) {
    const items = rawValue.split(",").map((s: string) => s.trim()).filter(Boolean);
    const jsonArray = JSON.stringify(items);
    const result = await configSet(`channels.slack.channels.${id}.${key}`, jsonArray);
    if (!result.ok) return `[FAIL] ${result.error}`;
    return `[PASS] Channel ${id}: ${key} = ${jsonArray}\n\nRestart gateway to apply.`;
  }

  const result = await configSet(`channels.slack.channels.${id}.${key}`, rawValue);
  if (!result.ok) {
    return `[FAIL] ${result.error}`;
  }

  return `[PASS] Channel ${id}: ${key} = ${rawValue}\n\nRestart gateway to apply.`;
}

// ── Prompt subcommands ───────────────────────────────────────

function handlePromptShow(channelId: string, config: any): string {
  const prompt = config.channels?.slack?.channels?.[channelId]?.systemPrompt;

  if (!prompt) {
    return `Channel ${channelId}: no system prompt set.\n\nUse /slack prompt ${channelId} <text> to set one.`;
  }

  return [
    `Channel ${channelId} system prompt:`,
    "---",
    prompt,
    "---",
    `(${prompt.length} chars)`,
  ].join("\n");
}

async function handlePromptSet(channelId: string, promptText: string): Promise<string> {
  const result = await configSet(`channels.slack.channels.${channelId}.systemPrompt`, promptText);
  if (!result.ok) {
    return `[FAIL] ${result.error}`;
  }

  const preview = promptText.length > 200 ? promptText.substring(0, 200) + "..." : promptText;
  return [
    `[PASS] Channel ${channelId}: systemPrompt updated (${promptText.length} chars)`,
    "",
    preview,
    "",
    "Restart gateway to apply.",
  ].join("\n");
}

async function handlePromptClear(channelId: string): Promise<string> {
  const result = await configUnset(`channels.slack.channels.${channelId}.systemPrompt`);
  if (!result.ok) {
    return `[FAIL] ${result.error}`;
  }

  return `[PASS] Channel ${channelId}: systemPrompt cleared\n\nRestart gateway to apply.`;
}

// ── Chat ID subcommand ───────────────────────────────────────

function handleChatId(ctx: any): string {
  // ctx.to = "channel:C12345" (channel) | "user:U12345" (DM)
  // ctx.from = "slack:channel:C12345" | "slack:group:C12345" | "slack:U12345"
  const to = (ctx.to || "") as string;
  const from = (ctx.from || "") as string;

  const lines: string[] = [];

  // Extract channel ID from ctx.to
  const channelMatch = to.match(/^channel:(C[A-Z0-9]+)$/i);
  const userMatch = to.match(/^user:(U[A-Z0-9]+)$/i);
  const channelId = channelMatch?.[1];

  if (channelId) {
    lines.push(`Channel ID: ${channelId}`);
  } else if (userMatch) {
    lines.push(`DM with user: ${userMatch[1]}`);
  } else if (to) {
    lines.push(`To: ${to}`);
  }

  if (from && from !== to) {
    lines.push(`From: ${from}`);
  }
  if (ctx.senderId) {
    lines.push(`Sender ID: ${ctx.senderId}`);
  }
  if (ctx.messageThreadId) {
    lines.push(`Thread TS: ${ctx.messageThreadId}`);
  }

  if (lines.length === 0) {
    return [
      "[WARN] Could not detect IDs from current context.",
      "",
      "Try sending this command in the Slack channel you want to add.",
    ].join("\n");
  }

  lines.push("");

  if (channelId) {
    const channels = ctx.config?.channels?.slack?.channels;
    const isConfigured = channels?.[channelId];
    if (isConfigured) {
      lines.push("[OK] This channel is already configured.");
    } else {
      lines.push(
        "This channel is NOT configured.",
        "",
        "To add it, run:",
        `  /slack channel add ${channelId}`,
      );
    }
  }

  return lines.join("\n");
}

// ── Help text ────────────────────────────────────────────────

function showHelp(): string {
  return [
    "Usage: /slack <subcommand>",
    "",
    "Pairing management:",
    "  /slack pair                     — List pending pairing requests",
    "  /slack pair list                — Same as above",
    "  /slack pair approve <code>      — Approve a pairing request",
    "",
    "Chat ID:",
    "  /slack chatid                   — Show current channel/sender ID",
    "",
    "System prompt:",
    "  /slack prompt [<id>]            — View system prompt (auto-detect channel if omitted)",
    "  /slack prompt [<id>] <text>     — Set system prompt",
    "  /slack prompt [<id>] --clear    — Clear system prompt",
    "",
    "Channel management:",
    "  /slack channel                  — List configured channels",
    "  /slack channel add <id>         — Add a channel config",
    "  /slack channel add <id> --bot-to-bot — Bot-to-bot (with allowBots)",
    "  /slack channel add <id> --bot-to-bot <id,...> — Bot-to-bot (users allowlist)",
    "  /slack channel join <id>        — Generate +users command with this bot's ID",
    "  /slack channel remove <id>      — Remove a channel config",
    "  /slack channel show <id>        — Show channel details",
    "  /slack channel set <id> <k> <v> — Set a per-channel config key",
    "  /slack channel set <id> +<k> <v> — Append to array key",
    "  /slack channel set <id> -<k> <v> — Remove from array key",
    "    Array keys: users, skills (comma-separated or JSON)",
    "",
    "Discipline (bot-to-bot loop prevention):",
    "  /slack discipline <id> [threshold] — Enable discipline (default: 6)",
    "  /slack discipline show [<id>]      — Show settings + current count",
    "  /slack discipline off <id>         — Disable discipline",
    "",
    "Slack config:",
    "  Use /config show channels.slack to view settings",
    "  Use /config set channels.slack.<key> <value> to modify",
  ].join("\n");
}

// ── Discipline subcommands ───────────────────────────────────

function extractChannelIdFromHookCtx(event: any, ctx: any): string | undefined {
  if (ctx.channelId !== "slack") return undefined;
  // conversationId: "slack:channel:C12345" | event.to: "channel:C12345"
  const raw = String(ctx.conversationId ?? event.to ?? event.metadata?.to ?? "");
  const match = raw.match(/(?:slack:)?(?:channel:|group:)?(C[A-Z0-9]+)/i);
  return match?.[1];
}

async function handleDiscipline(channelId: string, threshold: number): Promise<string> {
  if (!channelId || !/^C[A-Z0-9]+$/i.test(channelId)) {
    return "[FAIL] Usage: /slack discipline <channel-id> [threshold]";
  }

  const data = readDisciplineFile();
  data.channels[channelId] = { enabled: true, threshold };
  writeDisciplineFile(data);

  return [
    `[PASS] 已啟用 discipline (channel: ${channelId}, threshold: ${threshold})`,
    `連續 ${threshold} 則 bot 訊息後自動停止回應。人類發言後重置。`,
    "每則 bot 訊息後會發送 discipline 狀態。",
  ].join("\n");
}

function handleDisciplineShow(channelId?: string): string {
  const data = readDisciplineFile();

  if (channelId) {
    const cfg = data.channels[channelId];
    if (!cfg) {
      return `[WARN] Discipline 未設定 (channel: ${channelId})`;
    }
    const tracker = disciplineTracker.get(channelId);
    const count = tracker?.count ?? 0;
    const triggered = disciplineTriggered.has(channelId);
    const lines = [
      `Discipline 設定 (channel: ${channelId}):`,
      `  enabled: ${cfg.enabled}`,
      `  threshold: ${cfg.threshold}`,
      `  current count: ${count}/${cfg.threshold}`,
    ];
    if (triggered) lines.push(`  status: TRIGGERED`);
    return lines.join("\n");
  }

  const entries = Object.entries(data.channels);
  if (entries.length === 0) {
    return "No discipline settings configured.";
  }

  const lines: string[] = [`Discipline 設定 (${entries.length} channel(s)):`, ""];
  for (const [cid, cfg] of entries) {
    const tracker = disciplineTracker.get(cid);
    const count = tracker?.count ?? 0;
    const status = cfg.enabled ? "enabled" : "disabled";
    lines.push(`  ${cid}  [${status}, threshold: ${cfg.threshold}, count: ${count}/${cfg.threshold}]`);
  }
  return lines.join("\n");
}

async function handleDisciplineOff(channelId: string): Promise<string> {
  if (!channelId || !/^C[A-Z0-9]+$/i.test(channelId)) {
    return "[FAIL] Usage: /slack discipline off <channel-id>";
  }

  const data = readDisciplineFile();
  if (!data.channels[channelId]) {
    return `[PASS] Discipline 未設定 (channel: ${channelId})，無需停用。`;
  }

  delete data.channels[channelId];
  writeDisciplineFile(data);
  disciplineTracker.delete(channelId);
  disciplineTriggered.delete(channelId);

  return `[PASS] 已停用 discipline (channel: ${channelId})`;
}

// ── Plugin registration ──────────────────────────────────────

export default function register(api: any) {
  runtime = api.runtime;

  api.registerCommand({
    name: "slack",
    description: "Slack management — /slack pair|channel|prompt|chatid|discipline",
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
                text = `Unknown pair subcommand: ${sub}\n\nUsage: /slack pair [list|approve <code>]`;
            }
            break;

          case "channel": {
            const channelId = parts[2] || "";
            const channelRest = parts.slice(3).join(" ");
            switch (sub) {
              case "add":
                text = await handleChannelAdd(channelId, channelRest);
                break;
              case "remove":
                text = await handleChannelRemove(channelId);
                break;
              case "show":
                text = handleChannelShow(channelId, ctx.config);
                break;
              case "set":
                text = await handleChannelSet(channelId, channelRest);
                break;
              case "join":
                text = await handleChannelJoin(channelId);
                break;
              case "list":
              case "":
                text = handleChannelList(ctx.config);
                break;
              default:
                // /slack channel <id> → shorthand for show
                text = handleChannelShow(sub, ctx.config);
            }
            break;
          }

          case "chatid":
            text = handleChatId(ctx);
            break;

          case "prompt": {
            // /slack prompt [<id>] [--clear | <text>]
            // Auto-detect channel if first arg is not a channel ID
            let promptChannelId: string | undefined;
            let promptText: string;

            if (sub && /^C[A-Z0-9]+$/i.test(sub)) {
              // Explicit channel ID — extract text from raw args preserving newlines
              promptChannelId = sub;
              const idEndIdx = args.indexOf(sub) + sub.length;
              promptText = args.substring(idEndIdx).trim();
            } else {
              // Auto-detect from context
              promptChannelId = extractChannelIdFromContext(ctx);
              if (!promptChannelId) {
                text = "[FAIL] Usage: /slack prompt [<channel-id>] [--clear | <text>]\n\nUse /slack chatid to find the channel ID.";
                break;
              }
              // Everything after "prompt" is the text
              const promptIdx = args.indexOf("prompt") + "prompt".length;
              promptText = args.substring(promptIdx).trim();
            }

            if (!promptText) {
              text = handlePromptShow(promptChannelId, ctx.config);
            } else if (promptText === "--clear") {
              text = await handlePromptClear(promptChannelId);
            } else {
              text = await handlePromptSet(promptChannelId, promptText);
            }
            break;
          }

          case "discipline": {
            // sub = first arg after "discipline"
            // /slack discipline <channel-id> [threshold]
            // /slack discipline show [<channel-id>]
            // /slack discipline off <channel-id>
            if (sub === "show") {
              text = handleDisciplineShow(rest || undefined);
            } else if (sub === "off") {
              text = await handleDisciplineOff(rest);
            } else if (sub && /^C[A-Z0-9]+$/i.test(sub)) {
              const threshold = rest ? parseInt(rest, 10) : 6;
              if (Number.isNaN(threshold) || threshold < 1) {
                text = "[FAIL] Threshold must be a positive integer.";
              } else {
                text = await handleDiscipline(sub, threshold);
              }
            } else if (!sub) {
              text = handleDisciplineShow();
            } else {
              text = `Unknown discipline subcommand: ${sub}\n\nUsage:\n  /slack discipline <channel-id> [threshold]\n  /slack discipline show [<channel-id>]\n  /slack discipline off <channel-id>`;
            }
            break;
          }

          case "config":
            text = [
              "The /slack config subcommand is not available.",
              "",
              "Use built-in config commands instead:",
              "  /config show channels.slack",
              "  /config set channels.slack.<key> <value>",
              "  /config unset channels.slack.<key>",
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
        console.error("[slack-tools] Unexpected error:", e);
        return { text: `[FAIL] Unexpected error: ${e.message}` };
      }
    },
  });

  // ── Discipline hooks ────────────────────────────────────────
  // Track consecutive bot messages in Slack channels. When threshold is
  // reached, set allowBots=false to stop the loop and notify paired users.

  api.on("message_received", async (event: any, ctx: any) => {
    const channelId = extractChannelIdFromHookCtx(event, ctx);
    if (!channelId) return;

    // Already triggered for this channel — skip everything
    if (disciplineTriggered.has(channelId)) return;

    const monitorConfig = readDisciplineFile();
    const channelCfg = monitorConfig.channels?.[channelId];
    if (!channelCfg?.enabled) return;

    const senderId = String(event.metadata?.senderId ?? "");
    const pairedUsers = readAllowFromFile().allowFrom;

    if (pairedUsers.includes(senderId)) {
      disciplineTracker.delete(channelId);
      disciplineTriggered.delete(channelId);
      return;
    }

    // Bot message → increment
    const tracker = disciplineTracker.get(channelId) ?? { count: 0 };
    tracker.count++;
    disciplineTracker.set(channelId, tracker);

    const token = process.env.SLACK_BOT_TOKEN;
    const { count } = tracker;
    const { threshold } = channelCfg;

    if (count >= threshold) {
      // Mark as triggered to prevent re-entry
      disciplineTriggered.add(channelId);

      // Disable allowBots to stop bot-to-bot loop
      const setResult = await configSet(`channels.slack.channels.${channelId}.allowBots`, "false");
      if (!setResult.ok) {
        console.error(`[slack-tools] discipline: configSet failed: ${setResult.error}`);
        await notifyTelegramLifecycle(`⚠️ [slack] discipline configSet failed (channel: ${channelId}): ${setResult.error}`);
      }

      // DM trigger notice to owner (paired users)
      if (token) {
        const restoreCmd = `/slack channel set ${channelId} allowBots true`;
        const notice = [
          `discipline: ${threshold}/${threshold} — 自律觸發，停止回應 (channel: ${channelId})`,
          "",
          "恢復指令：",
          restoreCmd,
        ].join("\n");

        for (const userId of pairedUsers) {
          try {
            await slackApi(token, "chat.postMessage", { channel: userId, text: notice });
          } catch {} // Design Decision: best-effort notification — discipline core action (disable allowBots + restart) must not be blocked by notification failure
        }
      }

      // Immediate restart
      const restartResult = await restartGateway();
      if (!restartResult.ok) {
        console.error(`[slack-tools] discipline: restartGateway failed: ${restartResult.error}`);
        await notifyTelegramLifecycle(`⚠️ [slack] discipline restartGateway failed (channel: ${channelId}): ${restartResult.error}`);
      }
    }
  });
}
