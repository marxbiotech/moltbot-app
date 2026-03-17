import { Hono } from 'hono';
import type { Sandbox } from '@cloudflare/sandbox';
import type { Context } from 'hono';
import type { AppEnv, MoltbotEnv, WebhookQueueMessage, WebhookSource } from '../types';
import { MOLTBOT_PORT, TELEGRAM_WEBHOOK_PORT, WEBHOOK_ROUTES } from '../config';
import { timingSafeEqual, verifySlackSignature } from '../utils/crypto';
import { sanitizeCloseReason } from '../utils/ws';
import { findExistingMoltbotProcess, ensureMoltbotGateway } from '../gateway';

/** Shared webhook proxy: detect container state → queue or fire-and-forget (+ cold start trigger in parallel) */
async function proxyWebhook(opts: {
  source: WebhookSource;
  sandbox: Sandbox;
  env: MoltbotEnv;
  executionCtx: { waitUntil: (p: Promise<unknown>) => void };
  queue: { send: (msg: WebhookQueueMessage, opts?: { delaySeconds: number }) => Promise<void> } | undefined;
  bodyString: string;
  headers: Record<string, string>;
  proxyPort: number;
  proxyPath: string;
}): Promise<{ isHot: boolean; isCold: boolean }> {
  const { source, sandbox, env, executionCtx, queue, bodyString, headers, proxyPort, proxyPath } = opts;
  const tag = source.toUpperCase();

  // Determine container state: cold / warming / hot
  let existingProcess = null;
  try {
    existingProcess = await findExistingMoltbotProcess(sandbox);
  } catch (err) {
    console.error(`[${tag}] Failed to check process state, treating as cold:`, err);
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_LIFECYCLE_CHAT_ID) {
      executionCtx.waitUntil(
        fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TELEGRAM_LIFECYCLE_CHAT_ID, text: `⚠️ [${tag.toLowerCase()}] findExistingMoltbotProcess failed: ${err}`, disable_notification: true }),
        }).catch(() => {})
      );
    }
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

  if (queue) {
    const delaySeconds = isHot ? 0 : 180;
    console.log(`[${tag}] Enqueuing (${isCold ? 'cold' : isHot ? 'hot' : 'warming'}, delay=${delaySeconds}s)`);
    executionCtx.waitUntil(
      queue.send(
        { source, rawBody: bodyString, headers },
        { delaySeconds },
      ).catch((err) => {
        console.error(`[${tag}] Queue send failed, falling back to fire-and-forget:`, err);
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_LIFECYCLE_CHAT_ID) {
          fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: env.TELEGRAM_LIFECYCLE_CHAT_ID, text: `⚠️ [${tag.toLowerCase()}] Queue send failed, using fire-and-forget fallback`, disable_notification: true }),
          }).catch(() => {});
        }
        return ensureMoltbotGateway(sandbox, env).then(() =>
          sandbox.containerFetch(
            new Request(`http://localhost:${proxyPort}${proxyPath}`, {
              method: 'POST',
              headers,
              body: bodyString,
            }),
            proxyPort,
          )
        );
      })
    );
  } else {
    console.warn(`[${tag}] No queue configured, falling back to fire-and-forget`);
    executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, env).then(() =>
        sandbox.containerFetch(
          new Request(`http://localhost:${proxyPort}${proxyPath}`, {
            method: 'POST',
            headers,
            body: bodyString,
          }),
          proxyPort,
        )
      ).catch((err) => {
        console.error(`[${tag}] Webhook proxy failed:`, err);
      })
    );
  }

  // Cold or warming: trigger container startup (idempotent — safe if also called from fire-and-forget path above)
  if (!isHot) {
    executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, env).catch((err) => {
        console.error(`[${tag}] Gateway startup failed:`, err);
      })
    );
  }

  return { isHot, isCold };
}

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

  // WEBHOOK_QUEUE (new) → TELEGRAM_QUEUE (deprecated) → fire-and-forget
  const telegramQueue = c.env.WEBHOOK_QUEUE ?? c.env.TELEGRAM_QUEUE;
  const { isHot, isCold } = await proxyWebhook({
    source: 'telegram',
    sandbox,
    env: c.env,
    executionCtx: c.executionCtx,
    queue: telegramQueue,
    bodyString,
    headers: queueHeaders,
    proxyPort: WEBHOOK_ROUTES.telegram.port,
    proxyPath: WEBHOOK_ROUTES.telegram.path,
  });

  // Cold or warming: notify owner
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
// Worker verifies Slack HMAC at the edge, then proxies to container gateway via queue-based delivery.
publicRoutes.post('/slack/events', async (c) => {
  if (!c.env.SLACK_SIGNING_SECRET) {
    console.error('[SLACK] SLACK_SIGNING_SECRET not configured');
    return c.json({ error: 'Slack webhook not configured' }, 500);
  }

  // Buffer body before any async work — request stream closes once we respond
  const bodyString = await c.req.text();

  // Verify Slack HMAC signature at the Worker edge.
  // This rejects unauthenticated traffic before it reaches the queue or container,
  // and allows the queue consumer to re-sign with a fresh timestamp for delivery.
  const slackTimestamp = c.req.header('X-Slack-Request-Timestamp');
  const slackSignature = c.req.header('X-Slack-Signature');
  if (!slackTimestamp || !slackSignature) {
    return c.json({ error: 'Missing signature headers' }, 401);
  }
  const now = Math.floor(Date.now() / 1000);
  // Design Decision: No explicit NaN guard on parseInt — non-numeric timestamps produce NaN,
  // which makes the > 300 check false (passing staleness), but the HMAC verification below
  // rejects the request anyway since the computed signature incorporates the timestamp string.
  if (Math.abs(now - parseInt(slackTimestamp, 10)) > 300) {
    return c.json({ error: 'Stale request' }, 401);
  }
  if (!await verifySlackSignature(c.env.SLACK_SIGNING_SECRET, slackTimestamp, bodyString, slackSignature)) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  // Handle url_verification challenge directly (works even during cold start).
  // HMAC signature was already verified above.
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
    'X-Slack-Request-Timestamp': slackTimestamp,
    'X-Slack-Signature': slackSignature,
  };

  await proxyWebhook({
    source: 'slack',
    sandbox,
    env: c.env,
    executionCtx: c.executionCtx,
    queue: c.env.WEBHOOK_QUEUE,
    bodyString,
    headers: queueHeaders,
    proxyPort: WEBHOOK_ROUTES.slack.port,
    proxyPath: WEBHOOK_ROUTES.slack.path,
  });

  return c.json({ ok: true });
});

