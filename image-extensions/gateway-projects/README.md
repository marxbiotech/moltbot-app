# Gateway Projects

Gateway Projects 讓 agent 在 OpenClaw gateway 本機，以既有 GitHub 身分操作專案，並為不同開發任務建立可持續使用的 Git worktree。

**它是 OpenClaw tool plugin，底層沿用隨 image 安裝的 CLI。** `openclaw.plugin.json` 宣告工具，`index.mjs` 透過 `api.registerTool()` 註冊 optional tool factory。環境層將此目錄加入 `plugins.load.paths`，只對指定專案 agent 額外開放工具。它沒有 `registerCommand()`，不提供使用者可直接呼叫的 slash command。

```text
指定頻道 → OpenClaw agent tool → 非同步 CLI 子程序 → Git／GitHub
```

CLI 負責 Git／GitHub 與 worktree；plugin 負責工具 schema、可信執行上下文、結構化結果、取消與輸出限制。CLI 可以獨立測試，並不妨礙它同時透過 OpenClaw tool 提供給 agent。

## 解決什麼問題

Gateway 上的 agent 若只具備 shell，還需要解決三件事才能直接參與 GitHub 開發：

1. image 重建後仍有一致的 GitHub CLI 與認證方式。
2. 多個頻道或 thread 同時修改同一個 repo 時，不會在同一份 checkout 互相切換分支、混入未提交檔案。
3. Pod 重啟或對話續作後，仍能找回原本任務的分支、工作目錄和 PR 關聯。

這組工具提供上述基礎能力。頻道要不要使用某個專案，由環境設定決定，不由 CLI 猜測訊息內容。

## 分工與原理

| 元件 | 責任 |
| --- | --- |
| 本 repo 的 `Dockerfile` | 安裝固定版本、分架構 SHA256 驗證的官方 `gh`；建立 CLI symlink；執行 Linux 測試 |
| `index.mjs`／`openclaw.plugin.json` | 註冊兩個 agent tools，以可信 agent、workspace、Slack account／channel 與 session 決定專案 |
| `process.mjs` | 非同步啟動 CLI、傳遞取消訊號、限制執行時間與輸出量、遮蔽現有 PAT |
| `project.mjs` → `gateway-project` | 讀取專案設定、建立／重用任務 worktree，或帶入認證啟動 `gh` |
| `credential.mjs` → `git-credential-gateway-project` | 實作 Git credential protocol，為符合設定的 GitHub HTTPS 路徑提供現有 PAT |
| `config.mjs` | 載入 JSON 設定，檢查選定專案的基本欄位 |
| 環境 repo `moltbot-env` | 維護 image tag/digest、SOPS Secret、專案宣告、明確的頻道綁定，以及 agent workspace／技能掛載 |
| PVC | 保存 repo、worktree 與任務狀態；不靠容器可寫層保存工作 |

### `prepare` 的流程

```text
project ID + TASK_KEY
  → 載入設定
  → SHA256(TASK_KEY) 的前 24 個 hex 字元作為任務識別
  → 取得該 workspace 的 flock
  → 首次使用時 clone 至暫存目錄，再 rename 成正式 repo
  → 檢查 origin，設定 repo-local Git 認證與 commit 作者
  → 已有 worktree：檢查目錄及分支，沿用現有內容
  → 新 worktree：fetch 後由設定的 baseBranch 建立任務分支
  → 首次寫入任務狀態，輸出 JSON
```

來源 repo 使用 `clone --no-checkout`，工作應在回傳的 worktree 進行。分支名稱為 `merlin/<task-hash>`；目前前綴固定，並不是由 agent 名稱推導。

`flock` 最多等待 60 秒取得鎖，涵蓋 `prepare` 內的共用 Git 操作。它不限制之後的編輯、build、push 或任意 shell 指令，也不防止兩個執行者同時使用相同 TASK_KEY 編輯同一個 worktree。

重用已存在的 worktree 時，不執行 fetch、pull、reset 或自動清理，因此離線也能續作並保留未提交內容。建立新 worktree 仍會 fetch，即使同名任務分支已存在。

### 認證

