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
- [Bot 對 Bot 自動對談](#bot-對-bot-自動對談)
  - [Slack vs Telegram：Bot-to-Bot 根本差異](#slack-vs-telegrambot-to-bot-根本差異)
  - [Slack Events API 的 Bot 訊息傳遞機制](#slack-events-api-的-bot-訊息傳遞機制)
  - [ignoreSelf 陷阱（最常見的坑）](#ignoreself-陷阱最常見的坑)
  - [設定方式](#設定方式)
  - [防止無限循環（必讀）](#防止無限循環必讀)
  - [DM Bot-to-Bot 限制](#dm-bot-to-bot-限制)
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

## Bot 對 Bot 自動對談

如果你有兩個 OpenClaw 實例（各自運行一個 Slack App），想讓它們在同一個 Slack channel 中自動互相對話，以下是方法和限制。

### Slack vs Telegram：Bot-to-Bot 根本差異

**Slack 的 bot-to-bot 比 Telegram 簡單得多。** Telegram Bot API 在 server-side 就過濾掉其他 bot 的 `message` update（見 [telegram-setup.md](telegram-setup.md#bot-對-bot-自動對談)），逼你必須用 Channel + `channel_post` workaround。Slack 沒有這個限制。

| 面向 | Telegram | Slack |
|---|---|---|
| Bot 能否在群組/頻道收到其他 bot 的訊息 | **不能** — Bot API server-side 過濾 | **能** — Events API 正常送達 |
| 需要 workaround | Channel（`channel_post`） | 只需關掉 SDK 的 `ignoreSelf` |
| @mention 另一個 bot 觸發回應 | 不行（bot 根本收不到 update） | 可以（`app_mention` + `message` event 都會送達） |
| DM bot-to-bot | 完全不行 | 不行（`chat.postMessage` 限制） |
| 天然防循環 | **有** — bot 看不到對方就不會回 | **沒有** — 需自行實作防循環 |

> **關鍵：Slack 的 bot-to-bot 最大挑戰不是「能不能收到訊息」，而是「如何防止無限循環」。**

### Slack Events API 的 Bot 訊息傳遞機制

Slack 的 `message` event 有多種 subtype，其中 `bot_message` 是其他 bot（integration）發送的訊息：

| Event | 能否收到其他 bot 的訊息 | 所需 scope | 備註 |
|---|---|---|---|
| `message.channels` | **是** | `channels:history` | 公開頻道，subtype 為 `bot_message` |
| `message.groups` | **是** | `groups:history` | 私人頻道，subtype 為 `bot_message` |
| `message.im` | **部分** | `im:history` | DM 中，其他 app 的訊息不透過 `app_mention` dispatch |
| `app_mention` | **可能** | `app_mentions:read` | 官方文件未明確記載 bot @mention bot 是否觸發 |

Bot 訊息的 event payload 範例：

```json
{
  "type": "message",
  "subtype": "bot_message",
  "text": "Hello from Bot A!",
  "bot_id": "B123456",
  "channel": "C789012",
  "ts": "1234567890.123456"
}
```

注意 `bot_message` subtype 的特殊性：
- **沒有 `user` 欄位** — 改用 `bot_id` 識別發送者
- **`bot_profile` 欄位**（如有）包含 bot 名稱和 icon
- 普通使用者訊息的 subtype 為 `undefined`

### ignoreSelf 陷阱（最常見的坑）

**這是 Slack bot-to-bot 最常踩的坑。** Slack 的官方 Bolt SDK（JS / Python / Java）預設啟用 `ignoreSelf` middleware，會過濾掉**所有 bot 訊息**（不只自己的），導致 bot 看起來「收不到」其他 bot 的訊息。

```
Events API 送出 bot_message event
  → Bolt SDK 收到
  → ignoreSelf middleware 檢查 subtype === 'bot_message'
  → 判定為「自己的訊息」→ 丟棄  ← 問題在這裡
  → 你的 event handler 完全不會被觸發
```

**解法（Bolt.js）：**

```javascript
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  ignoreSelf: false,  // ← 關鍵：允許 bot 訊息進來
});

// 監聽所有訊息，包括 bot_message
app.event('message', async ({ event }) => {
  if (event.subtype === 'bot_message') {
    // 過濾自己的訊息（用 bot_id 比對）
    if (event.bot_id === MY_BOT_ID) return;

    console.log(`Other bot said: ${event.text}`);
  }
});
```

**解法（Bolt Python）：**

```python
app = App(
    token=os.environ["SLACK_BOT_TOKEN"],
    signing_secret=os.environ["SLACK_SIGNING_SECRET"],
    ignoring_self_events_enabled=False,  # ← 允許 bot 訊息
)

@app.event("message")
def handle_message(event, say):
    if event.get("subtype") == "bot_message":
        if event.get("bot_id") == MY_BOT_ID:
            return  # 過濾自己
        say(f"I heard: {event['text']}")
```

> **OpenClaw 的 Slack provider（`@slack/bolt`）是否預設 `ignoreSelf: true` 取決於版本。** 如果 bot 在 channel 中收不到其他 bot 的訊息，這是第一個要檢查的設定。

### 設定方式

在 Slack channel 中實現 bot-to-bot 對談，不需要像 Telegram 那樣使用特殊的 Channel workaround。直接在一般的 public/private channel 中即可運作。

#### 前提條件

1. 兩個 Slack App 都已安裝到同一個 Workspace
2. 兩個 bot 都已被邀請到同一個 channel（`/invite @BotA` 和 `/invite @BotB`）
3. 兩個 bot 都訂閱了 `message.channels`（或 `message.groups`）event
4. 兩個 bot 的 SDK 都已關閉 `ignoreSelf`（或其 Slack provider 已正確處理 `bot_message` subtype）

#### OpenClaw Config

```json
{
  "channels": {
    "slack": {
      "channels": {
        "C123456789": {
          "allow": true,
          "requireMention": false
        }
      },
      "groupPolicy": "allowlist"
    }
  }
}
```

兩個關鍵設定：
- **`requireMention: false`** — 不需要 @mention 就回應。如果設 `true`，bot A 需要在回覆中 @mention bot B 才能觸發，增加觸發控制但降低自然度
- **`groupPolicy: "allowlist"` + `allow: true`** — 明確允許此 channel

### 防止無限循環（必讀）

**這是 Slack bot-to-bot 最關鍵的問題。** 跟 Telegram 不同，Slack 沒有天然的 bot 訊息隔離，兩個 bot 如果都設定 `requireMention: false`，它們會無止盡地互相回覆。

Slack 本身的速率限制（1 msg/sec/channel）只會延緩循環，不會阻止它。

#### 方法 1：requireMention 觸發（推薦）

最簡單有效的方式是保持 `requireMention: true`，讓 bot 只在被 @mention 時回應：

```json
{
  "channels": {
    "slack": {
      "channels": {
        "C123456789": {
          "allow": true,
          "requireMention": true
        }
      }
    }
  }
}
```

配合 `mentionPatterns`（如 OpenClaw 支援）可以自訂觸發條件：

```json
{
  "messages": {
    "groupChat": {
      "mentionPatterns": ["\\b@?CodeBot\\b", "\\bcoding\\b"]
    }
  }
}
```

**效果：** Bot A 只有在訊息中被 @mention（或匹配 pattern）時才回應。Bot B 的普通回覆不會觸發 Bot A，除非 Bot B 的回覆中特意 @mention Bot A。

#### 方法 2：bot_id 過濾

在 event handler 中根據 `bot_id` 決定是否回應：

```javascript
// 只回應特定 bot 的訊息
const ALLOWED_BOT_IDS = ['B111111', 'B222222'];

app.event('message', async ({ event, say }) => {
  if (event.subtype === 'bot_message') {
    if (!ALLOWED_BOT_IDS.includes(event.bot_id)) return;
    if (event.bot_id === MY_BOT_ID) return; // 不回應自己
    // 處理...
  }
});
```

#### 方法 3：system prompt 行為約束

透過 system prompt 指示 bot 何時該回覆、何時不該（同 Telegram 的做法）：

```json
{
  "channels": {
    "slack": {
      "channels": {
        "C123456789": {
          "allow": true,
          "requireMention": false,
          "systemPrompt": "You are CodeBot, a coding assistant.\nYou share this channel with WriteBot.\n\nRules:\n1. Only respond when the message is directed at you or asks a coding question.\n2. If WriteBot is answering a writing question, do NOT respond.\n3. Never respond to a message that is clearly WriteBot talking to a human.\n4. Keep responses concise.\n5. If WriteBot asks you something directly, respond once then stop."
        }
      }
    }
  }
}
```

#### 方法 4：組合策略（推薦的完整設定）

最穩健的做法是結合多層防護：

**Bot A（coding assistant）：**

```json
{
  "channels": {
    "slack": {
      "channels": {
        "C123456789": {
          "allow": true,
          "requireMention": true,
          "historyLimit": 5,
          "systemPrompt": "You are CodeBot, a coding assistant.\nYou share this channel with WriteBot.\nOnly respond to coding questions or when explicitly addressed.\nNever engage in back-and-forth conversation with WriteBot unless a human asks you to."
        }
      },
      "groupPolicy": "allowlist"
    }
  },
  "messages": {
    "groupChat": {
      "mentionPatterns": ["\\b@?CodeBot\\b", "\\bcoding\\b"]
    }
  }
}
```

**Bot B（writing assistant）：**

```json
{
  "channels": {
    "slack": {
      "channels": {
        "C123456789": {
          "allow": true,
          "requireMention": true,
          "historyLimit": 5,
          "systemPrompt": "You are WriteBot, a writing assistant.\nYou share this channel with CodeBot.\nOnly respond to writing questions or when explicitly addressed.\nNever engage in back-and-forth conversation with CodeBot unless a human asks you to."
        }
      },
      "groupPolicy": "allowlist"
    }
  },
  "messages": {
    "groupChat": {
      "mentionPatterns": ["\\b@?WriteBot\\b", "\\bwriting\\b"]
    }
  }
}
```

#### Slack 的內建速率限制

Slack 本身有以下限制可間接減緩循環（但不會完全阻止）：

| 限制 | 值 | 效果 |
|---|---|---|
| `chat.postMessage` 頻率 | 1 msg/sec/channel | 每秒最多一則，循環速度有上限 |
| Tier 1 rate limit | 1 req/min（部分 API） | 限制 API 呼叫頻率 |
| Event delivery | best-effort | 高負載時可能延遲送達 |

> **注意：** 這些限制只會讓循環變慢，不會停止循環。防循環必須在 application 層實作。

### DM Bot-to-Bot 限制

Slack 官方明確限制：**Bot 無法使用 `chat.postMessage` 向兩個使用者之間的 DM 發送訊息。** 同理，兩個 bot 之間也無法直接建立 DM 對話。

如果需要 bot-to-bot 的「私下」通訊：
- 使用一個專用的 private channel 作為通訊頻道
- 或透過 backend relay（HTTP/webhook）在兩個 OpenClaw 實例之間直接通訊，不經過 Slack

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
