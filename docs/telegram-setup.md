# Telegram Bot 設定指南

本文件說明如何建立 Telegram Bot 並串接到 moltbot worker + OpenClaw。

## 目錄

- [模式選擇](#模式選擇)
- [Step 1：建立 Telegram Bot](#step-1建立-telegram-bot)
- [Step 2：設定 moltbot Worker](#step-2設定-moltbot-worker)
- [Step 3：部署](#step-3部署)
- [Step 4：啟用 Webhook](#step-4啟用-webhook)
- [Step 5：驗證](#step-5驗證)
- [DM 存取控制](#dm-存取控制)
- [群組設定](#群組設定)
- [Forum Topics（論壇主題）](#forum-topics論壇主題)
- [回覆模式與串流](#回覆模式與串流)
- [Reaction 設定](#reaction-設定)
- [Bot 對 Bot 自動對談](#bot-對-bot-自動對談)
- [Troubleshooting](#troubleshooting)

## 模式選擇

OpenClaw 的 Telegram 整合支援兩種模式：

| | Webhook（推薦） | Polling |
|---|---|---|
| 原理 | Telegram 推送 HTTP POST 到 Worker endpoint | Bot 主動向 Telegram 拉取更新 |
| 所需設定 | Bot Token + Webhook Secret + Worker URL | Bot Token |
| 延遲 | 即時 | 取決於 polling 間隔 |
| 適合場景 | 正式部署（Cloudflare Worker） | 本地開發、除錯 |
| 優點 | 省頻寬、即時、可水平擴展 | 不需 public endpoint |

**本指南預設使用 Webhook 模式。** Polling 模式在未設定 `WORKER_URL` + `TELEGRAM_WEBHOOK_SECRET` 時自動啟用。

## Step 1：建立 Telegram Bot

1. 在 Telegram 搜尋 [@BotFather](https://t.me/BotFather)
2. 發送 `/newbot`
3. 依指示輸入 bot 名稱和 username（username 必須以 `bot` 結尾）
4. 複製 **Bot Token**（格式：`123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh`）

### 建議的 BotFather 設定

```
/setprivacy → Disable（讓 bot 在群組中能看到所有訊息，而非只有 /commands 和 @mentions）
/setjoingroups → Enable（允許被加入群組）
/setcommands → 設定以下命令：
  openclaw - Send a message to OpenClaw
  help - Show help
  model - Switch AI model
```

> **重要：** `/setprivacy → Disable` 是群組對話的必要設定。否則 bot 在群組中只能看到 `/commands` 和被 @mention 的訊息。

## Step 2：設定 moltbot Worker

### 環境變數

| 變數 | 類型 | 必要 | 說明 |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Secret | Yes | BotFather 提供的 bot token |
| `TELEGRAM_WEBHOOK_SECRET` | Secret | Webhook 模式必要 | Webhook 驗證密鑰（自行產生） |
| `WORKER_URL` | Var | Webhook 模式必要 | Worker 的 public URL |
| `TELEGRAM_DM_POLICY` | Var | No | DM 存取策略，預設 `pairing` |
| `TELEGRAM_DM_ALLOW_FROM` | Var | No | 逗號分隔的允許 user ID |

### 產生 Webhook Secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 本地開發

編輯 `.dev.vars`：

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh
# 本地開發通常使用 polling 模式，不需要以下兩個：
# TELEGRAM_WEBHOOK_SECRET=your-random-hex-string
# WORKER_URL=https://your-worker.example.com
```

> 本地開發未設定 `WORKER_URL` + `TELEGRAM_WEBHOOK_SECRET` 時，OpenClaw 自動使用 polling 模式。

### 正式環境

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
# 貼上 bot token

wrangler secret put TELEGRAM_WEBHOOK_SECRET
# 貼上產生的 hex string
```

在 `wrangler.jsonc` 的 `vars` 中設定：

```jsonc
{
  "vars": {
    "WORKER_URL": "https://your-worker.example.com"
  }
}
```

## Step 3：部署

```bash
npm run deploy
```

等待 container 啟動（可透過 `/_admin/` 查看 gateway 狀態）。

### 運作原理

```
1. Worker 啟動，讀取 TELEGRAM_BOT_TOKEN + TELEGRAM_WEBHOOK_SECRET + WORKER_URL
2. Token 透過 buildEnvVars() 傳入 container 環境變數
3. start-openclaw.sh patch config:
   channels.telegram = {
     botToken, enabled: true, dmPolicy,
     webhookUrl, webhookSecret, webhookHost: "0.0.0.0"
   }
4. OpenClaw gateway 啟動 → monitorTelegramProvider()
5. 若有 webhookUrl → 啟動 webhook HTTP server (port 8787)
   若無 → 使用 long polling
6. 開始收發訊息
```

### Webhook 訊息流

```
Telegram API
  → POST https://your-worker.example.com/telegram/webhook
  → Header: X-Telegram-Bot-Api-Secret-Token: <secret>
  → Worker 驗證 secret（timing-safe comparison）
  → Worker proxy 到 container:8787/telegram-webhook
  → OpenClaw 處理訊息並回覆
```

> Webhook route 是 public 的（不經過 Cloudflare Access），`TELEGRAM_WEBHOOK_SECRET` 是唯一的驗證層。

## Step 4：啟用 Webhook

部署後，需要向 Telegram 註冊 webhook URL：

1. 透過 admin UI 或 DM bot 執行：
   ```
   /telegram webhook on
   ```
2. 驗證 webhook 狀態：
   ```
   /telegram webhook verify
   ```
3. 成功會顯示 `[PASS]` 和 webhook URL

> `/telegram webhook on` 會呼叫 Telegram `setWebhook` API 將你的 Worker URL 註冊為 webhook endpoint。這只需做一次，除非 URL 變更。

### 其他 webhook 管理命令

| 命令 | 說明 |
|---|---|
| `/telegram webhook` | 顯示 webhook 狀態 |
| `/telegram webhook on` | 註冊 webhook |
| `/telegram webhook off` | 取消 webhook（切回 polling） |
| `/telegram webhook verify` | 查詢 Telegram API 的 webhook 資訊 |

## Step 5：驗證

1. DM bot → 如果 `dmPolicy=pairing`（預設），會收到配對碼
2. 核准配對：`/telegram pair approve <code>`
3. 再次 DM bot，應收到 AI 回覆
4. 在群組中 @mention bot，應收到回覆

### 快速測試（跳過配對）

設定環境變數 `TELEGRAM_DM_POLICY=open`，重新部署即可。

## DM 存取控制

### DM Policy

透過 `TELEGRAM_DM_POLICY` 環境變數或 config patch 設定：

| Policy | 行為 |
|---|---|
| `pairing`（預設） | 未知使用者收到配對碼，需管理員核准 |
| `allowlist` | 只允許 `allowFrom` 列表中的使用者 |
| `open` | 允許所有人（`allowFrom = ["*"]`） |
| `disabled` | 停用 DM |

### 配對管理命令

| 命令 | 說明 |
|---|---|
| `/telegram pair` 或 `/telegram pair list` | 列出待核准的配對請求 |
| `/telegram pair approve <code>` | 核准配對（加入 allowFrom） |

配對請求有 60 分鐘有效期。核准後，user ID 會寫入 `telegram-allowFrom.json` 並持久化到 R2。

### 進階 DM 設定

透過擴充 `start-openclaw.sh` 的 config patch 或手動修改 `openclaw.json`：

```json
{
  "channels": {
    "telegram": {
      "dmPolicy": "pairing",
      "allowFrom": ["123456789", "987654321"],
      "dmHistoryLimit": 20
    }
  }
}
```

## 群組設定

### 群組 Policy

```json
{
  "channels": {
    "telegram": {
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["123456789"],
      "groups": {
        "-1001234567890": {
          "requireMention": true,
          "allowFrom": ["123456789", "987654321"]
        },
        "*": {
          "requireMention": true
        }
      }
    }
  }
}
```

| groupPolicy | 行為 |
|---|---|
| `open` | 所有群組成員都可觸發 bot |
| `allowlist`（預設） | 只允許 `groupAllowFrom` 或 per-group `allowFrom` 中的使用者 |
| `disabled` | 停用所有群組互動 |

### Mention 設定

| 設定 | 預設 | 說明 |
|---|---|---|
| `requireMention` | `true` | 群組中需要 @mention bot 才回應 |

可在 per-group config 覆蓋：

```json
{
  "channels": {
    "telegram": {
      "groups": {
        "-1001234567890": { "requireMention": false }
      }
    }
  }
}
```

> **BotFather Privacy Mode 注意事項：** 如果 BotFather 的 privacy mode 是 enabled（預設），bot 在群組中只能看到 `/commands` 和被 @mention 的訊息。即使 `requireMention: false`，bot 也看不到一般訊息。請確認已執行 `/setprivacy → Disable`。

## Forum Topics（論壇主題）

Telegram 的 Forum 群組支援以主題分隔對話，OpenClaw 會為每個 topic 建立獨立的 session：

```json
{
  "channels": {
    "telegram": {
      "groups": {
        "-1001234567890": {
          "requireMention": true,
          "topics": {
            "5": {
              "requireMention": false,
              "systemPrompt": "You are a coding assistant in this topic.",
              "allowFrom": ["*"]
            }
          }
        }
      }
    }
  }
}
```

- 每個 topic 有獨立的對話歷史
- 可以 per-topic 設定 `requireMention`、`systemPrompt`、`allowFrom`
- General topic（ID=1）是預設主題

## 回覆模式與串流

### replyToMode（回覆 threading）

```json
{
  "channels": {
    "telegram": {
      "replyToMode": "off"
    }
  }
}
```

| Mode | 行為 |
|---|---|
| `off`（預設） | 直接回覆在聊天中 |
| `first` | 第一則回覆 reply to 原訊息，後續直接發送 |
| `all` | 所有回覆都 reply to 原訊息 |

### streaming（串流模式）

```json
{
  "channels": {
    "telegram": {
      "streaming": "partial"
    }
  }
}
```

| Mode | 行為 |
|---|---|
| `off` | 等完整回覆後一次發送 |
| `partial`（預設） | 即時編輯單一預覽訊息 |
| `block` | 分段串流 |
| `progress` | 顯示進度條 |

## Reaction 設定

### reactionLevel（bot 的 reaction 能力）

| Level | 行為 |
|---|---|
| `off` | 不使用 reaction |
| `ack`（預設） | 只在處理中顯示確認 reaction（👀） |
| `minimal` | 偶爾使用 reaction |
| `extensive` | 頻繁使用 reaction |

### reactionNotifications（通知 agent 有人加了 reaction）

| Mode | 行為 |
|---|---|
| `off` | 忽略所有 reaction |
| `own`（預設） | 只通知對 bot 訊息的 reaction |
| `all` | 通知所有 reaction |

```json
{
  "channels": {
    "telegram": {
      "reactionLevel": "minimal",
      "reactionNotifications": "own",
      "ackReaction": "👀"
    }
  }
}
```

## Bot 對 Bot 自動對談

如果你有兩個 OpenClaw 實例（各自運行一個 Telegram Bot），想讓它們在同一個 Telegram 空間中自動互相對話，以下是方法和限制。

### Telegram Bot API 限制

**關鍵限制：Telegram Bot 在群組中看不到其他 Bot 的訊息。** 這是 Telegram Bot API 的基本限制，不是 OpenClaw 的問題。

| 場景 | Bot A 能否看到 Bot B 的訊息？ |
|---|---|
| 一般群組（group） | 否 |
| 超級群組（supergroup） | 否 |
| 頻道（channel） | **是** — 透過 `channel_post` 事件 |
| DM | 不適用 — Bot 之間無法互發 DM |

### 解法：使用 Telegram Channel

OpenClaw 已實作 `channel_post` handler，專門用於 bot-to-bot 通訊。透過 Telegram **Channel**（而非 Group），兩個 bot 可以看到彼此的訊息。

#### 設定步驟

1. **建立 Telegram Channel**
   - 在 Telegram 建立一個新的 Channel（公開或私人皆可）
   - 將兩個 bot 都加為 Channel 的 **管理員**（需要發送訊息權限）

2. **取得 Channel ID**
   - 將 bot 加入 channel 後，在 channel 中發送一則訊息
   - 透過 Telegram API 取得 channel ID（通常格式為 `-100xxxxxxxxxx`）
   - 或使用 [@userinfobot](https://t.me/userinfobot) 等工具

3. **設定 Bot A 的 OpenClaw config**

   ```json
   {
     "channels": {
       "telegram": {
         "groupPolicy": "open",
         "groups": {
           "<channel_id>": {
             "requireMention": false,
             "groupPolicy": "open"
           }
         }
       }
     }
   }
   ```

4. **設定 Bot B 的 OpenClaw config**（同上，但使用 Bot B 的 config）

   ```json
   {
     "channels": {
       "telegram": {
         "groupPolicy": "open",
         "groups": {
           "<channel_id>": {
             "requireMention": false,
             "groupPolicy": "open"
           }
         }
       }
     }
   }
   ```

5. **兩個關鍵設定**
   - `requireMention: false` — 不需要 @mention 就回應（否則 bot 不會互相 tag）
   - `groupPolicy: "open"` — 允許所有發送者（包括其他 bot）

#### 運作原理

```
Bot A 發送訊息到 Channel
  → Telegram 送出 channel_post update 給所有 channel 成員（包括 Bot B）
  → Bot B 的 OpenClaw 收到 channel_post
  → channel_post handler 將它轉換為標準訊息格式處理
  → Bot B 回覆到 Channel
  → Telegram 送出 channel_post update 給 Bot A
  → Bot A 處理並回覆...（循環）
```

### 防止無限循環

兩個 bot 如果都設定 `requireMention: false`，它們會互相回覆形成無限循環。建議的防護措施：

1. **使用 mentionPatterns 作為觸發條件**：設定自訂 mention pattern，只在特定關鍵字出現時回應

   ```json
   {
     "channels": {
       "telegram": {
         "groups": {
           "<channel_id>": {
             "requireMention": true
           }
         }
       }
     }
   }
   ```

   搭配 `agents.defaults.groupChat.mentionPatterns` 或 `messages.groupChat.mentionPatterns` 設定觸發 regex。

2. **使用 system prompt 約束**：在 system prompt 中指示 bot 何時該回覆、何時不該

3. **設定 historyLimit**：限制 bot 能看到的歷史訊息量，避免 context 過長

   ```json
   {
     "channels": {
       "telegram": {
         "groups": {
           "<channel_id>": {
             "historyLimit": 5
           }
         }
       }
     }
   }
   ```

### 替代方案：手動 relay

如果 Channel 模式不符合需求，可以考慮：

1. **Relay Bot**：建立一個 user account（非 bot）作為中繼，轉發兩個 bot 的訊息
2. **Telegram User Token**：使用 user token（`userbot`）模式，但有帳號風險且不推薦
3. **外部橋接**：透過 webhook 或 API 在兩個 OpenClaw 實例間直接轉發訊息（不經 Telegram）

## Troubleshooting

### Bot 沒有回應

1. 確認 gateway 已啟動：`GET /api/status` 應回傳 `{ ok: true }`
2. 確認 token 正確：container log 中應有 Telegram 連線成功的訊息
3. 確認 bot 已被加入群組（群組場景）
4. 確認 BotFather privacy mode 已 disable（群組場景）
5. 如果在群組中，確認有 @mention bot（除非設定 `requireMention: false`）

### Webhook 連線失敗

- 確認 `WORKER_URL` 是正確的 public URL（含 https://）
- 確認 `TELEGRAM_WEBHOOK_SECRET` 已設定
- 執行 `/telegram webhook verify` 查看 Telegram API 回報的狀態
- 查看是否有 `last_error_message`

### 配對碼沒收到

- 確認 DM policy 是 `pairing`（預設）
- 確認 bot token 正確
- 確認 container 已啟動且 gateway 運作中

### Webhook 502/503 錯誤

- Container 可能尚未啟動 — webhook server 需要 gateway 完全啟動後才能接收
- 檢查 container log 是否有 EADDRINUSE 錯誤（已有 patch，但仍需確認）
- 透過 admin UI `POST /api/admin/gateway/restart` 重啟

### Token 更換後沒生效

```bash
wrangler secret put TELEGRAM_BOT_TOKEN    # 貼上新 token
npm run deploy                             # 重建 container image
# 等待 container 重啟，或透過 admin UI POST /api/admin/gateway/restart
```

`start-openclaw.sh` 每次啟動都會 patch `auth-profiles.json`，覆蓋快取的舊 key。

### Bot-to-Bot 對談沒反應

1. 確認使用的是 **Channel**，不是 Group
2. 確認兩個 bot 都是 Channel 的管理員
3. 確認 `requireMention: false`
4. 確認 `groupPolicy: "open"` 或 `allowFrom` 包含對方 bot 的 user ID
5. 確認 BotFather 的 `/setjoingroups` 是 Enable
