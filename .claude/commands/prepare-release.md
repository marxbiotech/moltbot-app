# Prepare Release

自動化版本發佈的完整流程，整合 CHANGELOG 生成、Release Notes 生成、Git 操作和 GitHub Release 建立。

## 版本格式

版本號基於 OpenClaw 版本延伸：`v<openclaw-version>-<patch>`

- `v2026.2.26-0` — 基於 OpenClaw v2026.2.26 的第一個版本
- `v2026.2.26-1` — 同一 OpenClaw 版本的第二個版本（Worker 側修改）
- `v2026.3.1-0` — 升級到 OpenClaw v2026.3.1 後的第一個版本

## 使用方式

```bash
/prepare-release
```

無需參數，自動偵測當前版本並引導完整流程。

## 執行流程

### Step 1: 偵測版本並詢問新版本號

1. 執行 `git describe --tags --abbrev=0` 取得當前最新 tag
2. **偵測當前 Dockerfile 中的 OpenClaw 版本：**
   ```bash
   openclaw_version=$(grep -oP 'openclaw@\K[0-9.]+' Dockerfile)
   ```
3. **若無任何 tag（首次發佈）：**
   - 使用 Dockerfile 中的 OpenClaw 版本建議 `v${openclaw_version}-0`
   - commit range 改用 `git log --oneline`（全部 commits）
4. **若有 tag，使用 `scripts/parse-version.sh` 計算建議版本：**
   ```bash
   current_tag=$(git describe --tags --abbrev=0)
   bump_version=$(./scripts/parse-version.sh "$current_tag" bump)
   ```
5. **比較 Dockerfile 中的 OpenClaw 版本與 tag 中的基底版本：**
   - 若 OpenClaw 版本已更新（與 tag 基底不同），額外建議 rebase 版本：
     ```bash
     rebase_version=$(./scripts/parse-version.sh "$current_tag" rebase "$openclaw_version")
     ```
6. 使用 AskUserQuestion 提供選項：

   **若 OpenClaw 版本未變：**
   - **Option 1 (Recommended):** `${bump_version}` (bump) - Worker 側修改（bug 修復、功能新增、配置調整）

   **若 OpenClaw 版本已更新：**
   - **Option 1 (Recommended):** `${rebase_version}` (rebase) - 升級到 OpenClaw ${openclaw_version}
   - **Option 2:** `${bump_version}` (bump) - 不更新基底版本，僅 Worker 側修改

7. 允許使用者選擇 "Other" 輸入自訂版本號

**實作細節：**
- 使用 `scripts/parse-version.sh` 腳本確保版本解析的確定性
- 腳本支援 `v2026.2.26-0` 和 `2026.2.26-0` 兩種格式
- 輸出永遠包含 `v` 前綴

### Step 2: 生成 CHANGELOG（人工審核點 #1）

1. **收集變更資訊：**

   ```bash
   # 若有前一個 tag
   git log <current-tag>..HEAD --oneline
   gh pr list --state merged --json number,title,body,labels,mergedAt
   git diff <current-tag>..HEAD --stat

   # 若無 tag（首次發佈）
   git log --oneline
   gh pr list --state merged --json number,title,body,labels,mergedAt
   ```

2. **分類變更項目到對應區塊：**
   - `feat:`, `add`, `新增`, `implement` → **Added**
   - `change`, `update`, `refactor`, `調整`, `重構` → **Changed**
   - `deprecate` → **Deprecated**
   - `remove`, `delete`, `移除` → **Removed**
   - `fix`, `bug`, `修復`, `修正` → **Fixed**
   - `security`, `vuln` → **Security**

3. **檢查 Breaking Changes：**
   - 檢查 PR body 中的 `BREAKING` 標記
   - API response 格式變更
   - 預設行為變更
   - 必填參數新增
   - 環境變數名稱/行為變更

4. **若為 rebase 版本（OpenClaw 升級），額外標註：**
   - OpenClaw 版本從 X 升級到 Y
   - Dockerfile 中的變更

