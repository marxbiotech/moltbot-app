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
import type { WebhookSource } from './types';
import worker from './index';

function createQueueMessage(
  source: WebhookSource = 'telegram',
  body: string = '{"update_id":1}',
  headers: Record<string, string> = {},
) {
  return {
    body: { source, rawBody: body, headers },
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
    queue: 'webhook-queue',
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
    const msg1 = createQueueMessage('telegram');
    const msg2 = createQueueMessage('telegram');
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

    const msg1 = createQueueMessage('telegram');
    const msg2 = createQueueMessage('telegram');
    const batch = createBatch([msg1, msg2]);
    const env = createMockEnv();

    await worker.queue(batch, env);

    // Telegram needs ports 8787 + 18789; first failure triggers retry for all
    expect(mockProcess.waitForPort).toHaveBeenCalledWith(8787, { mode: 'tcp', timeout: 10_000 });
    expect(msg1.retry).toHaveBeenCalledOnce();
    expect(msg2.retry).toHaveBeenCalledOnce();
    expect(msg1.ack).not.toHaveBeenCalled();
    expect(ensureMoltbotGateway).not.toHaveBeenCalled();
  });

  it('acks telegram message on successful delivery', async () => {
    const mockProcess = {
      id: 'proc-1',
      status: 'running' as Process['status'],
      waitForPort: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue(mockProcess as any);
    mockSandbox.containerFetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const msg = createQueueMessage('telegram', '{"update_id":42}', { 'content-type': 'application/json' });
    const batch = createBatch([msg]);
    const env = createMockEnv();

    await worker.queue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();

    const [req, port] = mockSandbox.containerFetchMock.mock.calls[0];
    expect(port).toBe(8787);
    expect(req.url).toBe('http://localhost:8787/telegram-webhook');
    expect(req.method).toBe('POST');
  });

  it('acks slack message on successful delivery with re-signed headers', async () => {
    const mockProcess = {
      id: 'proc-1',
      status: 'running' as Process['status'],
      waitForPort: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue(mockProcess as any);
    mockSandbox.containerFetchMock.mockResolvedValue(new Response('', { status: 200 }));

    const msg = createQueueMessage('slack', '{"event":{"type":"message"}}', {
      'content-type': 'application/json',
      'X-Slack-Request-Timestamp': '1234567890',
      'X-Slack-Signature': 'v0=abc123',
    });
    const batch = createBatch([msg]);
    const env = createMockEnv({ SLACK_SIGNING_SECRET: 'test-signing-secret' });

    await worker.queue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();

    const [req, port] = mockSandbox.containerFetchMock.mock.calls[0];
    expect(port).toBe(18789);
    expect(req.url).toBe('http://localhost:18789/slack/events');
    expect(req.method).toBe('POST');

    // Verify headers were re-signed with fresh timestamp (not the original stale one)
    const deliveredTimestamp = req.headers.get('X-Slack-Request-Timestamp');
    const deliveredSignature = req.headers.get('X-Slack-Signature');
    expect(deliveredTimestamp).not.toBe('1234567890');
    expect(Number(deliveredTimestamp)).toBeGreaterThan(1234567890);
    expect(deliveredSignature).toMatch(/^v0=[0-9a-f]{64}$/);
  });

  it('retries message on non-2xx response', async () => {
    const mockProcess = {
      id: 'proc-1',
      status: 'running' as Process['status'],
      waitForPort: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue(mockProcess as any);
    mockSandbox.containerFetchMock.mockResolvedValue(new Response('error', { status: 500 }));

    const msg = createQueueMessage('telegram');
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

    const msg = createQueueMessage('telegram');
    const batch = createBatch([msg]);
    const env = createMockEnv();

    await worker.queue(batch, env);

    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('delivers mixed telegram+slack batch to correct targets', async () => {
    const mockProcess = {
      id: 'proc-1',
      status: 'running' as Process['status'],
      waitForPort: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue(mockProcess as any);
    mockSandbox.containerFetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const telegramMsg = createQueueMessage('telegram', '{"update_id":1}', { 'content-type': 'application/json' });
    const slackMsg = createQueueMessage('slack', '{"event":{"type":"message"}}', {
      'content-type': 'application/json',
      'X-Slack-Request-Timestamp': '1234567890',
      'X-Slack-Signature': 'v0=abc123',
    });
    const batch = createBatch([telegramMsg, slackMsg]);
    const env = createMockEnv({ SLACK_SIGNING_SECRET: 'test-signing-secret' });

    await worker.queue(batch, env);

    // Both ports checked (8787 for telegram target, 18789 for slack target + telegram extraPorts)
    const portCalls = mockProcess.waitForPort.mock.calls.map((call) => call[0] as number);
    expect(portCalls).toContain(8787);
    expect(portCalls).toContain(18789);

    // Both messages delivered successfully
    expect(telegramMsg.ack).toHaveBeenCalledOnce();
    expect(slackMsg.ack).toHaveBeenCalledOnce();
    expect(telegramMsg.retry).not.toHaveBeenCalled();
    expect(slackMsg.retry).not.toHaveBeenCalled();

    // Verify correct routing
    expect(mockSandbox.containerFetchMock).toHaveBeenCalledTimes(2);
    const [telegramReq, telegramPort] = mockSandbox.containerFetchMock.mock.calls[0];
    expect(telegramPort).toBe(8787);
    expect(telegramReq.url).toBe('http://localhost:8787/telegram-webhook');
    const [slackReq, slackPort] = mockSandbox.containerFetchMock.mock.calls[1];
    expect(slackPort).toBe(18789);
    expect(slackReq.url).toBe('http://localhost:18789/slack/events');
  });

  it('retries all messages when findExistingMoltbotProcess throws', async () => {
    vi.mocked(findExistingMoltbotProcess).mockRejectedValue(new Error('sandbox API error'));
    const msg = createQueueMessage('telegram');
    const batch = createBatch([msg]);
    const env = createMockEnv();

    await worker.queue(batch, env);

    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
    expect(ensureMoltbotGateway).not.toHaveBeenCalled();
  });

  it('acks message with unknown source', async () => {
    const mockProcess = {
      id: 'proc-1',
      status: 'running' as Process['status'],
      waitForPort: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(findExistingMoltbotProcess).mockResolvedValue(mockProcess as any);

    const msg = createQueueMessage('unknown' as any);
    const batch = createBatch([msg]);
    const env = createMockEnv();

    await worker.queue(batch, env);

    // Unknown source should be acked (dropped) to avoid infinite retries
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });
});
