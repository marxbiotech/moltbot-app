#!/bin/bash
# git_check — Pre-push safety check (LLM-free execution)
# Usage: git_check [repo_path]

PASS=0; WARN=0; FAIL=0
REPO_PATH="${1:-.}"

pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
warn() { echo "[WARN] $1"; WARN=$((WARN + 1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL + 1)); }
info() { echo "[INFO] $1"; }

cd "$REPO_PATH" 2>/dev/null || { fail "Cannot access: $REPO_PATH"; echo ""; echo "--- Git Check: $PASS PASS / $WARN WARN / $FAIL FAIL ---"; exit 0; }

# 1. Verify git repository
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
    fail "Not a git repository: $(pwd)"
    echo ""
    echo "--- Git Check: $PASS PASS / $WARN WARN / $FAIL FAIL ---"
    exit 0
fi

# 2. Workspace root protection (per Isolation-Backup.md)
if [ "$REPO_ROOT" = "/root/.openclaw/workspace" ] || [ "$REPO_ROOT" = "/root/.openclaw/workspace/repos" ]; then
    fail "Git repo at workspace root is forbidden! Repos must be in subdirectories."
    echo ""
    echo "--- Git Check: $PASS PASS / $WARN WARN / $FAIL FAIL ---"
    echo "PUSH NOT RECOMMENDED — resolve FAIL items first"
    exit 0
fi
pass "Repo location: $REPO_ROOT"

# 3. Sensitive files detection
SENSITIVE_PATTERNS=".ssh/|id_ed25519|id_rsa|id_ecdsa|\.env$|\.env\.|credentials|\.secret|SOUL\.md|IDENTITY\.md|\.pem$|\.key$"
SENSITIVE_FILES=""

# Check staged files
STAGED=$(git diff --cached --name-only 2>/dev/null)
if [ -n "$STAGED" ]; then
    MATCHES=$(echo "$STAGED" | grep -E "$SENSITIVE_PATTERNS" 2>/dev/null)
    [ -n "$MATCHES" ] && SENSITIVE_FILES="$SENSITIVE_FILES$MATCHES"$'\n'
fi

# Check unstaged files
UNSTAGED=$(git diff --name-only 2>/dev/null)
if [ -n "$UNSTAGED" ]; then
    MATCHES=$(echo "$UNSTAGED" | grep -E "$SENSITIVE_PATTERNS" 2>/dev/null)
    [ -n "$MATCHES" ] && SENSITIVE_FILES="$SENSITIVE_FILES$MATCHES"$'\n'
fi

# Check untracked files
UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null)
if [ -n "$UNTRACKED" ]; then
    MATCHES=$(echo "$UNTRACKED" | grep -E "$SENSITIVE_PATTERNS" 2>/dev/null)
    [ -n "$MATCHES" ] && SENSITIVE_FILES="$SENSITIVE_FILES$MATCHES"$'\n'
fi

SENSITIVE_FILES=$(echo "$SENSITIVE_FILES" | sort -u | sed '/^$/d')
if [ -n "$SENSITIVE_FILES" ]; then
    fail "Sensitive files detected:"
    echo "$SENSITIVE_FILES" | while read -r f; do
        echo "       $f"
    done
else
    pass "No sensitive files in changes"
fi

# 4. Diff size
STAT_LINE=$(git diff --cached --stat 2>/dev/null | tail -1)
if [ -n "$STAT_LINE" ] && echo "$STAT_LINE" | grep -q "changed"; then
    FILES_CHANGED=$(echo "$STAT_LINE" | grep -o '[0-9]* file' | grep -o '[0-9]*')
    INSERTIONS=$(echo "$STAT_LINE" | grep -o '[0-9]* insertion' | grep -o '[0-9]*')
    DELETIONS=$(echo "$STAT_LINE" | grep -o '[0-9]* deletion' | grep -o '[0-9]*')
    INSERTIONS=${INSERTIONS:-0}
    DELETIONS=${DELETIONS:-0}
    TOTAL=$((INSERTIONS + DELETIONS))
    if [ "$TOTAL" -gt 1000 ]; then
        warn "Diff size: ${FILES_CHANGED} files, +${INSERTIONS}/-${DELETIONS} lines (large diff)"
    else
        pass "Diff size: ${FILES_CHANGED} files, +${INSERTIONS}/-${DELETIONS} lines"
    fi
else
    info "Diff size: no staged changes"
fi

# 5. Branch name
BRANCH=$(git branch --show-current 2>/dev/null)
if [ -n "$BRANCH" ]; then
    info "Current branch: $BRANCH"
else
    warn "Detached HEAD state"
fi

# 6. Unpushed commits
UNPUSHED=$(git log @{u}..HEAD --oneline 2>/dev/null)
if [ -n "$UNPUSHED" ]; then
    COUNT=$(echo "$UNPUSHED" | wc -l | tr -d ' ')
    info "Unpushed commits ($COUNT):"
    echo "$UNPUSHED" | head -5 | while read -r line; do
        echo "       $line"
    done
    [ "$COUNT" -gt 5 ] && echo "       ... and $((COUNT - 5)) more"
elif git rev-parse --verify @{u} > /dev/null 2>&1; then
    info "Unpushed commits: 0 (up to date with remote)"
else
    info "Unpushed commits: no upstream tracking branch"
fi

# 7. Divergence check
BRANCH_AB=$(git status -b --porcelain=v2 2>/dev/null | grep "^# branch.ab")
if [ -n "$BRANCH_AB" ]; then
    AHEAD=$(echo "$BRANCH_AB" | awk '{print $3}' | tr -d '+')
    BEHIND=$(echo "$BRANCH_AB" | awk '{print $4}' | tr -d '-')
    if [ "$BEHIND" -gt 0 ] 2>/dev/null; then
        warn "Branch has diverged: +${AHEAD} ahead, -${BEHIND} behind"
    else
        pass "Branch not diverged from remote"
    fi
fi

echo ""
echo "--- Git Check: $PASS PASS / $WARN WARN / $FAIL FAIL ---"
[ "$FAIL" -gt 0 ] && echo "PUSH NOT RECOMMENDED — resolve FAIL items first"
exit 0