5. **更新 CHANGELOG.md：**
   - 在 `## [Unreleased]` 之後插入新版本條目
   - 格式：`## [<new-version>] - YYYY-MM-DD`
   - 遵循 [Keep a Changelog](https://keepachangelog.com/) 格式

6. **暫停並使用 AskUserQuestion：**

   提供選項：
   - **Option 1 (Recommended):** Continue - CHANGELOG 內容正確無誤
   - **Option 2:** Let me edit - 需要手動調整

   在 question 中顯示審核清單：
   ```
   ✅ CHANGELOG.md 已更新

   請審核以下內容：
   - 檢查分類是否正確 (Added/Changed/Fixed 等)
   - 檢查描述是否清楚易懂
   - 檢查是否有遺漏的重要變更
   - 檢查 Breaking Changes 標記是否正確

   確認無誤後請選擇 "Continue"
   ```

7. **若使用者選擇 "Let me edit"：**
   - 顯示訊息：「請手動編輯 CHANGELOG.md，完成後可重新執行 /prepare-release」
   - 中止流程，return

### Step 3: 生成 Release Notes（人工審核點 #2）

1. **收集完整的變更資訊：**

   ```bash
   # 若有前一個 tag
   git log <current-tag>..HEAD --oneline
   git diff <current-tag>..HEAD --stat
   gh pr list --state merged --json number,title,mergedAt,body,labels

   # 若無 tag（首次發佈）
   git log --oneline
   gh pr list --state merged --json number,title,mergedAt,body,labels
   ```

2. **生成詳細的 Release Notes 包含以下章節：**
   - **Summary** - 版本主要功能、Breaking Changes 警告、OpenClaw 基底版本
   - **部署須知** - Migration、環境變數、相依服務
   - **新功能** - 依 PR 說明業務場景和主要變更
   - **重構與改進** - 架構重構、程式碼改進
   - **基礎設施變更** - CI/CD、環境配置、Container/Dockerfile 變更
   - **變更檔案統計** - 檔案數量、新增/刪除行數
   - **測試覆蓋** - 新增的測試範圍
   - **相關 PR 列表** - 表格列出 PR 編號、標題、日期
   - **升級步驟** - 部署前準備、配置、流程、驗證（`npm run deploy`）
   - **Breaking Changes 詳細** - 影響範圍、前後對比、更新指南

3. **將 Release Notes 寫入檔案：**
   ```
   .plan/release-notes-<new-version>.md
   ```

4. **暫停並使用 AskUserQuestion：**

   提供選項：
   - **Option 1 (Recommended):** Continue - Release Notes 內容正確無誤
   - **Option 2:** Let me edit - 需要手動調整

   在 question 中顯示審核清單：
   ```
   ✅ Release Notes 已生成: .plan/release-notes-<new-version>.md

   請審核以下內容：
   - 檢查技術細節是否準確
   - 檢查部署須知是否完整
   - 檢查升級步驟是否清楚
   - 檢查 Breaking Changes 說明是否充分

   確認無誤後請選擇 "Continue"
   ```

5. **若使用者選擇 "Let me edit"：**
   - 顯示訊息：「請手動編輯 .plan/release-notes-<new-version>.md，完成後可重新執行 /prepare-release」
   - 中止流程，return

### Step 4: Commit CHANGELOG（自動化）

使用 Bash tool 執行（**使用 `&&` 確保原子性**）：

```bash
git add CHANGELOG.md && \
git commit -m "docs: update CHANGELOG for <new-version>" && \
git push origin main
```

**錯誤處理：**

若 `git push` 失敗：

1. 顯示完整錯誤訊息
2. 提供回滾指令：
   ```bash
   git reset --soft HEAD~1
   ```
3. 提示使用者：
   ```
   ❌ Git push 失敗

   可能原因：
   - 遠端有新的 commit（需要先 pull）
   - 網路連線問題
   - 沒有 push 權限

   回滾指令：
   git reset --soft HEAD~1

   請解決問題後重新執行 /prepare-release
   ```
4. 中止流程，return

### Step 5: 建立 GitHub Release（自動化）

使用 Bash tool 執行 GitHub CLI：

```bash
gh release create <new-version> \
  --title "<new-version>" \
  --notes-file .plan/release-notes-<new-version>.md \
  --target main
```

**這個指令會自動完成：**
- ✅ 建立 Git tag `<new-version>`
- ✅ 推送 tag 到 GitHub
- ✅ 建立 GitHub Release
- ✅ 使用本地檔案內容作為 Release Notes

**錯誤處理：**

若 `gh release create` 失敗，檢查常見問題並提示：

```
❌ GitHub Release 建立失敗

常見問題檢查：

1. GitHub CLI 未登入
   執行：gh auth status
   修正：gh auth login

2. Tag 已存在
   檢查：git tag -l <new-version>
   刪除：git tag -d <new-version> && git push origin --delete <new-version>

3. 無 repo 權限
   檢查：gh auth status
   確認 token scopes 包含 'repo'

4. Release Notes 檔案不存在
   檢查：ls -la .plan/release-notes-<new-version>.md

請解決問題後重新執行 /prepare-release
```

中止流程，return

### Step 6: 完成確認

顯示成功訊息（使用 GitHub repo 資訊動態生成 URL）：

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉 Release <new-version> 發佈完成！
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ CHANGELOG 已更新並推送
✅ Git tag 已建立: <new-version>
✅ GitHub Release 已發佈

🔗 連結：
- Release: https://github.com/<org>/<repo>/releases/tag/<new-version>
- Tag: https://github.com/<org>/<repo>/tree/<new-version>

📋 下一步建議：
- 執行 npm run deploy 部署至 Cloudflare
- 監控 Worker 與 Container 狀態
```

**取得 GitHub repo 資訊：**
```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

## 斷點續傳

若流程中斷，可偵測已完成的步驟並跳過：

1. **檢查 CHANGELOG.md 是否已包含新版本條目：**
   ```bash
   grep -q "## \[<new-version>\]" CHANGELOG.md
   ```
   若存在，詢問是否跳過 Step 2

2. **檢查 Release Notes 是否已生成：**
   ```bash
   test -f .plan/release-notes-<new-version>.md
   ```
   若存在，詢問是否跳過 Step 3

3. **檢查 CHANGELOG commit 是否已推送：**
   ```bash
   git log origin/main --oneline | grep "docs: update CHANGELOG for <new-version>"
   ```
   若存在，跳過 Step 4

4. **檢查 GitHub Release 是否已建立：**
   ```bash
   gh release view <new-version> 2>/dev/null
   ```
   若存在，跳過 Step 5，直接顯示完成訊息

## 前置條件檢查

在開始流程前，檢查必要條件：

```bash
# 1. 檢查是否在 git repo
git rev-parse --git-dir >/dev/null 2>&1

# 2. 檢查是否在 main branch
current_branch=$(git branch --show-current)
if [ "$current_branch" != "main" ]; then
  echo "⚠️  警告：當前不在 main branch（在 $current_branch）"
  echo "建議切換到 main branch 後再執行"
fi

# 3. 檢查是否有未提交的變更
if ! git diff-index --quiet HEAD --; then
  echo "⚠️  警告：有未提交的變更"
  echo "建議先提交或 stash 變更後再執行"
fi

# 4. 檢查 GitHub CLI 是否登入
if ! gh auth status >/dev/null 2>&1; then
  echo "❌ GitHub CLI 未登入"
  echo "請執行：gh auth login"
  exit 1
fi

# 5. 檢查遠端是否同步
git fetch origin
local_commit=$(git rev-parse main)
remote_commit=$(git rev-parse origin/main)
if [ "$local_commit" != "$remote_commit" ]; then
  echo "⚠️  警告：本地與遠端不同步"
  echo "建議執行：git pull origin main"
fi
```

若檢查失敗，提示使用者並詢問是否繼續。

## 注意事項

- ⚠️ 確保已安裝並登入 GitHub CLI: `gh auth login`
- ⚠️ 確保在 main branch 且已同步遠端
- ⚠️ 若審核階段發現錯誤，選擇 "Let me edit" 中止流程
- ⚠️ 手動修改完成後，可重新執行 `/prepare-release`（支援斷點續傳）
- ⚠️ 此 command 會自動推送到 GitHub，請確保變更已通過本地測試
