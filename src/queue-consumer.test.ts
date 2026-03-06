import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Process } from '@cloudflare/sandbox';
import { createMockEnv, createMockSandbox, suppressConsole } from './test-utils';

// Mock dependencies — must be before imports that trigger src/index.ts
vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
}));

vi.mock('./gateway', () => ({
  ensureMoltbotGateway: vi.fn().mockResolvedValue(undefined),
  findExistingMoltbotProcess: vi.fn().mockResolvedValue(null),
}));

// Mock modules imported by src/index.ts that aren't relevant to queue tests
vi.mock('./sandbox', () => ({ MoltbotSandbox: class {} }));
vi.mock('./auth', () => ({ createAccessMiddleware: () => async (_c: any, next: any) => next() }));
vi.mock('./routes', () => {
  const { Hono } = require('hono');
  const empty = new Hono();
  return { publicRoutes: empty, api: empty, adminUi: empty, debug: empty, cdp: empty };
});
vi.mock('./utils/logging', () => ({ redactSensitiveParams: (s: string) => s }));
vi.mock('./assets/loading.html', () => ({ default: '<html>loading</html>' }));
vi.mock('./assets/config-error.html', () => ({ default: '<html>error</html>' }));

import { getSandbox } from '@cloudflare/sandbox';
import { ensureMoltbotGateway, findExistingMoltbotProcess } from './gateway';
import worker from './index';

function createQueueMessage(body: string = '{"update_id":1}', headers: Record<string, string> = {}) {
  return {
    body: { body, headers },
    ack: vi.fn(),
    retry: vi.fn(),
    id: 'msg-' + Math.random().toString(36).slice(2),
    timestamp: new Date(),
    attempts: 1,
  };
}

function createBatch(messages: ReturnType<typeof createQueueMessage>[]) {
  return {
    messages,
    queue: 'telegram-webhook',
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as any;
}

describe('queue consumer', () => {
  let mockSandbox: ReturnType<typeof createMockSandbox>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    suppressConsole();
    mockSandbox = createMockSandbox();
    vi.mocked(getSandbox).mockReturnValue(mockSandbox.sandbox);
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue(null);
    vi.mocked(ensureMoltbotGateway).mockResolvedValue(undefined as any);
  });

  it('retries all messages and calls ensureMoltbotGateway when no process found', async () => {
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue(null);
    const msg1 = createQueueMessage();
    const msg2 = createQueueMessage();
    const batch = createBatch([msg1, msg2]);
    const env = createMockEnv();

    await worker.queue(batch, env);

    expect(ensureMoltbotGateway).toHaveBeenCalledOnce();
    expect(msg1.retry).toHaveBeenCalledOnce();
    expect(msg2.retry).toHaveBeenCalledOnce();
    expect(msg1.ack).not.toHaveBeenCalled();
    expect(msg2.ack).not.toHaveBeenCalled();
  });

  it('retries all messages when process exists but port is not ready', async () => {
    const mockProcess = {
      id: 'proc-1',
      status: 'running' as Process['status'],
      waitForPort: vi.fn().mockRejectedValue(new Error('port timeout')),
    };
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue(mockProcess as any);

    const msg1 = createQueueMessage();
    const msg2 = createQueueMessage();
    const batch = createBatch([msg1, msg2]);
    const env = createMockEnv();

    await worker.queue(batch, env);

    expect(mockProcess.waitForPort).toHaveBeenCalledWith(18789, { mode: 'tcp', timeout: 10_000 });
    expect(msg1.retry).toHaveBeenCalledOnce();
    expect(msg2.retry).toHaveBeenCalledOnce();
    expect(msg1.ack).not.toHaveBeenCalled();
    expect(ensureMoltbotGateway).not.toHaveBeenCalled();
  });

  it('acks message on successful delivery (res.ok)', async () => {
    const mockProcess = {
      id: 'proc-1',
      status: 'running' as Process['status'],
      waitForPort: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue(mockProcess as any);
    mockSandbox.containerFetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const msg = createQueueMessage('{"update_id":42}', { 'content-type': 'application/json' });
    const batch = createBatch([msg]);
    const env = createMockEnv();

    await worker.queue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();

    // Verify the request was made to the correct port and path
    const [req, port] = mockSandbox.containerFetchMock.mock.calls[0];
    expect(port).toBe(8787);
    expect(req.url).toBe('http://localhost:8787/telegram-webhook');
    expect(req.method).toBe('POST');
  });

  it('retries message on non-2xx response', async () => {
    const mockProcess = {
      id: 'proc-1',
      status: 'running' as Process['status'],
      waitForPort: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue(mockProcess as any);
    mockSandbox.containerFetchMock.mockResolvedValue(new Response('error', { status: 500 }));

    const msg = createQueueMessage();
    const batch = createBatch([msg]);
    const env = createMockEnv();

    await worker.queue(batch, env);

    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('retries message when delivery throws', async () => {
    const mockProcess = {
      id: 'proc-1',
      status: 'running' as Process['status'],
      waitForPort: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue(mockProcess as any);
    mockSandbox.containerFetchMock.mockRejectedValue(new Error('network error'));

    const msg = createQueueMessage();
    const batch = createBatch([msg]);
    const env = createMockEnv();

    await worker.queue(batch, env);

    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });
});
