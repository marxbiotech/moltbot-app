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

/** Send a 👀 reaction to acknowledge receipt before cold start / LLM processing. */
function sendAckReaction(botToken: string, chatId: number, messageId: number): Promise<void> {
  return fetch(`https://api.telegram.org/bot${botToken}/setMessageReaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: '⏳' }],
    }),
  }).then((res) => {
    if (!res.ok) console.error(`[TELEGRAM] ack reaction failed: ${res.status}`);
  }).catch((err) => {
    console.error('[TELEGRAM] ack reaction error:', err);
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

  // Send ack reaction immediately (before gateway startup) so the user knows
  // the message was received, even during cold start or long LLM inference.
  const botToken = c.env.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    try {
      const update = JSON.parse(new TextDecoder().decode(body));
      const msg = update.message || update.channel_post;
      if (msg?.chat?.id && msg?.message_id) {
        c.executionCtx.waitUntil(sendAckReaction(botToken, msg.chat.id, msg.message_id));
      }
    } catch {
      // Non-critical — don't block webhook processing if parsing fails
    }
  }

  const sandbox = c.get('sandbox');
  try {
    await ensureMoltbotGateway(sandbox, c.env);
  } catch (err) {
    console.error('[TELEGRAM] Gateway startup failed:', err);
    return c.json({ error: 'Bad gateway' }, 502);
  }

  // Fire-and-forget: proxy to container in background so Telegram gets 200 immediately
  c.executionCtx.waitUntil(
    sandbox.containerFetch(
      new Request(`http://localhost:${TELEGRAM_WEBHOOK_PORT}/telegram-webhook`, {
        method: 'POST',
        headers: c.req.raw.headers,
        body,
      }),
      TELEGRAM_WEBHOOK_PORT,
    ).catch((err) => {
      console.error('[TELEGRAM] Webhook proxy failed:', err);
    })
  );

  return c.json({ ok: true });
});

export { publicRoutes };
