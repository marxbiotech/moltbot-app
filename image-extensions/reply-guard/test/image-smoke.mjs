import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import plugin, { parseConfig } from '../index.js';
import { invalidConfigs, validConfigs } from './config-cases.mjs';
// Required image-build integration test against the installed host (/app/dist,
// override with OPENCLAW_DIST). Imports the host's real hook runner and its
// before-deliver / durable-preparation boundaries in this process, never the live
// Gateway. It checks the hook's decision at each boundary; it does not count
// calls to a transport.
// Design Decision: not driving the full inbound dispatcher into a counting
// sendText stub. The boundary functions above are the units the host composes, and
// a dispatcher fixture would depend on far more host internals than this regex
// export discovery already does. Revisit if the host exposes a stable test seam.
const dist = process.env.OPENCLAW_DIST ?? '/app/dist';
const modules = fs.readdirSync(dist).filter(n => n.endsWith('.mjs')).map(n => [n, fs.readFileSync(`${dist}/${n}`, 'utf8')]);
async function runtimeExport(name) {
  for (const [file, source] of modules) {
    const exports = [...source.matchAll(/export\s*\{([^}]+)\}/g)].map(m => m[1]).join(',');
    const match = exports.match(new RegExp(`(?:^|[,\\s])${name}\\s+as\\s+(\\w+)`));
    if (match) return (await import(pathToFileURL(`${dist}/${file}`).href))[match[1]];
  }
  throw new Error(`Runtime export not found: ${name}`);
}
const initialize = await runtimeExport('initializeGlobalHookRunner');
const beforeDelivery = await runtimeExport('buildInboundReplyPayloadSendingBeforeDeliver');
const loadPlugins = await runtimeExport('loadOpenClawPlugins');
const setRegistry = await runtimeExport('setActivePluginRegistry');
const validateSchema = await runtimeExport('validateJsonSchemaValue');
const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const lineErrors = { id: 'line-errors', match: { context: { channelId: 'line' }, payload: { isError: true } } };
const load = entry => loadPlugins({
  config: { plugins: { allow: [plugin.id], load: { paths: [pluginDir] }, entries: { [plugin.id]: { enabled: true, ...entry } } } },
  onlyPluginIds: [plugin.id], mode: 'full', cache: false, activate: false,
});
const hooksOf = registry => registry.typedHooks.filter(h => h.pluginId === plugin.id && h.hookName === 'reply_payload_sending');

// The manifest schema (checked by the host's own validator, so the host's real
// AJV rules apply) and parseConfig must agree on every shared config. A schema that
// accepts what parseConfig rejects would pass host validation and then fail open at
// register(). Duplicate ids are the one thing JSON Schema cannot express.
const { configSchema } = JSON.parse(fs.readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
const hostAccepts = value => validateSchema({ schema: configSchema, cacheKey: 'reply-guard-smoke-parity', value }).ok;
for (const config of validConfigs) {
  assert.doesNotThrow(() => parseConfig(config), JSON.stringify(config));
  assert.equal(hostAccepts(config), true, `host schema should accept ${JSON.stringify(config)}`);
}
for (const [config, , marker] of invalidConfigs) {
  assert.equal(hostAccepts(config), marker === 'runtime-only', `host schema vs parser mismatch for ${JSON.stringify(config)}`);
}
console.log('PASS: host JSON Schema validator and parseConfig agree on every shared config');

// An entry with no config block must still load, and needs no conversation-access grant.
// (The loader may hand the plugin schema defaults; parseConfig(undefined) is a unit test.)
const bare = await load({});
assert.equal(bare.plugins.find(p => p.id === plugin.id)?.status, 'loaded');
assert.equal(hooksOf(bare).length, 1);
const registry = await load({ config: { rules: [lineErrors] } });
assert.equal(registry.plugins.find(p => p.id === plugin.id)?.status, 'loaded');
assert.equal(hooksOf(registry).length, 1);
console.log('PASS: actual plugin loader registers exactly one outbound hook, with or without config');

registry.channels.push({ pluginId: 'fixture-line', plugin: { id: 'line', outbound: { deliveryMode: 'direct', sendText: async () => { throw new Error('Unexpected network send in isolated test'); } } } });
setRegistry(registry);
initialize(registry);
for (const channel of ['line', 'discord', 'telegram']) {
  const hook = beforeDelivery({ Body: 'fixture', From: `${channel}:group:fixture`, To: `${channel}:group:fixture`, OriginatingTo: `${channel}:group:fixture`, OriginatingChannel: channel, Provider: channel, Surface: channel, SessionKey: `agent:main:${channel}:group:fixture`, ChatType: 'group' }, { runId: 'isolated-test' });
  for (const kind of ['tool', 'block', 'final']) {
    const result = await hook({ text: 'synthetic tool failure', isError: true }, { kind });
    assert.equal(result === null, channel === 'line'); // LINE errors come back null; every other channel gets a payload to deliver.
  }
  assert.equal((await hook({ text: '正常回覆' }, { kind: 'final' })).text, '正常回覆');
}
console.log('PASS: real image hook runner + inbound before-deliver hook cancel LINE errors');

const prepare = await runtimeExport('prepareOutboundPayloadBatch');
const queuedHook = { kind: 'final', channel: 'line', sessionKey: 'agent:main:line:group:fixture', context: { channelId: 'line', accountId: 'default', conversationId: 'Cfixture' } };
const prepareLine = payload => prepare({ cfg: {}, channel: 'line', to: 'Cfixture', payloads: [payload], replyPayloadSendingHook: structuredClone(queuedHook) });
for (let attempt = 0; attempt < 2; attempt++) {
  const result = await prepareLine({ text: 'failed', isError: true });
  assert.equal(result.entries[0].status, 'suppressed');
  assert.equal(result.entries[0].reason, 'cancelled_by_reply_payload_sending_hook');
}
// Negative control: a normal LINE reply on the same path must not be suppressed by this hook.
const normal = await prepareLine({ text: '正常回覆' });
assert.equal(normal.entries[0].status, 'accepted');
assert.equal(normal.entries[0].payload.text, '正常回覆');
console.log('PASS: durable/replayed payload preparation reports suppression for LINE errors only, not retryable failure');
