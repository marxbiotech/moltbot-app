import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import plugin, { parseConfig } from '../index.js';
const PREFIX = '[reply-guard] ';
const rule = { id: 'line-errors', match: { context: { channelId: 'line' }, payload: { isError: true } } };
function setup(config, logger) {
  let hook;
  const logs = [];
  plugin.register({
    pluginConfig: config,
    logger: logger ?? { info: s => logs.push(JSON.parse(s.slice(PREFIX.length))) },
    on(name, callback) { assert.equal(name, 'reply_payload_sending'); hook = callback; },
  });
  return { hook, logs };
}
test('default and observation-only configurations allow all replies', () => {
  for (const config of [undefined, null, {}, { debug: true, rules: [] }]) assert.equal(setup(config).hook({ payload: { isError: true }, kind: 'final' }, { channelId: 'line' }), undefined);
});
test('LINE error cancellation preserves normal replies and other channels across lanes', () => {
  const { hook, logs } = setup({ rules: [rule] });
  for (const kind of ['tool', 'block', 'final']) {
    for (const channelId of ['line', 'discord', 'telegram']) {
      const result = hook({ kind, payload: { isError: true, mediaUrls: ['https://invalid.test/error'] } }, { channelId });
      assert.equal(result?.cancel === true, channelId === 'line');
    }
    for (const payload of [{ text: 'hello' }, { isError: false }, { text: 'sorry' }]) assert.equal(hook({ kind, payload }, { channelId: 'line' }), undefined);
  }
  assert.equal(logs.length, 0);
});
test('all conditions AND, rules OR; arrays use exact typed membership; absent never matches', () => {
  const { hook } = setup({ rules: [
    { id: 'narrow', match: { context: { channelId: ['line', 'telegram'], accountId: 'default', conversationId: ['group-a', 'group-b'] }, event: { kind: 'final' }, payload: { isError: true } } },
    { id: 'other', match: { context: { channelId: 'discord' } } },
  ] });
  const event = { kind: 'final', payload: { isError: true } };
  const ctx = { channelId: 'line', accountId: 'default', conversationId: 'group-a' };
  assert.equal(hook(event, ctx).cancel, true);
  for (const key of Object.keys(ctx)) {
    const { [key]: _removed, ...missing } = ctx;
    assert.equal(hook(event, missing), undefined);
  }
  assert.equal(hook({ ...event, kind: 'tool' }, ctx), undefined);
  assert.equal(hook({ ...event, payload: { isError: 'true' } }, ctx), undefined);
  assert.equal(hook(event, { channelId: 'discord' }).reason, 'reply-guard:other');
  assert.equal(setup({ rules: [{ id: 'null', match: { context: { accountId: null } } }] }).hook(event, {}), undefined);
});
test('null matches only a present null; numbers compare by type', () => {
  const event = { kind: 'final', payload: {} };
  const { hook } = setup({ rules: [{ id: 'nul', match: { context: { accountId: null } } }, { id: 'num', match: { context: { threadId: [1, 2] } } }] });
  assert.equal(hook(event, { accountId: null }).reason, 'reply-guard:nul');
  assert.equal(hook(event, { threadId: 2 }).reason, 'reply-guard:num');
  assert.equal(hook(event, { threadId: '1' }), undefined);
  assert.equal(hook(event, { threadId: 3 }), undefined);
});
test('a field the host sets to undefined counts as absent, and inherited keys never match', () => {
  const event = { kind: 'final', payload: {} };
  assert.equal(setup({ rules: [{ id: 'acct', match: { context: { accountId: 'default' } } }] }).hook(event, { accountId: undefined }), undefined);
  assert.equal(setup({ rules: [{ id: 'proto', match: { context: { constructor: 1 } } }, { id: 'proto2', match: { context: { toString: 'x' } } }] }).hook(event, {}), undefined);
  const { hook, logs } = setup({ debug: true, rules: [{ id: 'acct', match: { context: { accountId: 'default' } } }] });
  hook(event, { channelId: 'line', accountId: undefined });
  assert.equal(logs[0].rules[0].conditions[0].present, false);
  assert.equal('accountId' in logs[0].context, false);
});
test('several matching rules: reason names the first in config order, matchedRules lists all', () => {
  const { hook, logs } = setup({ debug: true, rules: [{ id: 'a', match: { context: { channelId: 'line' } } }, { id: 'b', match: { payload: { isError: true } } }] });
  assert.equal(hook({ kind: 'final', payload: { isError: true } }, { channelId: 'line' }).reason, 'reply-guard:a');
  assert.deepEqual(logs[0].matchedRules, ['a', 'b']);
});
test('malformed hook arguments do not throw', () => {
  const { hook } = setup({ rules: [rule] });
  for (const args of [[undefined, undefined], [{}, null], [{ kind: 'final' }, { channelId: 'line' }], [{ kind: 'final', payload: null }, { channelId: 'line' }]]) assert.equal(hook(...args), undefined);
});
test('debug logs routing values only: other context fields are omitted by name', () => {
  const { hook, logs } = setup({ debug: true, rules: [rule, { id: 'account', match: { context: { accountId: 'expected' } } }, { id: 'sender', match: { context: { senderId: 'u-1' } } }] });
  hook(
    { kind: 'final', payload: { text: 'PRIVATE_TEXT', mediaUrls: ['PRIVATE_URL'], isError: true } },
    { channelId: 'line', conversationId: 'group-a', sessionKey: 'agent:main:line:group', senderId: 'u-1', replyToBody: 'PRIVATE_QUOTE', replyToSender: 'PRIVATE_NAME', token: 'PRIVATE_TOKEN', apiKey: 'PRIVATE_KEY', extra: { password: 'PRIVATE_PASSWORD', count: 2 } },
  );
  assert.deepEqual(logs[0].context, {
    channelId: 'line', conversationId: 'group-a', sessionKey: 'agent:main:line:group',
    senderId: '[omitted]', replyToBody: '[omitted]', replyToSender: '[omitted]', token: '[omitted]', apiKey: '[omitted]', extra: '[omitted]',
  });
  assert.equal(logs[0].decision, 'cancel');
  assert.deepEqual(logs[0].matchedRules, ['line-errors', 'sender']);
  assert.equal(logs[0].rules[1].conditions[0].present, false);
  // Rules can match a field that is not echoed: the condition reports matched, not the value.
  const sender = logs[0].rules[2].conditions[0];
  assert.deepEqual([sender.present, sender.matched, 'actual' in sender], [true, true, false]);
  assert.equal(JSON.stringify(logs).includes('PRIVATE_'), false);
  hook({ kind: 'block', payload: {} }, { channelId: 'telegram' });
  assert.equal(logs[1].decision, 'allow');
  assert.equal(logs[1].rules[0].conditions[0].matched, false);
});
test('a non-scalar value under a routing key is omitted too', () => {
  const { hook, logs } = setup({ debug: true, rules: [] });
  hook({ kind: 'final', payload: {} }, { channelId: { nested: 'PRIVATE_NESTED' } });
  assert.equal(logs[0].context.channelId, '[omitted]');
  assert.equal(JSON.stringify(logs).includes('PRIVATE_'), false);
});
test('logger failure cannot bypass cancellation, and is reported through warn when possible', () => {
  const { hook } = setup({ debug: true, rules: [rule] }, { info() { throw new Error('disk full'); } });
  assert.equal(hook({ payload: { isError: true } }, { channelId: 'line' }).cancel, true);
  const warnings = [];
  const warned = setup({ debug: true, rules: [rule] }, { info() { throw new Error('disk full'); }, warn: s => warnings.push(s) });
  assert.equal(warned.hook({ payload: { isError: true } }, { channelId: 'line' }).cancel, true);
  assert.match(warnings[0], /debug log failed \(decision=cancel\): disk full/);
  const broken = setup({ debug: true, rules: [rule] }, { info() { throw new Error('x'); }, warn() { throw new Error('y'); } });
  assert.equal(broken.hook({ payload: { isError: true } }, { channelId: 'line' }).cancel, true);
});
test('register copies the config, so later mutation cannot change live rules', () => {
  const config = { rules: [{ id: 'live', match: { context: { channelId: 'line' } } }] };
  const { hook } = setup(config);
  config.rules[0].match.context.channelId = 'discord';
  assert.equal(hook({ kind: 'final', payload: {} }, { channelId: 'line' }).cancel, true);
});
// Each case names the rule or field it complains about, so an operator can find it.
const invalidConfigs = [
  [{ debug: 'true' }, /debug must be boolean/],
  [{ rules: {} }, /rules must be an array/],
  [{ rules: null }, /rules must be an array/],
  [{ extra: 1 }, /unknown config key "extra"/],
  [[], /config must be an object/],
  [{ rules: [null] }, /rules\[0\] must be an object/],
  [{ rules: [{ id: 'x', match: { context: { a: 1 } }, extra: 1 }] }, /rules\[0\] has unknown key "extra"/],
  [{ rules: [{ id: 7, match: { context: { a: 1 } } }] }, /rules\[0\] needs an id/],
  [{ rules: [{ id: 'bad id', match: { context: { a: 1 } } }] }, /rules\[0\] needs an id/],
  [{ rules: [rule, rule] }, /duplicate rule id "line-errors" at rules\[1\]/],
  [{ rules: [{ id: 'all', match: {} }] }, /rule "all" needs a non-empty match/],
  [{ rules: [{ id: 'bad', match: { context: {} } }] }, /rule "bad" needs a non-empty match\.context/],
  [{ rules: [{ id: 'bad', match: { other: { a: 1 } } }] }, /rule "bad" has unknown match section "other"/],
  [{ rules: [{ id: 'bad', match: { payload: { text: 'private' } } }] }, /rule "bad" has unsupported match field payload\.text/],
  [{ rules: [{ id: 'bad', match: { event: { text: 'x' } } }] }, /rule "bad" has unsupported match field event\.text/],
  [{ rules: [{ id: 'bad', match: { context: { 'a.b': 1 } } }] }, /rule "bad" has unsupported match field context\.a\.b/],
  [{ rules: [{ id: 'bad', match: { context: { channelId: [] } } }] }, /rule "bad" context\.channelId must be a scalar or a non-empty array/],
  [{ rules: [{ id: 'bad', match: { context: { channelId: { a: 1 } } } }] }, /rule "bad" context\.channelId must be a scalar/],
  [{ rules: [{ id: 'bad', match: { context: { n: Number.NaN } } }] }, /rule "bad" context\.n must be a scalar/],
  [{ rules: [{ id: 'bad', match: { event: { kind: 'unknown' } } }] }, /rule "bad" event\.kind must be one of tool\/block\/final/],
  [{ rules: [{ id: 'bad', match: { payload: { isError: 'true' } } }] }, /rule "bad" payload\.isError must be boolean/],
];
test('reject empty, duplicate, misspelled and malformed configs, naming the problem', () => {
  for (const [config, message] of invalidConfigs) assert.throws(() => parseConfig(config), message, JSON.stringify(config));
});
test('context keys are not restricted by name: only routing fields are ever echoed', () => {
  for (const key of ['token', 'text', 'senderId', 'tokenizerId']) assert.doesNotThrow(() => parseConfig({ rules: [{ id: 'k', match: { context: { [key]: 'x' } } }] }));
});
// The manifest schema must accept what parseConfig accepts (and vice versa), except
// duplicate ids, which JSON Schema cannot express. Walk the schema by hand: no validator dependency.
const schema = JSON.parse(fs.readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8')).configSchema;
function schemaAccepts(config) {
  const types = value => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
  const scalarOk = (value, allowed) => allowed.includes(types(value)) && (typeof value !== 'number' || Number.isFinite(value));
  const valueOk = (value, spec) => spec.anyOf.some(option => (option.type === 'array'
    ? Array.isArray(value) && value.length >= option.minItems && value.every(item => (option.items.enum ? option.items.enum.includes(item) : scalarOk(item, option.items.type)))
    : option.enum ? option.enum.includes(value) : option.type === 'boolean' ? typeof value === 'boolean' : scalarOk(value, option.type)));
  const isObject = value => types(value) === 'object';
  if (!isObject(config) || Object.keys(config).some(k => !(k in schema.properties))) return false;
  if (config.debug !== undefined && typeof config.debug !== 'boolean') return false;
  if (config.rules === undefined) return true;
  if (!Array.isArray(config.rules)) return false;
  const rulesSchema = schema.properties.rules.items;
  return config.rules.every(r => {
    if (!isObject(r) || Object.keys(r).some(k => !(k in rulesSchema.properties)) || typeof r.id !== 'string' || !new RegExp(rulesSchema.properties.id.pattern).test(r.id) || !isObject(r.match) || !Object.keys(r.match).length) return false;
    return Object.entries(r.match).every(([section, fields]) => {
      const sectionSchema = rulesSchema.properties.match.properties[section];
      if (!sectionSchema || !isObject(fields) || !Object.keys(fields).length) return false;
      return Object.entries(fields).every(([key, value]) => {
        if (section === 'context') return new RegExp(sectionSchema.propertyNames.pattern).test(key) && valueOk(value, sectionSchema.additionalProperties);
        return key in sectionSchema.properties && valueOk(value, sectionSchema.properties[key]);
      });
    });
  });
}
test('manifest schema and parseConfig agree on every shared valid/invalid config', () => {
  const valid = [undefined, {}, { debug: false }, { debug: true, rules: [] }, { rules: [rule] },
    { rules: [{ id: 'k', match: { context: { token: 'x', n: [1, 2], z: null }, event: { kind: ['tool', 'final'] }, payload: { isError: false } } }] }];
  for (const config of valid) {
    assert.doesNotThrow(() => parseConfig(config), JSON.stringify(config));
    if (config === undefined) continue; // absent config never reaches the schema
    assert.equal(schemaAccepts(config), true, JSON.stringify(config));
  }
  for (const [config] of invalidConfigs) {
    if (config?.rules?.length === 2 && config.rules[0] === config.rules[1]) continue; // duplicate ids: runtime-only
    assert.equal(schemaAccepts(config), false, JSON.stringify(config));
  }
});
