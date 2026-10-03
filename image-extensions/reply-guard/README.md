# Reply Guard

An image-baked, dependency-free `reply_payload_sending` plugin. By default it
allows every reply. A matching rule cancels the payload before supported inbound
and durable delivery paths reach transport. It does not intercept every direct
message-tool or low-level plugin send, and does not classify assistant prose.

Load `/opt/moltbot/extensions/reply-guard` in `plugins.load.paths`, then configure:

```yaml
plugins:
  entries:
    reply-guard:
      enabled: true
      hooks:
        allowConversationAccess: true
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

Conditions within a rule are AND; rules are OR. A scalar is an exact, typed
comparison; a nonempty scalar array accepts any listed value. Missing fields do
not match, even when the expected value is null. Context keys refer to top-level
runtime fields (no dotted paths, regex, coercion, or inference from message text).
The pinned host exposes routing fields such as `channelId`, `accountId`,
`conversationId`, and `sessionKey`; fields may be absent on some delivery paths.
Event matching supports `kind` (tool/block/final); payload matching supports only
boolean `isError`. Empty rules/match sections, duplicate IDs and unsupported
payload/event keys are rejected. Keep rule IDs descriptive, not sensitive.

## Discover context with debug

Set `debug: true` and `rules: []` to observe without suppressing anything, or keep
existing rules to inspect their decisions. Debug defaults to false. When enabled,
each hook call writes one `[reply-guard]` JSON line through the host info logger,
so changing the host's debug log level is unnecessary. It includes:

- Actual context fields and values, preserving JSON types.
- Event kind and payload isError when provided (absence stays absent).
- Each rule's conditions, expected/actual values, `present` and `matched` flags.
- `matchedRules` and the final `allow` or `cancel` decision.

Message text, media URLs and other payload fields are never logged. Sensitive
context keys (tokens, passwords, secrets, authorization, cookies, credentials,
text/body/content/attachments) are recursively redacted. Routing IDs remain
visible so operators can copy them into rules. Logging exceptions never change
the delivery decision. Debug can be noisy; disable it after configuring rules.
The decisions describe this plugin's action, not confirmation of final transport
or the actions of other plugins.

Tests: `npm test`. The Docker build also runs `test/image-smoke.mjs` against the
installed host loader and real inbound/durable hook boundaries, with a fixture
transport and no live credentials or chat messages.
