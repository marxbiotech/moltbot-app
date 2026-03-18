/**
 * Cloudflare Worker that runs OpenClaw in a Sandbox container.
 * Proxies HTTP/WebSocket to the gateway, with admin UI, webhooks, and ACP node routing.
 * See CLAUDE.md for architecture, env vars, and configuration details.
 */

import { Hono } from 'hono';
import { getSandbox, type SandboxOptions } from '@cloudflare/sandbox';

import type { AppEnv, MoltbotEnv, WebhookQueueMessage, WebhookSource } from './types';
import { MoltbotSandbox } from './sandbox';
import { MOLTBOT_PORT, TELEGRAM_WEBHOOK_PORT, WEBHOOK_ROUTES } from './config';
import { createAccessMiddleware, extractJWT, verifyAccessJWT } from './auth';
import { ensureMoltbotGateway, findExistingMoltbotProcess } from './gateway';
import { publicRoutes, handleNodeProxy, api, adminUi, debug, cdp } from './routes';
import { redactSensitiveParams } from './utils/logging';
import { signSlackRequest } from './utils/crypto';
import { sanitizeCloseReason } from './utils/ws';
import loadingPageHtml from './assets/loading.html';
import configErrorHtml from './assets/config-error.html';

/**
 * Transform error messages from the gateway to be more user-friendly.
 */
function transformErrorMessage(message: string, host: string): string {
  if (message.includes('gateway token missing') || message.includes('gateway token mismatch')) {
    return `Invalid or missing token. Visit https://${host}?token={REPLACE_WITH_YOUR_TOKEN}`;
  }

  if (message.includes('pairing required')) {
    return `Pairing required. Visit https://${host}/_admin/`;
  }

  return message;
}

export { MoltbotSandbox as Sandbox };

/**
 * Validate required environment variables.
 * Returns an array of missing variable descriptions, or empty array if all are set.
 */
function validateRequiredEnv(env: MoltbotEnv): string[] {
  const missing: string[] = [];
  const isTestMode = env.DEV_MODE === 'true' || env.E2E_TEST_MODE === 'true';

  if (!env.MOLTBOT_GATEWAY_TOKEN) {
    missing.push('MOLTBOT_GATEWAY_TOKEN');
  }

  // CF Access vars not required in dev/test mode since auth is skipped
  if (!isTestMode) {
    if (!env.CF_ACCESS_TEAM_DOMAIN) {
      missing.push('CF_ACCESS_TEAM_DOMAIN');
    }

    if (!env.CF_ACCESS_AUD) {
      missing.push('CF_ACCESS_AUD');
    }
  }

  // Check for AI provider configuration (at least one must be set)
  const hasCloudflareGateway = !!(
    env.CLOUDFLARE_AI_GATEWAY_API_KEY &&
    env.CF_AI_GATEWAY_ACCOUNT_ID &&
    env.CF_AI_GATEWAY_GATEWAY_ID
  );
  const hasLegacyGateway = !!(env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL);
  const hasAnthropicKey = !!env.ANTHROPIC_API_KEY;
  const hasOpenAIKey = !!env.OPENAI_API_KEY;
  const hasGoogleKey = !!env.GOOGLE_API_KEY;
  const hasBedrock = !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
  const hasSubscriptionAuth = env.SUBSCRIPTION_AUTH === 'true';

  if (!hasCloudflareGateway && !hasLegacyGateway && !hasAnthropicKey && !hasOpenAIKey && !hasGoogleKey && !hasBedrock && !hasSubscriptionAuth) {
    missing.push(
      'ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, CLOUDFLARE_AI_GATEWAY_API_KEY + CF_AI_GATEWAY_ACCOUNT_ID + CF_AI_GATEWAY_GATEWAY_ID, or SUBSCRIPTION_AUTH=true',
    );
  }

  return missing;
}

