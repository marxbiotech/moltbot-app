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
  - [Telegram Bot API 限制](#telegram-bot-api-限制)
  - [群組內 Bot-to-Bot 的可能替代方案](#群組內-bot-to-bot-的可能替代方案)
  - [解法 A：使用 Telegram Channel（最簡單）](#解法-a使用-telegram-channel最簡單)
    - [設定步驟](#設定步驟)
    - [新增 Bot 到已有的 Channel](#新增-bot-到已有的-channel)
    - [進階 Per-Group 設定](#進階-per-group-設定)
  - [防止無限循環](#防止無限循環)
  - [進階：同一 OpenClaw 實例跑多個 Bot](#進階同一-openclaw-實例跑多個-bot)
  - [替代方案](#替代方案)
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

**關鍵限制：Telegram Bot API 在群組中不會將其他 Bot 的訊息 update 傳送給 bot。** 這是 Telegram 的刻意設計，不是 OpenClaw 的問題。

Telegram 官方 FAQ 明確指出：

> "Bot admins and bots with privacy mode disabled will receive all messages **except messages sent by other bots**."
>
> "Bots talking to each other could potentially get stuck in unwelcome loops."

| 場景 | Bot A 能否收到 Bot B 的 message update？ | 原因 |
|---|---|---|
| 一般群組（group） | **否** | Bot API server-side 不送出 |
| 超級群組（supergroup） | **否** | 同上，即使是管理員也一樣 |
| 頻道（channel） | **是** | 透過 `channel_post` 事件（不同的 update type） |
| DM | **不適用** | Bot 之間無法互發 DM |

> **人類使用者 vs. Bot 的視角不同：** 在 Telegram 群組中，人類使用者可以看到所有 bot 的發言。但 bot 本身不會收到其他 bot 發言的 `message` update。如果你在群組中看到兩個 bot 都有發言，那是你（人類）的視角 — bot 並不知道對方說了什麼。

#### 實驗驗證（2026-02-24）

我們用 `getUpdates` API 對 MagataShikiBot（`can_read_all_group_messages: true`）進行了實測，在「火星生技效率部門」supergroup（forum 群組）中：

1. 先 `deleteWebhook` 切換到手動拉取模式
2. 清除舊 update（設定 offset）
3. 在群組中分別發送：人類訊息、另一個 bot（GranCavalloBot）的訊息、另一個 bot tag @MagataShikiBot 的訊息

**結果：`getUpdates` 只回傳了人類發送的訊息，所有 bot 發送的訊息（包含明確 @mention MagataShikiBot 的）完全未出現。**

```
收到的 update：
  ✅ Xin: "@GranCavalloBot 說說話"                    ← 人類訊息，收到
  ✅ Xin: "@GranCavalloBot 博士指的是真賀田四季博士..."   ← 人類訊息，收到
  ❌ GranCavalloBot 的所有回覆                         ← bot 訊息，完全未收到
  ❌ GranCavalloBot tag @MagataShikiBot 的訊息        ← bot 訊息，完全未收到
```

這證實 Telegram Bot API 確實在 **server 端過濾**掉其他 bot 的訊息，即使：
- 接收方 bot 已關閉隱私模式（`can_read_all_group_messages: true`）
- 發送方 bot 明確 @mention 接收方 bot
- 群組類型是 supergroup + forum

接著我們測試了 **Channel 的 `channel_post`**，在「徬徨海」Channel 中：

1. 將 MagataShikiBot 和 GranCavalloBot 都加為 Channel 管理員
2. 用 GranCavalloBot 的 Bot API `sendMessage` 發送訊息到 Channel
3. 檢查 MagataShikiBot 的 `getUpdates`

**結果：MagataShikiBot 成功透過 `channel_post` 收到了 GranCavalloBot 發送的訊息。**

```
收到的 channel_post update：
  ✅ GranCavalloBot 在 Channel 中發送的訊息           ← channel_post，收到！
```

進一步測試 **Sign Messages** 設定的影響：

| Channel 管理員設定 | `from` 欄位 | `sender_chat` 欄位 | `author_signature` |
|---|---|---|---|
| Sign Messages **OFF** | 無 | `{ id: channel_id, title: "徬徨海" }` | 無 |
| Sign Messages **ON** | `{ id: bot_id, is_bot: true, username: "GranCavalloBot" }` | 無 | `"達·文西"` |

**關鍵發現：必須啟用 Sign Messages，否則 `channel_post` 的 `from` 為空，接收方 bot 無法辨識發送者身份。** OpenClaw 的 `channel_post` handler 在 Sign Messages OFF 時會使用 `sender_chat`（channel info）建構 `syntheticFrom`，所有 bot 的訊息看起來都來自同一個 Channel。

#### 為什麼 Privacy Mode 和管理員權限都無法繞過？

這個限制是 Telegram **server-side** 的行為，不是 client-side 的過濾：

- **Privacy Mode Disabled**：bot 可以收到群組中所有**人類使用者**的訊息，但仍然收不到其他 bot 的訊息
- **Bot 是管理員**：管理員權限影響的是 bot 能執行的操作（刪除訊息、踢人等），不影響它能「收到」什麼 update
- **`getUpdates` / webhook**：Telegram API 在 server-side 就不會將 bot-to-bot 的 `message` update 送出，無論你怎麼設定 `allowed_updates`，都收不到
- **Bot API changelog 2024-2025 無相關變更**：此限制自始至終未改變
- **OpenClaw 的 message handler 完全沒有 `is_bot` 過濾**：如果 Telegram 有送出 bot 的 message update，OpenClaw 會正常處理。問題是 Telegram 根本不送

#### 為什麼 bot 看起來「看得到」但不回應？

如果你觀察到兩個 bot 在群組中都有發言但不互相回應，最可能的原因是：

1. **你看到的是人類視角**：人類使用者在群組中可以看到所有 bot 的訊息，但 bot 根本收不到對方的 message update
2. **兩個 bot 各自在回應人類**：兩個 bot 可能各自在回應不同人類使用者的訊息，看起來像是在對話但其實不是
3. **群組綁定了 Channel**：如果群組是某個 Channel 的 Discussion Group，bot 的部分訊息可能透過 `channel_post` 送達（而非 `message`），但行為會與一般群組不同

如果你確實需要驗證 bot 有沒有收到 update，可以檢查 OpenClaw 的 container log，搜尋 `"skipping group message"` 或對方 bot 的 user ID。

#### 如果 bot 真的收到了對方的 message update

OpenClaw 的 message handler **不會過濾 `is_bot`**，但有多層其他過濾會導致不回應：

| 過濾層 | 預設行為 | 效果 |
|---|---|---|
| `requireMention: true`（預設） | 群組訊息需要 @mention bot 才處理 | Bot A 的訊息不會包含 @BotB，被跳過 |
| `groupPolicy: "allowlist"`（預設） | 只允許 allowFrom 中的 sender ID | Bot A 的 user ID 不在 allowlist 中，被拒絕 |
| `shouldSkipUpdate` watermark | 跳過 update_id <= 已處理 offset 的訊息 | 如果 bot 重啟過，可能跳過舊訊息 |

要讓 bot 回應對方（假設真的收到 update），需要同時設定：
- `requireMention: false`
- `groupPolicy: "open"`（或在 `groupAllowFrom` 加入對方 bot 的 user ID）

#### 群組內 Bot-to-Bot 的可能替代方案

雖然 Bot API 無法直接實現群組內的 bot-to-bot，但有以下進階方案：

##### 方案 1：Channel + Linked Discussion Group（推薦）

Telegram Channel 可以綁定一個 Discussion Group。在 Channel 中發送的訊息會自動轉發到 Discussion Group，反之亦然。

```
Bot A 發訊息到 Channel
  → Telegram 自動轉發到 Linked Discussion Group（人類使用者可在此看到）
  → Bot B 透過 channel_post 收到 Channel 中的訊息
  → Bot B 回覆到 Channel
  → 同樣自動轉發到 Discussion Group
```

**設定方式：**
1. 建立一個 Channel，加入兩個 bot 為管理員
2. 建立一個 Supergroup 作為 Discussion Group
3. 在 Channel 設定 → Discussion → 連結到該 Supergroup
4. 人類使用者加入 Discussion Group 即可看到對話
5. 兩個 bot 的 OpenClaw config 設定 channel ID（不是 group ID）

**優點：** 人類使用者在 Discussion Group 中可以看到完整對話，也可以參與；bot 之間透過 Channel 通訊
**缺點：** 訊息會顯示為「從 Channel 轉發」而非直接發送

##### 方案 2：Backend Relay（out-of-band）

不依賴 Telegram 的訊息傳遞，在 OpenClaw 實例之間建立直接通訊：

```
人類使用者在群組中 @BotA "請問 BotB 怎麼看？"
  → Bot A 的 OpenClaw 處理訊息
  → Bot A 透過 HTTP/webhook 呼叫 Bot B 的 API
  → Bot B 回覆 Bot A
  → Bot A 將 Bot B 的回覆發送到群組
```

**實現方式：**
- 在 OpenClaw 的 agent tool 中建立自訂 tool，呼叫另一個 OpenClaw 的 gateway API
- 或使用共享的 message queue / pub-sub
- 可搭配 system prompt 指示 agent 何時該轉達

**優點：** 真正在群組中對話、延遲低、完全控制
**缺點：** 需要自行開發 relay 邏輯

##### 方案 3：MTProto Userbot（不推薦）

使用 Telegram MTProto API（如 Telethon / GramJS / TDLib）以一般使用者帳號登入，而非 Bot API。使用者帳號可以看到群組中所有訊息，包括其他 bot 的。

**風險：**
- 違反 Telegram ToS，帳號可能被封鎖
- 需要真實手機號碼
- 維護成本高（session 管理、2FA 處理）
- OpenClaw 目前不支援 MTProto（僅支援 Bot API via grammY）

> **不推薦用於正式環境。** 如果需要此功能，建議使用方案 1 或方案 2。

### 解法 A：使用 Telegram Channel（最簡單）

OpenClaw 已實作 `channel_post` handler（`src/telegram/bot-handlers.ts`），專門用於 bot-to-bot 通訊。透過 Telegram **Channel**（而非 Group），兩個 bot 可以看到彼此的訊息。

#### 設定步驟

##### Step 1：建立 Telegram Channel

1. 在 Telegram 建立一個新的 Channel（公開或私人皆可）
2. 將所有參與的 bot 加為 Channel 的 **管理員**（需要「發送訊息」權限）
3. **啟用 Sign Messages**：Channel 設定 → Administrators → 每個 bot → 開啟「Sign messages」。未啟用時 `channel_post` 的 `from` 為空，bot 無法辨識訊息發送者身份

##### Step 2：取得 Channel ID

- 在 channel 中發送一則訊息，透過 `/telegram chatid` 或 Telegram Bot API `getUpdates` 取得 channel ID（通常格式為 `-100xxxxxxxxxx`）
- 或在 Telegram Web 中打開 channel，URL 中的數字即為 ID

##### Step 3：在每個 Bot 上設定 Channel

在每個 bot 的 OpenClaw DM 中執行：

```
/telegram group add <channel-id> --bot-to-bot
```

此指令會自動設定：
- `enabled: true`
- `requireMention: false`
- `groupPolicy: allowlist`（使用 allowlist 而非 open，精確控制誰能觸發回應）
- `allowFrom`：自動包含所有已配對的 DM 使用者（owner）

##### Step 4：互相加入對方的 Bot ID（allowFrom 雙向設定）

每對 bot 之間需要**雙向**設定 allowFrom，讓彼此能看到對方的訊息：

- **A 能看到 B 的訊息** → B 的 bot ID 必須在 A 的 `allowFrom` 裡
- **B 能看到 A 的訊息** → A 的 bot ID 必須在 B 的 `allowFrom` 裡

**操作方式：** 在每個 bot 上執行 `/telegram group join <channel-id>`，此指令會產生一條 `+allowFrom` 指令，將該指令複製到**其他所有 bot** 上執行。

範例：假設 Channel 中有 Bot A（ID: `111`）和 Bot B（ID: `222`）

1. 在 Bot A 上執行：
   ```
   /telegram group join -100xxxxxxxxxx
   ```
   輸出：
   ```
   Copy this command and run it on the OTHER bot's OpenClaw,
   so that bot can see this bot's messages in the group:

   /telegram group set -100xxxxxxxxxx +allowFrom 111

   This bot's ID: 111
   ```

2. 把產生的指令 `/telegram group set -100xxxxxxxxxx +allowFrom 111` 貼到 **Bot B** 上執行

3. 在 Bot B 上同樣執行 `/telegram group join -100xxxxxxxxxx`，把產生的指令貼到 **Bot A** 上執行

4. 完成後在任一 bot 上驗證：
   ```
   /telegram group show -100xxxxxxxxxx
   ```
   應看到 `allowFrom` 包含對方的 bot ID 和自己的 user ID。

##### Step 5：重啟 Gateway

每個 bot 修改 config 後需要重啟 gateway 才能生效：

```
/telegram restart
```

##### 新增 Bot 到已有的 Channel

如果 Channel 已有 Bot A、Bot B，現在要加入 Bot C：

1. 在 Telegram 將 Bot C 加為 Channel 管理員，啟用 Sign Messages
2. 在 Bot C 上執行 `/telegram group add <channel-id> --bot-to-bot`
3. 在 Bot C 上執行 `/telegram group join <channel-id>`，把產生的指令分別貼到 Bot A 和 Bot B 上執行
4. 在 Bot A 和 Bot B 上各執行 `/telegram group join <channel-id>`，把產生的指令都貼到 Bot C 上執行
5. 所有 bot 執行 `/telegram restart`

##### allowFrom 管理

```
/telegram group set <id> +allowFrom <bot-id1>,<bot-id2>   # 增量加入
/telegram group set <id> -allowFrom <bot-id>               # 移除
/telegram group show <id>                                   # 查看目前設定
```

##### 關鍵設定說明

| 設定 | 值 | 說明 |
|---|---|---|
| `enabled` | `true` | 啟用此 channel（`channel_post` handler 需要 `requireConfiguredGroup: true`） |
| `requireMention` | `false` | 不需要 @mention 就回應（bot 之間不會互相 tag） |
| `groupPolicy` | `allowlist` | 只允許 `allowFrom` 中的 sender 觸發回應，防止未授權的 bot 加入對話 |
| `allowFrom` | `["bot-id-1", "bot-id-2", "owner-id"]` | 允許的 sender ID 列表，包含其他 bot 和 owner |

##### 進階 Per-Group 設定

除了基礎設定外，OpenClaw 支援以下 per-group 設定來精細控制 bot 在 Channel 中的行為：

| 設定 | 類型 | CLI 指令 | 說明 |
|---|---|---|---|
| `systemPrompt` | `string` | `/telegram group set <id> systemPrompt "..."` | 額外系統提示（**追加**到 global/agent prompt，不覆蓋） |
| `skills` | `string[]` | `/telegram group set <id> skills '["skill1"]'` | 技能白名單。省略=全部可用；`[]`=停用所有技能 |
| `tools` | `{allow?, alsoAllow?, deny?}` | 需直接修改 config | Tool 白名單/黑名單 |
| `toolsBySender` | `Record<sender, ToolPolicy>` | 需直接修改 config | Per-sender tool 權限覆蓋 |
| `topics` | `Record<id, TopicConfig>` | 需直接修改 config | Per-forum-topic 覆蓋（含 systemPrompt、skills、allowFrom 等） |

**systemPrompt 注入方式：**

Group `systemPrompt` 是**追加**到現有 prompt，不會覆蓋 bot 原有的人格設定。注入順序：

```
global agent system prompt（原有人格、指令）
  + inboundMetaPrompt（訊息 metadata）
  + groupChatContext（群組上下文）
  + groupIntro（群組介紹）
  + groupSystemPrompt（← 你設定的 per-group prompt）
  + topicSystemPrompt（如果是 forum topic）
```

這代表你可以放心在 group level 加入行為約束（如「不要主動回覆其他 bot」），不用重複定義 bot 的完整人格。

**skills 過濾：**

```bash
# 只允許 code_review 和 debugging 技能
/telegram group set <channel-id> skills '["code_review","debugging"]'

# 停用所有技能（純對話模式）
/telegram group set <channel-id> skills '[]'

# 恢復使用全部技能（移除限制）
# 需直接修改 config 刪除 skills key
```

Topic-level skills 優先於 group-level（`firstDefined` 語義）。

**tools 權限控制（需直接修改 config）：**

```json
{
  "channels": {
    "telegram": {
      "groups": {
        "-100xxxxxxxxxx": {
          "tools": {
            "allow": ["read_file", "web_search"],
            "deny": ["bash", "write_file"]
          },
          "toolsBySender": {
            "id:123456789": {
              "allow": ["bash", "read_file", "write_file"]
            },
            "*": {
              "deny": ["bash"]
            }
          }
        }
      }
    }
  }
}
```

`toolsBySender` 的 key 格式：`id:<telegram_user_id>`、`username:<username>`、`name:<display_name>`、`*`（所有 sender）。

**不支援 per-group 覆蓋的設定：**

| 設定 | 層級 | 說明 |
|---|---|---|
| `historyLimit` | Global（`messages.groupChat`） | 所有 group 共用 |
| `mentionPatterns` | Global（`messages.groupChat`） | 所有 group 共用 |
| Agent 選擇 | Routing config | 無法 per-group 指定不同 agent |
| Model | Agent config | 無法 per-group 切換 model |

##### Bot-to-Bot 推薦的完整 Per-Group 設定

```bash
# 基礎（由 group add --bot-to-bot 自動完成）
/telegram group add <channel-id> --bot-to-bot <other-bot-id>

# 防循環
/telegram group set <channel-id> requireMention true

# 行為約束（追加到現有 prompt）
/telegram group set <channel-id> systemPrompt "你在這個 Channel 中與其他 AI bot 共存。\n規則：\n1. 只在被點名或遇到你專長的問題時回應\n2. 不要與其他 bot 進行無限來回對話\n3. 如果不確定是否該回應，保持沉默\n4. 回覆保持簡潔"

# 限制 context 深度（全域設定）
# 需直接修改 openclaw.json: messages.groupChat.historyLimit = 5

# 限制可用技能（選用）
/telegram group set <channel-id> skills '["code_review"]'
```

#### channel_post 內部運作原理

OpenClaw 收到 `channel_post` 時的處理流程：

```
Telegram 送出 channel_post update
  │
  ├─ 1. 建構 syntheticFrom（發送者身份）
  │    ├─ 如果 post.from 存在 → 直接使用（通常是 bot 的真實 user info）
  │    ├─ 如果有 sender_chat → 用 sender_chat.id + title，標記 is_bot: true
  │    └─ 否則 → 用 channel 本身的 id + title，標記 is_bot: true
  │
  ├─ 2. 建構 syntheticMsg
  │    ├─ 繼承 post 的所有欄位（text, entities, media 等）
  │    ├─ from = post.from ?? syntheticFrom
  │    └─ chat.type 強制設為 "supergroup"（進入群組處理 pipeline）
  │
  ├─ 3. 提取 senderId
  │    ├─ 優先用 sender_chat.id（bot 透過 channel 發送時）
  │    └─ 其次用 from.id
  │
  └─ 4. 進入標準 handleInboundMessageLike()
       ├─ 走群組的 access control（groupPolicy + allowFrom）
       ├─ 走 mention gating（requireMention 檢查）
       ├─ 建立或恢復 session
       ├─ 送給 AI agent 處理
       └─ 回覆發送到同一個 channel（同一個 chatId）
```

#### 完整訊息流（兩個 Bot 對談）

```
┌─────────┐                    ┌─────────────────┐                    ┌─────────┐
│  Bot A   │                    │  Telegram API   │                    │  Bot B   │
│(OpenClaw)│                    │                 │                    │(OpenClaw)│
└────┬─────┘                    └────────┬────────┘                    └────┬─────┘
     │                                   │                                  │
     │  sendMessage(channel, "Hello!")    │                                  │
     │──────────────────────────────────>│                                  │
     │                                   │                                  │
     │                                   │  channel_post: from=BotA         │
     │                                   │  text="Hello!"                   │
     │                                   │─────────────────────────────────>│
     │                                   │                                  │
     │                                   │                 syntheticMsg 建構 │
     │                                   │                 groupPolicy 檢查  │
     │                                   │                 AI agent 推理     │
     │                                   │                                  │
     │                                   │  sendMessage(channel, "Hi!")     │
     │                                   │<─────────────────────────────────│
     │                                   │                                  │
     │  channel_post: from=BotB          │                                  │
     │  text="Hi!"                       │                                  │
     │<──────────────────────────────────│                                  │
     │                                   │                                  │
     │  syntheticMsg 建構                 │                                  │
     │  AI agent 推理                     │                                  │
     │  ...                              │                                  │
```

### 防止無限循環

兩個 bot 如果都設定 `requireMention: false` + `groupPolicy: "open"`，它們會互相回覆形成無限循環。以下是防護層，**建議至少使用方法 1 + 方法 2**。

#### 方法 1：allowlist 精確控制（基礎防護）

使用 `groupPolicy: "allowlist"` 搭配 `allowFrom`，只允許特定 sender 觸發回應。`/telegram group add --bot-to-bot` 預設就使用此模式。

這不能單獨防止循環（因為雙方都在對方的 allowFrom 裡），但能防止未授權的 bot 或使用者加入對話。

#### 方法 2：requireMention + mentionPatterns（推薦，有效防循環）

設定 `requireMention: true`，搭配自訂 regex pattern 作為觸發條件。**bot 之間不會自動互相 @mention，因此 `requireMention: true` 本身就能阻止大部分循環。** 加上 mentionPatterns 可以讓人類使用者用名稱觸發特定 bot。

```
/telegram group set <channel-id> requireMention true
```

mentionPatterns 透過 `openclaw.json` 設定（目前無 CLI 指令）：

```json
{
  "messages": {
    "groupChat": {
      "mentionPatterns": ["\\bask\\s+BotA\\b", "\\b@bot_a_username\\b"]
    }
  }
}
```

**mentionPatterns 運作方式：**
- 每個 pattern 是一個 regex string，以 case-insensitive (`i` flag) 編譯
- 訊息文字會先經過正規化（`normalizeMentionText`）再匹配
- 如果任一 pattern match，視同被 mention
- 無效的 regex 會被靜默跳過

**Pattern 優先順序：**
1. Agent-specific：`agents.list[].groupChat.mentionPatterns`
2. Global：`messages.groupChat.mentionPatterns`
3. 自動衍生：從 `agents.defaults.identity.name` 產生 `\b@?<name>\b`

**實用 pattern 範例：**

| Pattern | 匹配 | 說明 |
|---|---|---|
| `\b@?Claude\b` | "Claude", "@Claude", "claude" | 名稱觸發 |
| `\bask\s+BotA\b` | "ask BotA", "Ask BotA" | 動詞 + 名稱 |
| `\b(help\|question)\b` | "help", "question" | 關鍵字觸發 |
| `🤖` | 🤖 | Emoji 觸發 |

**範例情境：** Bot A 設定 pattern `\b@?BotA\b`，Bot B 設定 pattern `\b@?BotB\b`。人類使用者在 Channel 中提到 "BotA" 時只有 Bot A 回應，提到 "BotB" 時只有 Bot B 回應。Bot 互相回覆時不會包含對方名稱，因此不會觸發循環。

#### 方法 3：system prompt 行為約束

透過 per-group `systemPrompt` 指示 bot 何時該回覆、何時不該：

```
/telegram group set <channel-id> systemPrompt "You are Bot A (an AI coding assistant) in a shared channel with Bot B (an AI writing assistant).\n\nRules:\n1. Only respond when the message is directed at you or asks a coding question.\n2. If Bot B is answering a writing question, do NOT respond.\n3. If you are unsure whether to respond, stay silent.\n4. Never respond to a message that is clearly Bot B talking to a human.\n5. Keep responses concise to avoid triggering unnecessary back-and-forth."
```

> system prompt 完全取代預設 prompt，請確保包含足夠的角色設定。

#### 方法 4：historyLimit 限制 context

限制 bot 能看到的歷史訊息量，避免 context window 膨脹和過度回應：

```
/telegram group set <channel-id> historyLimit 3
```

`historyLimit` 限制的是送給 AI model 的歷史 context 條數，不影響 bot 是否接收訊息。

#### 推薦的組合策略

最穩健的做法是 **allowlist + requireMention + mentionPatterns + systemPrompt + historyLimit**：

```
# 在每個 bot 上執行
/telegram group set <channel-id> requireMention true
/telegram group set <channel-id> historyLimit 5
/telegram group set <channel-id> systemPrompt "You are CodeBot, a coding assistant.\nYou share this channel with WriteBot.\nOnly respond to coding questions or when explicitly addressed.\nNever engage in back-and-forth with WriteBot unless a human asks you to."
```

搭配 `openclaw.json` 中的 mentionPatterns：

```json
{
  "messages": {
    "groupChat": {
      "mentionPatterns": ["\\b@?CodeBot\\b", "\\b@?code_bot\\b", "\\bcoding\\b"]
    }
  }
}
```

**防循環效果總結：**

| 方法 | 能否單獨防循環 | 說明 |
|---|---|---|
| `groupPolicy: allowlist` | 否 | 只控制誰能觸發，雙方在對方名單裡仍會循環 |
| `requireMention: true` | **是** | bot 不會自動 @mention 對方，有效阻斷循環 |
| mentionPatterns | **是**（配合 requireMention） | 精確控制觸發條件，只有人類使用者能觸發 |
| systemPrompt | 部分 | 依賴 AI 遵守指令，非硬性阻斷 |
| historyLimit | 否 | 只限制 context 長度，不阻止觸發 |

### 現有的內建防護

OpenClaw 雖然沒有專門的 bot-to-bot 防循環，但有以下內建機制可間接幫助：

| 機制 | 說明 | 對防循環的幫助 |
|---|---|---|
| Update deduplication | 5 分鐘內相同 `update_id` 不重複處理，cache 最多 2000 筆 | 防止同一訊息被處理兩次 |
| Reaction `is_bot` filter | 來自 bot 的 reaction 事件會被忽略 | 防止 reaction 循環 |
| Sent message cache | 追蹤 bot 自己發送的訊息（24 小時 TTL） | 用於判斷 reaction 的目標訊息 |
| grammY apiThrottler | 自動限制 Telegram API 呼叫頻率 | 防止瞬間大量發送 |
| Media group buffering | 多媒體訊息等待 500ms 合併處理 | 減少觸發次數 |
| Text fragment coalescing | 分段文字等待 1500ms 合併 | 減少觸發次數 |

> **注意：** 以上機制都不會阻止 bot 回覆其他 bot 的文字訊息。防循環必須靠 mentionPatterns 或 systemPrompt。

### 進階：同一 OpenClaw 實例跑多個 Bot

OpenClaw 支援 multi-account，可以在同一個實例中同時運行多個 Telegram bot：

```json
{
  "channels": {
    "telegram": {
      "accounts": {
        "bot-a": {
          "botToken": "111111:AAA...",
          "groups": {
            "-100xxxxxxxxxx": {
              "requireMention": true,
              "groupPolicy": "open"
            }
          }
        },
        "bot-b": {
          "botToken": "222222:BBB...",
          "groups": {
            "-100xxxxxxxxxx": {
              "requireMention": true,
              "groupPolicy": "open"
            }
          }
        }
      }
    }
  }
}
```

每個 account 有獨立的 token、config、session state 和 pairing store。但注意：

- 目前 moltbot worker 的 `start-openclaw.sh` 只 patch 單一 bot token（`TELEGRAM_BOT_TOKEN`）
- 若要使用 multi-account，需要擴充 config patch 或手動修改 container 內的 `openclaw.json`
- 兩個 bot 在同一個 OpenClaw 實例中，它們會共享 AI model 和 agent 設定

### 替代方案

如果 Channel 模式不符合需求：

| 方案 | 說明 | 優缺點 |
|---|---|---|
| **Relay User Account** | 建立一個 user account 作為中繼，轉發 bot 訊息到群組 | 需要維護額外帳號；可在群組中使用 |
| **Telegram User Token（Userbot）** | 用 user token 而非 bot token，可看到所有訊息 | 有帳號封鎖風險；不推薦用於正式環境 |
| **外部橋接** | 透過 webhook 或 API 在兩個 OpenClaw 之間直接轉發 | 不經 Telegram，延遲低；需自行開發 |
| **Linked Chat** | Channel 綁定 Discussion Group，bot 訊息會轉發到 group | Telegram 原生功能；但轉發的訊息 `from` 會是 channel 而非 bot |

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

1. 確認使用的是 **Channel**，不是 Group（Group 中 bot 收不到其他 bot 的訊息）
2. 確認所有 bot 都是 Channel 的管理員，且啟用了 **Sign Messages**
3. 確認 Channel 已設定：`/telegram group show <channel-id>` 應顯示 `enabled: true`
4. 確認 `allowFrom` 包含對方 bot 的 ID：`/telegram group show <channel-id>` 查看
5. 如果 `requireMention: true`，確認有設定 mentionPatterns 讓人類能觸發 bot
6. 確認 gateway 已重啟：修改 config 後需執行 `/telegram restart`
7. 確認 BotFather 的 `/setjoingroups` 是 Enable

**快速診斷指令：**
```
/telegram group show <channel-id>    # 查看 channel 設定和 allowFrom
/telegram webhook verify             # 確認 webhook 正常
/telegram status                     # 確認 gateway 運作中
```