- 憑證來自執行環境既有的 `AGENT_GITHUB_PAT`。image 與專案 JSON 不包含 token。
- `prepare` 設定 repo-local credential helper 和 `credential.useHttpPath=true`。Clone 階段以一次性的 Git `-c` 設定使用同一個 helper。
- Helper 僅在 `get` 操作、`https`、精確的 `github.com` host，以及設定中宣告的 repo 路徑吻合時，將 PAT 透過 credential protocol stdout 交給 Git。`store`／`erase` 不保存任何內容。
- `gateway-project gh` 在子程序設定 `GH_TOKEN`、`GH_HOST=github.com`、`GH_REPO` 和 `GH_PROMPT_DISABLED=1`，接著原樣轉交 `gh` 參數及輸入輸出。它不執行 `gh auth login`。
- Commit 作者由 `authorName`／`authorEmail` 決定；GitHub 的 push、PR、Issue 操作身分則由 PAT 決定，兩者不是同一種設定。

## Agent 工具與使用者命令

- `gateway_project_prepare({ task: "issue-42" })`：plugin 從可信上下文選擇專案，將 session key 與 task 組合後交給 CLI，回傳 worktree／branch 等結構化結果。Agent 不傳 project ID、channel ID 或 session key。
- `gateway_project_github({ args: ["issue", "view", "42"] })`：以 argv array 呼叫 CLI，回傳 `exitCode`、`signal`、`stdout`、`stderr`。非零退出或 wrapper 失敗會標示 `isError`。

Tool factory 只在非 sandbox 的指定 Slack 上下文提供工具：agent 必須是 `project-<id>`、workspace 必須符合宣告、account／channel 必須匹配，且有 session key。每次執行前會重讀 registry；撤回指定後，舊 tool instance 也會拒絕執行。沒有使用者 slash command，但使用者仍可自然語言請 agent 完成已授權的工作。

配套 `gateway_project` skill 由環境 repo 掛載到專案 workspace，設定 `user-invocable: false`；不在 plugin manifest 宣告全域 skills，以免其他 agent 自動載入。`user-invocable` 控制的是 skill 的 slash 入口，不是禁止 agent 呼叫 tool 的開關。

CLI 子程序透過 argv 執行，不經 shell interpolation。預設 120 秒逾時、stdout＋stderr 上限 1 MiB；取消、逾時或超量時終止 CLI process group，避免其 Git 子程序繼續持有鎖。上限／取消錯誤不回傳部分輸出；這些限制僅適用 plugin 呼叫，直接使用 CLI 不受此 wrapper 管理。Wrapper 遮蔽輸出中與現有 PAT 完全相同的文字，不是任意秘密內容的通用過濾器。

GitHub tool 的 cwd 是專案 workspace（尚未建立時使用暫存目錄），不是 task worktree。PR 操作要明確提供 `--head`／`--base`，檔案參數使用絕對路徑。

## 設定

預設讀取 `/etc/moltbot/gateway-projects/projects.json`。測試或不同部署可用 `GATEWAY_PROJECT_CONFIG` 指定另一個 JSON 檔案。

```json
{
  "example-project": {
    "repository": "example-org/example-repo",
    "slackAccountId": "default",
    "slackChannelIds": ["C0123456789"],
    "workspace": "/home/node/.openclaw/project-workspaces/example-project",
    "baseBranch": "main",
    "authorName": "developer-bot",
    "authorEmail": "developer-bot@example.invalid"
  }
}
```

`baseBranch` 未提供時使用 `main`。Project ID 必須符合 `^[a-z][a-z0-9-]{0,47}$`；workspace 必須是絕對路徑並由部署方配置在 PVC。設定目前只做基本欄位檢查，不是完整的 JSON schema 驗證；應由受信任的 GitOps 設定產生。

每個專案應使用不同 workspace；CLI 不會檢查兩個專案是否設定了相同目錄。GitHub 存取權必須事先授予 PAT 對應帳號，工具本身不建立或擴大權限。

## CLI 使用方式

Agent 平常使用上述兩個 tool；以下命令保留給本機操作與排錯。

```bash
# TASK_KEY 使用穩定的「頻道 ID:thread root timestamp」。
# 同一任務續作沿用此值；同一 thread 中另開任務時加上明確 suffix。
gateway-project prepare example-project 'C0123456789:1780000000.000001'

# 將 cwd 設為上一行 JSON 回傳的 worktree，之後照常使用 Git。
git status
git add path/to/changed-file
git commit -m 'Describe the change'
git push -u origin HEAD

# GitHub 查詢不需要先建立 worktree。
gateway-project gh example-project issue view 42

# PR 建立從該任務 worktree 執行，明確給定 head 與 base。
gateway-project gh example-project pr create \
  --head 'merlin/<task-hash>' --base main \
  --title 'Describe the change' --body-file /tmp/pr-body.md
```

