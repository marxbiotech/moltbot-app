---
name: manage-config
description: >
  Update OpenClaw runtime config via the two-phase flow: apply immediately
  for instant feedback, then persist to the GitOps repo after user confirmation.
  Use when the user asks to change a model, toggle a feature, update channel
  settings, or modify agent config.
user-invocable: false
---

# Manage Config

## Intent detection

Trigger when the user:
- Asks to change the model, switch providers, or update model fallbacks
- Wants to enable/disable a channel, plugin, or feature
- Asks to modify agent identity, system prompts, or channel config
- Says "change the model to X", "enable Discord", "update the system prompt"

Do NOT trigger when:
- The user is asking about secrets (use manage-secrets skill)
- The change requires adding new SOPS-encrypted values
- The request is about image tags, Helm chart versions, or infra config
  (these require direct values.yaml edits, not runtime config patching)

## Two-phase workflow

### Phase 1: Runtime apply (instant feedback)

1. **Validate** — Use the gateway API to look up the config path and verify
   it exists and the proposed value matches the expected type.

2. **Preview** — Show the user: current value -> proposed value.

3. **Apply runtime** — Call `config.patch` with a merge-patch containing
   only the changed field. This writes to `openclaw.json` and triggers a
   graceful SIGUSR1 restart.

4. **Confirm** — Ask the user to verify the change works as expected.
   Wait for explicit confirmation before proceeding.

### Phase 2: Repo persist (durable change)

5. **Persist** — On confirmation, call the `set_config` tool with:
   - `config_path`: dot-delimited path relative to `openclaw-helm.config`
   - `config_value`: JSON-encoded value

6. **Report** — Poll the workflow run and report success/failure.

If the user rejects the change, it will revert on next pod restart
(no repo change is made).

## Config path format

- Paths are dot-delimited, relative to `openclaw-helm.config`
- Only simple identifiers per segment (no array selectors like `list[id=main]`)
- Examples:
  - `agents.defaults.model.primary` — model provider string
  - `agents.defaults.model.fallbacks` — fallback array (replaces entire array)
  - `channels.telegram.enabled` — boolean toggle
  - `channels.telegram.streaming` — streaming mode
  - `tools.media.audio.echoTranscript` — transcription settings

## Important notes

- NEVER write the full live `openclaw.json` back to `values.yaml`.
  Only the specific changed path+value is persisted.
- If the persist step fails, warn the user that the runtime change is
  ephemeral and will revert on next pod restart.
- Config values must be valid JSON (strings need double quotes: `"google/gemini-3-flash"`)
- Requires `MANAGE_SECRETS_GITHUB_REPO` env var (shared with set_secret)
- Auth: `AGENT_GITHUB_PAT` or `MANAGE_SECRETS_GITHUB_APP` (same as set_secret)
