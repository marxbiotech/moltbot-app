# 架構說明：Worker 與 Container 的職責劃分

本文件說明 moltbot-app 中哪些程式碼跑在 **Cloudflare Worker** 上，哪些跑在 **Sandbox Container** 裡，以及各種請求和事件的完整生命週期。

## 目錄

- [總覽](#總覽)
- [檔案對照表](#檔案對照表)
- [Worker 職責](#worker-職責)
- [Container 職責](#container-職責)
- [生命週期](#生命週期)
  - [Container 啟動](#container-啟動)
  - [Container 睡眠與喚醒](#container-睡眠與喚醒)
  - [聊天訊息（WebSocket）](#聊天訊息websocket)
  - [聊天訊息（HTTP 首次載入）](#聊天訊息http-首次載入)
  - [Telegram Webhook 訊息](#telegram-webhook-訊息)
  - [Admin UI 操作](#admin-ui-操作)
  - [R2 備份/還原](#r2-備份還原)
  - [Gateway 重啟](#gateway-重啟)
  - [Plugin 指令執行](#plugin-指令執行)

---

## 總覽

```
┌──────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker (Hono)                     │
│                                                                  │
│  src/index.ts          ← 進入點，middleware chain + catch-all    │
│  src/auth/             ← CF Access JWT 驗證                      │
│  src/routes/           ← 路由處理                                │
│  src/gateway/          ← Container 程序管理（透過 Sandbox API）   │
│  src/client/           ← React Admin UI（build 成靜態檔）        │
│  src/utils/            ← 加密、logging 等工具                    │
│                                                                  │
│  runtime: Cloudflare Workers (V8 isolate, 無 Node.js)           │
│  state:   Durable Object（Sandbox 繫結）                        │
│  storage: R2 Bucket 繫結（用於手動同步觸發）                     │
├──────────────────────────────────────────────────────────────────┤
│                   Sandbox Container (Linux)                       │
│                                                                  │
│  start-openclaw.sh     ← 啟動腳本（R2 還原 → onboard → 設定     │
│                           patch → 背景同步 → 啟動 gateway）      │
│  extensions/           ← Plugin（/claude_auth, /telegram 等）    │
│  skills/               ← Skill（cloudflare_browser）             │
│  Dockerfile            ← 映像定義（Node 22, openclaw, rclone）  │
│                                                                  │
│  runtime: Linux container (Node.js 22, bash)                     │
│  state:   /root/.openclaw/（設定、auth-profiles、對話紀錄）      │
│  storage: 本地磁碟 + rclone 背景同步至 R2                       │
└──────────────────────────────────────────────────────────────────┘
```

**關鍵區別：** Worker 只做路由、認證、代理——所有 AI 對話、設定檔讀寫、CLI 指令都發生在 Container 裡。Worker 透過 `sandbox.containerFetch()`（HTTP）和 `sandbox.wsConnect()`（WebSocket）與 Container 通訊。

---

## 檔案對照表

### 跑在 Worker 上的程式碼

| 路徑 | 用途 |
|------|------|
| `src/index.ts` | Hono app 進入點，middleware chain，catch-all proxy |
| `src/auth/middleware.ts` | CF Access JWT 驗證 middleware |
| `src/auth/jwt.ts` | JWT 解析與 JWKS 驗證（jose 函式庫） |
| `src/routes/public.ts` | 公開路由：健康檢查、靜態資源、Telegram webhook 代理 |
| `src/routes/api.ts` | Admin API：設備管理、R2 同步、gateway 重啟 |
| `src/routes/admin-ui.ts` | Admin UI SPA 服務（靜態 HTML） |
| `src/routes/debug.ts` | Debug 路由：程序列表、log、版本資訊 |
| `src/routes/cdp.ts` | Chrome DevTools Protocol shim |
| `src/gateway/process.ts` | 發現 / 啟動 / 等待 Gateway 程序 |
| `src/gateway/env.ts` | Worker env → Container env 的對應（`buildEnvVars()`） |
| `src/gateway/r2.ts` | 在 Container 內設定 rclone config |
| `src/gateway/sync.ts` | 從 Worker 觸發手動 R2 同步（`sandbox.exec()`） |
| `src/client/` | React Admin UI 原始碼（build 成 `dist/client/`） |
| `src/types.ts` | TypeScript 型別定義（`MoltbotEnv` 等） |
| `src/config.ts` | 常數（port、timeout） |
| `src/utils/crypto.ts` | `timingSafeEqual`（Telegram webhook 驗證用） |
| `src/utils/logging.ts` | URL 參數遮蔽（redact token） |

### 跑在 Container 裡的程式碼

| 路徑 | 用途 |
|------|------|
| `start-openclaw.sh` | 完整啟動腳本（還原 → onboard → patch → sync → gateway） |
| `Dockerfile` | Container 映像定義 |
| `extensions/subscription-auth/` | `/claude_auth`, `/openai_auth`, `/openai_callback` 指令 |
| `extensions/telegram-tools/` | `/telegram` 指令（webhook 管理、DM 配對） |
| `extensions/bedrock-auth/` | `/aws_auth` 指令 |
| `extensions/ssh-tools/` | `/ssh_setup`, `/ssh_check` 指令 |
| `extensions/git-tools/` | `/git_check`, `/git_sync`, `/git_repos` 指令 |
| `extensions/moltbot-utils/` | `/ws_check`, `/sys_info`, `/net_check` 指令 |
| `skills/cloudflare_browser/` | 瀏覽器自動化 skill |

### 跨越邊界的互動

Worker 程式碼**不直接**存取 Container 檔案系統。所有跨邊界操作都透過 Sandbox API：

| Worker 呼叫 | 實際效果 |
|-------------|---------|
| `sandbox.containerFetch(req, port)` | 將 HTTP 請求轉發至 Container 內的指定 port |
| `sandbox.wsConnect(req, port)` | 建立到 Container 指定 port 的 WebSocket 連線 |
| `sandbox.startProcess(cmd, opts)` | 在 Container 內啟動新程序 |
| `sandbox.listProcesses()` | 列出 Container 內所有程序 |
| `sandbox.exec(cmd)` | 在 Container 內執行指令並等待結果 |
| `sandbox.writeFile(path, content)` | 寫入檔案到 Container 檔案系統 |
| `process.waitForPort(port, opts)` | 等待 Container 內某個 port 可用 |
| `process.getLogs()` | 取得 Container 程序的 stdout/stderr |
| `process.kill()` | 終止 Container 程序 |

---

## 生命週期

### Container 啟動

當第一個請求到達（或容器從睡眠中被喚醒）時觸發。

```
使用者請求
    │
    ▼
[Worker] catch-all handler
    │
    ├─ findExistingMoltbotProcess(sandbox)
    │   └─ sandbox.listProcesses() → 搜尋 "start-openclaw.sh" 或 "openclaw-gateway"
    │
    ├─ (找不到程序) → ensureMoltbotGateway(sandbox, env)
    │   │
    │   ├─ ensureRcloneConfig(sandbox, env)          ← Worker 寫 rclone.conf 到 Container
    │   │   └─ sandbox.writeFile("/root/.config/rclone/rclone.conf", ...)
    │   │
    │   ├─ buildEnvVars(env)                         ← Worker env → Container env 對應
    │   │   └─ MOLTBOT_GATEWAY_TOKEN → OPENCLAW_GATEWAY_TOKEN
    │   │   └─ DEV_MODE → OPENCLAW_DEV_MODE
    │   │   └─ AWS_ACCESS_KEY_ID → AWS_BASE_ACCESS_KEY_ID
    │   │   └─ ... 等
    │   │
    │   ├─ sandbox.startProcess("/usr/local/bin/start-openclaw.sh", { env })
    │   │   │
    │   │   │  ┌────────────────────── Container 內 ──────────────────────┐
    │   │   │  │                                                          │
    │   │   └──┤  1. 停止殘留 gateway + 清理 orphan sync 程序            │
    │   │      │  2. 設定 rclone                                          │
    │   │      │  3. 從 R2 還原 config / workspace / AWS session         │
    │   │      │  4. 安裝 skills（從 /opt/openclaw-skills/ 複製）         │
    │   │      │  5. 安裝 plugins（從 /opt/openclaw-extensions/ 複製）    │
    │   │      │  6. openclaw onboard（僅首次，config 不存在時）          │
    │   │      │  7. Config patch（Node.js 腳本 — 每次啟動都執行）        │
    │   │      │     ├─ Gateway port, auth, trusted proxies               │
    │   │      │     ├─ Channel config（Telegram, Discord, Slack）        │
    │   │      │     ├─ AI Gateway / DEFAULT_MODEL 覆寫                   │
    │   │      │     ├─ Model allowlist + fallbacks（多 provider 時）     │
    │   │      │     ├─ Tool policy 清理（確保 exec 可用）                │
    │   │      │     └─ auth-profiles.json patch（key 輪替 + 錯誤清除）  │
    │   │      │  8. auth-profiles.json → auth.json 同步                  │
    │   │      │  9. 啟動背景 R2 sync loop（每 30 秒偵測變更）           │
    │   │      │  10. 寫入 exec-approvals.json                            │
    │   │      │  11. Bedrock model discovery（如有 AWS 設定）            │
    │   │      │  12. Telegram webhook EADDRINUSE patch                   │
    │   │      │  13. `openclaw gateway --port 18789 ...`（用 exec 取代  │
    │   │      │      shell，所以 gateway PID = start-openclaw.sh PID）   │
    │   │      │                                                          │
    │   │      └──────────────────────────────────────────────────────────┘
    │   │
    │   └─ process.waitForPort(18789, { timeout: 180000 })   ← Worker 等 Gateway ready
    │
    └─ 代理請求到 Container:18789
```

**重點：** `start-openclaw.sh` 最後用 `exec` 啟動 gateway，所以該 shell script 的 PID 就是 gateway 的 PID。整個啟動大約 60-120 秒。

### Container 睡眠與喚醒

```
最後一個請求完成
    │
    ├─ (經過 SANDBOX_SLEEP_AFTER 時間，如 10m)
    │
    ▼
[Cloudflare 平台] Container 進入睡眠（暫停，不計費 CPU）
    │
    ～ 等待 ～
    │
新請求到達
    │
    ▼
[Cloudflare 平台] Container 喚醒
    │
    ▼
[Worker] getSandbox() → Durable Object 恢復
    │
    ├─ findExistingMoltbotProcess(sandbox)
    │   └─ 如果 Container 被完全重建：找不到程序 → 完整啟動流程
    │   └─ 如果 Container 只是暫停恢復：找到現有程序 → waitForPort
    │
    ▼
正常請求處理
```

**注意：** 睡眠的 Container 磁碟資料會保留（只是程序暫停），但如果 Container 被平台回收重建，所有資料遺失——這就是為什麼需要 R2 備份。

### 聊天訊息（WebSocket）

這是主要的聊天互動路徑。使用者在 Control UI 打字 → AI 回覆。

```
瀏覽器
    │
    │  wss://worker.workers.dev/ws?token=xxx
    │
    ▼
[Worker] catch-all handler
    │
    ├─ 偵測 Upgrade: websocket header
    │
    ├─ ensureMoltbotGateway(sandbox, env)     ← 確保 Gateway 在跑
    │
    ├─ 注入 gateway token（如果 CF Access 認證通過但 URL 沒帶 token）
    │   └─ CF Access redirect 會吃掉 query params，所以 Worker 幫補
    │
    ├─ sandbox.wsConnect(request, 18789)      ← 建立到 Container 的 WebSocket
    │   │
    │   │  Container:18789 (OpenClaw Gateway)
    │   │  └─ 驗證 token
    │   │  └─ 驗證 device pairing
    │   │  └─ 建立 WebSocket 連線
    │   │
    │   ▼
    ├─ new WebSocketPair()                    ← 建立 client 端 WebSocket pair
    │
    ├─ 設定雙向 relay：
    │   │
    │   │  Client ──(message)──► serverWs ──(relay)──► containerWs ──► OpenClaw Gateway
    │   │                                                                    │
    │   │                                                                    ▼
    │   │                                                              [Container]
    │   │                                                              AI Provider API
    │   │                                                              (Anthropic/OpenAI/
    │   │                                                               Google/Bedrock)
    │   │                                                                    │
    │   │  Client ◄──(message)── serverWs ◄──(relay)── containerWs ◄─── Gateway 回覆
    │   │                │
    │   │                └─ Worker 攔截 error message 做轉換
    │   │                   （如 "gateway token missing" → 友善提示）
    │   │
    │   └─ close / error 事件也雙向 relay
    │      └─ close reason 會被 sanitize（≤ 123 bytes, ByteString only）
    │
    └─ 回傳 Response(101, { webSocket: clientWs })
```

**重點：** Worker 在 WebSocket relay 中會攔截並轉換錯誤訊息，但不修改正常聊天內容。所有 AI 推論都在 Container 內由 OpenClaw Gateway 處理。

### 聊天訊息（HTTP 首次載入）

使用者第一次用瀏覽器打開 Control UI。

```
瀏覽器
    │
    │  GET https://worker.workers.dev/?token=xxx
    │
    ▼
[Worker] middleware chain：
    │
    ├─ logging middleware        ← 記錄請求（redact token）
    ├─ sandbox init middleware   ← getSandbox(env.Sandbox, 'moltbot', options)
    ├─ (不符合 public routes，繼續)
    ├─ env validation middleware ← 檢查必要環境變數
    ├─ CF Access middleware      ← 驗證 JWT（DEV_MODE=true 時跳過）
    │   └─ 未認證：redirect 到 CF Access 登入頁
    │   └─ 認證通過：c.set('accessUser', { email, name })
    │
    ▼
[Worker] catch-all handler
    │
    ├─ findExistingMoltbotProcess(sandbox)
    │
    ├─ (Gateway 沒在跑 + 是瀏覽器請求)
    │   ├─ 背景啟動 gateway：executionCtx.waitUntil(ensureMoltbotGateway(...))
    │   └─ 立即回傳 loading page HTML（含自動重新整理的 JS）
    │
    ├─ (Gateway 在跑)
    │   └─ sandbox.containerFetch(request, 18789)
    │       │
    │       │  Container:18789 (OpenClaw Gateway)
    │       │  └─ 回傳 Control UI HTML/JS
    │       │
    │       ▼
    │   回傳 Response（加上 X-Worker-Debug header）
    │
    ▼
瀏覽器收到 Control UI → 建立 WebSocket（見上方流程）
```

### Telegram Webhook 訊息

Telegram 伺服器推送 update 到 Worker。

```
Telegram API Server
    │
    │  POST /telegram/webhook
    │  Header: X-Telegram-Bot-Api-Secret-Token: <secret>
    │  Body: { update_id, message: { chat: { id }, text, from: { ... } } }
    │
    ▼
[Worker] publicRoutes（不需要 CF Access 認證）
    │
    ├─ 讀取 env.TELEGRAM_WEBHOOK_SECRET
    │
    ├─ timingSafeEqual(provided, secret)      ← 時間安全比對，防 timing attack
    │   └─ 不符：回 401
    │
    ├─ ensureMoltbotGateway(sandbox, env)     ← 確保 Gateway 在跑（也會喚醒睡眠容器）
    │   └─ 失敗：回 502
    │
    ├─ sandbox.containerFetch(                ← 代理到 Container 的 telegram-tools
    │     Request("http://localhost:8787/telegram-webhook", ...),
    │     8787                                ← 注意：是 port 8787，不是 18789
    │   )
    │   │
    │   │  Container:8787 (OpenClaw Telegram Webhook Server)
    │   │  └─ 解析 update
    │   │  └─ 處理訊息（送到 AI agent 或處理 command）
    │   │  └─ 回覆 Telegram（直接呼叫 Telegram API）
    │   │
    │   ▼
    └─ 回傳 Container 的 response 給 Telegram（通常是 200 OK）
```

**重點：**
- Webhook 路由在 CF Access 之外（public），secret token 是唯一認證層
- 代理到 Container 的 port 是 **8787**（telegram-tools extension），不是 gateway 的 18789
- 這個路由能喚醒睡眠中的容器——所以 webhook 模式適合搭配 `SANDBOX_SLEEP_AFTER`

### Admin UI 操作

以「核准設備」為例。

```
Admin 在 /_admin/ 頁面點擊「Approve」
    │
    │  POST /api/admin/devices/:requestId/approve
    │
    ▼
[Worker] middleware chain：
    │
    ├─ CF Access middleware     ← 必須認證
    │
    ▼
[Worker] api.ts → adminApi
    │
    ├─ ensureMoltbotGateway(sandbox, env)
    │
    ├─ sandbox.startProcess(                   ← 在 Container 內跑 CLI
    │     "openclaw devices approve <id> --url ws://localhost:18789 --token <token>"
    │   )
    │   │
    │   │  Container 內
    │   │  └─ openclaw CLI 透過 WebSocket 連到 localhost:18789
    │   │  └─ 送出 approve 指令
    │   │  └─ Gateway 更新 paired devices 列表
    │   │
    │   ▼
    ├─ waitForProcess(proc, 20000)             ← Worker 等 CLI 完成（最多 20 秒）
    │
    ├─ proc.getLogs()                          ← 取得 stdout/stderr
    │
    └─ 回傳 JSON { success, requestId, message }
```

**類似模式的操作：**
- 列出設備：`openclaw devices list --json`
- R2 同步狀態：`sandbox.exec("cat /tmp/.last-sync")`
- 手動備份：`sandbox.exec("rclone sync ...")`（透過 `syncToR2()`）

### R2 備份/還原

```
┌─────────── 還原（Container 啟動時）──────────────────────────────┐
│                                                                   │
│  start-openclaw.sh:                                               │
│                                                                   │
│  1. setup_rclone()                                                │
│     └─ 寫 /root/.config/rclone/rclone.conf（R2 S3 credentials）  │
│                                                                   │
│  2. rclone ls "r2:moltbot-data/openclaw/openclaw.json"            │
│     └─ 有？→ rclone copy r2:moltbot-data/openclaw/ → ~/.openclaw/│
│     └─ 沒有？→ 檢查 legacy clawdbot path → 或從頭開始            │
│                                                                   │
│  3. rclone copy r2:moltbot-data/workspace/ → /root/clawd/         │
│                                                                   │
│  4. 還原 AWS session credentials（如有）                           │
│                                                                   │
│  5. 連結 SSH keys（如有）                                         │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘

┌─────────── 自動備份（Container 運行中）──────────────────────────┐
│                                                                   │
│  start-openclaw.sh 背景 subshell:                                 │
│                                                                   │
│  while true; do                                                   │
│      sleep 30                                                     │
│      find ~/.openclaw -newer $MARKER → 有變更的檔案               │
│      find /root/clawd  -newer $MARKER → 有變更的檔案              │
│      if 有變更:                                                    │
│          rclone sync ~/.openclaw/ → r2:moltbot-data/openclaw/     │
│          rclone sync /root/clawd/ → r2:moltbot-data/workspace/    │
│          rclone copy /root/.aws/session.json → r2:moltbot-data/   │
│          寫入 /tmp/.last-sync timestamp                            │
│  done                                                             │
│                                                                   │
│  排除項目：skills/*, extensions/*, *.lock, *.log, node_modules/   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘

┌─────────── 手動備份（Admin UI 觸發）─────────────────────────────┐
│                                                                   │
│  [Worker] POST /api/admin/storage/sync                            │
│      │                                                            │
│      ├─ syncToR2(sandbox, env)                                    │
│      │   └─ sandbox.exec("rclone sync ~/.openclaw/ r2:...")       │
│      │   └─ sandbox.exec("rclone sync /root/clawd/ r2:...")       │
│      │   └─ sandbox.exec("date -Iseconds > /tmp/.last-sync")     │
│      │                                                            │
│      └─ 回傳 { success, lastSync }                                │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Gateway 重啟

```
Admin 在 /_admin/ 點擊「Restart Gateway」
    │
    │  POST /api/admin/gateway/restart
    │
    ▼
[Worker] api.ts
    │
    ├─ findExistingMoltbotProcess(sandbox)
    │
    ├─ (找到) → process.kill()         ← 終止現有 gateway
    │   └─ 等 2 秒讓程序死掉
    │
    ├─ executionCtx.waitUntil(          ← 背景啟動新 gateway
    │     ensureMoltbotGateway(sandbox, env)
    │   )
    │   └─ start-openclaw.sh 重新執行完整啟動流程
    │   └─ 包含 R2 還原、config patch、auth-profiles patch 等
    │
    └─ 立即回傳 { success, message }    ← 不等 gateway ready
```

**重點：** Gateway 重啟會重新執行整個 `start-openclaw.sh`——這表示環境變數的變更（如 API key 輪替）會在重啟後生效，因為 config patch 每次啟動都執行。

### Plugin 指令執行

Plugin 指令（如 `/claude_auth`, `/telegram webhook on`）直接在 Container 內執行，**不經過 Worker**。

```
使用者在聊天中輸入 /claude_auth sk-ant-oat01-...
    │
    │  (透過 WebSocket relay)
    │
    ▼
[Container] OpenClaw Gateway
    │
    ├─ 辨識為 registered command（registerCommand()）
    │
    ├─ 直接呼叫 handler，不經過 AI agent（LLM-free）
    │   │
    │   │  extensions/subscription-auth/index.ts
    │   │  └─ 驗證 token 格式
    │   │  └─ 寫入 /root/.openclaw/agents/main/agent/auth-profiles.json
    │   │  └─ 更新 /root/.openclaw/openclaw.json（model allowlist）
    │   │
    │   ▼
    ├─ 回傳結果文字給使用者
    │
    │  (透過 WebSocket relay)
    │
    ▼
使用者看到 "[PASS] Claude subscription authenticated!"
```

**注意：** Worker 完全不知道這些指令的存在——它只是忠實地 relay WebSocket 訊息。Plugin 程式碼（`extensions/`）打包在 Docker image 裡，每次 Container 啟動從 `/opt/openclaw-extensions/` 安裝到 `~/.openclaw/extensions/`。

---

## 環境變數的旅程

一個環境變數從設定到被 Container 使用的完整路徑：

```
wrangler secret put ANTHROPIC_API_KEY          ← 使用者設定
    │
    ▼
Cloudflare Workers Runtime                      ← 注入到 Worker env
    │
    ▼
[Worker] src/gateway/env.ts: buildEnvVars()     ← 對應名稱
    │  env.MOLTBOT_GATEWAY_TOKEN → OPENCLAW_GATEWAY_TOKEN
    │  env.AWS_ACCESS_KEY_ID → AWS_BASE_ACCESS_KEY_ID
    │  （大部分直接透傳）
    │
    ▼
sandbox.startProcess(cmd, { env: envVars })     ← 傳入 Container
    │
    ▼
[Container] start-openclaw.sh                   ← Shell 環境變數
    │
    ├─ rclone 使用 R2_ACCESS_KEY_ID 等
    ├─ openclaw onboard 使用 ANTHROPIC_API_KEY 等
    ├─ Node.js config patch 使用 process.env.*
    ├─ AWS credential helper 使用 AWS_BASE_ACCESS_KEY_ID 等
    │
    ▼
[Container] openclaw gateway                    ← Gateway 程序繼承環境變數
    │
    ├─ OpenClaw runtime 使用 GOOGLE_API_KEY 等（SDK 慣例）
    └─ extensions 透過 process.env.* 存取
```

---

## 兩個 Port 的區別

| Port | 監聽者 | 用途 |
|------|--------|------|
| **18789** | OpenClaw Gateway | 主要入口：Control UI、WebSocket 聊天、REST API |
| **8787** | OpenClaw Telegram Webhook Server | 僅接收 Telegram webhook（由 `telegram-tools` extension 啟動） |

Worker 的 catch-all proxy 只代理到 18789。Telegram webhook 路由明確代理到 8787。兩者都透過 `sandbox.containerFetch()` 通訊。
