# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cloudflare Worker that runs [OpenClaw](https://github.com/openclaw/openclaw) (formerly Moltbot/Clawdbot) in a Cloudflare Sandbox container. Proxies HTTP/WebSocket to the OpenClaw gateway, with admin UI for device management, Cloudflare Access authentication, and R2-based persistent storage.

## Commands

```bash
npm run start             # Local dev (wrangler dev — runs worker + sandbox)
npm run dev               # Vite dev server (frontend only)
npm test                  # Run tests once (vitest)
npm run test:watch        # Tests in watch mode
npm run test:coverage     # Coverage report
npm run typecheck         # TypeScript type check (tsc --noEmit)
npm run lint              # oxlint src/
npm run lint:fix          # oxlint --fix src/
npm run format            # oxfmt --write src/
npm run format:check      # oxfmt --check src/
npm run build             # Vite build (produces dist/client)
npm run deploy            # Build + wrangler deploy
```

Local dev setup: `cp .dev.vars.example .dev.vars` and set `ANTHROPIC_API_KEY`, `DEV_MODE=true`, `DEBUG_ROUTES=true`.

## Architecture

```
Browser → Cloudflare Worker (Hono) → Cloudflare Sandbox Container (OpenClaw on port 18789)
```

**Worker (src/index.ts):** Hono app with middleware chain → public routes → CF Access auth → protected routes → catch-all proxy to container. The catch-all handles both HTTP (`sandbox.containerFetch`) and WebSocket (`sandbox.wsConnect` + `WebSocketPair` relay with error transformation).

**Container:** Dockerfile based on `cloudflare/sandbox`, runs `start-openclaw.sh` which restores R2 backup → runs `openclaw onboard` → patches config → starts gateway.

**Durable Object:** `Sandbox` class manages container lifecycle. Gateway process detected by checking for `start-openclaw.sh`, `openclaw gateway`, or `openclaw-gateway` in running processes (note: the actual binary is `openclaw-gateway` with a hyphen, not a space).

### Key Modules

