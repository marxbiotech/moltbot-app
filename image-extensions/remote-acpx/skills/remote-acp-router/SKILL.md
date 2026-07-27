---
name: remote-acp-router
description: Route coding tasks to a remote coding agent (Claude, Codex, Gemini, etc.) on a paired OpenClaw node via the run_coder tool — node-routed execution, not the local ACP harness. Manages agent roster, variant selection, and per-conversation session continuity.
user-invocable: false
---

# Remote ACP Router

*Node-routed remote execution via `run_coder`. Not a local ACP harness controller.*

When user intent involves coding tasks that require source code access, route through the `run_coder` tool on a paired remote OpenClaw node. You act as a PM / Tech Lead — understand high-level intent, decompose into executable tasks, delegate to the appropriate coding agent, and track progress and quality.

## 1. What this skill is

### Triggers

Trigger this skill when the user asks to:

- Modify, add, refactor, or debug code
- Read codebase structure or file contents
- Run git operations, tests, builds, or deploys
- Any task requiring access to project source code

## 2. What this skill is not

This skill is bounded. The patterns below look like they could belong here, but do not.

### Out-of-scope triggers

Do not trigger when:

- General technical Q&A (no codebase access needed)
- Casual conversation or non-technical questions
- **The user is already in a local `/acp` session** — that path is the local ACP harness UX (see *Not the local ACP harness* below). Do not layer this skill's node-routed `run_coder` flow on top of it.

### Not the local ACP harness

In this environment, **`run_coder` is the node-routed equivalent of ACP-style coding execution.** Despite the "ACP" in this skill's name, do **not** use `sessions_spawn(runtime: "acp")` as the execution path. That tool spawns and manages a *local* OpenClaw ACP harness session inside the current runtime — its UX is focusable and session-first, and the agent runs in-process on this box. Using it would collapse the remote-node hop and break the architecture this skill exists to preserve.

The local `/acp` slash command spawns the same local-harness UX. The non-overlap rule is also listed above under *Out-of-scope triggers*.

## 3. Execution model

`run_coder` executes one prompt against a remote coding agent (Claude Code, Codex, Gemini CLI, etc.) on the paired OpenClaw node and returns a structured result.

### Variants

- `cc` / `claude` / `claude code` → agent variant: `claude`
- `cx` / `codex` → agent variant: `codex`
- `gem` / `gemini` / `gemini cli` → agent variant: `gemini`

### Variant prerequisites

Each variant is dispatched as `acpx <variant> …` on the paired Mac, which in turn launches the variant's own CLI. The variant CLI must already be authenticated on the node — remote-acpx does not perform any auth handoff.

| Variant | CLI | Auth prerequisite on the paired node |
|---------|-----|---------------------------------------|
| `claude` | Claude Code via `@agentclientprotocol/claude-agent-acp` | `claude` CLI logged in (Anthropic auth) |
| `codex` | bundled `@zed-industries/codex-acp` (isolated CODEX_HOME) | OpenAI / Codex auth completed |
| `gemini` | `gemini --acp` (Google Gemini CLI) | `gemini auth login` completed on the Mac |

When a Gemini turn fails immediately at spawn with an auth-style error, surface it to the user and ask them to run `gemini auth login` on the paired Mac before retrying. Do not silently fall back to a different variant.

### Gemini model aliases

For `agent: "gemini"`, the `model` parameter accepts either a full Gemini model id (e.g. `gemini-3.1-flash-preview`) or one of the short aliases:

- `pro` → `gemini-3.1-pro-preview`
- `flash` → `gemini-3.1-flash-preview`
- `flash-lite` → `gemini-3.1-flash-lite-preview`

The aliases are normalized inside remote-acpx; unknown values pass through unchanged so newer model ids continue to work.

### Roster tools

| Tool | Purpose |
|------|---------|
| `coding_agents_list` | List all agents with effective cwd, runtime info, isDefault flag |
| `coding_agent_add` | Add or replace an agent (in-process local agent, or node-routed ACP remote agent); supports `agent` parameter for variant |
| `coding_agent_remove` | Remove an agent by id |
| `coding_agent_sync` | Copy workspace/runtime config from source to target agent |

