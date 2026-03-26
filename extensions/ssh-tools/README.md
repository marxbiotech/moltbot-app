# ssh-tools

OpenClaw plugin for SSH key management and diagnostics.

## Commands

| Command | Description |
|---------|-------------|
| `/ssh_setup` | Generate ed25519 key pair, set permissions, create symlink, configure known_hosts |
| `/ssh_check` | Diagnose SSH key health — symlink, permissions, GitHub connectivity |

## Requirements

The container must have these CLI tools installed:

- `ssh-keygen` — key generation (part of `openssh-client`)
- `ssh-keyscan` — known_hosts population (part of `openssh-client`)
- `ssh` — connectivity testing (part of `openssh-client`)

These are installed in the Dockerfile via `apt-get install -y openssh-client`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MOLTBOT_EMAIL` | No | Email for SSH key comment (e.g. `user@example.com`). Falls back to `openclaw-agent@github` |

## How It Works

Both commands use `registerCommand()` which executes **without the AI agent** — the shell script runs directly, no LLM involved.

- **`/ssh_setup`** creates keys at `/root/.openclaw/workspace/.ssh/`, symlinks `/root/.ssh` to it, and adds `github.com` to known_hosts. Keys persist across container restarts via R2 backup.
- **`/ssh_check`** verifies the symlink, file permissions, key fingerprint, and tests `ssh -T git@github.com`.