- **src/auth/** — Cloudflare Access JWT verification (jose library), middleware that extracts JWT from `CF-Access-JWT-Assertion` header or cookie
- **src/gateway/** — Container process lifecycle (`process.ts`), env var mapping (`env.ts`), R2 mount/sync (`r2.ts`, `sync.ts`)
- **src/routes/** — Route handlers: `public.ts` (no auth), `api.ts` (device management), `admin-ui.ts` (SPA), `debug.ts`, `cdp.ts` (Chrome DevTools Protocol shim)
- **src/client/** — React admin UI served at `/_admin/`, built to `dist/client/`

### Auth Layers

1. **Cloudflare Access** — Protects `/_admin/*`, `/api/*`, `/debug/*`. Skipped when `DEV_MODE=true` or `E2E_TEST_MODE=true`.
2. **Gateway Token** — `MOLTBOT_GATEWAY_TOKEN` → container's `OPENCLAW_GATEWAY_TOKEN`. Auto-injected into WebSocket for CF Access-authenticated users.
3. **Device Pairing** — OpenClaw's own mechanism. Managed via admin UI. Bypassed by `DEV_MODE`.

### Environment Variable Mapping

Worker env vars are mapped to container env vars in `src/gateway/env.ts` via `buildEnvVars()`. Key mapping: `MOLTBOT_GATEWAY_TOKEN` → `OPENCLAW_GATEWAY_TOKEN`, `DEV_MODE` → `OPENCLAW_DEV_MODE`. All types defined in `MoltbotEnv` interface in `src/types.ts`.

### Model & Provider Switching

Three-layer flow: `wrangler.jsonc`/secrets → `env.ts:buildEnvVars()` → `start-openclaw.sh` (onboard + config patch) → OpenClaw runtime.

**Supported provider paths:**

| Path | Env vars needed | Model config | Notes |
|------|----------------|-------------|-------|
| Anthropic direct | `ANTHROPIC_API_KEY` | onboard auto-sets | Most stable, onboard native |
| OpenAI direct | `OPENAI_API_KEY` | onboard auto-sets | onboard native |
| Google direct | `GOOGLE_API_KEY` + `DEFAULT_MODEL` | config patch | onboard has no `--auth-choice` for Google; relies on OpenClaw runtime auto-detecting `GOOGLE_API_KEY` (same convention as `@google/generative-ai` SDK) |
| CF AI Gateway | `CLOUDFLARE_AI_GATEWAY_API_KEY` + `CF_AI_GATEWAY_ACCOUNT_ID` + `CF_AI_GATEWAY_GATEWAY_ID` + `CF_AI_GATEWAY_MODEL` | config patch creates provider + sets model | Most complex |
| Legacy Gateway | `AI_GATEWAY_API_KEY` + `AI_GATEWAY_BASE_URL` | overrides `ANTHROPIC_BASE_URL` | Anthropic only |

**Config patch ordering in `start-openclaw.sh`:** `CF_AI_GATEWAY_MODEL` writes first, `DEFAULT_MODEL` writes second (last write wins). When both are set, `DEFAULT_MODEL` takes precedence.

**Key behaviors:**
- `openclaw onboard` only runs when `openclaw.json` doesn't exist (line 104). After R2 restore, config already exists so onboard is skipped.
- Config patch section runs every startup regardless, so changing env vars + restart always takes effect.
- `validateRequiredEnv()` in `src/index.ts` checks for at least one of: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, or full CF AI Gateway set.
- **Subscription/OAuth providers** (e.g. `openai-codex` via `/openai_auth`) register dynamically at runtime. Their model config and OAuth tokens (in auth-profiles.json) are persisted to R2 and restored on restart. OpenClaw's model registry reads `auth.json` (pi-coding-agent format), not `auth-profiles.json` directly. `start-openclaw.sh` syncs auth-profiles → auth.json on every startup so OAuth providers are discoverable on the first request.

**API key rotation:** OpenClaw caches API keys in `~/.openclaw/agents/*/agent/auth-profiles.json`. These files are persisted to R2. When a key is rotated via `wrangler secret put`, the cached key in auth-profiles becomes stale. `start-openclaw.sh` patches auth-profiles on every startup to overwrite cached keys with current env var values and clear error/cooldown stats. Without this patch, a rotated key won't take effect even after gateway restart.

**Runtime model switching (`/model` command):** When 2+ provider API keys are present, `start-openclaw.sh` auto-populates `agents.defaults.models` (object keyed by model ID, acts as allowlist for `/model`) and `agents.defaults.model.fallbacks`. Users can type `/model` in chat to see available models and `/model <number>` to switch. Models per provider:
- Google: `gemini-3-flash-preview`, `gemini-3-pro-preview`, `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-2.5-flash-lite`
- Anthropic: `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`
- OpenAI: `gpt-4o`

**To switch default model/provider:** Change env vars in `wrangler.jsonc` (vars) or secrets → `npm run deploy` → restart gateway via admin UI or `POST /api/admin/gateway/restart`.

**To rotate an API key:** `wrangler secret put <KEY_NAME>` → `npm run deploy` (to rebuild container image with updated `start-openclaw.sh`) → wait for container to be recreated (10 min idle timeout via `SANDBOX_SLEEP_AFTER`) or POST restart. The auth-profiles patch in `start-openclaw.sh` will overwrite the stale cached key.

### Telegram Webhook

```
Telegram → CF Worker (POST /telegram/webhook) → Container (port 8787, /telegram-webhook)
```

**Flow:** Telegram sends updates to the Worker's public endpoint. The Worker validates `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET` using `timingSafeEqual`, then proxies to the container's OpenClaw telegram-tools extension on port 8787. This route sits outside CF Access (public), so the secret token is the sole auth layer.

**Env vars:**
- `TELEGRAM_BOT_TOKEN` — Bot token, passed to container for Telegram API calls
- `TELEGRAM_WEBHOOK_SECRET` — Shared secret for webhook validation (Worker + container). Set via `wrangler secret put`
- `WORKER_URL` — Public URL of the Worker (used by CDP endpoint; also needed by `telegram-tools` to register webhook URL with Telegram)

**EADDRINUSE patch:** `start-openclaw.sh` patches OpenClaw's `monitorTelegramProvider` in webhook mode (openclaw/openclaw#19831). The upstream bug causes an immediate return → auto-restart → port conflict crash loop. The patch adds an `abortSignal` await before the return. Applies to all matching `.js` files in `dist/` since chunk boundaries vary between versions. Remove once OpenClaw ships PR #20309.

**Extension:** `extensions/telegram-tools/` is an OpenClaw extension (not Worker code) that runs inside the container. It handles `/telegram` slash commands (webhook on/off, pair, approve) and manages webhook config + `allow-from.json` for DM access control.

## Patterns & Conventions

- **Hono routing:** Subrouters mounted with `app.route()`, context variables via `c.set()`/`c.get()`, responses via `c.json()`/`c.html()`
- **Tests:** Colocated with source as `*.test.ts`, using Vitest with Node environment
- **OpenClaw CLI calls:** Always include `--url ws://localhost:18789` and optionally `--token`. Commands take 10-15s (WebSocket overhead). Use `waitForProcess()` helper.
- **Linting/formatting:** oxlint + oxfmt (not ESLint/Prettier)
- **The CLI tool is named `openclaw`** but config paths use `.openclaw/openclaw.json`. Legacy `.clawdbot` paths still supported.

