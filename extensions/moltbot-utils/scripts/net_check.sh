#!/bin/bash
# net_check — Network connectivity check (LLM-free execution)
# Usage: net_check (no arguments)

PASS=0; WARN=0

pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
warn() { echo "[WARN] $1"; WARN=$((WARN + 1)); }

check_port() {
    local HOST="$1" PORT="$2" LABEL="$3"
    if timeout 3 bash -c "echo > /dev/tcp/$HOST/$PORT" 2>/dev/null; then
        pass "$LABEL ($HOST:$PORT): reachable"
    else
        warn "$LABEL ($HOST:$PORT): unreachable"
    fi
}

check_port "github.com" 22 "GitHub SSH"
check_port "api.anthropic.com" 443 "Anthropic API"
check_port "api.openai.com" 443 "OpenAI API"
check_port "generativelanguage.googleapis.com" 443 "Google AI API"

echo ""
echo "--- Network Check: $PASS PASS / $WARN WARN ---"
