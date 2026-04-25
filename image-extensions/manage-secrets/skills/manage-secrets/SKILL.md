---
name: manage-secrets
description: Set or update environment secrets for this persona via the set_secret tool. Use when the user asks to update, rotate, or set a secret, token, or API key.
user-invocable: false
---

# Manage Secrets

When the user asks to set, update, or rotate a secret (API key, token, credential) for this persona's environment, use the `set_secret` tool.

## Intent detection

Trigger when the user:

- Asks to set, update, or rotate a secret, token, or API key
- Says "change my Telegram token" or "update the Google API key"
- Provides a new credential and asks to deploy it

Do not trigger when:

- The user is asking about secret values (never reveal secrets)
- The user is discussing secrets conceptually without intent to change them

## How to use

Call the `set_secret` tool with:

- `secret_key`: uppercase env var name (e.g., `TELEGRAM_BOT_TOKEN`, `GOOGLE_API_KEY`)
- `secret_value`: the new value

The tool auto-detects the current persona and saves the secret securely,
triggering a deploy so the new value takes effect.

## Important notes

- Secret keys must match `^[A-Z][A-Z0-9_]*$`
- Concurrent secret updates are serialized — they queue, never cancel each other
- If the value is unchanged, the operation completes cleanly with no effect
- After triggering, report the save status to the user
- Never echo the secret value back to the user
