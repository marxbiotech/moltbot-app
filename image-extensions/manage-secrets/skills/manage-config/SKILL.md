---
name: manage-config
description: >
  Update agent config via apply-then-save: apply immediately for instant
  feedback, then save permanently after user confirmation.
  Use when the user asks to change a model, toggle a feature, update channel
  settings, or modify agent config — including natural-language intents like
  "turn off transcript echo" or "make Telegram streaming partial".
user-invocable: false
---

# Manage Config

## Intent detection

Trigger when the user:
- Uses product language to describe a config change
  ("turn off transcript echo", "make Telegram streaming partial",
  "switch to gemini", "always echo STT transcription")
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

### Step 0 — Resolve intent to config path

**If the user provides an exact dot-path** (e.g. `channels.telegram.streaming`):
skip directly to Step 1.

**If the user describes intent in natural language:**

1. Identify the most likely top-level group from the group guide at the end
   of this document.
2. If you can infer a plausible full path from context, try it directly:
   ```
   gateway(action: "config.schema.lookup", path: "<guessed.full.path>")
   ```
   If the lookup succeeds and the result's `children` array is empty,
   the path is a settable leaf — you already have the schema info, so
   skip Step 1 and proceed to Step 2.
   If the lookup succeeds but `children` is non-empty, this is a group
   node, not a settable leaf — use its `children` to continue
   drill-down (item 3) rather than proceeding to Step 1.
3. If the direct guess fails (path not found or empty result — NOT a
   gateway/timeout error; see guardrails) or you aren't confident,
   drill down iteratively from the top-level group:
   ```
   gateway(action: "config.schema.lookup", path: "<group>")
   ```
   Each child in the response includes `key`, `path`, `type`,
   `hasChildren`, and optionally `hint` (with `label` and `help`
   text — may be absent for some nodes).
   Scan the flat `children` list, find the child whose name or hint
   best matches the user's intent, and drill deeper:
   ```
   gateway(action: "config.schema.lookup", path: "<group>.<child>")
   ```
   Repeat until you reach a settable leaf — indicated by one of:
   - `hasChildren: false` in the parent's children list, **or**
   - the lookup returns an **empty** `children` array.
   Note: union-typed fields (e.g. a string or an object) may report
   `hasChildren: true` even though they are settable leaves — this
   happens because the object variant has sub-properties. If drilling
   into such a node returns children that don't match the user's
   intent, step back and treat the parent as the target leaf. The
   lookup `schema` does not expose union alternatives — use the
   current value from `config.get` (Step 2) and the `hint` to
   determine the accepted shape.
4. Match the user's intent against children `hint.label` and `hint.help`
   text — these are more reliable than guessing from path segment names.
5. If multiple paths could match, present the top 2-3 candidates with their
   labels and ask the user to pick:
   > I found multiple config fields that could match:
   > 1. `tools.media.audio.echoTranscript` — Echo Transcript to Chat
   > 2. `tools.media.audio.echoFormat` — Transcript Echo Format
   > Which one did you mean?
6. If zero matches are found in the chosen group, try the next most likely
   group. If still nothing, ask the user to clarify.
7. Once a single path is identified, state it to the user and proceed
   to Step 1.

**Guardrails:**
- When a group has many children, scan ALL of them before drilling — the
  right match may not be the first child listed.
- If the leaf schema includes `enum` or `type: "boolean"`, use those
  constraints to propose an appropriate value. Do not guess enum values.
- Do not invent config paths. Every path must be confirmed by a successful
  `config.schema.lookup` call before proceeding to Step 1.
- If any `config.schema.lookup` call returns a tool-level error (gateway
  unreachable, timeout), tell the user the gateway appears to be down and
  do not proceed.
- If no child matches the user's intent at any drill-down level, do not
  force-pick the closest match. Back up and try a sibling node, or return
  to the top-level group and try the next most likely group.
