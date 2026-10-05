import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import test from 'node:test';
import plugin, { createTools } from './index.mjs';
import { loadConfig } from './config.mjs';
import { runCli } from './process.mjs';

const p = { repository: 'example/capsule', workspace: os.tmpdir(), slackChannelIds: ['C123'] };
const context = { agentId: 'main', workspaceDir: '/persona/workspace', messageChannel: 'slack', nativeChannelId: 'C123', sessionKey: 'agent:main:slack:channel:c123:thread:123.45' };
test('registers optional agent tools, never a user command', () => {
  const registrations = [];
  plugin.register({ registerTool: (...args) => registrations.push(args), registerCommand: () => assert.fail('no slash command') });
  const manifest = JSON.parse(fs.readFileSync(new URL('./openclaw.plugin.json', import.meta.url)));
  assert.deepEqual(registrations[0][1], { names: manifest.contracts.tools, optional: true });
  for (const name of manifest.contracts.tools) assert.equal(manifest.toolMetadata[name].optional, true);
  assert.deepEqual(manifest.skills, ['./skills']);
  assert.match(fs.readFileSync(new URL('./skills/gateway_project/SKILL.md', import.meta.url), 'utf8'), /user-invocable: false/);
});
test('only assigned runtime context gets tools; revoked assignment fails before spawn', async () => {
  let declared = { capsule: p }; const calls = [];
  const deps = { registry: () => declared, project: () => p, run: async (argv, options) => { calls.push({ argv, options }); return { exitCode: 0, stdout: JSON.stringify({ worktree: '/task' }), stderr: '' }; } };
  for (const change of [{ nativeChannelId: 'COTHER' }, { messageChannel: 'telegram' }, { agentAccountId: 'other' }, { sessionKey: '' }, { sandboxed: true }]) assert.equal(createTools({ ...context, ...change }, deps), null);
  assert(createTools({ ...context, agentId: 'another-persona-agent', workspaceDir: '/different' }, deps));
  assert.equal(createTools(context, { ...deps, registry: () => ({ capsule: p, ambiguous: p }) }), null);
  const tools = createTools(context, deps);
  const abort = new AbortController();
  const prepared = await tools[0].execute('1', { task: 'issue-42' }, abort.signal);
  assert.deepEqual(prepared.details, { worktree: '/task' });
  assert.deepEqual(calls[0].argv.slice(1), ['prepare', 'capsule', `${context.sessionKey}:issue-42`]);
  assert.equal(calls[0].options.signal, abort.signal);
  await tools[1].execute('2', { args: ['pr', 'create', '--title', 'literal $(text); not shell'] });
  assert.deepEqual(calls[1].argv.slice(1), ['gh', 'capsule', 'pr', 'create', '--title', 'literal $(text); not shell']);
  assert.equal((await tools[1].execute('3', { args: [] })).isError, true);
  declared = {};
  assert.equal((await tools[0].execute('4', { task: 'issue-42' })).isError, true);
  assert.equal(calls.length, 2);
});
test('subprocess is asynchronous, forwards exit status, redacts credentials and bounds output', async () => {
  let ticked = false;
  const promise = runCli(['-e', 'setTimeout(()=>{console.log(process.env.AGENT_GITHUB_PAT);console.error("problem");process.exit(7)},80)'], { env: { ...process.env, AGENT_GITHUB_PAT: 'fixture-token' } });
  setTimeout(() => { ticked = true; }, 10);
  const output = await promise;
  assert(ticked);
  assert.equal(output.exitCode, 7);
  assert.equal(output.stdout.trim(), '[REDACTED]');
  assert.match(output.stderr, /problem/);
  await assert.rejects(runCli(['-e', 'console.log("x".repeat(10000))'], { maxBytes: 32 }), /output exceeded/);
  await assert.rejects(runCli(['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 30 }), /timed out/);
});
test('abort terminates the CLI process group', async () => {
  const controller = new AbortController();
  const promise = runCli(['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(promise, /cancelled/);
});

test('native config supplies a selected CLI snapshot and live revocation', async () => {
  const project = { ...p, authorName: 'Test', authorEmail: 'test@example.invalid' };
  let config = { plugins: { entries: { 'gateway-projects': { enabled: true, config: { projects: { capsule: project } } } } } };
  const calls = [];
  const tools = createTools({ ...context, getRuntimeConfig: () => config }, { run: async (_argv, options) => {
    calls.push(options);
    assert.deepEqual(loadConfig(options.env), { capsule: project });
    return { exitCode: 0, stdout: '{}', stderr: '' };
  } });
  assert.equal((await tools[0].execute('1', { task: 'issue-42' })).isError, undefined);
  config.plugins.entries['gateway-projects'].enabled = false;
  assert.equal((await tools[0].execute('2', { task: 'issue-42' })).isError, true);
  assert.equal(calls.length, 1);
});
