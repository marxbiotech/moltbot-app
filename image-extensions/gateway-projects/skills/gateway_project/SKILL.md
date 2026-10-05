---
name: gateway_project
user-invocable: false
description: Develop the project explicitly assigned to this channel on the gateway, using persistent task worktrees and the project's GitHub identity.
---

Use only the project ID assigned by this channel's system prompt. An unrelated
channel or a repository mentioned in a message does not establish an assignment.

For development, call `gateway_project_prepare` with a stable `task` identifier
such as `issue-42`. Reuse it on continuation; use a new identifier for a separate
task, especially for unthreaded messages. The plugin binds the task to the host's
session and resolves the project from the trusted agent/channel context; do not
supply a project ID or fabricate channel/session identifiers. The structured result
provides the worktree, branch and repository. Run all edits, builds, commits and
pushes in that worktree. Read the repository's own AGENTS.md before modifying it.

`gateway_project_prepare` clones lazily, locks shared Git operations and reuses existing task
worktrees without resetting or pulling over changes. If an existing directory or
branch does not match, inspect and resolve it; do not delete it to bypass the check.
Retain unfinished work across restarts. Do not edit the shared source checkout.

Git HTTPS authentication and commit identity are configured by `gateway_project_prepare`.
Use `gateway_project_github` with an `args` array for authenticated GitHub commands,
for example `{ "args": ["issue", "view", "42"] }`. The tool runs from the project
workspace, not the task worktree: supply PR `--head` and `--base` explicitly and
use absolute `--body-file` paths for multiline text. Save the resulting PR URL in the task's project-state JSON, keeping
the generated task/worktree fields. Resume by consulting that state and GitHub.

Push the task branch and create PRs/issues when requested by the user. The presence
of this skill does not authorize unrelated publishing, merging or deployments.
Never print credentials, invoke the credential helper to view its output, store a
token in a remote URL, or use `/gh_apps token` in chat.

Keep project files and task notes in the returned project worktree. The persona's
main agent and memory are shared; do not proactively send project context to
channels outside this project's explicit assignments. Use another persona when
separate memory or identity is required. GitHub issues and PRs are the shared progress record across assigned
channels. This workflow runs on the gateway in the returned task worktree.
