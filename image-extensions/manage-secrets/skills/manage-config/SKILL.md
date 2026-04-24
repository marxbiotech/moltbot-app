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

Phase 1 uses the built-in `gateway` tool (provided by openclaw).
Phase 2 uses the plugin `set_config` tool (provided by this plugin).

### Phase 1: Runtime apply (via `gateway` tool)

Steps 1 and 2 are independent — call them in parallel when possible.

#### Step 1 — Look up schema

Call the `gateway` tool to verify the config path exists and check its type:

```
gateway(action: "config.schema.lookup", path: "<dot.path>")
```

The response includes `schema` (JSON Schema node), `hint` (UI metadata), and
`children` (available sub-paths). Use this to validate the proposed value type.

**If the path is not found:** tell the user the path does not exist. Use
`children` from the parent path to suggest valid alternatives.

#### Step 2 — Get current value

Call the `gateway` tool to fetch the live config snapshot:

```
gateway(action: "config.get")
```

The response includes:
- `config` — the full config object (navigate to the target path to read current value)
- `hash` — **save this** — required as `baseHash` for the patch step

Show the user: `current value -> proposed value`.

**If config.get fails:** the gateway may be unreachable. Tell the user and
do not proceed — both phases require a working gateway.

#### Step 3 — Apply runtime patch

Build a merge-patch: convert the dot-delimited path into a nested object with
only the target leaf set. For path `a.b.c` with value `V`:

```json
{"a": {"b": {"c": V}}}
```

Arrays are replaced wholesale — merge-patch has no array-append semantics.
To change one element of `agents.defaults.model.fallbacks`, replace the
entire array.

Then call:

```
gateway(
  action: "config.patch",
  raw: "<the merge-patch JSON string>",
  baseHash: "<hash from config.get>",
  note: "<human-readable summary, e.g. 'Changed primary model to google/gemini-3-flash'>"
)
```

This writes to `openclaw.json` and triggers a graceful SIGUSR1 restart.
The `note` parameter is delivered to the user after restart completes.

**If config.patch fails:**
- *baseHash mismatch* — config was changed concurrently. Re-fetch via
  `config.get` and retry with the new hash.
- *Protected path* — `tools.exec.ask` and `tools.exec.security` cannot be
  changed via agent config mutations. Tell the user this path is protected.
- *Other error* — report the error and do not proceed to Phase 2.

#### Step 4 — Confirm

Ask the user to verify the change works as expected.
Wait for **explicit confirmation** before proceeding to Phase 2.

**If the user rejects the change:** the runtime change reverts automatically
on the next pod restart (or immediately if the user requests a restart via
`gateway(action: "restart")`). No repo change is made. Inform the user that
the change is ephemeral and will revert.

### Phase 2: Repo persist (via `set_config` tool)

#### Step 5 — Persist

On confirmation, call the `set_config` tool with:
- `config_path`: dot-delimited path relative to `openclaw-helm.config`
  (same format used in schema lookup, e.g. `agents.defaults.model.primary`)
- `config_value`: JSON-encoded value (e.g. `"google/gemini-3-flash"`, `true`, `42`)

The tool runs transport-safety preflight checks (well-formed path, valid JSON)
but does **not** validate against the config schema — that authority belongs to
the `gateway` tool (Phase 1) and the repo-side workflow.
It then triggers a GitHub Actions workflow that patches the persona's `values.yaml`,
commits, and pushes — triggering a durable deploy.

**If the workflow dispatch fails:** warn the user that the runtime change is
live but ephemeral — it will revert on the next pod restart. They can retry
`set_config` or persist manually.

#### Step 6 — Report

The tool returns the workflow dispatch status and recent run URLs.
Report success/failure to the user.

## Worked example

User says: "change the model to google/gemini-3-flash"

**Step 1+2** (parallel):
```
gateway(action: "config.schema.lookup", path: "agents.defaults.model.primary")
gateway(action: "config.get")
```

Schema lookup confirms `agents.defaults.model.primary` exists and is a string.
Config.get returns hash `"abc123"` and shows current value is `"anthropic/claude-sonnet-4-20250514"`.

**Preview:**
> Changing `agents.defaults.model.primary`:
> `"anthropic/claude-sonnet-4-20250514"` -> `"google/gemini-3-flash"`
> Apply this change?

**Step 3** (after user says "yes, try it"):
```
gateway(
  action: "config.patch",
  raw: "{\"agents\":{\"defaults\":{\"model\":{\"primary\":\"google/gemini-3-flash\"}}}}",
  baseHash: "abc123",
  note: "Changed primary model to google/gemini-3-flash"
)
```

**Step 4:** "The model has been changed. Please try sending a message to
verify it works. Should I persist this to the repo?"

**Step 5** (after user confirms):
```
set_config(
  config_path: "agents.defaults.model.primary",
  config_value: "\"google/gemini-3-flash\""
)
```

**Step 6:** "Workflow dispatched. Run #12345 is in progress — [view](url)."

## Config path format

- Dot-delimited, relative to `openclaw-helm.config`
- Only simple identifiers per segment (no array selectors like `list[id=main]`)
- Examples:
  - `agents.defaults.model.primary` — model provider string
  - `agents.defaults.model.fallbacks` — fallback array (replaces entire array)
  - `channels.telegram.enabled` — boolean toggle
  - `channels.telegram.streaming` — streaming mode
  - `tools.media.audio.echoTranscript` — transcription settings

## Important notes

- NEVER write the full live `openclaw.json` back to `values.yaml`.
  Only the specific changed path+value is persisted via `set_config`.
- If the persist step fails, warn the user that the runtime change is
  ephemeral and will revert on next pod restart.
- Config values must be valid JSON (strings need double quotes: `"google/gemini-3-flash"`)
- The `gateway` tool enforces protected paths (`tools.exec.ask`, `tools.exec.security`)
  that cannot be changed via agent config mutations.
- Requires `MANAGE_SECRETS_GITHUB_REPO` env var (shared with set_secret)
- Auth: `AGENT_GITHUB_PAT` or `MANAGE_SECRETS_GITHUB_APP` (same as set_secret)
