import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createMockEnv, createMockSandbox, suppressConsole } from '../test-utils';
import { signSlackRequest } from '../utils/crypto';
import { publicRoutes } from './public';

// Mock the gateway module
vi.mock('../gateway/process', () => ({
  ensureMoltbotGateway: vi.fn().mockResolvedValue(undefined),
  findExistingMoltbotProcess: vi.fn().mockResolvedValue(null),
}));

import { ensureMoltbotGateway, findExistingMoltbotProcess } from '../gateway/process';

/** Generate valid Slack HMAC signing headers for a given body and secret. */
async function slackHeaders(body: string, secret: string = 'test-secret'): Promise<Record<string, string>> {
  const { timestamp, signature } = await signSlackRequest(secret, body);
  return {
    'Content-Type': 'application/json',
    'X-Slack-Request-Timestamp': timestamp,
    'X-Slack-Signature': signature,
  };
}

function createApp(env: ReturnType<typeof createMockEnv>, sandbox: ReturnType<typeof createMockSandbox>) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('sandbox', sandbox.sandbox);
    await next();
  });
  app.route('/', publicRoutes);

  const waitUntilPromises: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: vi.fn((p: Promise<unknown>) => { waitUntilPromises.push(p); }),
    passThroughOnException: vi.fn(),
  };

  return {
    app,
    fetch: (req: Request) => app.fetch(req, env, executionCtx as any),
    flushWaitUntil: () => Promise.all(waitUntilPromises),
  };
}

