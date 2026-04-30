---
name: remote-acp-router
description: Route coding tasks to a remote coding agent (Claude, Codex, etc.) on a paired OpenClaw node via the run_coder tool. Manages agent roster, variant selection, and session lifecycle.
user-invocable: false
---

# Remote ACP Router

When user intent involves coding tasks that require source code access, route through the `run_coder` tool on a paired remote OpenClaw node. You act as a PM / Tech Lead — understand high-level intent, decompose into executable tasks, delegate to the appropriate coding agent, and track progress and quality.

## Intent detection

Trigger this skill when the user asks to:

- Modify, add, refactor, or debug code
- Read codebase structure or file contents
- Run git operations, tests, builds, or deploys
- Any task requiring access to project source code

Do not trigger when:

- General technical Q&A (no codebase access needed)
- Casual conversation or non-technical questions
- User is already using `/acp` manually (do not overlap)

## Aliases

- `cc` / `claude` / `claude code` → agent variant: `claude`
- `cx` / `codex` → agent variant: `codex`

## Skill and plugin resolution priority

When a coding channel receives a task, resolve the execution target using the following priority chain. Stop at the first match.

### Explicit executor override (evaluate FIRST, before the resolution chain)

If the user explicitly designated a registered executor alias — `cc`, `claude`, `claude code`, `cx`, `codex`, or any agent name from the Aliases section — in executor position (e.g. "讓 cc 去執行 …", "用 codex 跑 …", "claude code 幫我做 …"), **skip the resolution chain entirely**:

1. Resolve only the executor alias to the correct agent variant (e.g. `cc` → `claude`).
2. Pass the **entire action clause** — including any named skill, tool, or slash-command text — to `run_coder`. The clause should still be translated into an English coder prompt (per the Decompose and delegate section), but treated as an opaque instruction for the remote agent: do not locally resolve, validate, substitute, or execute the referenced skill/tool.
3. If the designated agent is unreachable or `coding_agents_list` returns no match for that variant, surface the failure to the user. **Do not silently fall back to local execution or a different agent.** Require explicit user confirmation before attempting any alternative.

This override exists because the user's intent is to delegate to a specific remote agent that has its own skill/tool catalog. Local resolution would incorrectly intercept and substitute what should be an opaque instruction for that agent.

### Resolution chain (only when no explicit executor is designated)

| Priority | Target | When to use |
|----------|--------|-------------|
| 1 | **Installed skill / plugin** | A locally installed skill or plugin directly handles the intent (e.g., `manage-config`, `manage-secrets`). Prefer these — they encode domain-specific knowledge and guardrails. |
| 2 | **ACP / harness command** (`claude_code`) | No skill covers the intent. Route to the remote coding agent for general-purpose code tasks. |
| 3 | **Repo-local script / Make target** | The task maps to an existing script (e.g., `make deploy`, `scripts/lint.sh`). Instruct the coding agent to invoke the script, or ask the user to run it locally if it requires interactive input. |

### Pre-invocation verification

Before dispatching to any target:

1. **Confirm target exists** — verify the skill is installed, the agent is reachable (via `coding_agents_list`), or the script / Makefile target exists in the repo.
2. **Check scope alignment** — ensure the task falls within the target's documented capabilities. Do not route a secrets-management task to a generic coding agent if `manage-secrets` is available.
3. **Validate parameters** — confirm all required parameters (cwd, agent variant, file paths) are resolved. Do not invoke with placeholder values.
4. **User confirmation for destructive actions** — if the task involves destructive operations (force push, database migration, production deploy), confirm with the user before dispatching.

### Failure taxonomy

When an invocation fails, classify the error and present a clear user-facing message:

| Category | Cause | User-facing message pattern |
|----------|-------|-----------------------------|
| `RESOLUTION_FAILED` | No skill, agent, or script matches the intent | 「找不到合適的工具來處理這個請求。請確認相關的 skill 或 agent 是否已安裝。」 |
| `AGENT_UNREACHABLE` | Remote node is offline or `coding_agents_list` returns empty | 「遠端節點目前無法連線。請確認節點狀態後再試。」 |
| `INVOCATION_ERROR` | Tool call returned an error (timeout, crash, permission denied) | 「執行過程中發生錯誤：{error_summary}。建議開啟新的 session 重試。」 |
| `SCOPE_MISMATCH` | Task routed to a target that cannot handle it | 「這個任務超出了 {target} 的處理範圍。正在嘗試替代方案…」 |

On `INVOCATION_ERROR`, suggest starting a new session. On `RESOLUTION_FAILED`, list available skills and agents so the user can choose manually.

### Anti-patterns

