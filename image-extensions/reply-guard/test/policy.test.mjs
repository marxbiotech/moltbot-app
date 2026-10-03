import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { parseConfig } from '../index.js';
const rule = { id: 'line-errors', match: { context: { channelId: 'line' }, payload: { isError: true } } };
function setup(config, logger) {
  let hook; const logs = [];
  plugin.register({ pluginConfig: config, logger: logger ?? { info: s => logs.push(JSON.parse(s.slice('[reply-guard] '.length))) }, on(name, callback) { assert.equal(name, 'reply_payload_sending'); hook = callback; } });
  return { hook, logs };
}
test('default and observation-only configurations allow all replies', () => {
  for (const config of [undefined, {}, { debug: true, rules: [] }]) assert.equal(setup(config).hook({ payload: { isError: true }, kind: 'final' }, { channelId: 'line' }), undefined);
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
  const { hook } = setup({ rules: [ { id: 'narrow', match: { context: { channelId: ['line','telegram'], accountId: 'default', conversationId: ['group-a','group-b'] }, event: { kind: 'final' }, payload: { isError: true } } }, { id: 'other', match: { context: { channelId: 'discord' } } } ] });
  const event = { kind: 'final', payload: { isError: true } }, ctx = { channelId: 'line', accountId: 'default', conversationId: 'group-a' };
  assert.equal(hook(event, ctx).cancel, true);
  for (const key of Object.keys(ctx)) { const missing = { ...ctx }; delete missing[key]; assert.equal(hook(event, missing), undefined); }
  assert.equal(hook({ ...event, kind: 'tool' }, ctx), undefined);
  assert.equal(hook({ ...event, payload: { isError: 'true' } }, ctx), undefined);
  assert.equal(hook(event, { channelId: 'discord' }).reason, 'reply-guard:other');
  assert.equal(setup({ rules: [{ id:'null', match:{ context:{ accountId:null } } }] }).hook(event, {}), undefined);
});
test('debug reports context, missing/mismatched fields and allow/cancel without contents', () => {
  const { hook, logs } = setup({ debug: true, rules: [rule, { id: 'account', match: { context: { accountId: 'expected' } } }] });
  hook({ kind: 'final', payload: { text: 'PRIVATE_TEXT', mediaUrls: ['PRIVATE_URL'], isError: true } }, { channelId:'line', conversationId:'group-a', token:'PRIVATE_TOKEN', extra:{ password:'PRIVATE_PASSWORD', count:2 } });
  assert.equal(logs[0].context.channelId, 'line');
  assert.equal(logs[0].context.extra.count, 2);
  assert.equal(logs[0].decision, 'cancel');
  assert.deepEqual(logs[0].matchedRules, ['line-errors']);
  assert.equal(logs[0].rules[1].conditions[0].present, false);
  assert.equal(JSON.stringify(logs).includes('PRIVATE_'), false);
  hook({ kind:'block', payload:{} }, { channelId:'telegram' });
  assert.equal(logs[1].decision, 'allow');
  assert.equal(logs[1].rules[0].conditions[0].matched, false);
});
test('logger failure cannot bypass cancellation', () => {
  const { hook } = setup({ debug:true, rules:[rule] }, { info(){ throw new Error('disk full'); } });
  assert.equal(hook({ payload:{isError:true} }, { channelId:'line' }).cancel, true);
});
test('reject empty, duplicate, misspelled and malformed rules', () => {
  for (const config of [{ debug:'true' }, { rules:{} }, { rules:[rule,rule] }, { rules:[{id:'all',match:{}}] }, { rules:[{id:'bad',match:{context:{}}}] }, { rules:[{id:'bad',match:{payload:{text:'private'}}}] }, { rules:[{id:'bad',match:{context:{channelId:[]}}}] }, { rules:[{id:'bad',match:{event:{kind:'unknown'}}}] }, { rules:[{id:'bad',match:{payload:{isError:'true'}}}] }, { rules:[{id:'bad',match:{context:{token:'secret'}}}] }]) assert.throws(()=>parseConfig(config));
});
