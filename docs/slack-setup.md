# Slack App 設定指南

本文件說明如何建立 Slack App 並串接到 moltbot worker + OpenClaw。

## 目錄

- [模式選擇](#模式選擇)
- [Step 1：建立 Slack App](#step-1建立-slack-app)
- [Step 2：設定 Socket Mode 與 Token](#step-2設定-socket-mode-與-token)
- [Step 3：設定 OAuth Scopes](#step-3設定-oauth-scopes)
- [Step 4：訂閱 Events](#step-4訂閱-events)
- [Step 5：設定 Slash Commands](#step-5設定-slash-commands)
- [Step 6：啟用 App Home](#step-6啟用-app-home)
- [Step 7：安裝 App 到 Workspace](#step-7安裝-app-到-workspace)
- [Step 8：設定 moltbot Worker](#step-8設定-moltbot-worker)
- [Step 9：驗證](#step-9驗證)
- [App Manifest（一鍵匯入）](#app-manifest一鍵匯入)
- [HTTP Events API 模式（進階）](#http-events-api-模式進階)
- [OpenClaw 進階設定](#openclaw-進階設定)
- [Troubleshooting](#troubleshooting)

## 模式選擇

OpenClaw 的 Slack 整合支援兩種模式：

| | Socket Mode（推薦） | HTTP Events API |
|---|---|---|
| 原理 | App 主動建立 WebSocket 到 Slack | Slack 推送 HTTP POST 到你的 endpoint |
| 所需 Token | Bot Token + App Token | Bot Token + Signing Secret |
| Worker 改動 | 無 | 需要新增 proxy route |
| 適合場景 | 大多數情況、開發環境 | 高流量、企業級部署 |
| 優點 | 設定簡單、不需 public endpoint | 更穩定、可水平擴展 |

**本指南預設使用 Socket Mode。** HTTP 模式請見[進階章節](#http-events-api-模式進階)。

## Step 1：建立 Slack App

1. 前往 https://api.slack.com/apps
2. 點選 **Create New App**
3. 選擇 **From scratch**（或使用[下方 manifest](#app-manifest一鍵匯入) 快速匯入）
4. 輸入 App 名稱（例如 `OpenClaw`）並選擇要安裝的 Workspace
5. 點選 **Create App**

## Step 2：設定 Socket Mode 與 Token

1. 左側選單 → **Socket Mode** → 開啟
2. 回到 **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**
   - Token Name：`socket`（任意名稱）
   - 新增 scope：`connections:write`
   - 點選 **Generate**
3. 複製 **App Token**（格式：`xapp-1-...`），稍後使用

## Step 3：設定 OAuth Scopes

左側選單 → **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**，新增以下 scopes：

### 必要 Bot Scopes

| Scope | 用途 |
|---|---|
| `app_mentions:read` | 接收 @mention 事件 |
| `channels:history` | 讀取公開頻道訊息歷史 |
| `channels:read` | 讀取公開頻道資訊 |
| `chat:write` | 傳送/編輯/刪除訊息 |
| `commands` | 註冊 Slash Commands |
| `emoji:read` | 讀取自訂 emoji 列表 |
| `files:read` | 讀取檔案 |
| `files:write` | 上傳檔案 |
| `groups:history` | 讀取私人頻道訊息歷史 |
| `groups:read` | 讀取私人頻道資訊 |
| `groups:write` | 管理私人頻道 |
| `im:history` | 讀取 DM 訊息歷史 |
| `im:read` | 讀取 DM 資訊 |
| `im:write` | 開啟 DM 對話 |
| `mpim:history` | 讀取群組 DM 訊息歷史 |
| `mpim:read` | 讀取群組 DM 資訊 |
| `mpim:write` | 管理群組 DM |
| `pins:read` | 讀取釘選訊息 |
| `pins:write` | 釘選/取消釘選訊息 |
| `reactions:read` | 讀取 emoji reactions |
| `reactions:write` | 新增/移除 emoji reactions |
| `users:read` | 查詢使用者資訊 |

### 選用 User Token Scopes

如果需要 User Token（`xoxp-...`）以使用者身份讀取，在 **User Token Scopes** 新增：

`channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:history`, `im:read`, `mpim:history`, `mpim:read`, `users:read`, `reactions:read`, `pins:read`, `emoji:read`, `search:read`

> User Token 預設為唯讀。設定 `userTokenReadOnly: false` 可允許寫入，但請謹慎使用。

## Step 4：訂閱 Events

左側選單 → **Event Subscriptions** → 開啟 **Enable Events**

在 **Subscribe to bot events** 新增：

| Event | 說明 |
|---|---|
| `app_mention` | 有人 @mention bot |
| `message.channels` | 公開頻道訊息（含編輯/刪除） |
| `message.groups` | 私人頻道訊息 |
| `message.im` | DM 訊息 |
| `message.mpim` | 群組 DM 訊息 |
| `reaction_added` | 有人加了 emoji reaction |
| `reaction_removed` | 有人移除 emoji reaction |
| `member_joined_channel` | 有人加入頻道 |
| `member_left_channel` | 有人離開頻道 |
| `channel_rename` | 頻道改名 |
| `pin_added` | 訊息被釘選 |
| `pin_removed` | 釘選被移除 |

點選 **Save Changes**。

## Step 5：設定 Slash Commands

左側選單 → **Slash Commands** → **Create New Command**

| 欄位 | 值 |
|---|---|
| Command | `/openclaw` |
| Short Description | `Send a message to OpenClaw` |
| Should Escape | 不勾選 |

> Socket Mode 下 Request URL 會自動處理，不需填寫。

如果要啟用 OpenClaw 內建的原生命令（`/help`, `/model` 等），需要為每個命令建立對應的 Slash Command。

## Step 6：啟用 App Home

左側選單 → **App Home**：

- 勾選 **Messages Tab** → 啟用（允許使用者 DM bot）
- 取消勾選 **Messages Tab Read Only**（允許 bot 回覆）

## Step 7：安裝 App 到 Workspace

左側選單 → **OAuth & Permissions** → **Install to Workspace** → **Allow**

複製 **Bot User OAuth Token**（格式：`xoxb-...`）。

安裝後，在 Slack 中邀請 bot 到需要的頻道：
```
/invite @OpenClaw
```

## Step 8：設定 moltbot Worker

### 本地開發

編輯 `.dev.vars`：

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

### 正式環境

```bash
wrangler secret put SLACK_BOT_TOKEN
# 貼上 xoxb-...

wrangler secret put SLACK_APP_TOKEN
# 貼上 xapp-...
```

然後部署：

```bash
npm run deploy
```

> **不需要改任何 Worker 程式碼。** `src/gateway/env.ts` 已經會將 token 傳遞到 container，`start-openclaw.sh` 已經會 patch `channels.slack` 設定。

### 運作原理

```
1. Worker 啟動，讀取 SLACK_BOT_TOKEN + SLACK_APP_TOKEN
2. Token 透過 buildEnvVars() 傳入 container 環境變數
3. start-openclaw.sh patch config:
   channels.slack = { botToken, appToken, enabled: true }
4. OpenClaw gateway 啟動 → monitorSlackProvider()
5. @slack/bolt 以 Socket Mode 連接 Slack WebSocket
6. 開始收發訊息
```

## Step 9：驗證

1. 部署後，等待 container 啟動（可透過 `/_admin/` 查看 gateway 狀態）
2. 在 Slack 中 DM bot 或在頻道 @mention bot
3. 如果設定了 `dm.policy: "pairing"`（預設），第一次 DM 會收到配對碼
4. 透過 admin UI 或 CLI 核准：`openclaw pairing approve slack <code>`

### 快速測試（跳過配對）

如果只是測試，可以在 `start-openclaw.sh` 的 Slack config patch 中加入 open DM policy。但目前的 `start-openclaw.sh` 只設定了最小 config（botToken + appToken + enabled）。

要開放所有人 DM，需要擴充 config patch 或手動修改 container 內的 `openclaw.json`。

## App Manifest（一鍵匯入）

在 https://api.slack.com/apps → **Create New App** → **From an app manifest** → 選擇 Workspace → 貼上以下 JSON：

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "channels:history",
        "channels:read",
        "chat:write",
        "commands",
        "emoji:read",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "pins:read",
        "pins:write",
        "reactions:read",
        "reactions:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

匯入後仍需：
1. 到 **Basic Information** → **App-Level Tokens** 產生 App Token（scope: `connections:write`）
2. 到 **OAuth & Permissions** → **Install to Workspace** 取得 Bot Token

## HTTP Events API 模式（進階）

如果需要 HTTP 模式而非 Socket Mode：

### Slack App 設定差異

1. **不啟用** Socket Mode（或同時啟用也可）
2. 到 **Basic Information** 複製 **Signing Secret**
3. **Event Subscriptions** → Request URL 設為：`https://your-worker.example.com/slack/events`
4. **Interactivity & Shortcuts** → 啟用，Request URL 同上
5. **Slash Commands** → 每個命令的 Request URL 同上

### Worker 端需要新增

目前 Worker 尚未實作 Slack HTTP proxy route。需要：

1. 在 `src/routes/public.ts` 新增 `POST /slack/events` endpoint（參考 Telegram webhook pattern）
2. Proxy 到 container 的 port 18789（OpenClaw gateway HTTP server 已內建 `/slack/events` handler）
3. 新增 `SLACK_SIGNING_SECRET` 環境變數
4. 更新 `start-openclaw.sh` 的 Slack config patch 加入 `mode: "http"` 和 `signingSecret`

### OpenClaw Config（HTTP 模式）

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "mode": "http",
      "botToken": "xoxb-...",
      "signingSecret": "your-signing-secret",
      "webhookPath": "/slack/events"
    }
  }
}
```

> HTTP 模式不需要 App Token（`xapp-...`），但需要 Signing Secret。

## OpenClaw 進階設定

以下設定需透過擴充 `start-openclaw.sh` 的 config patch 或手動修改 `openclaw.json` 來調整。

### DM 存取控制

```json
{
  "channels": {
    "slack": {
      "dm": {
        "enabled": true,
        "policy": "pairing",
        "allowFrom": ["U123456", "@username", "*"],
        "groupEnabled": false
      }
    }
  }
}
```

| Policy | 行為 |
|---|---|
| `pairing` | 未知使用者收到配對碼，需管理員核准（預設） |
| `allowlist` | 只允許 `allowFrom` 列表中的使用者 |
| `open` | 允許所有人（搭配 `allowFrom: ["*"]`） |
| `disabled` | 停用 DM |

### 頻道白名單

```json
{
  "channels": {
    "slack": {
      "groupPolicy": "allowlist",
      "channels": {
        "#general": { "allow": true, "requireMention": true },
        "C123456": { "allow": true, "requireMention": false }
      }
    }
  }
}
```

| groupPolicy | 行為 |
|---|---|
| `open` | 所有被邀請的頻道都可互動（未設定 `channels.slack` 時的預設） |
| `allowlist` | 只允許列在 `channels` 中的頻道 |
| `disabled` | 停用所有頻道互動 |

### 回覆模式

```json
{
  "channels": {
    "slack": {
      "replyToMode": "off",
      "replyToModeByChatType": {
        "direct": "all",
        "group": "first",
        "channel": "off"
      }
    }
  }
}
```

| Mode | 行為 |
|---|---|
| `off` | 在主頻道回覆（預設） |
| `first` | 第一則回覆到 thread，後續到主頻道 |
| `all` | 所有回覆都到 thread |

### Reaction 通知

```json
{
  "channels": {
    "slack": {
      "reactionNotifications": "own",
      "reactionAllowlist": ["U123"]
    }
  }
}
```

| Mode | 行為 |
|---|---|
| `off` | 忽略所有 reaction |
| `own` | 只通知對 bot 訊息的 reaction（預設） |
| `all` | 通知所有 reaction |
| `allowlist` | 只通知 `reactionAllowlist` 中的使用者 |

## Troubleshooting

### Bot 沒有回應

1. 確認 gateway 已啟動：`GET /api/status` 應回傳 `{ ok: true }`
2. 確認 token 正確：container log 中應有 `slack: connected` 類似訊息
3. 確認 bot 已被邀請到頻道
4. 如果在頻道中，確認有 @mention bot（除非設定 `requireMention: false`）

### Socket Mode 連線失敗

- 確認 App Token scope 包含 `connections:write`
- 確認 App Token 格式為 `xapp-1-...`
- Container 需要 outbound 網路存取（Cloudflare Sandbox 預設允許）

### 配對碼沒收到

- 確認 App Home 的 Messages Tab 已啟用
- 確認 `im:history` + `im:read` + `im:write` scopes 已設定
- 確認 `message.im` event 已訂閱

### Token 更換後沒生效

Slack token 與 Telegram/Anthropic 不同，不會被快取在 `auth-profiles.json` 中。更換步驟：

```bash
wrangler secret put SLACK_BOT_TOKEN    # 貼上新 token
wrangler secret put SLACK_APP_TOKEN    # 貼上新 token
npm run deploy                         # 重建 container image
# 等待 container 重啟，或透過 admin UI POST /api/admin/gateway/restart
```