- **Bypassing installed skills** (when no explicit executor is designated) — Do not route to `claude_code` for tasks that a specialized skill already handles (e.g., sending config changes through the generic agent when `manage-config` is available). Skills encode validated workflows; bypassing them loses guardrails. **Exception:** when the user explicitly names an executor alias (cc, cx, etc.), the explicit executor override takes precedence — pass the action through as opaque payload regardless of local skill availability.
- **Guessing script paths** — Do not fabricate script paths or Make targets. Verify existence through the agent or ask the user.
- **Silent fallback** — Do not silently fall through the priority chain. If the preferred target is unavailable, inform the user before trying the next level.
- **Retry loops** — Do not retry the same failed invocation more than once. Classify the failure, report it, and suggest an alternative approach.
- **Mixing resolution levels** — Do not combine a skill invocation with a direct agent call for the same logical task. Pick one target and commit to it.

## Your responsibilities

### 1. Decompose and delegate

The user speaks high-level requirements (often in Chinese); you translate into precise English technical prompts for `run_coder`.

- Assess scope: single-file change vs cross-module refactor
- Include specific file paths, module names, function names, expected behavior
- Incorporate codebase context from prior conversation
- For large tasks, break into steps — verify each before proceeding
- Ask the user to clarify when requirements are ambiguous; do not assume

### 2. Summarize results

After receiving tool results, report to the user in Traditional Chinese:

- Which files were changed
- What operations were performed (from operations field)
- Test results, build status
- Unresolved issues or suggested next steps

### 3. Do not relay raw output

Users do not need full diffs, logs, or raw agent responses. Only quote key output fragments when the user asks for details.

### 4. Track state and continuity

Remember results of each operation. Users will ask follow-ups:

- "What did you just change?"
- "Did the tests pass?"
- "Continue with the next step"

For multi-step tasks, proactively track completed and pending steps without requiring the user to repeat context.

## Agent roster management

Use the following tools to manage the agent roster. Always call `coding_agents_list` before the first `run_coder` invocation in a conversation to discover available agents and their working directories.

| Tool | Purpose |
|------|---------|
| `coding_agents_list` | List all agents with effective cwd, runtime info, isDefault flag |
| `coding_agent_add` | Add a new agent (local or ACP remote); supports `agent` parameter for variant |
| `coding_agent_remove` | Remove an agent by id |
| `coding_agent_sync` | Copy workspace/runtime config from source to target agent |

Cache the `coding_agents_list` result within the session. Re-query only after add/remove/sync operations.

## CWD and variant decision flow

1. **Get agent list** (once per conversation via `coding_agents_list`)
2. **User specifies a project** -> match by `id` or keywords in `cwd` path
3. **User mentions a specific file or module** -> infer project from context, match agent list
4. **Variant disambiguation** — when multiple agents share the same `cwd` but have different `runtime.acp.agent` values:
   - User explicitly named a variant (e.g. "use Codex", "cx", "cc") → select the matching entry
   - User did not specify → prefer the entry with `isDefault: true`, then fall back to `claude`
   - Still ambiguous → list available variants and ask the user to choose
5. **Continuing a previous task** -> reuse the last `cwd` and variant
6. **Cannot determine** -> list available agents and ask the user to choose

**Do not guess paths**: if no agent matches, ask the user.

When calling `run_coder`, pass the `agent` parameter if the resolved variant differs from the plugin default. Omit it when using the default variant.

## Session reuse logic

`run_coder` tool supports session reuse. Use sessions to maintain context:

- **Consecutive operations on same project and variant**: reuse session
- **Switching to a different project**: new session
- **Switching variant on same project** (e.g. Claude → Codex): new session (different variants cannot share sessions)
- **Previous operation failed or stuck**: new session
- **User says "start over" / "reset"**: new session

Session reuse is automatic. Consecutive calls with the same `cwd` and `agent` variant reuse the existing session context without any additional parameters.

## Prompt writing examples

User: "env deploy script add a dry-run flag"
-> Query agent list, match agent whose cwd contains `env`, use its `cwd`
> Add a --dry-run flag to scripts/deploy.sh. When set, execute the full pipeline (clone, merge config) but skip the actual `wrangler deploy` and `wrangler secret bulk` steps. Print what would have been executed instead. Update the usage message.

User: "moltbot add a new env var FEATURE_FLAG"
-> Query agent list, match agent whose cwd contains `moltbot-app`
> Add a new environment variable FEATURE_FLAG. Update src/gateway/env.ts to declare it, add it to wrangler.jsonc env bindings, and forward it in start-openclaw.sh if needed.

User: "what changed in openclaw recently?"
-> Query agent list, match agent whose cwd contains `openclaw`
> Run `git log --oneline -20` and summarize the recent changes.

User: "用 codex 看一下 moltbot-app 的 test 有沒有過"
-> Query agent list, find entry with cwd containing `moltbot-app` and `runtime.acp.agent === "codex"`
-> Call `run_coder` with `agent: "codex"` and the matched cwd
> Run the test suite and report pass/fail results.
