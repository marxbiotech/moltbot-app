import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('./', import.meta.url));
const state = mkdtempSync(path.join(tmpdir(), 'gateway-project-plugin-'));
const env = { PATH: process.env.PATH, HOME: state, OPENCLAW_HOME: state, OPENCLAW_STATE_DIR: path.join(state, 'state'), OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'), OPENCLAW_NO_ONBOARD: '1', OPENCLAW_SUPPRESS_NOTES: '1', OPENCLAW_DISABLE_BUNDLED_PLUGINS: '1', AWS_EC2_METADATA_DISABLED: 'true', NODE_ENV: 'production' };
try {
  const workspace = path.join(state, 'workspace');
  const skillDir = path.join(workspace, 'skills/gateway_project');
  mkdirSync(skillDir, { recursive: true });
  // Mirrors the env-owned mount: the plugin must not publish a global skill.
  writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: gateway_project\ndescription: Use the assigned project tools.\nuser-invocable: false\n---\nUse gateway_project_prepare.\n');
  writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify({ agents: { defaults: { workspace } }, plugins: { allow: ['gateway-projects'], load: { paths: [pluginRoot] }, entries: { 'gateway-projects': { enabled: true } } } }));
  const invoke = args => JSON.parse(execFileSync(process.execPath, ['/app/openclaw.mjs', ...args, '--json'], { env, cwd: state, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 }));
  const report = invoke(['plugins', 'inspect', 'gateway-projects', '--runtime']);
  assert.equal(report.plugin.status, 'loaded', JSON.stringify(report.diagnostics));
  assert.deepEqual([...report.plugin.toolNames].sort(), ['gateway_project_github', 'gateway_project_prepare']);
  assert.equal(report.commands.length, 0);
  const skill = invoke(['skills', 'list']).skills.find(s => s.name === 'gateway_project');
  assert(skill?.eligible && skill.modelVisible);
  assert.equal(skill.userInvocable, false);
  console.log('Verified gateway-projects plugin loading, tool contracts and agent-only skill discovery.');
} finally { rmSync(state, { recursive: true, force: true }); }