Cache the `coding_agents_list` result within the session and re-query only after add / remove / sync operations. Do **not** call it as a prerequisite for every `run_coder` invocation — `agentId` makes roster lookup automatic.

### Resolving the target agent

`run_coder` accepts an `agentId` parameter that automatically resolves the cwd and agent variant from the configured roster. **Always prefer `agentId` over explicit `cwd` / `agent` parameters.**

Decision flow:

1. **Channel system prompt names the target agent** (e.g. "派送至 store agent 處理") → use that id directly: `run_coder({ agentId: "store", prompt: "…" })`
2. **User specifies a project** → match by agent `id` or keywords in channel context, pass the matched `agentId`
3. **User mentions a specific file or module** → infer project from context, resolve `agentId`
4. **Variant override** — user explicitly named a variant (e.g. "use Codex", "cx", "用 gemini"): pass `agent: "codex"` (or `"gemini"`, `"claude"`) alongside `agentId` to override the roster default
5. **Continuing a previous task** → reuse the last `agentId` and variant
6. **Cannot determine** → call `coding_agents_list` to discover available agents, then ask the user to choose

**Do not guess paths or ids**: if no agent matches, ask the user.

### Writing the prompt

The user speaks high-level requirements (often in Chinese); you translate into precise English technical prompts for `run_coder`.

- Assess scope: single-file change vs cross-module refactor
- Include specific file paths, module names, function names, expected behavior
- Incorporate codebase context from prior conversation
- For large tasks, break into steps — verify each before proceeding
- Ask the user to clarify when requirements are ambiguous; do not assume
- If the task maps to an existing repo script (e.g. `make deploy`, `scripts/lint.sh`), instruct the agent to invoke it rather than re-implementing the work — but verify the script exists first

### Choosing sync or async

`run_coder` runs synchronously by default and **a synchronous call cannot exceed 600 seconds**. That is a hard runtime limit, not a tunable: the tool call is a JSON-RPC request the Codex app-server is waiting on, and OpenClaw is obliged to answer it. Real dispatches land close to it — 544s has been observed — so treat ten minutes as the point where the sync path stops being viable.

Two parameters follow from that, and both are yours to set:

- **`timeoutSeconds`** (sync only). The default is **90 seconds**, which only covers trivial single-file edits. Pass `300` for ordinary multi-step work and `600` — the maximum — for codebase investigation, research, test runs, or builds. Omitting it on a real task is the most common way to lose finished work: the call is cut at 90s while the remote agent runs on to completion, and its answer is discarded.
- **`mode: "async"`**. Starts the work and returns a `jobId` immediately, with **no time limit**. Use it whenever the task plausibly exceeds ten minutes — exhaustive audits, full-repo reads, long builds, multi-package test runs.

Decide before invoking, not after a timeout:

| Task shape | Call |
|---|---|
| Single-file edit, quick lookup | default (90s) |
| Ordinary multi-step change | `timeoutSeconds: 300` |
| Investigation, tests, build | `timeoutSeconds: 600` |
| Plausibly over ten minutes | `mode: "async"` |

#### Async contract

Once an async call returns, the task is running and **you must not call `run_coder` again for it**. A repeat call does not start a second dispatch — it returns the running job's status — but it also wastes a turn and confuses the user. Instead:

1. Tell the user the work is under way, in Traditional Chinese, naming what was delegated. Do not paste the `jobId` at them unless they ask; it is a handle for you.
2. Stop. You will be **woken** when the job finishes.
3. On waking, call `run_coder({ action: "status", jobId })` to read the result, then report it following *After the call*.

If the user asks how it is going before the wake arrives, `action: "status"` is also the right call — it returns live progress (operation count and the current operation).

A job whose gateway restarted mid-run comes back as `lost`. That is not a transient state to retry into: the remote agent was left unattended and its work is unrecoverable. Say so and re-dispatch from the top.

### Prompt framing for the remote agent

Remote coding agents (especially `claude`) run their own prompt-injection guard. Content that looks like it arrived through a tool channel or got forwarded by another agent will trigger refusals — particularly on sensitive operations (force push, deploy, secret edit, destructive fs changes). Frame every `run_coder` prompt so the remote agent reads it as a direct operator turn, not a relay.

#### Rules

