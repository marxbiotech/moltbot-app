// Shared by policy.test.mjs (parseConfig) and image-smoke.mjs (the host's real
// JSON Schema validator), so a schema/parser drift fails the image build.
export const rule = { id: 'line-errors', match: { context: { channelId: 'line' }, payload: { isError: true } } };

export const validConfigs = [
  {},
  { debug: false },
  { debug: true, rules: [] },
  { rules: [rule] },
  { rules: [{ id: 'k', match: { context: { token: 'x', n: [1, 2], z: null }, event: { kind: ['tool', 'final'] }, payload: { isError: false } } }] },
];

// [config, expected parseConfig error, optional marker]. 'runtime-only' means JSON
// Schema cannot express the rule, so only parseConfig rejects it (rule-id uniqueness).
export const invalidConfigs = [
  [{ debug: 'true' }, /debug must be boolean/],
  [{ rules: {} }, /rules must be an array/],
  [{ rules: null }, /rules must be an array/],
  [{ extra: 1 }, /unknown config key "extra"/],
  [[], /config must be an object/],
  [{ rules: [null] }, /rules\[0\] must be an object/],
  [{ rules: [{ id: 'x', match: { context: { a: 1 } }, extra: 1 }] }, /rules\[0\] has unknown key "extra"/],
  [{ rules: [{ match: { context: { a: 1 } } }] }, /rules\[0\] needs an id/],
  [{ rules: [{ id: 7, match: { context: { a: 1 } } }] }, /rules\[0\] needs an id/],
  [{ rules: [{ id: 'bad id', match: { context: { a: 1 } } }] }, /rules\[0\] needs an id/],
  [{ rules: [{ id: 'bad' }] }, /rule "bad" needs a non-empty match/],
  [{ rules: [{ id: 'all', match: {} }] }, /rule "all" needs a non-empty match/],
  [{ rules: [{ id: 'bad', match: { context: {} } }] }, /rule "bad" needs a non-empty match\.context/],
  [{ rules: [{ id: 'bad', match: { other: { a: 1 } } }] }, /rule "bad" has unknown match section "other"/],
  [{ rules: [{ id: 'bad', match: { payload: { text: 'private' } } }] }, /rule "bad" has unsupported match field payload\.text/],
  [{ rules: [{ id: 'bad', match: { event: { text: 'x' } } }] }, /rule "bad" has unsupported match field event\.text/],
  [{ rules: [{ id: 'bad', match: { context: { 'a.b': 1 } } }] }, /rule "bad" has unsupported match field context\.a\.b/],
  [{ rules: [{ id: 'bad', match: { context: { channelId: [] } } }] }, /rule "bad" context\.channelId must be a scalar or a non-empty array/],
  [{ rules: [{ id: 'bad', match: { context: { channelId: { a: 1 } } } }] }, /rule "bad" context\.channelId must be a scalar/],
  [{ rules: [{ id: 'bad', match: { context: { channelId: [['x']] } } }] }, /rule "bad" context\.channelId must be a scalar/],
  [{ rules: [{ id: 'bad', match: { event: { kind: 'unknown' } } }] }, /rule "bad" event\.kind must be one of tool\/block\/final/],
  [{ rules: [{ id: 'bad', match: { payload: { isError: 'true' } } }] }, /rule "bad" payload\.isError must be boolean/],
  [{ rules: [rule, rule] }, /duplicate rule id "line-errors" at rules\[1\]/, 'runtime-only'],
];
