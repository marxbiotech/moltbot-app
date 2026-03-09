# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [v2026.2.26-2] - 2026-03-09

### Added

- Slack webhook endpoint (`POST /slack/events`) with unified queue delivery, `url_verification` challenge handling, and signing header forwarding (#8)
- Unified `WEBHOOK_QUEUE` routing by `source` field (`telegram` | `slack`), with backward compat for existing `TELEGRAM_QUEUE` binding (#8)
- `DELIVERY_TARGETS` routing table in queue consumer for source→port/path dispatch (#8)
- GitHub Apps multi-app authentication (`github-apps` extension) with openssl RS256 JWT signing and Installation Token management (#9)
- Env-managed skills architecture: skills maintained in moltbot-env, injected at deploy-time via `deploy.sh` (#9)
- `slack-tools` extension with Slack HTTP mode support (`SLACK_SIGNING_SECRET`) (#9)
- `decode_github_apps.js` script for decoding `GITHUB_APPS` env var to `~/.github-apps/` with field validation (#9)

### Fixed

- Slack config overwriting runtime changes on restart (now spreads existing config) (#9)

## [v2026.2.26-1] - 2026-03-07

### Changed

- Send lifecycle notifications silently (`disable_notification: true`) (#7)
- Show 🔄 version update notification instead of ⚠️ error on deploy rollout (#7)

## [v2026.2.26-0] - 2026-03-06

Initial release. Cloudflare Worker running OpenClaw v2026.2.26 in a Sandbox container.

### Added

- Cloudflare Worker with Hono framework proxying HTTP/WebSocket to OpenClaw gateway in Sandbox container
- Cloudflare Access JWT authentication for admin UI and API routes
- React admin UI served at `/_admin/` for device management and gateway control
- R2-based persistent storage with mount/sync for container state across restarts
- Telegram webhook proxy with timing-safe secret validation (`POST /telegram/webhook`) (#1)
- `telegram-tools` extension: `/telegram` commands for webhook management, pairing, group/mention/config runtime management (#1, #3)
- Telegram message queue for cold-start buffering with 3-state detection (cold/warming/hot) and lifecycle notifications (#5)
- Conversation state protocol for bot-to-bot context relay
- Discipline system (bot loop prevention) replacing mute/unmute with automatic restart and triggered flag
- Multi-provider support: Anthropic, OpenAI, Google, Cloudflare AI Gateway, with `/model` runtime switching
- OAuth provider persistence (openai-codex) surviving container restarts via auth-profiles to auth.json sync (#2)
- API key rotation handling: `start-openclaw.sh` patches cached auth-profiles on every startup
- Chrome DevTools Protocol (CDP) shim endpoint
- Debug routes for container inspection (gated by `DEBUG_ROUTES`)
- `start-openclaw.sh`: R2 restore, `openclaw onboard`, config patching, EADDRINUSE fix, skills/extensions installation
- Documentation: architecture guide, Telegram Bot setup, Slack App setup (zh-TW)

### Changed

- Telegram config patch changed from full overwrite to merge, preserving runtime changes across restarts (#3)

### Fixed

- OAuth provider (openai-codex) not surviving container restart due to missing auth.json sync (#2)
- EADDRINUSE crash on Telegram webhook mode restart (patches OpenClaw dist files) (#1)
- Orphan process accumulation on gateway restart (#1)
- Discipline state reset when bot re-added to allowFrom
- Telegram streaming forced off and replyToMode set to all at startup