### OpenClaw Plugin Config Writes — NEVER Hardcode Schema

**Rule: OpenClaw extensions MUST NOT hardcode config field types, enum values, or schema definitions.** OpenClaw's config schema changes between versions. If a plugin maintains its own copy of type mappings (e.g., `streaming: { type: "enum", values: [...] }`), it will break silently when OpenClaw updates the schema.

**How to write config from plugins:**

1. **Individual field writes** — Use `openclaw config set/unset` CLI via `api.runtime.system.runCommandWithTimeout`:
   ```typescript
   // In register(api), capture runtime:
   runtime = api.runtime;
   // In handler:
   await runtime.system.runCommandWithTimeout(
     ["openclaw", "config", "set", "channels.telegram.streaming", "partial"],
     10000,
   );
   ```
   The CLI handles schema validation, type coercion, and error reporting. Invalid values are rejected with a clear error — no need to validate types ourselves.

2. **Array/batch operations** — Use `api.runtime.config.loadConfig()` + `writeConfigFile()` when CLI is impractical (e.g., pushing to an array):
   ```typescript
   const config = await runtime.config.loadConfig();
   config.messages.groupChat.mentionPatterns.push(newPattern);
   await runtime.config.writeConfigFile(config);
   ```

3. **Reading config** — Use `ctx.config` (the validated snapshot passed to command handlers), not `readFileSync`:
   ```typescript
   handler: async (ctx) => {
     const tg = ctx.config.channels?.telegram;
   }
   ```

4. **Redundant subcommands** — Do NOT wrap OpenClaw's built-in `/config show/set` with plugin commands. `/config` is a reserved command and handles validation + restart automatically. Only create plugin commands for operations that OpenClaw doesn't provide natively (e.g., Telegram API calls, pairing flows, array manipulation with UX).

## Adding New Features

**New API endpoint:** Add handler in `src/routes/api.ts` → types in `src/types.ts` → client API in `src/client/api.ts` if needed → tests.

**New env var:** Add to `MoltbotEnv` in `src/types.ts` → if passed to container, add to `buildEnvVars()` in `src/gateway/env.ts` → update `.dev.vars.example`.

## Gotchas

- WebSocket proxying doesn't fully work with `wrangler dev` — deploy to Cloudflare for full functionality
- R2 mounting only works in production, not local dev
- WebSocket close reasons truncated to 123 bytes (spec limit)
- Dockerfile cache bust: edit `# Build cache bust:` comment to force rebuild. Wrangler's container build uses Docker's content-addressable cache; if `COPY start-openclaw.sh` shows as CACHED despite file changes, prune Docker build cache with `docker builder prune -a -f` then redeploy
- `start-openclaw.sh` must have LF line endings (configure `git config --global core.autocrlf input` on Windows)
- **`wrangler secret put` doesn't require redeploy** for Worker code, but container image changes (e.g. `start-openclaw.sh`) require `npm run deploy` to rebuild and push the image
- **Gateway restart may not kill the actual process:** The OpenClaw gateway binary is `openclaw-gateway` (hyphen), not `openclaw gateway` (space). `findExistingMoltbotProcess()` must match both forms
- **OpenClaw credential cache:** API keys are cached in `~/.openclaw/agents/*/agent/auth-profiles.json` and synced to R2. Rotating a key via `wrangler secret` alone is insufficient — the auth-profiles file must also be patched (handled by `start-openclaw.sh` on startup)