/**
 * Build sandbox options based on environment configuration.
 *
 * SANDBOX_SLEEP_AFTER controls how long the container stays alive after inactivity:
 * - 'never' (default): Container stays alive indefinitely (recommended due to long cold starts)
 * - Duration string: e.g., '10m', '1h', '30s' - container sleeps after this period of inactivity
 *
 * To reduce costs at the expense of cold start latency, set SANDBOX_SLEEP_AFTER to a duration:
 *   npx wrangler secret put SANDBOX_SLEEP_AFTER
 *   # Enter: 10m (or 1h, 30m, etc.)
 */
function buildSandboxOptions(env: MoltbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';

  // 'never' means keep the container alive indefinitely
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }

  // Otherwise, use the specified duration
  return { sleepAfter };
}

// Main app
const app = new Hono<AppEnv>();

// =============================================================================
// MIDDLEWARE: Applied to ALL routes
// =============================================================================

// Middleware: Log every request
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const redactedSearch = redactSensitiveParams(url);
  console.log(`[REQ] ${c.req.method} ${url.pathname}${redactedSearch}`);
  console.log(`[REQ] Has ANTHROPIC_API_KEY: ${!!c.env.ANTHROPIC_API_KEY}`);
  console.log(`[REQ] DEV_MODE: ${c.env.DEV_MODE}`);
  console.log(`[REQ] DEBUG_ROUTES: ${c.env.DEBUG_ROUTES}`);
  await next();
});

// Middleware: Initialize sandbox for all requests
app.use('*', async (c, next) => {
  const options = buildSandboxOptions(c.env);
  const sandbox = getSandbox(c.env.Sandbox, 'moltbot', options);
  c.set('sandbox', sandbox);
  await next();
});

// =============================================================================
// PUBLIC ROUTES: No Cloudflare Access authentication required
// =============================================================================

// Mount public routes first (before auth middleware)
// Includes: /sandbox-health, /logo.png, /api/status, /_admin/assets/*, /telegram/webhook, /slack/events
app.route('/', publicRoutes);

// Mount CDP routes (uses shared secret auth via query param, not CF Access)
app.route('/cdp', cdp);

// =============================================================================
// NODE ROUTE: Protected by CF Access Service Token (separate Access app)
// Must be before CF Access auth middleware — the node Access app issues JWTs
// with a different AUD than the main app, so the main app's JWT validation
// would reject them. When NODE_ACCESS_AUD is set, the Worker verifies the JWT
// here using the node-specific AUD. When not set, relies on CDN-level Access only.
// =============================================================================

// Reserved route prefixes — NODE_ROUTE must not collide with these
// Design Decision: NODE_ROUTE=`/` is not explicitly blocked — NODE_ROUTE is an operator-set env var,
// not user input. Operators are responsible for setting a meaningful path (e.g., `/acp`).
const RESERVED_PREFIXES = ['/_admin', '/api', '/debug', '/cdp', '/sandbox-health', '/telegram', '/slack'];

app.use('*', async (c, next) => {
  const nodeRoute = c.env.NODE_ROUTE;
  if (nodeRoute) {
    // Design Decision: Invalid NODE_ROUTE logs an error and falls through rather than failing at startup.
    // NODE_ROUTE is operator-configured; console.error per-request is sufficient — wrangler tail surfaces it.
    // Cloudflare Workers don't have a startup hook to validate env vars before the first request.
    if (!nodeRoute.startsWith('/') || RESERVED_PREFIXES.some((p) => nodeRoute.startsWith(p))) {
      console.error(`[NODE] Invalid NODE_ROUTE "${nodeRoute}": must start with / and not collide with reserved prefixes`);
      return next();
    }
    if (c.req.path === nodeRoute) {
      // Optional Worker-level JWT verification (defense-in-depth)
      const nodeAud = c.env.NODE_ACCESS_AUD;
      if (nodeAud) {
        const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN;
        if (!teamDomain) {
          console.error('[NODE] NODE_ACCESS_AUD is set but CF_ACCESS_TEAM_DOMAIN is missing');
          return c.json({ error: 'CF Access not configured for node route' }, 500);
        }
        const jwt = extractJWT(c);
        if (!jwt) {
          return c.json({ error: 'Unauthorized', hint: 'Missing CF Access JWT for node route' }, 401);
        }
        try {
          await verifyAccessJWT(jwt, teamDomain, nodeAud);
        } catch (err) {
          console.error('[NODE] JWT verification failed:', err);
          return c.json({ error: 'Unauthorized', details: err instanceof Error ? err.message : 'JWT verification failed' }, 401);
        }
      }
      return handleNodeProxy(c);
    }
  }
  return next();
});