`<task-hash>` 是說明用 placeholder，執行前替換成 `prepare` 回傳的分支。上述寫入指令須在使用者授權的任務範圍內使用；安裝工具本身不代表已授權發文、merge 或部署。

Workspace 內容如下：

```text
<workspace>/
  .git-operations.lock
  repos/<project-id>/
  worktrees/<task-hash>/
  project-state/<task-hash>.json
```

狀態 JSON 記錄 `task`、`project`、`repository`、`branch`、`worktree`。呼叫端可在檔案中加入 PR URL；後續 `prepare` 不覆寫既有檔案。不過 stdout 每次只回傳上述基本欄位，額外欄位需自行讀取狀態檔。工具不會自動查詢 PR 或同步其狀態。

## 注意事項與操作界線

- **不是安全沙箱。** Plugin 會驗證其工具呼叫的上下文；Agent／workspace 分離由環境層提供。直接呼叫 CLI 可繞過 plugin，CLI 不驗證 Slack channel ID，也不限制 shell 可讀取哪些檔案。同一 container user 仍可存取共同檔案系統及其環境憑證。
- **`GH_REPO` 是預設目標，不是 allowlist。** `gh` 參數原樣轉交，`--repo` 或 `gh api` 可以指定其他目標。Helper 的路徑比對只控制這個 Git credential helper 何時回傳 token；最終權限界線是 GitHub 帳號／PAT 的權限。
- 不手動執行 credential helper 來查看其 stdout，不使用 `gh auth token` 輸出憑證，不把 token 放在 remote URL、commit、PR、聊天或 debug log。父程序本來就持有 PAT；wrapper 並未將它從其他子程序的環境移除。
- 同一 TASK_KEY 對應同一 worktree。它不提供同任務的多寫入者協調，呼叫端需要避免同時修改同一任務。
- 只在 Linux image 使用；依賴 Node.js、Git、`flock`，以及 `gh`。新 clone／fetch 與 GitHub API 呼叫需要網路；工具不安裝專案本身的 build dependencies。
- 憑證若由 Kubernetes env 注入，Secret 輪替後需要正常 rollout 才會載入新值。CLI 不管理 token 更新、撤銷或 GitHub App installation token。
- 既有 origin 或 worktree／分支不符會停止。不要直接刪除目錄重試；先檢查 `git status`、remote、worktree 註冊及未提交／未推送內容。
- Git 失敗目前只回報簡化的 exit 訊息，不轉印 subprocess stderr，避免 transport error 洩露認證資料。診斷時需由操作者檢查權限、連線、磁碟及 repo 狀態；缺少 CLI 或鎖逾時也會以非零狀態退出。
- 沒有自動 worktree 清理、磁碟配額、備份或任務排程。移除 worktree 前確認 dirty files、未推送 commits 和 PR 狀態。程序被強制終止可能留下 clone 暫存目錄；不要把暫存目錄當作正式來源 repo。

## 它不是什麼

它是 OpenClaw tool plugin，但不是 MCP server、GitHub App、GitHub 權限管理器、Slack router、coding agent、遠端 ACP executor 或部署平台。它也不實作 code review、PR 自動合併、分支保護、工作排程或 repo 內容同步。

工具負責讓已獲授權的 gateway 程序使用 Git／GitHub 並維持任務工作目錄；「誰可以在哪個頻道做什麼」仍由使用者授權、OpenClaw 路由與 GitHub 權限共同決定。

## 驗證與發布

在 Linux、已安裝 Git 與 flock 的環境執行：

```bash
node --test image-extensions/gateway-projects/*.test.mjs
```

測試使用暫存的本機 Git remote 與假 token，涵蓋 credential 目的地比對、gh 子程序參數／環境、不同任務並行建置、離線 dirty worktree 續作與 PR 額外欄位保留。這些測試不是對真實 GitHub push／PR／Issue 的端到端驗證。

Plugin 測試另外涵蓋未授權上下文不提供工具、撤回宣告後拒絕呼叫、argv 傳遞、錯誤狀態、PAT 遮蔽、取消、逾時及輸出上限。

Docker build 會執行這些測試、gateway-projects host-loader／skill discovery smoke test 與既有 remote-acpx smoke test。發布沿用本 repo 的 image workflow；環境 repo 再固定 immutable tag 與 digest。更新 README 本身不需要改動已部署的執行行為。
