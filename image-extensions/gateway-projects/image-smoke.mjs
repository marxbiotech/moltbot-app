import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('./', import.meta.url));
const state = mkdtempSync(path.join(tmpdir(), 'gateway-project-plugin-'));
const env = { PATH: process.env.PATH, HOME: state, OPENCLAW_HOME: state, OPENCLAW_STATE_DIR: path.join(state, 'state'), OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'), OPENCLAW_NO_ONBOARD: '1', OPENCLAW_SUPPRESS_NOTES: '1', OPENCLAW_DISABLE_BUNDLED_PLUGINS: '1', AWS_EC2_METADATA_DISABLED: 'true', NODE_ENV: 'production' };
try {
  const workspace = path.join(state, 'workspace');
  const config = { agents: { ownership: 'explicit', defaults: { workspace, skills: [] }, entries: { main: { skills: ['gateway_project'] } } }, plugins: { allow: ['gateway-projects'], load: { paths: [pluginRoot] }, entries: { 'gateway-projects': { enabled: true, config: { projects: { example: { repository: 'example/repo', workspace, authorName: 'Example', authorEmail: 'example@example.invalid', slackAccountId: 'default', slackChannelIds: ['C123'] } } } } } } };
  writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  const invoke = args => JSON.parse(execFileSync(process.execPath, ['/app/openclaw.mjs', ...args, '--json'], { env, cwd: state, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 }));
  assert.equal(invoke(['config', 'validate']).valid, true);
  const report = invoke(['plugins', 'inspect', 'gateway-projects', '--runtime']);
  assert.equal(report.plugin.status, 'loaded', JSON.stringify(report.diagnostics));
  assert.deepEqual([...report.plugin.toolNames].sort(), ['gateway_project_github', 'gateway_project_prepare']);
  assert.equal(report.commands.length, 0);
  const skill = invoke(['skills', 'list', '--agent', 'main']).skills.find(s => s.name === 'gateway_project');
  assert(skill?.eligible && skill.modelVisible);
  assert.equal(skill.userInvocable, false);
  const { createTools } = await import('./index.mjs');
  const ctx = { config, agentId: 'main', workspaceDir: '/persona/workspace', messageChannel: 'slack', nativeChannelId: 'C123', agentAccountId: 'default', sessionKey: 'agent:main:slack:channel:c123' };
  assert.equal(createTools(ctx).length, 2);
  assert.equal(createTools({ ...ctx, nativeChannelId: 'COTHER' }), null);
  console.log('Verified gateway-projects plugin loading, tool contracts and agent-only skill discovery.');
} finally { rmSync(state, { recursive: true, force: true }); }
