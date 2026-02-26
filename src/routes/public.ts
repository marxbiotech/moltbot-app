import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT, TELEGRAM_WEBHOOK_PORT } from '../config';
import { timingSafeEqual } from '../utils/crypto';
import { findExistingMoltbotProcess, ensureMoltbotGateway } from '../gateway';

/**
 * Public routes - NO Cloudflare Access authentication required
 *
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltbot-sandbox',
    gateway_port: MOLTBOT_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Public health check for gateway status (no auth required)
publicRoutes.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const process = await findExistingMoltbotProcess(sandbox);
    if (!process) {
      return c.json({ ok: false, status: 'not_running' });
    }

    // Process exists, check if it's actually responding
    // Try to reach the gateway with a short timeout
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 5000 });
      return c.json({ ok: true, status: 'running', processId: process.id });
    } catch {
      return c.json({ ok: false, status: 'not_responding', processId: process.id });
    }
  } catch (err) {
    return c.json({
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

/** Send a ⚡️ reaction to acknowledge receipt before cold start / LLM processing. */
function sendAckReaction(botToken: string, chatId: number, messageId: number): Promise<void> {
  return fetch(`https://api.telegram.org/bot${botToken}/setMessageReaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: '⚡' }],
    }),
  }).then((res) => {
    if (!res.ok) console.error(`[TELEGRAM] ack reaction failed: ${res.status}`);
  }).catch((err) => {
    console.error('[TELEGRAM] ack reaction error:', err);
  });
}

/**
 * Fire-and-forget: if the chat is not in the configured group allowlist,
 * send a one-time hint message with the chat ID and add instructions.
 * Only triggers when groups config has entries (i.e. allowlist is active).
 * Uses a flag file in /tmp to deduplicate within a container lifetime.
 *
 * Note: sandbox.exec() is the Cloudflare Container API, not child_process.exec().
 * chatId is a number from Telegram's update payload — no injection risk.
 */
async function sendGroupAllowlistHint(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Sandbox type from @cloudflare/sandbox
  sandbox: any,
  botToken: string,
  chatId: number,
): Promise<void> {
  const flagFile = `/tmp/.tg-hint-${chatId}`;

  // Single exec: skip if already hinted, otherwise read config
  const result = await sandbox.exec(
    `test -f ${flagFile} && echo HINTED || cat /root/.openclaw/openclaw.json 2>/dev/null`,
    { timeout: 5000 },
  );

  const stdout = (result.stdout || '').trim();
  if (stdout === 'HINTED' || !stdout) return;

  let config: any;
  try {
    config = JSON.parse(stdout);
  } catch {
    return;
  }

  const groups = config.channels?.telegram?.groups;
  if (!groups || Object.keys(groups).length === 0) return;
  if (groups[String(chatId)] || groups['*']) return;

  // Mark as hinted before sending (dedup within container lifetime)
  await sandbox.exec(`touch ${flagFile}`);

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: [
        '⚠️ This group is not in the allowlist. Messages will be ignored.',
        '',
        `Chat ID: \`${chatId}\``,
        '',
        'To enable, ask the bot admin to run:',
        `\`/telegram group add ${chatId}\``,
      ].join('\n'),
      parse_mode: 'Markdown',
    }),
  });
}

// POST /telegram/webhook - Telegram webhook endpoint (secret-validated, no CF Access)
publicRoutes.post('/telegram/webhook', async (c) => {
  const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[TELEGRAM] TELEGRAM_WEBHOOK_SECRET not configured');
    return c.json({ error: 'Webhook not configured' }, 500);
  }

  const provided = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (!provided || !timingSafeEqual(provided, secret)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Buffer the body before returning — the request stream closes once we respond
  const body = await c.req.arrayBuffer();

  // Parse update for ack reaction and group allowlist hint
  const botToken = c.env.TELEGRAM_BOT_TOKEN;
  let chatId: number | undefined;
  let chatType: string | undefined;
  if (botToken) {
    try {
      const update = JSON.parse(new TextDecoder().decode(body));
      const msg = update.message || update.channel_post;
      if (msg?.chat?.id && msg?.message_id) {
        chatId = msg.chat.id;
        chatType = msg.chat.type;
        c.executionCtx.waitUntil(sendAckReaction(botToken, msg.chat.id, msg.message_id));
      }
    } catch {
      // Non-critical — don't block webhook processing if parsing fails
    }
  }

  // Fire-and-forget: start gateway + proxy in background so Telegram gets 200 immediately.
  // ensureMoltbotGateway can take 60-120s on cold start, exceeding Telegram's 60s timeout.
  const sandbox = c.get('sandbox');
  const gatewayReady = ensureMoltbotGateway(sandbox, c.env);

  c.executionCtx.waitUntil(
    gatewayReady.then(() =>
      sandbox.containerFetch(
        new Request(`http://localhost:${TELEGRAM_WEBHOOK_PORT}/telegram-webhook`, {
          method: 'POST',
          headers: c.req.raw.headers,
          body,
        }),
        TELEGRAM_WEBHOOK_PORT,
      )
    ).catch((err) => {
      console.error('[TELEGRAM] Webhook proxy failed:', err);
    })
  );

  // Fire-and-forget: hint unconfigured groups with their chat ID
  if (botToken && chatId && chatType && chatType !== 'private') {
    const hintChatId = chatId;
    c.executionCtx.waitUntil(
      gatewayReady.then(() =>
        sendGroupAllowlistHint(sandbox, botToken, hintChatId)
      ).catch((err) => {
        console.error('[TELEGRAM] Allowlist hint failed:', err);
      })
    );
  }

  return c.json({ ok: true });
});

export { publicRoutes };