// =============================================================================
// PROTECTED ROUTES: Cloudflare Access authentication required
// =============================================================================

// Middleware: Validate required environment variables (skip in dev mode and for debug routes)
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);

  // Skip validation for debug routes (they have their own enable check)
  if (url.pathname.startsWith('/debug')) {
    return next();
  }

  // Skip validation in dev mode
  if (c.env.DEV_MODE === 'true') {
    return next();
  }

  const missingVars = validateRequiredEnv(c.env);
  if (missingVars.length > 0) {
    console.error('[CONFIG] Missing required environment variables:', missingVars.join(', '));

    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) {
      // Return a user-friendly HTML error page
      const html = configErrorHtml.replace('{{MISSING_VARS}}', missingVars.join(', '));
      return c.html(html, 503);
    }

    // Return JSON error for API requests
    return c.json(
      {
        error: 'Configuration error',
        message: 'Required environment variables are not configured',
        missing: missingVars,
        hint: 'Set these using: wrangler secret put <VARIABLE_NAME>',
      },
      503,
    );
  }

  return next();
});

// Middleware: Cloudflare Access authentication for protected routes
app.use('*', async (c, next) => {
  // Determine response type based on Accept header
  const acceptsHtml = c.req.header('Accept')?.includes('text/html');
  const middleware = createAccessMiddleware({
    type: acceptsHtml ? 'html' : 'json',
    redirectOnMissing: acceptsHtml,
  });

  return middleware(c, next);
});

// Mount API routes (protected by Cloudflare Access)
app.route('/api', api);

// Mount Admin UI routes (protected by Cloudflare Access)
app.route('/_admin', adminUi);

// Mount debug routes (protected by Cloudflare Access, only when DEBUG_ROUTES is enabled)
app.use('/debug/*', async (c, next) => {
  if (c.env.DEBUG_ROUTES !== 'true') {
    return c.json({ error: 'Debug routes are disabled' }, 404);
  }
  return next();
});
app.route('/debug', debug);

// =============================================================================
// CATCH-ALL: Proxy to Moltbot gateway
// =============================================================================

