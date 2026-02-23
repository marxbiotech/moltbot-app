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
  return { app, fetch: (req: Request) => app.fetch(req, env) };
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

  it('proxies to correct URL and port on valid request', async () => {
    const env = createMockEnv({ TELEGRAM_WEBHOOK_SECRET: 'my-secret' });
    const mock = createMockSandbox();
    mock.containerFetchMock.mockResolvedValue(new Response('{"ok":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const { fetch } = createApp(env, mock);

    // No body — avoids Node.js `duplex: 'half'` requirement for streaming bodies
    // (Cloudflare Workers runtime handles this natively; Node test env does not)
    const resp = await fetch(new Request('http://localhost/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'my-secret' },
    }));

    expect(resp.status).toBe(200);
    expect(ensureMoltbotGateway).toHaveBeenCalledOnce();
    expect(mock.containerFetchMock).toHaveBeenCalledOnce();

    // Verify proxy target URL and port
    const [proxiedReq, port] = mock.containerFetchMock.mock.calls[0];
    expect(port).toBe(8787);
    expect(proxiedReq.url).toBe('http://localhost:8787/telegram-webhook');
    expect(proxiedReq.method).toBe('POST');
  });

  it('returns 503 when container proxy fails', async () => {
    const env = createMockEnv({ TELEGRAM_WEBHOOK_SECRET: 'my-secret' });
    const mock = createMockSandbox();
    mock.containerFetchMock.mockRejectedValue(new Error('container unavailable'));
    const { fetch } = createApp(env, mock);

    const resp = await fetch(new Request('http://localhost/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'my-secret' },
    }));

    expect(resp.status).toBe(503);
    expect(await resp.json()).toEqual({ error: 'Service unavailable' });
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