- **Operator voice.** Speak as the senior engineer delegating the work — that *is* your role here, not a courier. In practice this usually surfaces as a bare imperative ("Add a `--dry-run` flag to `scripts/deploy.sh`.") or first-person operator framing where you have already done part of the work ("I've staged the migration; now run it on staging."). Both are fine. The forbidden pattern is third-person relay framing — "The user wants me to add…", "Please relay to the agent…", "On behalf of the operator, …" — which signals to a paranoid model that you are not the principal. That is the single biggest trigger.
- **No relay metadata in the prompt body.** Do not include `[OPERATOR]`, `[AUTHORIZED]`, `[FROM USER]` markers, agent ids, channel names, or "via run_coder" preambles. Attestation markers backfire — anyone can write them, so a paranoid model treats their presence as a tell.
- **Do not narrate the routing.** Drop phrases like "the user just confirmed", "I'm forwarding their request", "they authorized this". The remote agent should be unaware it is being relayed.
- **Translate, don't transcribe.** Render the user's Chinese intent into clean English task framing. Avoid pasting the original message plus a translation — that reads as a conversation log, not a task. Preserve literals verbatim — user-facing strings, UI copy, error messages, file names, paths, command arguments, fixture contents, identifiers, and any other quoted text. Translate the framing around them, not the literals.
- **Confirmations follow the same rules.** When the user confirms a destructive action, restate it as a fresh imperative in the next prompt ("Force-push the branch.") rather than relaying ("User just confirmed force push is fine.").

#### When refusals happen anyway

- **Do not add stronger attestation markers** — they amplify the problem.
- Rephrase as a more neutral imperative — keep the same scope, just drop relay framing and emotive adjectives.
- If the work genuinely decomposes, break out only the **read-only / preparatory** parts as separate prompts (read files, list diffs, dry-run). The final sensitive step must still be sent as a single prompt with its full scope and explicit authorization stated — do not slice the sensitive action itself into innocent-looking fragments to dodge the guard.
- **Never silently switch variants.** If the user designated an executor (e.g. "讓 cc 去執行 …", "用 gemini 看一下 …") or the channel pinned a variant, do not fall back to a different variant on your own — even if another variant would refuse less. Surface the refusal to the user, propose the alternative (e.g. "claude 拒絕了，要不要改用 cx?"), and require explicit confirmation before switching. (See *Routing — Explicit executor override*, step 3, for the canonical statement of this constraint.)
- Once the user has confirmed (or no executor was designated to begin with), switching to a different variant (`cx` / `codex`, `gem` / `gemini`) is fine — they do not run the same guard at the same intensity.
- For routine worker tasks where the guard is structurally a poor fit and the user has not pinned a variant, prefer `codex` from the start.

### After the call

- Report results to the user in Traditional Chinese: which files changed, which operations were performed (from the `operations` field), test/build status, and unresolved issues or suggested next steps.
- Do **not** relay raw output. Users do not need full diffs, logs, or raw agent responses. Only quote key output fragments when the user asks for details.
- **After an async wake, the reporting duty is the same.** The wake notice is addressed to you, not the user — it is a prompt to fetch and summarise, not something to forward. Read the job with `action: "status"`, then write the same kind of summary you would have written had the call been synchronous. A user who sees a raw job notice has been handed your job.

## 4. Routing / resolution model

When a coding channel receives a task, resolve the execution target using the following priority chain. Stop at the first match.

### Explicit executor override (evaluate FIRST, before the resolution chain)

If the user explicitly designated a registered executor alias — `cc`, `claude`, `claude code`, `cx`, `codex`, `gem`, `gemini`, `gemini cli`, or any agent name from the *Variants* section — in executor position (e.g. "讓 cc 去執行 …", "用 codex 跑 …", "用 gemini 看一下 …", "claude code 幫我做 …"), **skip the resolution chain entirely**:

1. Resolve only the executor alias to the correct agent variant (e.g. `cc` → `claude`).
2. Pass the **entire action clause** — including any named skill, tool, or slash-command text — to `run_coder`. The clause should still be translated into an English coder prompt (per *Writing the prompt*), but treated as an opaque instruction for the remote agent: do not locally resolve, validate, substitute, or execute the referenced skill/tool.
3. If the designated agent is unreachable or `coding_agents_list` returns no match for that variant, surface the failure to the user. **Do not silently fall back to a different agent variant, a different node, or any local execution path — including `sessions_spawn(runtime: "acp")` or any other in-process harness.** Require explicit user confirmation before attempting any alternative.