app.all('*', async (c) => {
  const sandbox = c.get('sandbox');
  const request = c.req.raw;
  const url = new URL(request.url);

  console.log('[PROXY] Handling request:', url.pathname);

  // Check if gateway is already running
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  const isGatewayReady = existingProcess !== null && existingProcess.status === 'running';

  // For browser requests (non-WebSocket, non-API), show loading page if gateway isn't ready
  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const acceptsHtml = request.headers.get('Accept')?.includes('text/html');

  if (!isGatewayReady && !isWebSocketRequest && acceptsHtml) {
    console.log('[PROXY] Gateway not ready, serving loading page');

    // Start the gateway in the background (don't await)
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env).catch((err: Error) => {
        console.error('[PROXY] Background gateway start failed:', err);
      }),
    );

    // Return the loading page immediately
    return c.html(loadingPageHtml);
  }

  // Ensure moltbot is running (this will wait for startup)
  try {
    await ensureMoltbotGateway(sandbox, c.env);
  } catch (error) {
    console.error('[PROXY] Failed to start Moltbot:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    let hint = 'Check worker logs with: wrangler tail';
    if (!c.env.ANTHROPIC_API_KEY) {
      hint = 'ANTHROPIC_API_KEY is not set. Run: wrangler secret put ANTHROPIC_API_KEY';
    } else if (errorMessage.includes('heap out of memory') || errorMessage.includes('OOM')) {
      hint = 'Gateway ran out of memory. Try again or check for memory leaks.';
    }

    return c.json(
      {
        error: 'Moltbot gateway failed to start',
        details: errorMessage,
        hint,
      },
      503,
    );
  }

  // Proxy to Moltbot with WebSocket message interception
  if (isWebSocketRequest) {
    const debugLogs = c.env.DEBUG_ROUTES === 'true';
    const redactedSearch = redactSensitiveParams(url);

    console.log('[WS] Proxying WebSocket connection to Moltbot');
    if (debugLogs) {
      console.log('[WS] URL:', url.pathname + redactedSearch);
    }

    // Inject gateway token into WebSocket request if not already present.
    // CF Access redirects strip query params, so authenticated users lose ?token=.
    // Since the user already passed CF Access auth, we inject the token server-side.
    let wsRequest = request;
    if (c.env.MOLTBOT_GATEWAY_TOKEN && !url.searchParams.has('token')) {
      const tokenUrl = new URL(url.toString());
      tokenUrl.searchParams.set('token', c.env.MOLTBOT_GATEWAY_TOKEN);
      wsRequest = new Request(tokenUrl.toString(), request);
    }

    // Get WebSocket connection to the container
    const containerResponse = await sandbox.wsConnect(wsRequest, MOLTBOT_PORT);
    console.log('[WS] wsConnect response status:', containerResponse.status);

    // Get the container-side WebSocket
    const containerWs = containerResponse.webSocket;
    if (!containerWs) {
      console.error('[WS] No WebSocket in container response - falling back to direct proxy');
      return containerResponse;
    }

    if (debugLogs) {
      console.log('[WS] Got container WebSocket, setting up interception');
    }

    // Create a WebSocket pair for the client
    const [clientWs, serverWs] = Object.values(new WebSocketPair());

    // Accept both WebSockets
    serverWs.accept();
    containerWs.accept();

    if (debugLogs) {
      console.log('[WS] Both WebSockets accepted');
      console.log('[WS] containerWs.readyState:', containerWs.readyState);
      console.log('[WS] serverWs.readyState:', serverWs.readyState);
    }

    // Relay messages from client to container
    serverWs.addEventListener('message', (event) => {
      if (debugLogs) {
        console.log(
          '[WS] Client -> Container:',
          typeof event.data,
          typeof event.data === 'string' ? event.data.slice(0, 200) : '(binary)',
        );
      }
      if (containerWs.readyState === WebSocket.OPEN) {
        containerWs.send(event.data);
      } else if (debugLogs) {
        console.log('[WS] Container not open, readyState:', containerWs.readyState);
      }
    });

    // Relay messages from container to client, with error transformation
    containerWs.addEventListener('message', (event) => {
      if (debugLogs) {
        console.log(
          '[WS] Container -> Client (raw):',
          typeof event.data,
          typeof event.data === 'string' ? event.data.slice(0, 500) : '(binary)',
        );
      }
      let data = event.data;

      // Try to intercept and transform error messages
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (debugLogs) {
            console.log('[WS] Parsed JSON, has error.message:', !!parsed.error?.message);
          }
          if (parsed.error?.message) {
            if (debugLogs) {
              console.log('[WS] Original error.message:', parsed.error.message);
            }
            parsed.error.message = transformErrorMessage(parsed.error.message, url.host);
            if (debugLogs) {
              console.log('[WS] Transformed error.message:', parsed.error.message);
            }
            data = JSON.stringify(parsed);
          }
        } catch (e) {
          if (debugLogs) {
            console.log('[WS] Not JSON or parse error:', e);
          }
        }
      }

      if (serverWs.readyState === WebSocket.OPEN) {
        serverWs.send(data);
      } else if (debugLogs) {
        console.log('[WS] Server not open, readyState:', serverWs.readyState);
      }
    });

    // Handle close events
    serverWs.addEventListener('close', (event) => {
      if (debugLogs) {
        console.log('[WS] Client closed:', event.code, event.reason);
      }
      containerWs.close(event.code, sanitizeCloseReason(event.reason));
    });

    containerWs.addEventListener('close', (event) => {
      if (debugLogs) {
        console.log('[WS] Container closed:', event.code, event.reason);
      }
      // Transform the close reason (truncate to 123 bytes max for WebSocket spec)
      let reason = transformErrorMessage(event.reason, url.host);
      reason = sanitizeCloseReason(reason);
      if (debugLogs) {
        console.log('[WS] Transformed close reason:', reason);
      }
      serverWs.close(event.code, reason);
    });

    // Handle errors
    serverWs.addEventListener('error', (event) => {
      console.error('[WS] Client error:', event);
      containerWs.close(1011, 'Client error');
    });

    containerWs.addEventListener('error', (event) => {
      console.error('[WS] Container error:', event);
      serverWs.close(1011, 'Container error');
    });

    if (debugLogs) {
      console.log('[WS] Returning intercepted WebSocket response');
    }
    return new Response(null, {
      status: 101,
      webSocket: clientWs,
    });
  }

  console.log('[HTTP] Proxying:', url.pathname + url.search);
  const httpResponse = await sandbox.containerFetch(request, MOLTBOT_PORT);
  console.log('[HTTP] Response status:', httpResponse.status);

  // Add debug header to verify worker handled the request
  const newHeaders = new Headers(httpResponse.headers);
  newHeaders.set('X-Worker-Debug', 'proxy-to-moltbot');
  newHeaders.set('X-Debug-Path', url.pathname);

  return new Response(httpResponse.body, {
    status: httpResponse.status,
    statusText: httpResponse.statusText,
    headers: newHeaders,
  });
});