/**
 * Node WebSocket proxy handler (protected by CF Access Service Token).
 * Bridges external openclaw nodes to the container gateway via WebSocket relay.
 * Unlike the catch-all WS proxy: no JSON error message transformation, target path is always /.
 * Close reasons are still sanitized for WebSocket spec compliance.
 * Gateway token is injected server-side if not in query params.
 */
export async function handleNodeProxy(c: Context<AppEnv>): Promise<Response> {
  const request = c.req.raw;

  // Require WebSocket upgrade
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('WebSocket upgrade required', 426);
  }

  const sandbox = c.get('sandbox');

  // Ensure gateway is running
  try {
    await ensureMoltbotGateway(sandbox, c.env);
  } catch (error) {
    console.error('[NODE] Failed to start gateway:', error);
    return c.json(
      {
        error: 'Gateway failed to start',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      503,
    );
  }

  // Build gateway URL: always target /, forward query params.
  // Container gateway requires a valid token on the initial HTTP upgrade request.
  // Token sources (in priority order):
  //   1. ?token= query param (legacy, for backward compatibility)
  //   2. Authorization: Bearer header (preferred, avoids token in URL/logs)
  //   3. Server-side MOLTBOT_GATEWAY_TOKEN env var (for CF Access authenticated users)
  const url = new URL(request.url);
  const gatewayUrl = new URL(`http://localhost:${MOLTBOT_PORT}/`);
  gatewayUrl.search = url.search;
  if (!gatewayUrl.searchParams.has('token')) {
    const authHeader = request.headers.get('Authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (bearerToken) {
      gatewayUrl.searchParams.set('token', bearerToken);
    } else if (c.env.MOLTBOT_GATEWAY_TOKEN) {
      gatewayUrl.searchParams.set('token', c.env.MOLTBOT_GATEWAY_TOKEN);
    }
  }

  console.log(`[NODE] Proxying WebSocket from ${c.req.header('CF-Connecting-IP') || 'unknown'}`);

  // Connect to container
  const wsRequest = new Request(gatewayUrl.toString(), request);
  let containerResponse: Response;
  try {
    containerResponse = await sandbox.wsConnect(wsRequest, MOLTBOT_PORT);
  } catch (error) {
    console.error('[NODE] wsConnect failed:', error);
    return c.json(
      { error: 'WebSocket connection to gateway failed', details: error instanceof Error ? error.message : 'Unknown error' },
      502,
    );
  }
  console.log('[NODE] wsConnect response status:', containerResponse.status);

  const containerWs = containerResponse.webSocket;
  if (!containerWs) {
    console.error('[NODE] No WebSocket in container response');
    return containerResponse;
  }

  // Create WebSocket pair for the client
  const [clientWs, serverWs] = Object.values(new WebSocketPair());
  serverWs.accept();
  containerWs.accept();

  // Relay: client -> container
  serverWs.addEventListener('message', (event) => {
    if (containerWs.readyState === WebSocket.OPEN) {
      containerWs.send(event.data);
    } else {
      console.warn('[NODE] Dropped client→container message, container readyState:', containerWs.readyState);
    }
  });

  // Relay: container -> client (no error transformation)
  containerWs.addEventListener('message', (event) => {
    if (serverWs.readyState === WebSocket.OPEN) {
      serverWs.send(event.data);
    } else {
      console.warn('[NODE] Dropped container→client message, client readyState:', serverWs.readyState);
    }
  });

  // Handle close events (sanitize only, no error transformation)
  serverWs.addEventListener('close', (event) => {
    try {
      containerWs.close(event.code, sanitizeCloseReason(event.reason));
    } catch (e) {
      console.error('[NODE] Failed to close container WS:', e);
    }
  });

  containerWs.addEventListener('close', (event) => {
    try {
      serverWs.close(event.code, sanitizeCloseReason(event.reason));
    } catch (e) {
      console.error('[NODE] Failed to close client WS:', e);
    }
  });

  // Handle errors
  serverWs.addEventListener('error', (event) => {
    console.error('[NODE] Client error:', event);
    try {
      containerWs.close(1011, 'Client error');
    } catch (e) {
      console.error('[NODE] Failed to close container WS after client error:', e);
    }
  });

  containerWs.addEventListener('error', (event) => {
    console.error('[NODE] Container error:', event);
    try {
      serverWs.close(1011, 'Container error');
    } catch (e) {
      console.error('[NODE] Failed to close client WS after container error:', e);
    }
  });

  return new Response(null, {
    status: 101,
    webSocket: clientWs,
  });
}

export { publicRoutes };
