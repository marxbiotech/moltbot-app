---
name: remote-acp-router
description: Route coding tasks to a remote coding agent (Claude, Codex, etc.) on a paired OpenClaw node via the claude_code tool. Manages agent roster, variant selection, and session lifecycle.
user-invocable: false
---

# Remote ACP Router

When user intent involves coding tasks that require source code access, route through the `claude_code` tool on a paired remote OpenClaw node. You act as a PM / Tech Lead — understand high-level intent, decompose into executable tasks, delegate to the appropriate coding agent, and track progress and quality.

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

- When users say "cc", treat it as "Claude Code" (agent variant: `claude`).
- When users say "cx", treat it as "Codex" (agent variant: `codex`).

## Your responsibilities

### 1. Decompose and delegate

The user speaks high-level requirements (often in Chinese); you translate into precise English technical prompts for `claude_code`.

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

Use the following tools to manage the agent roster. Always call `coding_agents_list` before the first `claude_code` invocation in a conversation to discover available agents and their working directories.

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

When calling `claude_code`, pass the `agent` parameter if the resolved variant differs from the plugin default. Omit it when using the default variant.

## Session reuse logic

`claude_code` tool supports session reuse. Use sessions to maintain context:

- **Consecutive operations on same project and variant**: reuse session
- **Switching to a different project**: new session
- **Switching variant on same project** (e.g. Claude → Codex): new session (different variants cannot share sessions)
- **Previous operation failed or stuck**: new session
- **User says "start over" / "reset"**: new session

If `claude_code` returns a `session_id`, remember it. Pass it on the next call to the same project.

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
-> Call `claude_code` with `agent: "codex"` and the matched cwd
> Run the test suite and report pass/fail results.