/** Delivery target config per webhook source */
interface DeliveryTarget {
  port: number;
  path: string;
  /** Extra ports that must also be ready before delivering (e.g. Telegram also needs the gateway port) */
  extraPorts?: number[];
}

const DELIVERY_TARGETS: Record<WebhookSource, DeliveryTarget> = {
  telegram: {
    ...WEBHOOK_ROUTES.telegram,
    extraPorts: [MOLTBOT_PORT],
  },
  slack: WEBHOOK_ROUTES.slack,
};

/** Awaitable lifecycle notification for queue consumer (no waitUntil available). */
async function notifyQueueLifecycle(env: MoltbotEnv, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_LIFECYCLE_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_LIFECYCLE_CHAT_ID, text, disable_notification: true }),
  }).catch((err) => console.warn('[QUEUE] Lifecycle notification failed:', err));
}

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<WebhookQueueMessage>, env: MoltbotEnv) {
    console.log(`[QUEUE] Consumer triggered, batch size: ${batch.messages.length}`);
    const options = buildSandboxOptions(env);
    const sandbox = getSandbox(env.Sandbox, 'moltbot', options);

    // Quick readiness check — rather than blocking a consumer invocation for the
    // full 60-90s cold start, we check port readiness with a short timeout and
    // retry via the queue if not ready. This keeps consumer invocations fast and
    // avoids exhausting the queue's max_retries during a single cold start.
    // The webhook handler's waitUntil already kicked off ensureMoltbotGateway.
    let process;
    try {
      process = await findExistingMoltbotProcess(sandbox);
    } catch (err) {
      console.error('[QUEUE] findExistingMoltbotProcess failed:', err);
      await notifyQueueLifecycle(env, `⚠️ [queue] findExistingMoltbotProcess failed: ${err}`);
      for (const msg of batch.messages) msg.retry();
      return;
    }
    if (!process) {
      // No process at all — kick off startup and retry
      console.log('[QUEUE] No process found, starting gateway and retrying...');
      try {
        await ensureMoltbotGateway(sandbox, env);
      } catch (err) {
        console.error('[QUEUE] Gateway startup failed:', err);
        await notifyQueueLifecycle(env, `⚠️ [queue] Gateway startup failed: ${err}`);
      }
      for (const msg of batch.messages) msg.retry();
      return;
    }

    // Collect unique ports needed across all messages in this batch.
    // Legacy messages (from old TELEGRAM_QUEUE) may lack `source` — default to 'telegram'.
    // TODO: remove `?? 'telegram'` fallback once TELEGRAM_QUEUE binding is fully removed.
    const portsNeeded = new Set<number>();
    for (const msg of batch.messages) {
      const target = DELIVERY_TARGETS[msg.body.source ?? 'telegram'];
      if (target) {
        portsNeeded.add(target.port);
        for (const p of target.extraPorts ?? []) portsNeeded.add(p);
      }
    }

    // Check all required ports are ready
    try {
      const ports = [...portsNeeded];
      console.log(`[QUEUE] Process ${process.id} (${process.status}), checking ports ${ports.join(', ')}...`);
      for (const port of ports) {
        await process.waitForPort(port, { mode: 'tcp', timeout: 10_000 });
      }
      console.log('[QUEUE] Gateway ready');
    } catch (err) {
      console.error('[QUEUE] Port check failed, retrying...', err);
      await notifyQueueLifecycle(env, `⚠️ [queue] Port check failed: ${err}`);
      for (const msg of batch.messages) msg.retry();
      return;
    }

    for (const msg of batch.messages) {
      const source = msg.body.source ?? 'telegram';
      const target = DELIVERY_TARGETS[source];
      if (!target) {
        // Design Decision: unknown source is acked without operator notification — this is an
        // extreme edge case (source mismatch during deploy) not worth adding alerting complexity for.
        console.error(`[QUEUE] Unknown source: ${source}, acking message`);
        msg.ack();
        continue;
      }

      try {
        // For Slack messages, re-sign with fresh timestamp before delivery.
        // Worker already verified the original Slack HMAC; queue delay would make
        // the original timestamp stale (>5min), causing Bolt to reject silently.
        const deliveryHeaders = { ...msg.body.headers };
        // Deferred: warn when SLACK_SIGNING_SECRET is unset for Slack messages — the webhook
        // route already returns 500 preventing new enqueues, so only pre-existing messages
        // from before a config change would hit this path. Low priority diagnostic.
        if (source === 'slack' && env.SLACK_SIGNING_SECRET) {
          const { timestamp, signature } = await signSlackRequest(
            env.SLACK_SIGNING_SECRET,
            msg.body.rawBody,
          );
          deliveryHeaders['X-Slack-Request-Timestamp'] = timestamp;
          deliveryHeaders['X-Slack-Signature'] = signature;
        }

        console.log(`[QUEUE:${source}] Delivering to port ${target.port}${target.path}...`);
        const res = await sandbox.containerFetch(
          new Request(`http://localhost:${target.port}${target.path}`, {
            method: 'POST',
            headers: deliveryHeaders,
            body: msg.body.rawBody,
          }),
          target.port,
        );
        if (res.ok) {
          console.log(`[QUEUE:${source}] Delivered, status: ${res.status}`);
          msg.ack();
        } else {
          console.error(`[QUEUE:${source}] Error status ${res.status}, retrying...`);
          await notifyQueueLifecycle(env, `⚠️ [queue:${source}] Delivery error status ${res.status}`);
          msg.retry();
        }
      } catch (err) {
        console.error(`[QUEUE:${source}] Delivery failed:`, err);
        await notifyQueueLifecycle(env, `⚠️ [queue:${source}] Delivery failed: ${err}`);
        msg.retry();
      }
    }
  },
};
