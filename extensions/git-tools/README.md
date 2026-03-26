# git-tools

OpenClaw plugin for git repository management in the workspace.

## Commands

| Command | Description |
|---------|-------------|
| `/git_check [path]` | Pre-push safety check — sensitive files, diff size, branch name, divergence |
| `/git_sync [url]` | Pull all workspace repos (no args) or clone a new repo by URL |
| `/git_repos` | Scan all workspace repos — branch, dirty status, last commit |

## Requirements

- `git` CLI installed in the container (included in base image)
