import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createMockEnv, createMockSandbox, suppressConsole } from '../test-utils';
import { publicRoutes } from './public';

// Mock the gateway module
vi.mock('../gateway/process', () => ({
  ensureMoltbotGateway: vi.fn().mockResolvedValue(undefined),
  findExistingMoltbotProcess: vi.fn(),
}));

import { ensureMoltbotGateway } from '../gateway/process';

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

  it('returns 502 when ensureMoltbotGateway throws', async () => {
    const env = createMockEnv({ TELEGRAM_WEBHOOK_SECRET: 'my-secret' });
    const mock = createMockSandbox();
    vi.mocked(ensureMoltbotGateway).mockRejectedValue(new Error('gateway startup failed'));
    const { fetch } = createApp(env, mock);

    const resp = await fetch(new Request('http://localhost/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'my-secret' },
    }));

    expect(resp.status).toBe(502);
    expect(await resp.json()).toEqual({ error: 'Bad gateway' });
    expect(mock.containerFetchMock).not.toHaveBeenCalled();
  });
});
