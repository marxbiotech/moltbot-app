# Reply Guard

An image-baked, dependency-free `reply_payload_sending` plugin. By default it
allows every reply. A matching rule cancels the payload before supported inbound
and durable delivery paths reach transport. It does not intercept every direct
message-tool or low-level plugin send, and does not classify assistant prose.

Load `/opt/moltbot/extensions/reply-guard` in `plugins.load.paths`, then configure:

```yaml
plugins:
  # Only needed where an allowlist is already set (e.g. merlin): add reply-guard
  # to it, or the plugin is silently never loaded.
  # allow: [..., reply-guard]
  entries:
    reply-guard:
      enabled: true
      config:
        debug: false
        rules:
          - id: suppress-line-errors
            match:
              context:
                channelId: line
                # accountId: default
                # conversationId: [group-a, group-b]
              payload:
                isError: true
              # event:
              #   kind: [tool, final]
```

`hooks.allowConversationAccess` is not needed: `reply_payload_sending` is not a
conversation hook on the pinned host.

Conditions within a rule are AND; rules are OR. A scalar is an exact, typed
comparison; a nonempty scalar array accepts any listed value. Missing fields do
not match, even when the expected value is null; a field the host sets to
`undefined` counts as missing. Context keys refer to top-level runtime fields (no
dotted paths, regex, coercion, or inference from message text). Any context field
can be matched, but debug output echoes only routing fields (below).
The pinned host exposes routing fields such as `channelId`, `accountId`,
`conversationId`, and `sessionKey`; fields may be absent on some delivery paths,
and values can differ between paths: on the routed/durable path `conversationId`
is the delivery target, on the inbound path it is the resolved inbound
conversation. Capture IDs with debug on each path you need to match.
Event matching supports `kind` (tool/block/final); payload matching supports only
boolean `isError`.

The config is validated at startup. These are rejected: unknown config keys,
`rules` that is not an array, rules with an unknown key or a malformed or
duplicate `id`, an empty `match` or empty match section, unknown sections,
unsupported event/payload keys, and values that are not a scalar or a non-empty
array of scalars. `rules: []` is valid and means allow everything. Rule IDs and
expected values appear in debug output, so keep them descriptive, not sensitive.

## Failure behaviour: fail open

An invalid config makes `register()` throw. The host logs one
`[plugins] reply-guard failed during register` line, installs no hook and keeps
running, so **every reply is delivered**. The manifest schema rejects most bad
configs before that point, but rule-id uniqueness cannot be expressed in JSON
Schema and is only enforced at startup. After changing rules, confirm the plugin
reports `loaded` (`openclaw plugins list --json`). A handler error at runtime is
also fail-open: the host logs it and the reply is delivered.

## Discover context with debug

Set `debug: true` and `rules: []` to observe without suppressing anything, or keep
existing rules to inspect their decisions. Debug defaults to false. When enabled,
each hook call writes one `[reply-guard]` JSON line through the host info logger,
so changing the host's debug log level is unnecessary. It includes:

- Context values for `channelId`, `accountId`, `conversationId` and `sessionKey`.
  Every other context field is listed by name with the value `[omitted]`, because
  the host also puts sender ids and quoted message text (`replyToBody`,
  `replyToSender`) in this context.
- Event kind and payload isError when provided (absence stays absent).
- Each rule's conditions with `expected`, `present` and `matched`; `actual` is
  included only for routing fields, event kind and isError. A rule on an omitted
  field still reports whether it matched.
- `matchedRules` and the final `allow` or `cancel` decision. The hook's `reason`
  names only the first matching rule in config order.

Message text, media URLs and other payload fields are never logged. If the log
line itself cannot be produced, the decision is unaffected and a `warn` line says
why. Debug can be noisy; disable it after configuring rules. The decisions
describe this plugin's action, not confirmation of final transport or the actions
of other plugins.

Tests: `npm test`. The Docker build also runs `test/image-smoke.mjs` against the
installed host loader and the real inbound before-deliver and durable
preparation boundaries, with a fixture channel and no live credentials or chat
messages. That test does not count calls to a transport; it checks the hook's
decision at each boundary.
