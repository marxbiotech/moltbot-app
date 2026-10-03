import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import plugin from '../index.js';
// Optional integration against the exact deployed image. Import its real hook
// runner and dispatcher boundary in a separate process, never the live Gateway.
{
  process.env.OPENCLAW_DIST ??= '/app/dist';
  process.env.LINE_GUARD_MODULE ??= new URL('../index.js', import.meta.url).pathname;
  const dist = process.env.OPENCLAW_DIST;
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
  const pluginDir = new URL('.', pathToFileURL(process.env.LINE_GUARD_MODULE)).pathname;
  const registry = await loadPlugins({
    config: { plugins: { allow: [plugin.id], load: { paths: [pluginDir] }, entries: { [plugin.id]: { enabled: true, config: { rules: [{ id: 'line-errors', match: { context: { channelId: 'line' }, payload: { isError: true } } }] }, hooks: { allowConversationAccess: true } } } } },
    onlyPluginIds: [plugin.id], mode: 'full', cache: false, activate: false,
  });
  assert.equal(registry.plugins.find(p => p.id === plugin.id)?.status, 'loaded');
  assert.equal(registry.typedHooks.filter(h => h.pluginId === plugin.id && h.hookName === 'reply_payload_sending').length, 1);
  console.log('PASS: actual plugin loader registers exactly one outbound hook');
  registry.channels.push({ pluginId: 'fixture-line', plugin: { id: 'line', outbound: { deliveryMode: 'direct', sendText: async () => { throw new Error('Unexpected network send in isolated test'); } } } });
  setRegistry(registry);
  initialize(registry);
  let sends = 0;
  for (const channel of ['line', 'discord', 'telegram']) {
    const hook = beforeDelivery({ Body: 'fixture', From: `${channel}:group:fixture`, To: `${channel}:group:fixture`, OriginatingTo: `${channel}:group:fixture`, OriginatingChannel: channel, Provider: channel, Surface: channel, SessionKey: `agent:main:${channel}:group:fixture`, ChatType: 'group' }, { runId: 'isolated-test' });
    for (const kind of ['tool', 'block', 'final']) {
      const payload = { text: 'synthetic tool failure', isError: true };
      const result = await hook(payload, { kind });
      assert.equal(result === null, channel === 'line');
      if (result !== null) sends++;
    }
    assert.equal((await hook({ text: '正常回覆' }, { kind: 'final' })).text, '正常回覆');
  }
  assert.equal(sends, 6); // Only Discord and Telegram crossed the transport boundary.
  console.log('PASS: real image hook runner + inbound dispatcher cancel LINE errors before transport');
  const prepare = await runtimeExport('prepareOutboundPayloadBatch');
  const queuedHook = { kind: 'final', channel: 'line', sessionKey: 'agent:main:line:group:fixture', context: { channelId: 'line', accountId: 'default', conversationId: 'fixture' } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await prepare({ cfg: {}, channel: 'line', to: 'Cfixture', payloads: [{ text: 'failed', isError: true }], replyPayloadSendingHook: JSON.parse(JSON.stringify(queuedHook)) });
    assert.equal(result.entries[0].status, 'suppressed');
    assert.equal(result.entries[0].reason, 'cancelled_by_reply_payload_sending_hook');
  }
  console.log('PASS: durable/replayed payload preparation reports suppression, not retryable failure');
}
