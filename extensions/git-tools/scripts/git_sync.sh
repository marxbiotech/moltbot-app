#!/bin/bash
# git_sync — Pull all workspace repos or clone a new one (LLM-free execution)
# Usage: git_sync          — pull all repos
#        git_sync <url>    — clone or pull specific repo

PASS=0; WARN=0; FAIL=0
WORKSPACE="/root/.openclaw/workspace"

pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
warn() { echo "[WARN] $1"; WARN=$((WARN + 1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL + 1)); }
info() { echo "[INFO] $1"; }

# Set global pull.rebase
git config --global pull.rebase true 2>/dev/null
pass "git config: pull.rebase = true"

if [ -n "$1" ]; then
    # Mode 2: Clone/pull a specific repo
    URL="$1"

    # Validate URL format
    if ! echo "$URL" | grep -qE '^(git@|https://|ssh://)'; then
        fail "Invalid URL format: $URL (must start with git@, https://, or ssh://)"
        echo ""
        echo "--- Git Sync: $PASS PASS / $WARN WARN / $FAIL FAIL ---"
        exit 0
    fi

    # Extract repo name
    REPO_NAME=$(basename "$URL" .git)

    # Check both flat and repos/ layouts for existing repos
    if [ -d "$WORKSPACE/$REPO_NAME/.git" ]; then
        TARGET="$WORKSPACE/$REPO_NAME"
    elif [ -d "$WORKSPACE/repos/$REPO_NAME/.git" ]; then
        TARGET="$WORKSPACE/repos/$REPO_NAME"
    else
        # New clone — use flat layout (backward compatible)
        TARGET="$WORKSPACE/$REPO_NAME"
    fi

    if [ -d "$TARGET/.git" ]; then
        # Repo exists — pull instead
        info "Repo already exists: $TARGET"
        DIRTY=$(git -C "$TARGET" status --porcelain 2>/dev/null)
        if [ -n "$DIRTY" ]; then
            warn "$REPO_NAME: has uncommitted changes, skipping pull"
        else
            PULL_OUT=$(git -C "$TARGET" pull --rebase 2>&1)
            if [ $? -eq 0 ]; then
                if echo "$PULL_OUT" | grep -q "Already up to date"; then
                    pass "$REPO_NAME: already up to date"
                else
                    pass "$REPO_NAME: pulled ($(echo "$PULL_OUT" | tail -1))"
                fi
            else
                fail "$REPO_NAME: pull failed — $(echo "$PULL_OUT" | head -1)"
            fi
        fi
    else
        # Clone
        mkdir -p "$(dirname "$TARGET")" 2>/dev/null
        info "Cloning $URL -> $TARGET"
        CLONE_OUT=$(git clone "$URL" "$TARGET" 2>&1)
        if [ $? -eq 0 ]; then
            pass "$REPO_NAME: cloned successfully"
        else
            fail "$REPO_NAME: clone failed — $(echo "$CLONE_OUT" | head -1)"
        fi
    fi
else
    # Mode 1: Pull all repos
    info "Scanning workspace for git repos..."

    REPOS=$(find "$WORKSPACE" -maxdepth 4 -name .git -type d 2>/dev/null | while read -r gitdir; do dirname "$gitdir"; done)

    if [ -z "$REPOS" ]; then
        warn "No git repos found in $WORKSPACE"
        info "To clone a repo: /git_sync <git-url>"
    else
        COUNT=$(echo "$REPOS" | wc -l | tr -d ' ')
        info "Found $COUNT repo(s)"

        echo "$REPOS" | while read -r REPO; do
            NAME=$(basename "$REPO")
            DIRTY=$(git -C "$REPO" status --porcelain 2>/dev/null)
            if [ -n "$DIRTY" ]; then
                echo "[WARN] $NAME: has uncommitted changes, skipping pull"
            else
                PULL_OUT=$(git -C "$REPO" pull --rebase 2>&1)
                if [ $? -eq 0 ]; then
                    if echo "$PULL_OUT" | grep -q "Already up to date"; then
                        echo "[PASS] $NAME: already up to date"
                    else
                        echo "[PASS] $NAME: pulled ($(echo "$PULL_OUT" | tail -1))"
                    fi
                else
                    echo "[FAIL] $NAME: pull failed — $(echo "$PULL_OUT" | head -1)"
                fi
            fi
        done
    fi
fi

echo ""
echo "--- Git Sync: $PASS PASS / $WARN WARN / $FAIL FAIL ---"