This override exists because the user's intent is to delegate to a specific remote agent that has its own skill/tool catalog. Local resolution would incorrectly intercept and substitute what should be an opaque instruction for that agent.

### Resolution chain (only when no explicit executor is designated)

| Priority | Target | When to use |
|----------|--------|-------------|
| 1 | **Installed skill / plugin** | A locally installed skill or plugin directly handles the intent (e.g., `manage-config`, `manage-secrets`). Prefer these — they encode domain-specific knowledge and guardrails. |
| 2 | **Node-routed remote agent** (`run_coder`) | No skill covers the intent. Route to the remote coding agent for general-purpose code tasks. This is the only ACP-style execution path for this skill — see *Not the local ACP harness*; do not substitute `sessions_spawn(runtime: "acp")`. |

### Pre-invocation verification

Before dispatching to any target:

1. **Confirm target exists** — verify the skill is installed, or the agent is reachable (via `coding_agents_list`).
2. **Check scope alignment** — ensure the task falls within the target's documented capabilities. Do not route a secrets-management task to a generic coding agent if `manage-secrets` is available.
3. **Validate parameters** — preferred path: confirm `agentId` resolves to a real roster entry (cwd and variant come from the roster automatically). Only fall back to checking explicit `cwd` / `agent` parameters in override or exception cases (see *Resolving the target agent*). Do not invoke with placeholder values.
4. **User confirmation for destructive actions** — if the task involves destructive operations (force push, database migration, production deploy), confirm with the user before dispatching.

### Failure taxonomy

When an invocation fails, classify the error and present a clear user-facing message:

| Category | Cause | User-facing message pattern |
|----------|-------|-----------------------------|
| `RESOLUTION_FAILED` | No skill or agent matches the intent | 「找不到合適的工具來處理這個請求。請確認相關的 skill 或 agent 是否已安裝。」 |
| `AGENT_UNREACHABLE` | Remote node is offline or `coding_agents_list` returns empty | 「遠端節點目前無法連線。請確認節點狀態後再試。」 |
| `INVOCATION_ERROR` | Tool call returned an error (timeout, crash, permission denied) | 「執行過程中發生錯誤：{error_summary}。建議開啟新的 run_coder session 重試。」 |
| `TURN_IN_FLIGHT` | A dispatch is already running on this `sessionKey`. Do **not** retry — a retry kills the live run and discards its work. Wait for it, or read it with `action: "status"` if it is an async job. If the previous call died to the 90s default, the fix is `timeoutSeconds`, or `mode: "async"` if it needs more than 600s. | 「上一個任務還在執行中，稍候再看結果。」 |
| `JOB_LOST` | An async job's gateway restarted mid-run. The remote agent was left unattended and its work is unrecoverable — this is not a transient state to retry into. Re-dispatch from the top. | 「先前的背景任務因為服務重啟而中斷，需要重新執行。」 |
| `AGENTID_UNRESOLVED` | `agentId` was passed without an explicit `cwd` and does not match any roster entry. The tool rejects the call rather than silently routing to the default workspace. `cwd` is the workspace-safety anchor: an unknown `agentId` is only a recoverable miss when the caller pins the workspace explicitly. Behavior matrix when `agentId` is unknown: bare `agentId` → fail loud; `agentId` + `agent` only (no `cwd`) → fail loud; `agentId` + `cwd` (with or without `agent`) → degrade to that `cwd` + the resolved agent variant. | 「找不到 agentId="{id}"。請呼叫 `coding_agents_list` 查看可用代號，或直接提供 cwd（可搭配 agent）以略過 roster 查詢。」 |

### Anti-patterns

