const own = (value, key) => value != null && Object.hasOwn(value, key);
const scalar = value => value === null || ['string', 'boolean', 'number'].includes(typeof value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const forbidden = /token|password|secret|authorization|cookie|credential|^(text|body|content|attachments?)$/i;

// Validate even when a host bypasses manifest validation. Never interpret an
// invalid/empty rule as a catch-all cancellation rule.
export function parseConfig(config = {}) {
  if (!object(config) || Object.keys(config).some(k => !['debug', 'rules'].includes(k))) throw new Error('reply-guard: invalid config');
  if (config.debug !== undefined && typeof config.debug !== 'boolean') throw new Error('reply-guard: debug must be boolean');
  const rules = config.rules ?? [];
  if (!Array.isArray(rules)) throw new Error('reply-guard: rules must be an array');
  const ids = new Set();
  for (const rule of rules) {
    if (!object(rule) || Object.keys(rule).some(k => !['id', 'match'].includes(k)) || typeof rule.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(rule.id) || ids.has(rule.id)) throw new Error('reply-guard: invalid or duplicate rule id');
    ids.add(rule.id);
    if (!object(rule.match) || !Object.keys(rule.match).length) throw new Error(`reply-guard: empty match for ${rule.id}`);
    for (const [section, fields] of Object.entries(rule.match)) {
      if (!['context', 'event', 'payload'].includes(section) || !object(fields) || !Object.keys(fields).length) throw new Error(`reply-guard: invalid match section for ${rule.id}`);
      for (const [key, expected] of Object.entries(fields)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) || forbidden.test(key) || (section === 'event' && key !== 'kind') || (section === 'payload' && key !== 'isError')) throw new Error(`reply-guard: unsupported match field ${section}.${key}`);
        const values = Array.isArray(expected) ? expected : [expected];
        if (!values.length || values.some(v => !scalar(v) || (typeof v === 'number' && !Number.isFinite(v)))) throw new Error('reply-guard: expected scalar or nonempty scalar array');
        if (section === 'payload' && values.some(v => typeof v !== 'boolean')) throw new Error('reply-guard: isError requires boolean');
        if (section === 'event' && values.some(v => !['tool', 'block', 'final'].includes(v))) throw new Error('reply-guard: invalid reply kind');
      }
    }
  }
  return structuredClone({ debug: config.debug ?? false, rules });
}

function evaluate(rules, event, context) {
  const sources = { context, event, payload: event.payload };
  return rules.map(rule => {
    const conditions = Object.entries(rule.match).flatMap(([section, fields]) => Object.entries(fields).map(([key, expected]) => {
      const present = own(sources[section], key);
      const actual = present ? sources[section][key] : undefined;
      const matched = present && (Array.isArray(expected) ? expected : [expected]).some(value => value === actual);
      return { field: `${section}.${key}`, expected, present, ...(present ? { actual } : {}), matched };
    }));
    return { id: rule.id, matched: conditions.every(c => c.matched), conditions };
  });
}

// Current host context contains routing metadata. Preserve its names/types, but
// redact sensitive fields recursively if a future host adds them. Never log payload text.
function safeContext(value) {
  if (Array.isArray(value)) return value.map(safeContext);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, forbidden.test(key) ? '[REDACTED]' : safeContext(item)]));
  return value;
}

export default {
  id: 'reply-guard',
  name: 'Reply Guard',
  register(api) {
    const config = parseConfig(api.pluginConfig);
    api.on('reply_payload_sending', (event, context) => {
      const results = evaluate(config.rules, event, context);
      const matched = results.filter(rule => rule.matched).map(rule => rule.id);
      const decision = matched.length ? { cancel: true, reason: `reply-guard:${matched[0]}` } : undefined;
      if (config.debug) {
        try {
          api.logger.info(`[reply-guard] ${JSON.stringify(safeContext({ context, event: { kind: event.kind }, payload: own(event.payload, 'isError') ? { isError: event.payload.isError } : {}, rules: results, decision: decision ? 'cancel' : 'allow', matchedRules: matched }))}`);
        } catch { /* Diagnostics must never alter a delivery decision. */ }
      }
      return decision;
    });
  },
};