describe('POST /telegram/webhook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    suppressConsole();
    vi.mocked(ensureMoltbotGateway).mockResolvedValue(undefined as any);
  });

  it('returns 500 when TELEGRAM_WEBHOOK_SECRET is not configured', async () => {
    const env = createMockEnv();
    const mock = createMockSandbox();
    const { fetch } = createApp(env, mock);

    const resp = await fetch(new Request('http://localhost/telegram/webhook', { method: 'POST' }));

    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({ error: 'Webhook not configured' });
  });

  it('returns 401 when X-Telegram-Bot-Api-Secret-Token header is missing', async () => {
    const env = createMockEnv({ TELEGRAM_WEBHOOK_SECRET: 'my-secret' });
    const mock = createMockSandbox();
    const { fetch } = createApp(env, mock);

    const resp = await fetch(new Request('http://localhost/telegram/webhook', { method: 'POST' }));

    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 when secret token does not match', async () => {
    const env = createMockEnv({ TELEGRAM_WEBHOOK_SECRET: 'my-secret' });
    const mock = createMockSandbox();
    const { fetch } = createApp(env, mock);

    const resp = await fetch(new Request('http://localhost/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' },
    }));

    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 200 immediately and proxies in background via waitUntil', async () => {
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue({ status: 'running', waitForPort: vi.fn().mockResolvedValue(undefined) } as any);
    const env = createMockEnv({ TELEGRAM_WEBHOOK_SECRET: 'my-secret' });
    const mock = createMockSandbox();
    mock.containerFetchMock.mockResolvedValue(new Response('{"ok":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const { fetch, flushWaitUntil } = createApp(env, mock);

    const resp = await fetch(new Request('http://localhost/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'my-secret' },
    }));

    // Handler returns 200 immediately without waiting for container
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    expect(ensureMoltbotGateway).toHaveBeenCalledOnce();

    // containerFetch is called via waitUntil (fire-and-forget)
    await flushWaitUntil();
    expect(mock.containerFetchMock).toHaveBeenCalledOnce();
    const [proxiedReq, port] = mock.containerFetchMock.mock.calls[0];
    expect(port).toBe(8787);
    expect(proxiedReq.url).toBe('http://localhost:8787/telegram-webhook');
    expect(proxiedReq.method).toBe('POST');
  });

  it('sends ⏳ ack reaction for channel_post', async () => {
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue({ status: 'running', waitForPort: vi.fn().mockResolvedValue(undefined) } as any);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}'));
    const env = createMockEnv({
      TELEGRAM_WEBHOOK_SECRET: 'my-secret',
      TELEGRAM_BOT_TOKEN: 'bot-token-123',
    });
    const mock = createMockSandbox();
    mock.containerFetchMock.mockResolvedValue(new Response('{"ok":true}'));
    const { fetch, flushWaitUntil } = createApp(env, mock);

    const update = JSON.stringify({
      update_id: 123,
      channel_post: { message_id: 7, chat: { id: -1003645700926, type: 'channel' }, date: 1234, text: 'hello' },
    });
    const resp = await fetch(new Request('http://localhost/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'my-secret', 'Content-Type': 'application/json' },
      body: update,
    }));

    expect(resp.status).toBe(200);
    await flushWaitUntil();

    const reactionCall = fetchSpy.mock.calls.find(([url]) =>
      typeof url === 'string' && url.includes('/setMessageReaction'),
    );
    expect(reactionCall).toBeDefined();
    const [reactionUrl, reactionInit] = reactionCall!;
    expect(reactionUrl).toBe('https://api.telegram.org/botbot-token-123/setMessageReaction');
    const reactionBody = JSON.parse(reactionInit!.body as string);
    expect(reactionBody.chat_id).toBe(-1003645700926);
    expect(reactionBody.message_id).toBe(7);
    expect(reactionBody.reaction).toEqual([{ type: 'emoji', emoji: '⚡' }]);

    fetchSpy.mockRestore();
  });

  it('returns 200 even when container proxy fails (error is logged)', async () => {
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue({ status: 'running', waitForPort: vi.fn().mockResolvedValue(undefined) } as any);
    const env = createMockEnv({ TELEGRAM_WEBHOOK_SECRET: 'my-secret' });
    const mock = createMockSandbox();
    mock.containerFetchMock.mockRejectedValue(new Error('container unavailable'));
    const { fetch, flushWaitUntil } = createApp(env, mock);

    const resp = await fetch(new Request('http://localhost/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'my-secret' },
    }));

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });

    // waitUntil catches the error internally (no unhandled rejection)
    await flushWaitUntil();
  });

  it('returns 200 even when ensureMoltbotGateway throws on cold start (error is logged)', async () => {
    // Cold path: findExistingMoltbotProcess returns null (default mock)
    const env = createMockEnv({ TELEGRAM_WEBHOOK_SECRET: 'my-secret' });
    const mock = createMockSandbox();
    vi.mocked(ensureMoltbotGateway).mockRejectedValue(new Error('gateway startup failed'));
    const { fetch, flushWaitUntil } = createApp(env, mock);

    const resp = await fetch(new Request('http://localhost/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'my-secret' },
    }));

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });

    // Gateway failure is caught inside waitUntil (no unhandled rejection)
    await flushWaitUntil();
    expect(mock.containerFetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /slack/events', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    suppressConsole();
    vi.mocked(ensureMoltbotGateway).mockClear().mockResolvedValue(undefined as any);
    vi.mocked(findExistingMoltbotProcess).mockClear().mockResolvedValue(null as any);
  });

  it('returns 500 when SLACK_SIGNING_SECRET is not configured', async () => {
    const env = createMockEnv();
    const mock = createMockSandbox();
    const { fetch } = createApp(env, mock);

    const resp = await fetch(new Request('http://localhost/slack/events', { method: 'POST' }));

    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({ error: 'Slack webhook not configured' });
  });

  it('returns 401 when Slack signature headers are missing', async () => {
    const env = createMockEnv({ SLACK_SIGNING_SECRET: 'test-secret' });
    const mock = createMockSandbox();
    const { fetch } = createApp(env, mock);

    const resp = await fetch(new Request('http://localhost/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'event_callback' }),
    }));

    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ error: 'Missing signature headers' });
  });

  it('returns 401 when Slack timestamp is stale', async () => {
    const env = createMockEnv({ SLACK_SIGNING_SECRET: 'test-secret' });
    const mock = createMockSandbox();
    const { fetch } = createApp(env, mock);

    const resp = await fetch(new Request('http://localhost/slack/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': '1000000000',
        'X-Slack-Signature': 'v0=fake',
      },
      body: JSON.stringify({ type: 'event_callback' }),
    }));

    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ error: 'Stale request' });
  });

  it('returns 401 when Slack signature is invalid', async () => {
    const env = createMockEnv({ SLACK_SIGNING_SECRET: 'test-secret' });
    const mock = createMockSandbox();
    const { fetch } = createApp(env, mock);

    const resp = await fetch(new Request('http://localhost/slack/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
        'X-Slack-Signature': 'v0=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: JSON.stringify({ type: 'event_callback' }),
    }));

    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ error: 'Invalid signature' });
  });

  it('handles url_verification challenge', async () => {
    const env = createMockEnv({ SLACK_SIGNING_SECRET: 'test-secret' });
    const mock = createMockSandbox();
    const { fetch } = createApp(env, mock);

    const body = JSON.stringify({ type: 'url_verification', challenge: 'test-challenge-123' });
    const resp = await fetch(new Request('http://localhost/slack/events', {
      method: 'POST',
      headers: await slackHeaders(body),
      body,
    }));

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ challenge: 'test-challenge-123' });
  });

  it('returns 200 and proxies via fire-and-forget when no queue (hot container)', async () => {
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue({
      status: 'running',
      waitForPort: vi.fn().mockResolvedValue(undefined),
    } as any);
    const env = createMockEnv({ SLACK_SIGNING_SECRET: 'test-secret' });
    const mock = createMockSandbox();
    mock.containerFetchMock.mockResolvedValue(new Response('{"ok":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const { fetch, flushWaitUntil } = createApp(env, mock);

    const body = JSON.stringify({ type: 'event_callback', event: { type: 'message' } });
    const resp = await fetch(new Request('http://localhost/slack/events', {
      method: 'POST',
      headers: await slackHeaders(body),
      body,
    }));

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });

    // containerFetch is called via waitUntil (fire-and-forget)
    await flushWaitUntil();
    expect(mock.containerFetchMock).toHaveBeenCalledOnce();
    const [proxiedReq, port] = mock.containerFetchMock.mock.calls[0];
    expect(port).toBe(18789);
    expect(proxiedReq.url).toBe('http://localhost:18789/slack/events');
    expect(proxiedReq.method).toBe('POST');
  });

  it('forwards Slack signing headers to container', async () => {
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue({
      status: 'running',
      waitForPort: vi.fn().mockResolvedValue(undefined),
    } as any);
    const env = createMockEnv({ SLACK_SIGNING_SECRET: 'test-secret' });
    const mock = createMockSandbox();
    mock.containerFetchMock.mockResolvedValue(new Response('{"ok":true}'));
    const { fetch, flushWaitUntil } = createApp(env, mock);

    const body = JSON.stringify({ type: 'event_callback' });
    const headers = await slackHeaders(body);
    const resp = await fetch(new Request('http://localhost/slack/events', {
      method: 'POST',
      headers,
      body,
    }));

    expect(resp.status).toBe(200);
    await flushWaitUntil();

    const [proxiedReq] = mock.containerFetchMock.mock.calls[0];
    const proxiedHeaders = proxiedReq.headers;
    expect(proxiedHeaders.get('X-Slack-Request-Timestamp')).toBe(headers['X-Slack-Request-Timestamp']);
    expect(proxiedHeaders.get('X-Slack-Signature')).toBe(headers['X-Slack-Signature']);
    expect(proxiedHeaders.get('content-type')).toBe('application/json');
  });

  it('enqueues message when WEBHOOK_QUEUE is configured (hot container)', async () => {
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue({
      status: 'running',
      waitForPort: vi.fn().mockResolvedValue(undefined),
    } as any);
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const env = createMockEnv({
      SLACK_SIGNING_SECRET: 'test-secret',
      WEBHOOK_QUEUE: { send: queueSend } as any,
    });
    const mock = createMockSandbox();
    const { fetch, flushWaitUntil } = createApp(env, mock);

    const body = JSON.stringify({ type: 'event_callback', event: { type: 'message' } });
    const headers = await slackHeaders(body);
    const resp = await fetch(new Request('http://localhost/slack/events', {
      method: 'POST',
      headers,
      body,
    }));

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });

    await flushWaitUntil();
    expect(queueSend).toHaveBeenCalledOnce();
    expect(queueSend).toHaveBeenCalledWith(
      {
        source: 'slack',
        rawBody: body,
        headers: {
          'content-type': 'application/json',
          'X-Slack-Request-Timestamp': headers['X-Slack-Request-Timestamp'],
          'X-Slack-Signature': headers['X-Slack-Signature'],
        },
      },
      { delaySeconds: 0 },
    );
    // containerFetch should NOT be called when queue is used
    expect(mock.containerFetchMock).not.toHaveBeenCalled();
  });

  it('enqueues with 180s delay on cold start', async () => {
    // Cold path: no existing process
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue(null as any);
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const env = createMockEnv({
      SLACK_SIGNING_SECRET: 'test-secret',
      WEBHOOK_QUEUE: { send: queueSend } as any,
    });
    const mock = createMockSandbox();
    const { fetch, flushWaitUntil } = createApp(env, mock);

    const body = JSON.stringify({ type: 'event_callback' });
    const resp = await fetch(new Request('http://localhost/slack/events', {
      method: 'POST',
      headers: await slackHeaders(body),
      body,
    }));

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });

    await flushWaitUntil();
    expect(queueSend).toHaveBeenCalledOnce();
    expect(queueSend).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'slack' }),
      { delaySeconds: 180 },
    );
    // Cold start triggers ensureMoltbotGateway
    expect(ensureMoltbotGateway).toHaveBeenCalledOnce();
  });

  it('returns 200 even when container proxy fails (error is logged)', async () => {
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue({
      status: 'running',
      waitForPort: vi.fn().mockResolvedValue(undefined),
    } as any);
    const env = createMockEnv({ SLACK_SIGNING_SECRET: 'test-secret' });
    const mock = createMockSandbox();
    mock.containerFetchMock.mockRejectedValue(new Error('container unavailable'));
    const { fetch, flushWaitUntil } = createApp(env, mock);

    const body = JSON.stringify({ type: 'event_callback' });
    const resp = await fetch(new Request('http://localhost/slack/events', {
      method: 'POST',
      headers: await slackHeaders(body),
      body,
    }));

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });

    // waitUntil catches the error internally (no unhandled rejection)
    await flushWaitUntil();
  });

  it('returns 200 even when ensureMoltbotGateway throws on cold start (error is logged)', async () => {
    // Cold path: no existing process
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue(null as any);
    const env = createMockEnv({ SLACK_SIGNING_SECRET: 'test-secret' });
    const mock = createMockSandbox();
    vi.mocked(ensureMoltbotGateway).mockRejectedValue(new Error('gateway startup failed'));
    const { fetch, flushWaitUntil } = createApp(env, mock);

    const body = JSON.stringify({ type: 'event_callback' });
    const resp = await fetch(new Request('http://localhost/slack/events', {
      method: 'POST',
      headers: await slackHeaders(body),
      body,
    }));

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });

    // Gateway failure is caught inside waitUntil (no unhandled rejection)
    await flushWaitUntil();
    expect(mock.containerFetchMock).not.toHaveBeenCalled();
  });
});