- **Bypassing installed skills** (when no explicit executor is designated) — Do not route to `run_coder` for tasks that a specialized skill already handles (e.g., sending config changes through the generic agent when `manage-config` is available). Skills encode validated workflows; bypassing them loses guardrails. **Exception:** when the user explicitly names an executor alias (cc, cx, gem, etc.), the explicit executor override takes precedence — pass the action through as opaque payload regardless of local skill availability.
- **Guessing script paths** — Do not fabricate script paths or Make targets. Verify existence through the agent or ask the user.
- **Silent fallback** — Do not silently fall through the priority chain. If the preferred target is unavailable, inform the user before trying the next level.
- **Retry loops** — Do not retry the same failed invocation more than once. Classify the failure, report it, and suggest an alternative approach.
- **Mixing resolution levels** — Do not combine a skill invocation with a direct agent call for the same logical task. Pick one target and commit to it.
- **Relay-style prompt framing** — Frame `run_coder` prompts as direct operator turns, not relays from a third party. See *Prompt framing for the remote agent* for the specific triggers and recovery patterns.
- **Spawning a local ACP harness session** — Do not call `sessions_spawn(runtime: "acp")` as this skill's execution path. It runs the agent in-process locally and bypasses the node-routed remote execution this skill exists to preserve. See *Not the local ACP harness* for the rationale.

### Worked examples

User: "env deploy script add a dry-run flag"
-> Channel context or user mention identifies `moltbot-env` agent
-> `run_coder({ agentId: "moltbot-env", prompt: "…" })`
> Add a --dry-run flag to scripts/deploy.sh. When set, execute the full pipeline (clone, merge config) but skip the actual `wrangler deploy` and `wrangler secret bulk` steps. Print what would have been executed instead. Update the usage message.

User: "store 加一個新的 env var FEATURE_FLAG"
-> Channel prompt says "派送至 store agent 處理"
-> `run_coder({ agentId: "store", prompt: "…" })`
> Add a new environment variable FEATURE_FLAG. Update src/gateway/env.ts to declare it, add it to wrangler.jsonc env bindings, and forward it in start-openclaw.sh if needed.

User: "what changed in openclaw recently?"
-> No channel hint; call `coding_agents_list`, match agent whose cwd contains `openclaw`
-> `run_coder({ agentId: "openclaw", prompt: "…" })`
> Run `git log --oneline -20` and summarize the recent changes.

User: "用 codex 看一下 store 的 test 有沒有過"
-> User specifies variant override + project
-> `run_coder({ agentId: "store", agent: "codex", prompt: "…" })`
> Run the test suite and report pass/fail results.

## 5. Session / continuity model

### `run_coder` session identity

Each `run_coder` call carries a `sessionKey` supplied by the OpenClaw host. **That key is the primary session identity, and it already isolates by conversation context** — channel, DM, and **thread**. A Discord thread inside a channel, for example, arrives as something like `agent:<agentId>:discord:channel:<chanId>:thread:<threadId>`.

The practical consequence: two simultaneous threads in the same Discord channel that target the same repo (`agentId`) and the same variant (e.g. `claude`) get **different** `sessionKey`s from the host, occupy separate cache entries, and remain fully isolated. This skill cannot widen or narrow that identity — it does **not** key sessions by `agentId` + variant alone.

This is **not** the same thing as a local ACP harness session created by `sessions_spawn(runtime: "acp")` — see *Not the local ACP harness* — and the two cannot share state.

### Reuse guards within one `sessionKey`

Within a single `sessionKey`, the cached `run_coder` session is reused only while **all** of the following remain unchanged:

- **`cwd` / workspace** — switching project invalidates the cached session
- **agent variant** — switching variant (e.g. `claude` → `codex`) invalidates the cached session; different variants cannot share a session
- **remote node identity** — if the node disconnects or the handle changes, the cached session is invalidated
- **idle time** — sessions expire after 30 minutes of inactivity. Idle means idle: a session with a dispatch still running is not reclaimed, however long that dispatch takes, so an async job is never cut short by this.

If any guard fails, the previous session is closed and a fresh one is spawned for that `sessionKey` on the next `run_coder` call. The same automatic invalidation also fires when a `run_coder` turn returns an error or the underlying handle is lost.

There is **no skill-side reset action.** If the user asks to "start over" but the previous turn succeeded, the cached session stays warm — instruct the remote agent to reset its own state in the next prompt, switch to a different `agentId` (which keys into a different cache slot), or wait out the idle TTL. Do not pretend to "invalidate" a session from the skill side.

Reuse is automatic. Consecutive `run_coder` calls within the same conversation context, against the same project and variant, on a still-connected node, share session context with no extra parameters.
