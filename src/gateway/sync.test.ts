import { describe, it, expect, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { syncToR2 } from './sync';
import type { SyncResult } from './sync';
import {
  createMockEnv,
  createMockEnvWithR2,
  createMockExecResult,
  createMockSandbox,
  suppressConsole,
} from '../test-utils';
import type { MoltbotEnv } from '../types';

/** Standard exec mock sequence for a successful sync through openclaw config dir. */
function mockSuccessSequence(execMock: Mock, configDir = 'openclaw', timestamp = '2026-01-27') {
  execMock
    .mockResolvedValueOnce(createMockExecResult('yes')) // rclone configured
    .mockResolvedValueOnce(createMockExecResult(configDir)) // config detect
    .mockResolvedValueOnce(createMockExecResult()) // rclone sync config
    .mockResolvedValueOnce(createMockExecResult()) // rclone sync workspace
    .mockResolvedValueOnce(createMockExecResult()) // date > last-sync
    .mockResolvedValueOnce(createMockExecResult(timestamp)); // cat last-sync
}

describe('syncToR2', () => {
  beforeEach(() => {
    suppressConsole();
  });

  // ── Result-focused tests ───────────────────────────────────

  const resultCases: {
    name: string;
    setup: () => { sandbox: ReturnType<typeof createMockSandbox>['sandbox']; env: MoltbotEnv; execMock: Mock };
    expected: Partial<SyncResult>;
  }[] = [
    {
      name: 'returns error when R2 is not configured',
      setup: () => {
        const { sandbox, execMock } = createMockSandbox();
        return { sandbox, env: createMockEnv(), execMock };
      },
      expected: { success: false, error: 'R2 storage is not configured' },
    },
    {
      name: 'returns error when no config file found',
      setup: () => {
        const { sandbox, execMock } = createMockSandbox();
        execMock
          .mockResolvedValueOnce(createMockExecResult('yes'))
          .mockResolvedValueOnce(createMockExecResult('none'));
        return { sandbox, env: createMockEnvWithR2(), execMock };
      },
      expected: { success: false, error: 'Sync aborted: no config file found' },
    },
    {
      name: 'returns error when config sync fails',
      setup: () => {
        const { sandbox, execMock } = createMockSandbox();
        execMock
          .mockResolvedValueOnce(createMockExecResult('yes'))
          .mockResolvedValueOnce(createMockExecResult('openclaw'))
          .mockResolvedValueOnce(
            createMockExecResult('', { exitCode: 1, success: false, stderr: 'rclone error' }),
          );
        return { sandbox, env: createMockEnvWithR2(), execMock };
      },
      expected: { success: false, error: 'Config sync failed' },
    },
    {
      name: 'returns success with timestamp after sync',
      setup: () => {
        const { sandbox, execMock } = createMockSandbox();
        mockSuccessSequence(execMock, 'openclaw', '2026-01-27T12:00:00+00:00');
        return { sandbox, env: createMockEnvWithR2(), execMock };
      },
      expected: { success: true, lastSync: '2026-01-27T12:00:00+00:00' },
    },
  ];

  it.each(resultCases)('$name', async ({ setup, expected }) => {
    const { sandbox, env } = setup();
    const result = await syncToR2(sandbox, env);

    for (const [key, value] of Object.entries(expected)) {
      expect(result[key as keyof SyncResult]).toBe(value);
    }
  });

  // ── Config sync command tests ──────────────────────────────

  const configCmdCases: {
    name: string;
    configDir: string;
    envOverrides: Partial<MoltbotEnv>;
    assertions: (cmd: string) => void;
  }[] = [
    {
      name: 'uses rclone sync (not copy) to propagate deletions',
      configDir: 'openclaw',
      envOverrides: {},
      assertions: (cmd) => {
        expect(cmd).toMatch(/^rclone sync /);
      },
    },
    {
      name: 'includes --transfers=16, excludes .git, targets correct paths',
      configDir: 'openclaw',
      envOverrides: {},
      assertions: (cmd) => {
        expect(cmd).toContain('--transfers=16');
        expect(cmd).toContain("--exclude='.git/**'");
        expect(cmd).toContain('/root/.openclaw/');
        expect(cmd).toContain('r2:moltbot-data/openclaw/');
      },
    },
    {
      name: 'falls back to legacy clawdbot config directory',
      configDir: 'clawdbot',
      envOverrides: {},
      assertions: (cmd) => {
        expect(cmd).toContain('/root/.clawdbot/');
      },
    },
    {
      name: 'uses custom bucket name',
      configDir: 'openclaw',
      envOverrides: { R2_BUCKET_NAME: 'my-custom-bucket' },
      assertions: (cmd) => {
        expect(cmd).toContain('r2:my-custom-bucket/openclaw/');
      },
    },
  ];

  it.each(configCmdCases)('$name', async ({ configDir, envOverrides, assertions }) => {
    const { sandbox, execMock } = createMockSandbox();
    mockSuccessSequence(execMock, configDir);

    await syncToR2(sandbox, createMockEnvWithR2(envOverrides));

    const configSyncCmd = execMock.mock.calls[2][0];
    assertions(configSyncCmd);
  });
});
