import { describe, it, expect, vi, beforeEach } from 'vitest';
import { suppressConsole } from './test-utils';

// Mock the base Sandbox class from @cloudflare/sandbox
vi.mock('@cloudflare/sandbox', () => {
  class MockSandbox {
    env: any;
    constructor(_state: any, env: any) {
      this.env = env;
    }
    onStart() {}
    async onStop() {}
    onError(_error: unknown) {}
    async onActivityExpired() {}
  }
  return { Sandbox: MockSandbox };
});

import { MoltbotSandbox } from './sandbox';

function createInstance(env: Record<string, string | undefined> = {}) {
  const state = {} as any;
  return new MoltbotSandbox(state, env as any);
}

describe('MoltbotSandbox', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    suppressConsole();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}'));
  });

  describe('onStart', () => {
    it('calls Telegram API with correct message when both env vars are set', () => {
      const instance = createInstance({
        TELEGRAM_BOT_TOKEN: 'bot123',
        TELEGRAM_LIFECYCLE_CHAT_ID: '456',
      });

      instance.onStart();

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.telegram.org/botbot123/sendMessage');
      expect(init).toMatchObject({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = JSON.parse(init!.body as string);
      expect(body.chat_id).toBe('456');
      expect(body.text).toContain('Container');
    });

    it('skips notification when TELEGRAM_BOT_TOKEN is not set', () => {
      const instance = createInstance({
        TELEGRAM_LIFECYCLE_CHAT_ID: '456',
      });

      instance.onStart();

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('skips notification when TELEGRAM_LIFECYCLE_CHAT_ID is not set', () => {
      const instance = createInstance({
        TELEGRAM_BOT_TOKEN: 'bot123',
      });

      instance.onStart();

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('onStop', () => {
    it('calls Telegram API with correct message when both env vars are set', async () => {
      const instance = createInstance({
        TELEGRAM_BOT_TOKEN: 'bot123',
        TELEGRAM_LIFECYCLE_CHAT_ID: '456',
      });

      await instance.onStop();

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.telegram.org/botbot123/sendMessage');
      const body = JSON.parse(init!.body as string);
      expect(body.chat_id).toBe('456');
      expect(body.text).toContain('Container');
    });

    it('skips notification when TELEGRAM_BOT_TOKEN is not set', async () => {
      const instance = createInstance({
        TELEGRAM_LIFECYCLE_CHAT_ID: '456',
      });

      await instance.onStop();

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('skips notification when TELEGRAM_LIFECYCLE_CHAT_ID is not set', async () => {
      const instance = createInstance({
        TELEGRAM_BOT_TOKEN: 'bot123',
      });

      await instance.onStop();

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('onError', () => {
    it('calls Telegram API with error message for Error instances', () => {
      const instance = createInstance({
        TELEGRAM_BOT_TOKEN: 'bot123',
        TELEGRAM_LIFECYCLE_CHAT_ID: '456',
      });

      instance.onError(new Error('something broke'));

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body.text).toContain('something broke');
    });

    it('calls Telegram API with stringified error for non-Error instances', () => {
      const instance = createInstance({
        TELEGRAM_BOT_TOKEN: 'bot123',
        TELEGRAM_LIFECYCLE_CHAT_ID: '456',
      });

      instance.onError('string error');

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body.text).toContain('string error');
    });

    it('skips notification when TELEGRAM_BOT_TOKEN is not set', () => {
      const instance = createInstance({
        TELEGRAM_LIFECYCLE_CHAT_ID: '456',
      });

      instance.onError(new Error('test'));

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('skips notification when TELEGRAM_LIFECYCLE_CHAT_ID is not set', () => {
      const instance = createInstance({
        TELEGRAM_BOT_TOKEN: 'bot123',
      });

      instance.onError(new Error('test'));

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('sends version update notification for version rollout errors', () => {
      const instance = createInstance({
        TELEGRAM_BOT_TOKEN: 'bot123',
        TELEGRAM_LIFECYCLE_CHAT_ID: '456',
      });

      instance.onError(new Error('Runtime signalled the container to exit due to a new version rollout: 0'));

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body.text).toContain('版本更新');
      expect(body.text).not.toContain('錯誤');
    });
  });
});
