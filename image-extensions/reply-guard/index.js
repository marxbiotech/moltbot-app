// Design Decision: this guard fails open. A register-time error (invalid config)
// leaves no hook installed, and a handler error is logged by the host and the
// reply is delivered. Suppression must never take down unrelated replies, so
// the signal for a dead guard is the host's `[plugins] reply-guard failed` line.
const CONFIG_KEYS = ['debug', 'rules'];
const RULE_KEYS = ['id', 'match'];
const SECTIONS = ['context', 'event', 'payload'];
const KINDS = ['tool', 'block', 'final'];
// Debug prints values for these routing fields only. Every other context field
// (sender ids, quoted message bodies, trace ids, anything a future host adds) is
// reported by name as '[omitted]', so the log cannot leak content the host puts
// in the hook context.
const LOGGED_CONTEXT = ['channelId', 'accountId', 'conversationId', 'sessionKey'];
const ID = /^[a-zA-Z0-9_-]+$/;
const KEY = /^[a-zA-Z][a-zA-Z0-9_]*$/;

// A field the host sets to undefined counts as absent.
const own = (value, key) => value != null && Object.hasOwn(value, key) && value[key] !== undefined;
const scalar = value => value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const asList = value => (Array.isArray(value) ? value : [value]);

// Validate even when a host bypasses manifest validation. Never interpret an
// invalid/empty rule as a catch-all cancellation rule. The manifest schema in
// openclaw.plugin.json must accept exactly what this accepts, except rule-id
// uniqueness, which JSON Schema cannot express.
export function parseConfig(config) {
  config ??= {};
  if (!object(config)) throw new Error('reply-guard: config must be an object');
  for (const key of Object.keys(config)) if (!CONFIG_KEYS.includes(key)) throw new Error(`reply-guard: unknown config key "${key}"`);
  if (config.debug !== undefined && typeof config.debug !== 'boolean') throw new Error('reply-guard: debug must be boolean');
  const rules = config.rules === undefined ? [] : config.rules;
  if (!Array.isArray(rules)) throw new Error('reply-guard: rules must be an array');
  const ids = new Set();
  rules.forEach((rule, index) => {
    const at = `rules[${index}]`;
    if (!object(rule)) throw new Error(`reply-guard: ${at} must be an object`);
    for (const key of Object.keys(rule)) if (!RULE_KEYS.includes(key)) throw new Error(`reply-guard: ${at} has unknown key "${key}"`);
    if (typeof rule.id !== 'string' || !ID.test(rule.id)) throw new Error(`reply-guard: ${at} needs an id of letters, digits, _ or -`);
    if (ids.has(rule.id)) throw new Error(`reply-guard: duplicate rule id "${rule.id}" at ${at}`);
    ids.add(rule.id);
    const where = `rule "${rule.id}"`;
    if (!object(rule.match) || !Object.keys(rule.match).length) throw new Error(`reply-guard: ${where} needs a non-empty match`);
    for (const [section, fields] of Object.entries(rule.match)) {
      if (!SECTIONS.includes(section)) throw new Error(`reply-guard: ${where} has unknown match section "${section}"`);
      if (!object(fields) || !Object.keys(fields).length) throw new Error(`reply-guard: ${where} needs a non-empty match.${section}`);
      for (const [key, expected] of Object.entries(fields)) {
        const field = `${section}.${key}`;
        if (!KEY.test(key) || (section === 'event' && key !== 'kind') || (section === 'payload' && key !== 'isError')) throw new Error(`reply-guard: ${where} has unsupported match field ${field}`);
        const values = asList(expected);
        if (!values.length || !values.every(scalar)) throw new Error(`reply-guard: ${where} ${field} must be a scalar or a non-empty array of scalars`);
        if (section === 'payload' && !values.every(v => typeof v === 'boolean')) throw new Error(`reply-guard: ${where} ${field} must be boolean`);
        if (section === 'event' && !values.every(v => KINDS.includes(v))) throw new Error(`reply-guard: ${where} ${field} must be one of ${KINDS.join('/')}`);
      }
    }
  });
  return structuredClone({ debug: config.debug ?? false, rules });
}

function evaluate(rules, event, context) {
  const sources = { context, event, payload: event.payload };
  return rules.map(rule => {
    const conditions = Object.entries(rule.match).flatMap(([section, fields]) => Object.entries(fields).map(([key, expected]) => {
      const present = own(sources[section], key);
      const actual = present ? sources[section][key] : undefined;
      const matched = present && asList(expected).includes(actual);
      // Rules may match any context field, but only routing fields are echoed back.
      const visible = section !== 'context' || LOGGED_CONTEXT.includes(key);
      return { field: `${section}.${key}`, expected, present, ...(present && visible ? { actual } : {}), matched };
    }));
    return { id: rule.id, matched: conditions.every(c => c.matched), conditions };
  });
}

function loggableContext(context) {
  if (!object(context)) return {};
  return Object.fromEntries(Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, LOGGED_CONTEXT.includes(key) && scalar(value) ? value : '[omitted]']));
}

export default {
  id: 'reply-guard',
  name: 'Reply Guard',
  register(api) {
    const config = parseConfig(api.pluginConfig);
    api.on('reply_payload_sending', (event, context) => {
      event ??= {};
      context ??= {};
      const results = evaluate(config.rules, event, context);
      const matched = results.filter(rule => rule.matched).map(rule => rule.id);
      const decision = matched.length ? { cancel: true, reason: `reply-guard:${matched[0]}` } : undefined;
      if (config.debug) {
        try {
          api.logger.info(`[reply-guard] ${JSON.stringify({ context: loggableContext(context), event: { kind: event.kind }, payload: own(event.payload, 'isError') ? { isError: event.payload.isError } : {}, rules: results, decision: decision ? 'cancel' : 'allow', matchedRules: matched })}`);
        } catch (error) {
          // Diagnostics must never alter a delivery decision, but a debug run that
          // prints nothing is baffling, so say why (best effort).
          try { api.logger.warn?.(`[reply-guard] debug log failed (decision=${decision ? 'cancel' : 'allow'}): ${error?.message ?? error}`); } catch { /* nothing left to try */ }
        }
      }
      return decision;
    });
  },
};
