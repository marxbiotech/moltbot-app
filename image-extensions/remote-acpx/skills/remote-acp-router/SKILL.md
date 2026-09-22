---
name: remote-acp-router
description: Delegate repository work to an ACP coding agent on a configured paired node, then coordinate progress, follow-up, and results from the Gateway conversation. Use for remote coding requests or coding channels configured for remote execution.
user-invocable: false
---

# Remote ACP Router

You are the coordinating Gateway agent. Turn the user's request into work for
the configured remote coding agent, follow its outcome, and report to the user.
Invoke tools yourself; the user does not need to enter slash commands.

## Choose the target

- Use the project, harness, and node-local workspace from the conversation's
  configured routing or the user's explicit choice. Do not invent paths or ids.
- `sessions_spawn` with `runtime: "acp"` selects the configured ACP backend.
  With `remote-acpx`, acpx runs on the paired node, not on the Gateway. The
  plugin's `target` / `targets` configuration selects the node; do not pass a
  `nodeName` argument to the tool.
- `agentId` selects an allowed ACP harness, such as `claude`, or a configured
  ACP agent alias. It is not automatically the old project's roster id. Pass
  the known absolute node-local `cwd` explicitly to preserve project selection.
- Keep an explicitly requested executor. If its node or login is unavailable,
  report the problem instead of switching executor, node, or local execution.

## Start work

For delegated background work, call `sessions_spawn` yourself:

```json
{
  "runtime": "acp",
  "agentId": "claude",
  "cwd": "/absolute/project/on/node",
  "mode": "run",
  "streamTo": "parent",
  "task": "Investigate the failing tests in this project, fix the cause, and report the changes and verification results."
}
```

Replace the example target and task with the actual configured project and
user request. Include useful context, constraints, and acceptance criteria.
Preserve the user's scope and authorization; delegation grants no additional
permission. Do not conceal that instructions are delegated or invent approvals.

`mode: "run"` keeps you as the coordinator and uses the core background task
completion path. Do not bind the user's conversation directly to a coding
harness as a substitute for delegation. Use `mode: "session", thread: true`
only when the user actually requests a persistent harness conversation in a
supported thread.

## Coordinate and finish

- An accepted spawn returns `childSessionKey` and `runId`. Keep these exact
  handles and the project/executor mapping. Acceptance means admitted, not done.
- Tell the user what was started and let the core task completion notification
  bring back the result. Do not repeatedly spawn the same task or poll in a loop.
- For requested status, use `subagents` with `action: "list"` or the available
  session history tools. To wait or cancel, use `subagents` with the task id
  returned by its listing; do not substitute a run id or session key for it.
- For a still-active child, send additional instructions with `sessions_send`
  using its exact `sessionKey` and `message`; this queues a follow-up turn.
  Include the full relevant context because a one-shot run does not retain
  native harness memory between turns. Do not start a second writer for the
  same work. `mode: "steer"` and `mode: "resume"` are for native agent runs,
  not ACP; use `subagents` cancellation when interruption is required.
- `mode: "run"` is one-shot: completion closes that harness session. For later
  work, start a new run with the prior findings, decisions, and remaining work
  in `task`. Reusing its session key does not preserve native harness memory.
  If continuous native harness context is required, use a supported persistent
  child-thread session instead; do not bind away the coordinating conversation.
- When a task completes, inspect its result and report the changes, validation,
  and remaining issues in the user's language. Summarize the outcome yourself;
  do not forward raw task notices as the final answer.

## Failure and recovery

Execution authorization comes from the Gateway/node policy, independently of
the coding harness's own file/tool permissions. Never self-approve requests or
change policy to get past a denial. If approval is required, surface the actual
request; do not tell the user to replace your tool call with `/acp`.

For a confirmed pre-dispatch denial, say that work did not start. A dispatch or
task-registration error can occur after work started, even when the tool returns
an error. A timeout or disconnect can also leave completion unknown: inspect
task state and the workspace before retrying. Node disconnect cancels owned
work; it is not a promise of detached execution. Do not replay an uncertain
prompt automatically.

The old `run_coder`, `coding_agents_*`, and plugin `jobId` workflow are absent.
Do not call them, install a local acpx fallback, or treat a missing old job as
permission to repeat work. Use the core session/task owners throughout.