- **Never patch a group node directly.** If a lookup returns non-empty
  `children`, you must drill to a leaf. Patching a group risks
  overwriting sibling config values the user did not intend to change.
- **Never use `null` in the merge-patch.** In RFC 7396 merge-patch, `null`
  means "delete this key." The gateway will silently remove it from config.
  If the user wants to reset a field to its default, ask what value to
  restore (the schema lookup does not expose default values).
- **Termination bound:** Stop after **8 `config.schema.lookup` calls**
  (including both direct guesses and drill-down steps). If the target
  has not been found within this budget, present the best candidates
  discovered so far and ask the user for clarification.

### Phase 1: Apply (via `gateway` tool)

Steps 1 and 2 are independent — call them in parallel when possible.

#### Step 1 — Look up schema

Call the `gateway` tool to verify the config path exists and check its type:

```
gateway(action: "config.schema.lookup", path: "<dot.path>")
```

The response includes `schema` (JSON Schema node), `hint` (UI metadata), and
`children` (available sub-paths). Use this to validate the proposed value type.

**If Step 0 already provided sufficient schema info for the target leaf:**
skip this call and proceed to Step 2. This applies when Step 0 called
`config.schema.lookup` on the exact leaf path, or when the parent's
`children` list already reveals a fully-determined type (e.g. boolean).
If the leaf may have enum values, complex constraints, or a union type
that the parent's children list does not fully describe, call this step
to get the complete schema.

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
- `valid` — boolean; if `false`, the config has validation errors

**If `valid` is `false`:** stop immediately — do NOT show a current→proposed
preview or proceed to Step 3. The `config` object may be empty or incomplete
when validation fails, so any values extracted from it are unreliable. Tell the
user: "Your config currently has validation errors and cannot be patched. Please
fix the config first, then retry this change."

Show the user: `current value -> proposed value`.

**If config.get fails:** the gateway may be unreachable. Tell the user and
do not proceed — both phases require a working gateway.

**Large patches (>20 leaf paths):** `set_config` rejects patches with more
than 20 leaf paths. If your merge-patch would exceed this limit, split the
change into multiple cycles (each with its own Phase 1 + Phase 2) before
starting. Do not build a patch that Phase 1 will accept but Phase 2 will
reject.

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

For simple-value arrays, replacement is wholesale (merge-patch has no
array-append semantics). For arrays of objects with `id` fields (e.g.
`agents.list`), entries merge by id — include only the entries you want to
add or update. When in doubt, replace the entire array with all desired
entries.

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

This applies the change and schedules a graceful restart. The gateway
waits for in-flight work to drain (up to a timeout) before restarting.
The `note` parameter is delivered to the user after the restart completes.

**If config.patch fails:**
- *baseHash mismatch* — config was changed concurrently. Re-fetch via
  `config.get` and retry with the new hash. **Stop after 3 retries.** If
  the mismatch persists, tell the user: "Config is being modified by
  another source. Please try again in a moment."
- *Protected path* — `tools.exec.ask` and `tools.exec.security` cannot be
  changed via agent config mutations. Tell the user this path is protected.
- *Invalid config* — same as the `valid: false` check in Step 2 (lines above).
  Do not retry.
- *Other error* — report the error and do not proceed to Phase 2.

#### Step 4 — Confirm

Ask the user to verify the change works as expected.
Wait for **explicit confirmation** before proceeding to Phase 2.

**If the user does not confirm within the conversation:** Before ending the
conversation or switching topics, remind the user: "Your config change is
active but unsaved — it will persist across restarts but be lost on the next
full redeployment. Say 'save config' to make it permanent."

