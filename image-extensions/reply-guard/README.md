# Reply Guard

An image-baked, dependency-free `reply_payload_sending` plugin. By default it
allows every reply. A matching rule cancels the payload before supported inbound
and durable delivery paths reach transport. It does not intercept every direct
message-tool or low-level plugin send, and does not classify assistant prose.

Load `/opt/moltbot/extensions/reply-guard` in `plugins.load.paths`, then configure:

```yaml
plugins:
  # Only needed where an allowlist is already set (e.g. merlin): add reply-guard
  # to it, or the plugin is not loaded.
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
is the delivery target, on the inbound path it is the raw inbound address
(`OriginatingTo`, else `To`, else `From`), which may carry a channel prefix such
as `line:group:...`. Capture IDs with debug on each path you need to match.
Event matching supports `kind` (tool/block/final); payload matching supports only
boolean `isError`.

The config is checked twice. The manifest schema and the plugin's own parser
reject: unknown config keys, a non-boolean `debug`, `rules` that is not an array,
rules with an unknown key or a malformed `id`, an empty `match` or empty match
section, unknown sections, unsupported event/payload keys, an `event.kind`
outside tool/block/final, a non-boolean `isError`, and values that are not a
scalar or a non-empty array of scalars. The parser alone also rejects duplicate
rule ids, which JSON Schema cannot express. `rules: []` is valid and means allow
everything. Rule IDs and expected values appear in debug output, so keep them
descriptive, not sensitive.

## Failure behaviour: two different outcomes

- **A config the schema rejects stops the gateway.** The host validates the
  plugin's `config` against the manifest schema, so one bad rule makes the whole
  `openclaw.json` invalid and the gateway refuses to start. Every channel goes
  down, not just this plugin. Run `openclaw config validate --json` before
  deploying rule changes.
- **A duplicate rule id fails open.** It passes the schema and then makes
  `register()` throw. At startup the host logs
  `[plugins] reply-guard failed during register from <source>: ...`, installs no
  hook and keeps running, so **every reply is delivered**. To check after a
  deploy, look for that line in the gateway log, or run
  `openclaw plugins inspect reply-guard --runtime --json`, which re-runs
  `register()`. `openclaw plugins list` does not run `register()`, so it cannot
  show this failure.

A handler error while a reply is being processed is also fail-open: the host logs
it and the reply is delivered.

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
