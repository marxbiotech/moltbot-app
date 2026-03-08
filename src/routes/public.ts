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

/** Send a ⚡️ reaction to acknowledge receipt before processing. */
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
  const bodyString = await c.req.text();

  // Parse update for ack reaction and group allowlist hint
  const botToken = c.env.TELEGRAM_BOT_TOKEN;
  let chatId: number | undefined;
  let chatType: string | undefined;
  if (botToken) {
    try {
      const update = JSON.parse(bodyString);
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

  const sandbox = c.get('sandbox');

  // Headers for queue messages (serializable subset)
  const queueHeaders: Record<string, string> = {
    'content-type': c.req.header('content-type') || 'application/json',
  };
  const webhookSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (webhookSecret) {
    queueHeaders['X-Telegram-Bot-Api-Secret-Token'] = webhookSecret;
  }

  // Determine container state: cold / warming / hot
  let existingProcess = null;
  try {
    existingProcess = await findExistingMoltbotProcess(sandbox);
  } catch (err) {
    console.error('[TELEGRAM] Failed to check process state, treating as cold:', err);
  }
  let isHot = false;
  if (existingProcess?.status === 'running') {
    try {
      await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: 2_000 });
      isHot = true;
    } catch {
      // Process exists but port not ready — still booting
    }
  }
  const isCold = !existingProcess;

  // WEBHOOK_QUEUE (new) → TELEGRAM_QUEUE (deprecated) → fire-and-forget
  const telegramQueue = c.env.WEBHOOK_QUEUE ?? c.env.TELEGRAM_QUEUE;
  if (telegramQueue) {
    // All messages go through queue for at-least-once delivery.
    // Delay based on state to avoid wasting retries during cold start.
    const delaySeconds = isHot ? 0 : 180;
    console.log(`[TELEGRAM] Enqueuing (${isCold ? 'cold' : isHot ? 'hot' : 'warming'}, delay=${delaySeconds}s)`);
    c.executionCtx.waitUntil(
      telegramQueue.send(
        { source: 'telegram', body: bodyString, headers: queueHeaders },
        { delaySeconds },
      ).catch((err) => {
        console.error('[TELEGRAM] Queue send failed:', err);
      })
    );
  } else {
    // Fallback: no queue configured, use fire-and-forget (old behavior)
    console.warn('[TELEGRAM] No queue configured, falling back to fire-and-forget');
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env).then(() =>
        sandbox.containerFetch(
          new Request(`http://localhost:${TELEGRAM_WEBHOOK_PORT}/telegram-webhook`, {
            method: 'POST',
            headers: c.req.raw.headers,
            body: bodyString,
          }),
          TELEGRAM_WEBHOOK_PORT,
        )
      ).catch((err) => {
        console.error('[TELEGRAM] Webhook proxy failed:', err);
      })
    );
  }

  // Cold or warming: notify owner + trigger container startup
  if (!isHot) {
    const lifecycleChatId = c.env.TELEGRAM_LIFECYCLE_CHAT_ID;
    if (botToken && lifecycleChatId) {
      const text = isCold ? '\u{23F3} 開機中\u{2026}' : '\u{23F3} 開機中\u{2026}\u{2026}';
      c.executionCtx.waitUntil(
        fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: lifecycleChatId, text }),
        }).catch((err) => {
          console.error('[TELEGRAM] Lifecycle notification failed:', err);
        })
      );
    }

    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env).catch((err) => {
        console.error('[TELEGRAM] Gateway startup failed:', err);
      })
    );
  }

  // Group allowlist hint (only when gateway is reachable)
  if (isHot && botToken && chatId && chatType && chatType !== 'private') {
    const hintChatId = chatId;
    c.executionCtx.waitUntil(
      sendGroupAllowlistHint(sandbox, botToken, hintChatId).catch((err) => {
        console.error('[TELEGRAM] Allowlist hint failed:', err);
      })
    );
  }

  return c.json({ ok: true });
});

// POST /slack/events - Slack Events API webhook endpoint (no CF Access)
// Signing verification is handled by OpenClaw's @slack/bolt HTTPReceiver inside the container.
// Worker's job: proxy to container gateway port 18789, handle cold start via queue.
publicRoutes.post('/slack/events', async (c) => {
  if (!c.env.SLACK_SIGNING_SECRET) {
    console.error('[SLACK] SLACK_SIGNING_SECRET not configured');
    return c.json({ error: 'Slack webhook not configured' }, 500);
  }

  // Buffer body before any async work — request stream closes once we respond
  const bodyString = await c.req.text();

  // Handle url_verification challenge directly (works even during cold start).
  // This only happens once when setting the Request URL in Slack admin.
  try {
    const payload = JSON.parse(bodyString);
    if (payload.type === 'url_verification') {
      console.log('[SLACK] url_verification challenge received');
      return c.json({ challenge: payload.challenge });
    }
  } catch {
    // Not JSON — continue with proxy
  }

  const sandbox = c.get('sandbox');

  // Serializable headers for queue messages
  const queueHeaders: Record<string, string> = {
    'content-type': c.req.header('content-type') || 'application/json',
  };
  // Slack signing headers — required by Bolt's HTTPReceiver for HMAC verification
  const slackTimestamp = c.req.header('X-Slack-Request-Timestamp');
  const slackSignature = c.req.header('X-Slack-Signature');
  if (slackTimestamp) queueHeaders['X-Slack-Request-Timestamp'] = slackTimestamp;
  if (slackSignature) queueHeaders['X-Slack-Signature'] = slackSignature;

  // Determine container state: cold / warming / hot
  let existingProcess = null;
  try {
    existingProcess = await findExistingMoltbotProcess(sandbox);
  } catch (err) {
    console.error('[SLACK] Failed to check process state, treating as cold:', err);
  }
  let isHot = false;
  if (existingProcess?.status === 'running') {
    try {
      await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: 2_000 });
      isHot = true;
    } catch {
      // Process exists but port not ready — still booting
    }
  }
  const isCold = !existingProcess;

  if (c.env.WEBHOOK_QUEUE) {
    // Queue mode: at-least-once delivery with delay for cold containers.
    // Slack retries events that don't get a 200 within 3s, but the queue
    // gives us control over delivery timing during cold starts.
    const delaySeconds = isHot ? 0 : 180;
    console.log(`[SLACK] Enqueuing (${isCold ? 'cold' : isHot ? 'hot' : 'warming'}, delay=${delaySeconds}s)`);
    c.executionCtx.waitUntil(
      c.env.WEBHOOK_QUEUE.send(
        { source: 'slack', body: bodyString, headers: queueHeaders },
        { delaySeconds },
      ).catch((err) => {
        console.error('[SLACK] Queue send failed:', err);
      })
    );
  } else {
    // No queue: fire-and-forget proxy (old behavior)
    console.warn('[SLACK] WEBHOOK_QUEUE not configured, falling back to fire-and-forget');
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env).then(() =>
        sandbox.containerFetch(
          new Request(`http://localhost:${MOLTBOT_PORT}/slack/events`, {
            method: 'POST',
            headers: queueHeaders,
            body: bodyString,
          }),
          MOLTBOT_PORT,
        )
      ).catch((err) => {
        console.error('[SLACK] Webhook proxy failed:', err);
      })
    );
  }

  // Cold or warming: trigger container startup
  if (!isHot) {
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env).catch((err) => {
        console.error('[SLACK] Gateway startup failed:', err);
      })
    );
  }

  return c.json({ ok: true });
});

export { publicRoutes };