**If the user rejects the change:** the change has been applied to the local
config file but NOT saved to the deployment repo. It will persist across
in-process restarts but will be overwritten on the next full redeployment.
To revert immediately, construct a reverse patch that restores the original
value (from Step 2's `config.get` snapshot) and apply it via `config.patch`.
Do NOT tell the user the change will "revert on restart."

**Revert details:**
- **Fresh baseHash required.** The `baseHash` from Step 2 is stale after
  `config.patch` already changed the config. Call `config.get` again before
  applying the reverse patch and use the new hash.
- **Multi-path revert.** If the original patch changed multiple paths,
  revert ALL paths in a single reverse patch unless the user explicitly
  requests a partial revert.
- **Type-changing revert.** Restore each path to its exact original value
  and type from the Step 2 snapshot — even if the original was a different
  type (e.g. reverting from an object back to a string). Do not attempt to
  patch individual sub-keys; replace the whole value.
- **Absent-field revert.** If a field was absent in the Step 2 snapshot
  (i.e. the key did not exist in `config` and was inheriting its schema
  default), do NOT use `null` to delete it — that violates the merge-patch
  guardrail. The schema lookup does not expose default values, so ask the
  user what value to restore, or suggest leaving the field at its current
  value until the next redeployment restores the original default from the
  base config.

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

The tool runs transport-safety preflight checks (valid JSON object, well-formed
dot-delimited path segments at every leaf, no null/deletion values, max 20
paths per patch) but does **not** validate against the config schema — that
authority belongs to the `gateway` tool in Phase 1. It then saves the change
durably so it survives restarts and redeployments.

**If saving fails:** warn the user that the change is active but hasn't been
saved to the deployment repo — it will persist across in-process restarts
but will be lost on the next full redeployment. They can retry `set_config`
later.

#### Step 6 — Report

The tool returns save status and progress information.
Report success/failure to the user.

## Worked example: intent resolution via iterative drill-down

User says: "turn off transcript echo"

**Step 0:** "transcript echo" is media-related → start with `tools` group.

```
gateway(action: "config.schema.lookup", path: "tools")
```
→ children include `media` (hasChildren: true), `web`, `exec`, `links`, …
"media" matches best → drill deeper:

```
gateway(action: "config.schema.lookup", path: "tools.media")
```
→ children: `audio` (hasChildren: true), `image`, `video`
"audio" is the right sub-group → drill deeper:

```
gateway(action: "config.schema.lookup", path: "tools.media.audio")
```
→ children: `echoTranscript` (boolean, label: "Echo Transcript to Chat"),
  `echoFormat` (string), `scope` (object, hasChildren: true)

Match: "transcript echo" → `echoTranscript` (boolean, no `hasChildren` flag
→ settable leaf). Path resolved.

"I'll set `tools.media.audio.echoTranscript` to `false`."

**Steps 2-6:** proceed as normal with path
`tools.media.audio.echoTranscript` and value `false`.
(Step 1 skipped — the parent lookup already provided the type info.)

## Worked example: single path with direct guess

User says: "change the model to google/gemini-3-flash"

**Step 0:** "model" → `agents` group. Guess full path directly:
```
gateway(action: "config.schema.lookup", path: "agents.defaults.model")
```
→ succeeds: children `[]` — this is a settable leaf.

**Step 2** (Step 1 already done in Step 0):
```
gateway(action: "config.get")
```

Config.get returns hash `"abc123"` and shows current value is
`"anthropic/claude-sonnet-4-20250514"` (a string). The user wants a
simple model swap, so a string value is appropriate.

**Preview:**
> Changing `agents.defaults.model`:
> `"anthropic/claude-sonnet-4-20250514"` → `"google/gemini-3-flash"`
> Apply this change?

**Step 3** (after user says "yes, try it"):
```
gateway(
  action: "config.patch",
  raw: "{\"agents\":{\"defaults\":{\"model\":\"google/gemini-3-flash\"}}}",
  baseHash: "abc123",
  note: "Changed model to google/gemini-3-flash"
)
```

**Step 4:** "The model has been changed. Please try sending a message to
verify it works. Want me to save this permanently?"

**Step 5** (after user confirms):
```
set_config(
  patch: "{\"agents\":{\"defaults\":{\"model\":\"google/gemini-3-flash\"}}}"
)
```

**Step 6:** "Change saved. Deployment in progress — [view](url)."

## Worked example: multi-path patch

User says: "switch to gemini-3-flash with claude-sonnet as fallback, and
enable streaming on Telegram"

**Step 0:** Two groups — `agents` for models, `channels` for streaming.
Guess paths directly (parallel):
```
gateway(action: "config.schema.lookup", path: "agents.defaults.model")
gateway(action: "config.schema.lookup", path: "channels.telegram.streaming")
```
→ `agents.defaults.model`: children `[]` — settable leaf.
→ `channels.telegram.streaming`: schema `{}`, children `[]` — settable leaf
  (union type; use `config.get` and `hint` to determine accepted shapes).

Two paths confirmed.

**Step 2** (Step 1 already done in Step 0; only config.get needed):
```
gateway(action: "config.get")
```

Current value for `agents.defaults.model` is
`"anthropic/claude-sonnet-4-20250514"` (a string). The user wants
primary + fallback, so try the object form `{primary, fallbacks}`.

**Preview:**
> Changing 2 config paths:
> - `agents.defaults.model`: `"anthropic/claude-sonnet-4-20250514"` →
>   `{"primary":"google/gemini-3-flash","fallbacks":["anthropic/claude-sonnet-4-20250514"]}`
> - `channels.telegram.streaming`: `"off"` → `"partial"`
> Apply these changes?

**Step 3** (one patch covers both paths):
```
gateway(
  action: "config.patch",
  raw: "{\"agents\":{\"defaults\":{\"model\":{\"primary\":\"google/gemini-3-flash\",\"fallbacks\":[\"anthropic/claude-sonnet-4-20250514\"]}}},\"channels\":{\"telegram\":{\"streaming\":\"partial\"}}}",
  baseHash: "abc123",
  note: "Switched to gemini-3-flash with claude-sonnet fallback, set Telegram streaming to partial"
)
```

**Step 4:** "Both changes are now active. Please verify everything
works. Want me to save these permanently?"

**Step 5** (after user confirms):
```
set_config(
  patch: "{\"agents\":{\"defaults\":{\"model\":{\"primary\":\"google/gemini-3-flash\",\"fallbacks\":[\"anthropic/claude-sonnet-4-20250514\"]}}},\"channels\":{\"telegram\":{\"streaming\":\"partial\"}}}"
)
```

**Step 6:** "Both changes saved. Deployment in progress — [view](url)."

## Config path format

- Dot-delimited config path
- Only simple identifiers per segment (no array selectors like `list[id=main]`)
- Examples:
  - `agents.defaults.model` — accepts a string or `{primary, fallbacks}` object
  - `channels.telegram.enabled` — boolean toggle
  - `channels.telegram.streaming` — streaming mode
  - `tools.media.audio.echoTranscript` — echo transcript to chat (boolean)

## Top-level config groups

Use this guide to identify the starting group for `config.schema.lookup`.
Each group name is a valid `path` argument. Plugin-contributed and
channel-contributed config fields are included in the schema automatically —
no manual listing required.

| Group | Covers |
|-------|--------|
| `agents` | Model selection (primary, fallback, image, PDF), agent list, heartbeat, memory search |
| `channels` | Per-channel toggles, streaming mode, parse mode (telegram, discord, slack, imessage, …) |
| `tools` | Media understanding (audio, image, video), web search/fetch, shell exec, agent-to-agent, links |
| `talk` | TTS provider, interrupt-on-speech, silence timeout |
| `session` | Session scope, DM scope, reset mode & schedule, reset triggers, typing indicator |
| `browser` | Browser automation toggle, headless mode |
| `ui` | Assistant name, avatar, accent color |
| `memory` | Memory backend, citations mode, QMD config |
| `plugins` | Plugin entries and per-plugin config |
| `models` | Provider credentials, model registry, custom model definitions |
| `mcp` | MCP server definitions and configuration |

Other groups exist beyond this table. If no row matches, try
`config.schema.lookup` on a plausible group name.
