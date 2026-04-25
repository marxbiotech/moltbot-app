---
name: manage-config
description: >
  Update agent config via apply-then-save: apply immediately for instant
  feedback, then save permanently after user confirmation.
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
- The change requires adding new encrypted secrets
- The request is about infrastructure-level changes (image versions, chart
  config, or deployment settings) — these are outside this tool's scope

## Two-phase workflow

Phase 1 uses the built-in `gateway` tool to apply the change live.
Phase 2 uses the `set_config` tool to save it permanently.

The **merge-patch JSON string** is the single canonical artifact — construct
it once in Phase 1, then pass the same string verbatim to Phase 2.

### Phase 1: Apply (via `gateway` tool)

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

#### Step 3 — Build and apply runtime patch

Build a merge-patch: convert the dot-delimited path into a nested object with
only the target leaf set. For path `a.b.c` with value `V`:

```json
{"a": {"b": {"c": V}}}
```

Multiple paths can be combined into one patch:

```json
{"a": {"b": {"c": V1}}, "x": {"y": V2}}
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

**Save the `raw` string** — you will pass it verbatim to `set_config` in
Phase 2.

This applies the change and triggers a graceful reload.
The `note` parameter is delivered to the user after the reload completes.

**If config.patch fails:**
- *baseHash mismatch* — config was changed concurrently. Re-fetch via
  `config.get` and retry with the new hash.
- *Protected path* — `tools.exec.ask` and `tools.exec.security` cannot be
  changed via agent config mutations. Tell the user this path is protected.
- *Other error* — report the error and do not proceed to Phase 2.

#### Step 4 — Confirm

Ask the user to verify the change works as expected.
Wait for **explicit confirmation** before proceeding to Phase 2.

**If the user rejects the change:** the change is active but unsaved — it
won't survive a restart. The user can request an immediate restart via
`gateway(action: "restart")` to revert right away. No permanent save is made.
Inform the user that the change will revert on next restart.

### Phase 2: Save (via `set_config` tool)

#### Step 5 — Save permanently

On confirmation, call the `set_config` tool with the **same merge-patch
string** from Step 3:

```
set_config(
  patch: "<same merge-patch JSON string from Step 3>"
)
```

Do NOT re-derive or re-construct the patch — pass the `raw` string verbatim.

The tool runs transport-safety preflight checks (valid JSON object, supported
config paths at every leaf, no null/deletion values) but does **not** validate
against the config schema — that authority belongs to the `gateway` tool in
Phase 1. It then saves the change durably so it survives restarts and
redeployments.

**If saving fails:** warn the user that the change is active but hasn't been
saved — it won't survive a restart. They can retry `set_config` later.

#### Step 6 — Report

The tool returns save status and progress information.
Report success/failure to the user.

## Worked example: single path

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
verify it works. Want me to save this permanently?"

**Step 5** (after user confirms):
```
set_config(
  patch: "{\"agents\":{\"defaults\":{\"model\":{\"primary\":\"google/gemini-3-flash\"}}}}"
)
```

**Step 6:** "Change saved. Deployment in progress — [view](url)."

## Worked example: multi-path

User says: "switch to gemini-3-flash with claude-sonnet as fallback, and
enable streaming on Telegram"

**Step 1+2** (parallel — look up each path + fetch config):
```
gateway(action: "config.schema.lookup", path: "agents.defaults.model.primary")
gateway(action: "config.schema.lookup", path: "agents.defaults.model.fallbacks")
gateway(action: "config.schema.lookup", path: "channels.telegram.streaming")
gateway(action: "config.get")
```

**Preview:**
> Changing 3 config paths:
> - `agents.defaults.model.primary`: `"anthropic/claude-sonnet-4-20250514"` -> `"google/gemini-3-flash"`
> - `agents.defaults.model.fallbacks`: `["google/gemini-3.1-pro-preview"]` -> `["anthropic/claude-sonnet-4-20250514"]`
> - `channels.telegram.streaming`: `false` -> `true`
> Apply these changes?

**Step 3** (one patch covers all paths):
```
gateway(
  action: "config.patch",
  raw: "{\"agents\":{\"defaults\":{\"model\":{\"primary\":\"google/gemini-3-flash\",\"fallbacks\":[\"anthropic/claude-sonnet-4-20250514\"]}}},\"channels\":{\"telegram\":{\"streaming\":true}}}",
  baseHash: "abc123",
  note: "Switched to gemini-3-flash, added claude-sonnet fallback, enabled Telegram streaming"
)
```

**Step 5** (same string):
```
set_config(
  patch: "{\"agents\":{\"defaults\":{\"model\":{\"primary\":\"google/gemini-3-flash\",\"fallbacks\":[\"anthropic/claude-sonnet-4-20250514\"]}}},\"channels\":{\"telegram\":{\"streaming\":true}}}"
)
```

## Config path format

- Dot-delimited config path
- Only simple identifiers per segment (no array selectors like `list[id=main]`)
- Examples:
  - `agents.defaults.model.primary` — model provider string
  - `agents.defaults.model.fallbacks` — fallback array (replaces entire array)
  - `channels.telegram.enabled` — boolean toggle
  - `channels.telegram.streaming` — streaming mode
  - `tools.media.audio.echoTranscript` — transcription settings

## Important notes

- NEVER save the full live config wholesale.
  Only the specific merge-patch from Phase 1 is passed to `set_config`.
- The `patch` string passed to `set_config` must be the **same** merge-patch
  JSON string used as `raw` in the `gateway(config.patch)` call.
  Do NOT re-derive or re-construct it — copy it verbatim.
- If the save step fails, warn the user that the change is active but
  unsaved — it won't survive a restart.
- Arrays are replaced wholesale — merge-patch has no array-append semantics.
- The `gateway` tool enforces protected paths (`tools.exec.ask`, `tools.exec.security`)
  that cannot be changed via agent config mutations.
