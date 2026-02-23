# OpenClaw on Cloudflare Workers

Run [OpenClaw](https://github.com/openclaw/openclaw) (formerly Moltbot, formerly Clawdbot) personal AI assistant in a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/).

![moltbot-app architecture](./assets/logo.png)

> **Experimental:** This is a proof of concept demonstrating that OpenClaw can run in Cloudflare Sandbox. It is not officially supported and may break without notice. Use at your own risk.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aehrt55/moltbot-app)

## Requirements

- [Workers Paid plan](https://www.cloudflare.com/plans/developer-platform/) ($5 USD/month) — required for Cloudflare Sandbox containers
- At least one AI provider:
  - [Anthropic API key](https://console.anthropic.com/) — Claude models
  - [OpenAI API key](https://platform.openai.com/) — GPT models
  - [Google API key](https://aistudio.google.com/apikey) — Gemini models
  - [AWS Bedrock](https://aws.amazon.com/bedrock/) — Claude, DeepSeek, Qwen, and more via AWS (MFA-gated)
  - **Subscription auth** — use your Claude Pro/Max or ChatGPT Plus/Pro subscription without API keys (see [Subscription Auth](#subscription-auth))
  - [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) with [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) — route through Cloudflare

The following Cloudflare features used by this project have free tiers:
- Cloudflare Access (authentication)
- Browser Rendering (for browser navigation)
- AI Gateway (optional, for API routing/analytics)
- R2 Storage (optional, for persistence)

## Container Cost Estimate

This project uses a `standard-1` Cloudflare Container instance (1/2 vCPU, 4 GiB memory, 8 GB disk). Below are approximate monthly costs assuming the container runs 24/7, based on [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/):

| Resource | Provisioned | Monthly Usage | Included Free | Overage | Approx. Cost |
|----------|-------------|---------------|---------------|---------|--------------|
| Memory | 4 GiB | 2,920 GiB-hrs | 25 GiB-hrs | 2,895 GiB-hrs | ~$26/mo |
| CPU (at ~10% utilization) | 1/2 vCPU | ~2,190 vCPU-min | 375 vCPU-min | ~1,815 vCPU-min | ~$2/mo |
| Disk | 8 GB | 5,840 GB-hrs | 200 GB-hrs | 5,640 GB-hrs | ~$1.50/mo |
| Workers Paid plan | | | | | $5/mo |
| **Total** | | | | | **~$34.50/mo** |

Notes:
- CPU is billed on **active usage only**, not provisioned capacity. The 10% utilization estimate is a rough baseline for a lightly-used personal assistant; your actual cost will vary with usage.
- Memory and disk are billed on **provisioned capacity** for the full time the container is running.
- To reduce costs, configure `SANDBOX_SLEEP_AFTER` (e.g., `10m`) so the container sleeps when idle. A container that only runs 4 hours/day would cost roughly ~$5-6/mo in compute on top of the $5 plan fee.
- Network egress, Workers/Durable Objects requests, and logs are additional but typically minimal for personal use.
- See the [instance types table](https://developers.cloudflare.com/containers/pricing/) for other options (e.g., `lite` at 256 MiB/$0.50/mo memory or `standard-4` at 12 GiB for heavier workloads).

## What is OpenClaw?

[OpenClaw](https://github.com/openclaw/openclaw) (formerly Moltbot, formerly Clawdbot) is a personal AI assistant with a gateway architecture that connects to multiple chat platforms. Key features:

- **Control UI** - Web-based chat interface at the gateway
- **Multi-channel support** - Telegram, Discord, Slack
- **Device pairing** - Secure DM authentication requiring explicit approval
- **Persistent conversations** - Chat history and context across sessions
- **Agent runtime** - Extensible AI capabilities with workspace and skills

This project packages OpenClaw to run in a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) container, providing a fully managed, always-on deployment without needing to self-host. Optional R2 storage enables persistence across container restarts.

## Architecture

```
                    ┌─────────────────────────────────────────────────────┐
                    │              Cloudflare Worker (Hono)               │
                    │                                                     │
Browser ──────────► │  CF Access auth ──► /_admin/* (React SPA)          │
                    │                 ──► /api/*    (device mgmt)        │
                    │                                                     │
                    │  Catch-all proxy ──► Sandbox Container :18789      │
                    │    HTTP (containerFetch)                            │
                    │    WS  (wsConnect + WebSocketPair relay)           │
                    │                                                     │
Telegram ─────────► │  POST /telegram/webhook ──► Container :8787       │
                    │    (secret token validation)   (telegram-tools)     │
                    └─────────────────────────────────────────────────────┘
```

![moltworker architecture](./assets/architecture.png)

## Quick Start

_Cloudflare Sandboxes are available on the [Workers Paid plan](https://dash.cloudflare.com/?to=/:account/workers/plans)._

```bash
# Install dependencies
npm install

# Set your AI provider key (pick one)
npx wrangler secret put ANTHROPIC_API_KEY    # Anthropic (Claude)
# npx wrangler secret put OPENAI_API_KEY     # OpenAI (GPT)
# npx wrangler secret put GOOGLE_API_KEY     # Google (Gemini)

# Or skip API keys entirely and use subscription auth after deploy:
#   Set SUBSCRIPTION_AUTH=true in wrangler.jsonc vars, then use
#   /claude_auth or /openai_auth in chat (see Subscription Auth below)

# Or use Cloudflare AI Gateway instead (see "Optional: Cloudflare AI Gateway" below)
# npx wrangler secret put CLOUDFLARE_AI_GATEWAY_API_KEY
# npx wrangler secret put CF_AI_GATEWAY_ACCOUNT_ID
# npx wrangler secret put CF_AI_GATEWAY_GATEWAY_ID

# Generate and set a gateway token (required for remote access)
# Save this token - you'll need it to access the Control UI
export MOLTBOT_GATEWAY_TOKEN=$(openssl rand -hex 32)
echo "Your gateway token: $MOLTBOT_GATEWAY_TOKEN"
echo "$MOLTBOT_GATEWAY_TOKEN" | npx wrangler secret put MOLTBOT_GATEWAY_TOKEN

# Deploy
npm run deploy
```

After deploying, open the Control UI with your token:

```
https://your-worker.workers.dev/?token=YOUR_GATEWAY_TOKEN
```

Replace `your-worker` with your actual worker subdomain and `YOUR_GATEWAY_TOKEN` with the token you generated above.

**Note:** The first request may take 1-2 minutes while the container starts.

> **Important:** You will not be able to use the Control UI until you complete the following steps. You MUST:
> 1. [Set up Cloudflare Access](#setting-up-the-admin-ui) to protect the admin UI
> 2. [Pair your device](#device-pairing) via the admin UI at `/_admin/`

You'll also likely want to [enable R2 storage](#persistent-storage-r2) so your paired devices and conversation history persist across container restarts (optional but recommended).

## Setting Up the Admin UI

To use the admin UI at `/_admin/` for device management, you need to:
1. Enable Cloudflare Access on your worker
2. Set the Access secrets so the worker can validate JWTs

### 1. Enable Cloudflare Access on workers.dev

The easiest way to protect your worker is using the built-in Cloudflare Access integration for workers.dev:

1. Go to the [Workers & Pages dashboard](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
2. Select your Worker (e.g., `moltbot-sandbox`)
3. In **Settings**, under **Domains & Routes**, in the `workers.dev` row, click the meatballs menu (`...`)
4. Click **Enable Cloudflare Access**
5. Copy the values shown in the dialog (you'll need the AUD tag later). **Note:** The "Manage Cloudflare Access" link in the dialog may 404 — ignore it.
6. To configure who can access, go to **Zero Trust** in the Cloudflare dashboard sidebar → **Access** → **Applications**, and find your worker's application:
   - Add your email address to the allow list
   - Or configure other identity providers (Google, GitHub, etc.)
7. Copy the **Application Audience (AUD)** tag from the Access application settings. This will be your `CF_ACCESS_AUD` in Step 2 below

### 2. Set Access Secrets

After enabling Cloudflare Access, set the secrets so the worker can validate JWTs:

```bash
# Your Cloudflare Access team domain (e.g., "myteam.cloudflareaccess.com")
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN

# The Application Audience (AUD) tag from your Access application that you copied in the step above
npx wrangler secret put CF_ACCESS_AUD
```

You can find your team domain in the [Zero Trust Dashboard](https://one.dash.cloudflare.com/) under **Settings** > **Custom Pages** (it's the subdomain before `.cloudflareaccess.com`).

### 3. Redeploy

```bash
npm run deploy
```

Now visit `/_admin/` and you'll be prompted to authenticate via Cloudflare Access before accessing the admin UI.

### Alternative: Manual Access Application

If you prefer more control, you can manually create an Access application:

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Access** > **Applications**
3. Create a new **Self-hosted** application
4. Set the application domain to your Worker URL (e.g., `moltbot-sandbox.your-subdomain.workers.dev`)
5. Add paths to protect: `/_admin/*`, `/api/*`, `/debug/*`
6. Configure your desired identity providers (e.g., email OTP, Google, GitHub)
7. Copy the **Application Audience (AUD)** tag and set the secrets as shown above

### Local Development

For local development, create a `.dev.vars` file with:

```bash
DEV_MODE=true               # Skip Cloudflare Access auth + bypass device pairing
DEBUG_ROUTES=true           # Enable /debug/* routes (optional)
```

## Authentication

By default, moltbot uses **device pairing** for authentication. When a new device (browser, CLI, etc.) connects, it must be approved via the admin UI at `/_admin/`.

### Device Pairing

1. A device connects to the gateway
2. The connection is held pending until approved
3. An admin approves the device via `/_admin/`
4. The device is now paired and can connect freely

This is the most secure option as it requires explicit approval for each device.

### Gateway Token (Required)

A gateway token is required to access the Control UI when hosted remotely. Pass it as a query parameter:

```
https://your-worker.workers.dev/?token=YOUR_TOKEN
wss://your-worker.workers.dev/ws?token=YOUR_TOKEN
```

**Note:** Even with a valid token, new devices still require approval via the admin UI at `/_admin/` (see Device Pairing above).

For local development only, set `DEV_MODE=true` in `.dev.vars` to skip Cloudflare Access authentication and enable `allowInsecureAuth` (bypasses device pairing entirely).

## Persistent Storage (R2)

By default, moltbot data (configs, paired devices, conversation history) is lost when the container restarts. To enable persistent storage across sessions, configure R2:

### 1. Create R2 API Token

1. Go to **R2** > **Overview** in the [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Click **Manage R2 API Tokens**
3. Create a new token with **Object Read & Write** permissions
4. Select the `moltbot-data` bucket (created automatically on first deploy)
5. Copy the **Access Key ID** and **Secret Access Key**

### 2. Set Secrets

```bash
# R2 Access Key ID
npx wrangler secret put R2_ACCESS_KEY_ID

# R2 Secret Access Key
npx wrangler secret put R2_SECRET_ACCESS_KEY

# Your Cloudflare Account ID
npx wrangler secret put CF_ACCOUNT_ID
```

To find your Account ID: Go to the [Cloudflare Dashboard](https://dash.cloudflare.com/), click the three dots menu next to your account name, and select "Copy Account ID".

### How It Works

R2 storage uses a backup/restore approach for simplicity:

**On container startup:**
- If R2 is mounted and contains backup data, it's restored to the moltbot config directory
- OpenClaw uses its default paths (no special configuration needed)

**During operation:**
- A background sync loop watches for file changes every 30 seconds and uploads to R2
- You can also trigger a manual backup from the admin UI at `/_admin/`

**In the admin UI:**
- When R2 is configured, you'll see "Last backup: [timestamp]"
- Click "Backup Now" to trigger an immediate sync

Without R2 credentials, moltbot still works but uses ephemeral storage (data lost on container restart).

## Container Lifecycle

By default, the sandbox container stays alive indefinitely (`SANDBOX_SLEEP_AFTER=never`). This is recommended because cold starts take 1-2 minutes.

To reduce costs for infrequently used deployments, you can configure the container to sleep after a period of inactivity:

```bash
npx wrangler secret put SANDBOX_SLEEP_AFTER
# Enter: 10m (or 1h, 30m, etc.)
```

When the container sleeps, the next request will trigger a cold start. If you have R2 storage configured, your paired devices and data will persist across restarts.

## Admin UI

![admin ui](./assets/adminui.png)

Access the admin UI at `/_admin/` to:
- **R2 Storage Status** - Shows if R2 is configured, last backup time, and a "Backup Now" button
- **Restart Gateway** - Kill and restart the moltbot gateway process
- **Device Pairing** - View pending requests, approve devices individually or all at once, view paired devices

The admin UI requires Cloudflare Access authentication (or `DEV_MODE=true` for local development).

## Multi-Provider Support & Model Switching

moltbot supports multiple AI providers simultaneously. When two or more providers are configured, you can switch between models at runtime using the `/model` command in chat.

### Supported Providers

| Provider | Env Var(s) | Models |
|----------|-----------|--------|
| Anthropic | `ANTHROPIC_API_KEY` | Claude Haiku 4.5, Claude Sonnet 4.6, Claude Opus 4.6 |
| OpenAI | `OPENAI_API_KEY` | GPT-4o |
| Google | `GOOGLE_API_KEY` | Gemini 3 Flash, Gemini 3 Pro, Gemini 2.5 Flash, Gemini 2.5 Pro, Gemini 2.5 Flash Lite |
| AWS Bedrock | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | Claude, DeepSeek R1/V3, Qwen3 Coder, GPT-OSS 120B (auto-discovered) |
| Claude subscription | `/claude_auth` command | Same as Anthropic |
| OpenAI subscription | `/openai_auth` command | GPT-5.3 Codex, GPT-5.1 Codex Max, GPT-5 Codex Mini |
| CF AI Gateway | `CLOUDFLARE_AI_GATEWAY_API_KEY` + account/gateway IDs | Any [AI Gateway provider](https://developers.cloudflare.com/ai-gateway/usage/providers/) |

### Runtime Model Switching

Type `/model` in chat to see available models and `/model <number>` to switch. The model catalog is built automatically from your configured providers on each startup.

To set the default model, use the `DEFAULT_MODEL` env var:

```bash
npx wrangler secret put DEFAULT_MODEL
# Enter: google/gemini-3-pro-preview
```

Format is `provider/model-id`. The `DEFAULT_MODEL` setting takes effect on next container restart.

### Subscription Auth

Use your existing Claude Pro/Max or ChatGPT Plus/Pro subscription instead of API keys:

1. Set `SUBSCRIPTION_AUTH=true` in `wrangler.jsonc` vars (this allows the worker to start without API keys)
2. Deploy and connect to the Control UI
3. Authenticate in chat:

**Claude Pro/Max:**
```
# On any machine with Claude Code installed:
claude setup-token

# Paste the token in chat:
/claude_auth sk-ant-oat01-...
```

**ChatGPT Plus/Pro (OAuth):**
```
# Start the OAuth flow:
/openai_auth

# Sign in via browser, copy the redirect URL, then:
/openai_callback http://localhost:1455/auth/callback?code=...
```

Subscription credentials are persisted to R2 and auto-refreshed (OAuth tokens refresh automatically).

## Debug Endpoints

Debug endpoints are available at `/debug/*` when enabled (requires `DEBUG_ROUTES=true` and Cloudflare Access):

- `GET /debug/processes` - List all container processes
- `GET /debug/logs?id=<process_id>` - Get logs for a specific process
- `GET /debug/version` - Get container and moltbot version info

## Optional: Chat Channels

### Telegram

Telegram supports two modes: **polling** (default) and **webhook**.

**Polling mode** (simplest setup):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npm run deploy
```

**Webhook mode** (lower latency, required for sleep/wake containers):

Webhook mode routes Telegram updates through the Cloudflare Worker, so the container doesn't need to maintain a persistent connection. This is required if you use `SANDBOX_SLEEP_AFTER` — a sleeping container can't poll, but an incoming webhook wakes it up.

```
Telegram API ──► CF Worker (POST /telegram/webhook) ──► Container :8787 (telegram-tools)
                    │ validates X-Telegram-Bot-Api-Secret-Token
                    │ against TELEGRAM_WEBHOOK_SECRET (timing-safe)
```

Setup:

```bash
# Required for both modes
npx wrangler secret put TELEGRAM_BOT_TOKEN

# Additional secrets for webhook mode
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # Shared secret for webhook validation
npx wrangler secret put WORKER_URL                 # e.g., https://moltbot.example.workers.dev

npm run deploy
```

After deploying, register the webhook with Telegram via chat command:

```
/telegram webhook on
```

Manage webhooks with the `/telegram` command:

| Command | Description |
|---------|-------------|
| `/telegram webhook` | Show webhook status |
| `/telegram webhook on` | Register webhook with Telegram |
| `/telegram webhook off` | Delete webhook, revert to polling |
| `/telegram webhook verify` | Query Telegram API for current webhook info |
| `/telegram pair` | List pending Telegram DM pairing requests |
| `/telegram pair approve <code>` | Approve a pairing request |

**DM access control:** By default, Telegram uses `pairing` mode — new users must be approved. Set `TELEGRAM_DM_POLICY=open` to allow all users.

### Discord

```bash
npx wrangler secret put DISCORD_BOT_TOKEN
npm run deploy
```

### Slack

```bash
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_APP_TOKEN
npm run deploy
```

## Optional: Browser Automation (CDP)

This worker includes a Chrome DevTools Protocol (CDP) shim that enables browser automation capabilities. This allows OpenClaw to control a headless browser for tasks like web scraping, screenshots, and automated testing.

### Setup

1. Set a shared secret for authentication:

```bash
npx wrangler secret put CDP_SECRET
# Enter a secure random string
```

2. Set your worker's public URL:

```bash
npx wrangler secret put WORKER_URL
# Enter: https://your-worker.workers.dev
```

3. Redeploy:

```bash
npm run deploy
```

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /cdp/json/version` | Browser version information |
| `GET /cdp/json/list` | List available browser targets |
| `GET /cdp/json/new` | Create a new browser target |
| `WS /cdp/devtools/browser/{id}` | WebSocket connection for CDP commands |

All endpoints require authentication via the `?secret=<CDP_SECRET>` query parameter.

## Built-in Skills

The container includes pre-installed skills in `/root/.openclaw/skills/` and plugins in `/root/.openclaw/extensions/`.

### Skills

#### cloudflare_browser

Browser automation via the CDP shim. Requires `CDP_SECRET` and `WORKER_URL` to be set (see [Browser Automation](#optional-browser-automation-cdp) above).

**Scripts:**
- `screenshot.js` - Capture a screenshot of a URL
- `video.js` - Create a video from multiple URLs
- `cdp-client.js` - Reusable CDP client library

**Usage:**
```bash
# Screenshot
node /root/.openclaw/skills/cloudflare_browser/scripts/screenshot.js https://example.com output.png

# Video from multiple URLs
node /root/.openclaw/skills/cloudflare_browser/scripts/video.js "https://site1.com,https://site2.com" output.mp4 --scroll
```

See `skills/cloudflare_browser/SKILL.md` for full documentation.

### Plugins

Commands registered via plugins execute WITHOUT the AI agent (LLM-free). Each plugin lives in `extensions/` and is installed to `/root/.openclaw/extensions/` on boot.

| Plugin | Commands | Description |
|--------|----------|-------------|
| `bedrock-auth` | `/aws_auth` | AWS Bedrock MFA authentication |
| `subscription-auth` | `/claude_auth`, `/openai_auth`, `/openai_callback` | Claude Pro/Max setup-token and OpenAI Codex OAuth sign-in |
| `telegram-tools` | `/telegram` | Telegram webhook management and DM pairing |
| `ssh-tools` | `/ssh_setup`, `/ssh_check` | SSH key management and GitHub connectivity |
| `git-tools` | `/git_check`, `/git_sync`, `/git_repos` | Git operations and repo scanning |
| `moltbot-utils` | `/ws_check`, `/sys_info`, `/net_check` | Workspace health, system info, network diagnostics |

## Optional: Cloudflare AI Gateway

You can route API requests through [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) for caching, rate limiting, analytics, and cost tracking. OpenClaw has native support for Cloudflare AI Gateway as a first-class provider.

AI Gateway acts as a proxy between OpenClaw and your AI provider (e.g., Anthropic). Requests are sent to `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic` instead of directly to `api.anthropic.com`, giving you Cloudflare's analytics, caching, and rate limiting. You still need a provider API key (e.g., your Anthropic API key) — the gateway forwards it to the upstream provider.

### Setup

1. Create an AI Gateway in the [AI Gateway section](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway/create-gateway) of the Cloudflare Dashboard.
2. Set the three required secrets:

```bash
# Your AI provider's API key (e.g., your Anthropic API key).
# This is passed through the gateway to the upstream provider.
npx wrangler secret put CLOUDFLARE_AI_GATEWAY_API_KEY

# Your Cloudflare account ID
npx wrangler secret put CF_AI_GATEWAY_ACCOUNT_ID

# Your AI Gateway ID (from the gateway overview page)
npx wrangler secret put CF_AI_GATEWAY_GATEWAY_ID
```

All three are required. OpenClaw constructs the gateway URL from the account ID and gateway ID, and passes the API key to the upstream provider through the gateway.

3. Redeploy:

```bash
npm run deploy
```

When Cloudflare AI Gateway is configured, it takes precedence over direct `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

### Choosing a Model

By default, AI Gateway uses Anthropic's Claude Sonnet 4.5. To use a different model or provider, set `CF_AI_GATEWAY_MODEL` with the format `provider/model-id`:

```bash
npx wrangler secret put CF_AI_GATEWAY_MODEL
# Enter: workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast
```

This works with any [AI Gateway provider](https://developers.cloudflare.com/ai-gateway/usage/providers/):

| Provider | Example `CF_AI_GATEWAY_MODEL` value | API key is... |
|----------|-------------------------------------|---------------|
| Workers AI | `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Cloudflare API token |
| OpenAI | `openai/gpt-4o` | OpenAI API key |
| Anthropic | `anthropic/claude-sonnet-4-5` | Anthropic API key |
| Groq | `groq/llama-3.3-70b` | Groq API key |

**Note:** `CLOUDFLARE_AI_GATEWAY_API_KEY` must match the provider you're using — it's your provider's API key, forwarded through the gateway. You can only use one provider at a time through the gateway. For multiple providers, use direct keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) alongside the gateway config.

#### Workers AI with Unified Billing

With [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/), you can use Workers AI models without a separate provider API key — Cloudflare bills you directly. Set `CLOUDFLARE_AI_GATEWAY_API_KEY` to your [AI Gateway authentication token](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) (the `cf-aig-authorization` token).

### Legacy AI Gateway Configuration

The previous `AI_GATEWAY_API_KEY` + `AI_GATEWAY_BASE_URL` approach is still supported for backward compatibility but is deprecated in favor of the native configuration above.

## Multi-Environment Deployment (GitOps)

For a single environment, `wrangler secret put` is all you need. For managing multiple environments (staging, production, per-user), moltbot-app supports a GitOps workflow via a separate environment repository.

[`@aehrt55/create-moltbot-env`](https://www.npmjs.com/package/@aehrt55/create-moltbot-env) scaffolds a GitOps repo with:

- **Overlay pattern** — per-environment config directories (`overlays/<env>/`) with Wrangler config, pinned app version, and encrypted secrets
- **SOPS + AGE** — secrets encrypted at rest in git, decrypted at deploy time
- **Makefile orchestration** — `make deploy`, `make edit-secrets`, `make push-secrets`
- **Claude Code commands** — `/create-env`, `/delete-env`, `/upgrade` for agent-assisted operations

```bash
npx @aehrt55/create-moltbot-env
```

The CLI walks you through account setup, generates the repo structure, and optionally creates an AGE key pair for secret encryption. See the [create-moltbot-env README](https://github.com/aehrt55/create-moltbot-env) for full documentation.

## All Secrets Reference

| Secret | Required | Description |
|--------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes* | Direct Anthropic API key |
| `OPENAI_API_KEY` | Yes* | OpenAI API key |
| `GOOGLE_API_KEY` | Yes* | Google AI API key (Gemini models) |
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | Yes* | Your AI provider's API key, passed through the gateway. Requires `CF_AI_GATEWAY_ACCOUNT_ID` and `CF_AI_GATEWAY_GATEWAY_ID` |
| `CF_AI_GATEWAY_ACCOUNT_ID` | Yes* | Cloudflare account ID for AI Gateway URL |
| `CF_AI_GATEWAY_GATEWAY_ID` | Yes* | AI Gateway ID for AI Gateway URL |
| `CF_AI_GATEWAY_MODEL` | No | Override AI Gateway model: `provider/model-id` (e.g. `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`). See [Choosing a Model](#choosing-a-model) |
| `DEFAULT_MODEL` | No | Default model override: `provider/model-id` (e.g. `google/gemini-3-pro-preview`). Takes effect on container restart |
| `SUBSCRIPTION_AUTH` | No | Set to `true` to allow startup without API keys (use `/claude_auth` or `/openai_auth` in chat) |
| `ANTHROPIC_BASE_URL` | No | Direct Anthropic API base URL override |
| `AI_GATEWAY_API_KEY` | No | Legacy AI Gateway API key (deprecated, use `CLOUDFLARE_AI_GATEWAY_API_KEY`) |
| `AI_GATEWAY_BASE_URL` | No | Legacy AI Gateway endpoint URL (deprecated) |
| `AWS_ACCESS_KEY_ID` | No | AWS IAM access key for Bedrock (used with MFA via `/aws_auth`) |
| `AWS_SECRET_ACCESS_KEY` | No | AWS IAM secret key for Bedrock |
| `AWS_MFA_SERIAL` | No | MFA device ARN for Bedrock authentication |
| `AWS_ROLE_ARN` | No | IAM role to assume for Bedrock access |
| `BEDROCK_DEFAULT_MODEL` | No | Default Bedrock model pattern after auth (e.g. `claude-sonnet-4-6`) |
| `MOLTBOT_GATEWAY_TOKEN` | Yes | Gateway token for authentication (pass via `?token=` query param) |
| `CF_ACCESS_TEAM_DOMAIN` | Yes* | Cloudflare Access team domain (required for admin UI) |
| `CF_ACCESS_AUD` | Yes* | Cloudflare Access application audience (required for admin UI) |
| `MOLTBOT_EMAIL` | No | Owner email for SSH key comment and git config |
| `DEV_MODE` | No | Set to `true` to skip CF Access auth + device pairing (local dev only) |
| `DEBUG_ROUTES` | No | Set to `true` to enable `/debug/*` routes |
| `SANDBOX_SLEEP_AFTER` | No | Container sleep timeout: `never` (default) or duration like `10m`, `1h` |
| `R2_ACCESS_KEY_ID` | No | R2 access key for persistent storage |
| `R2_SECRET_ACCESS_KEY` | No | R2 secret key for persistent storage |
| `R2_BUCKET_NAME` | No | Override R2 bucket name (default: `moltbot-data`) |
| `CF_ACCOUNT_ID` | No | Cloudflare account ID (required for R2 storage) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token |
| `TELEGRAM_DM_POLICY` | No | Telegram DM policy: `pairing` (default) or `open` |
| `TELEGRAM_WEBHOOK_SECRET` | No | Shared secret for Telegram webhook validation (required for webhook mode) |
| `DISCORD_BOT_TOKEN` | No | Discord bot token |
| `DISCORD_DM_POLICY` | No | Discord DM policy: `pairing` (default) or `open` |
| `SLACK_BOT_TOKEN` | No | Slack bot token |
| `SLACK_APP_TOKEN` | No | Slack app token |
| `CDP_SECRET` | No | Shared secret for CDP endpoint authentication (see [Browser Automation](#optional-browser-automation-cdp)) |
| `WORKER_URL` | No | Public URL of the worker (required for CDP and Telegram webhook) |

\* At least one AI provider is required. Set one of: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, the full CF AI Gateway set, AWS Bedrock keys, or `SUBSCRIPTION_AUTH=true`. CF Access secrets are required for the admin UI.

## Design Principles

- **Environment-agnostic app code** — All configuration flows through env vars and secrets. The app repo contains zero environment-specific values; deployment differences live in separate overlay repos (see [Multi-Environment Deployment](#multi-environment-deployment-gitops)).

- **Container sleep/wake cost optimization** — `SANDBOX_SLEEP_AFTER` puts the container to sleep when idle. Incoming HTTP requests or Telegram webhooks wake it up. R2 backup/restore ensures no data loss across sleep cycles. A container running 4 hours/day costs ~$5-6/mo instead of ~$30/mo.

- **Multi-layer authentication** — Cloudflare Access protects admin routes, gateway tokens gate the Control UI, and device pairing requires explicit approval for each new client. Each layer can be bypassed independently for development (`DEV_MODE=true`).

- **R2 backup/restore persistence** — Rather than mounting networked storage, moltbot uses a simple backup/restore approach: restore from R2 on startup, sync changes back every 30 seconds. This avoids complexity with FUSE mounts in containers and works reliably with container sleep/wake cycles.

- **Overlay-based GitOps** — For multi-environment deployments, each environment gets its own overlay directory with Wrangler config and SOPS-encrypted secrets. The app repo is cloned and overlaid at deploy time, keeping the app portable and environments reproducible.

## Security Considerations

### Authentication Layers

OpenClaw in Cloudflare Sandbox uses multiple authentication layers:

1. **Cloudflare Access** - Protects admin routes (`/_admin/`, `/api/*`, `/debug/*`). Only authenticated users can manage devices.

2. **Gateway Token** - Required to access the Control UI. Pass via `?token=` query parameter. Keep this secret.

3. **Device Pairing** - Each device (browser, CLI, chat platform DM) must be explicitly approved via the admin UI before it can interact with the assistant. This is the default "pairing" DM policy.

## Troubleshooting

**`npm run dev` fails with an `Unauthorized` error:** You need to enable Cloudflare Containers in the [Containers dashboard](https://dash.cloudflare.com/?to=/:account/workers/containers)

**Gateway fails to start:** Check `npx wrangler secret list` and `npx wrangler tail`

**Config changes not working:** Edit the `# Build cache bust:` comment in `Dockerfile` and redeploy

**Slow first request:** Cold starts take 1-2 minutes. Subsequent requests are faster.

**R2 not mounting:** Check that all three R2 secrets are set (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CF_ACCOUNT_ID`). Note: R2 mounting only works in production, not with `wrangler dev`.

**Access denied on admin routes:** Ensure `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are set, and that your Cloudflare Access application is configured correctly.

**Devices not appearing in admin UI:** Device list commands take 10-15 seconds due to WebSocket connection overhead. Wait and refresh.

**WebSocket issues in local development:** `wrangler dev` has known limitations with WebSocket proxying through the sandbox. HTTP requests work but WebSocket connections may fail. Deploy to Cloudflare for full functionality.

**API key rotation not taking effect:** OpenClaw caches API keys in `auth-profiles.json` (synced to R2). After rotating a key via `wrangler secret put`, you need to redeploy (`npm run deploy`) and restart the gateway. The startup script patches `auth-profiles.json` with current env var values on every boot.

## Known Issues

### Windows: Gateway fails to start with exit code 126 (permission denied)

On Windows, Git may check out shell scripts with CRLF line endings instead of LF. This causes `start-openclaw.sh` to fail with exit code 126 inside the Linux container. Ensure your repository uses LF line endings — configure Git with `git config --global core.autocrlf input` or add a `.gitattributes` file with `* text=auto eol=lf`.

## Links

- [OpenClaw](https://github.com/openclaw/openclaw)
- [OpenClaw Docs](https://docs.openclaw.ai/)
- [create-moltbot-env](https://github.com/aehrt55/create-moltbot-env) — GitOps environment scaffold CLI
- [@aehrt55/create-moltbot-env on npm](https://www.npmjs.com/package/@aehrt55/create-moltbot-env)
- [Cloudflare Sandbox Docs](https://developers.cloudflare.com/sandbox/)
- [Cloudflare Access Docs](https://developers.cloudflare.com/cloudflare-one/policies/access/)
