#!/bin/bash
# git_repos — Scan workspace git repos (LLM-free execution)
# Usage: git_repos (no arguments)

PASS=0; WARN=0; FAIL=0
REPOS_DIR="/root/.openclaw/workspace/repos"

pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
warn() { echo "[WARN] $1"; WARN=$((WARN + 1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL + 1)); }
info() { echo "[INFO] $1"; }

info "Scanning $REPOS_DIR for git repos..."

REPOS=$(find "$REPOS_DIR" -maxdepth 3 -name .git -type d 2>/dev/null | while read -r d; do dirname "$d"; done)

if [ -z "$REPOS" ]; then
    warn "No git repos found in $REPOS_DIR"
    info "To clone a repo: /git_sync <git-url>"
else
    COUNT=$(echo "$REPOS" | wc -l | tr -d ' ')
    info "Found $COUNT repo(s)"
    echo ""

    echo "$REPOS" | while read -r REPO; do
        NAME=$(basename "$REPO")
        BRANCH=$(git -C "$REPO" branch --show-current 2>/dev/null)
        [ -z "$BRANCH" ] && BRANCH="detached"
        LAST_COMMIT=$(git -C "$REPO" log -1 --format='%h %s' 2>/dev/null | head -c 60)
        DIRTY=$(git -C "$REPO" status --porcelain 2>/dev/null)

        if [ -n "$DIRTY" ]; then
            DIRTY_COUNT=$(echo "$DIRTY" | wc -l | tr -d ' ')
            echo "[WARN] $NAME: branch=$BRANCH (${DIRTY_COUNT} uncommitted changes) — $LAST_COMMIT"
        else
            echo "[PASS] $NAME: branch=$BRANCH (clean) — $LAST_COMMIT"
        fi
    done
fi

echo ""
echo "--- Git Repos: $PASS PASS / $WARN WARN / $FAIL FAIL ---"
