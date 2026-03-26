#!/bin/bash
# ws_check — Workspace health diagnostic (LLM-free execution)
# Usage: ws_check (no arguments)

PASS=0; WARN=0; FAIL=0

pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
warn() { echo "[WARN] $1"; WARN=$((WARN + 1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL + 1)); }
info() { echo "[INFO] $1"; }

# 1. Directory structure
for DIR in /root/.openclaw /root/clawd /root/.openclaw/skills /root/.openclaw/extensions /root/.openclaw/workspace /root/.openclaw/workspace/.ssh; do
    if [ -d "$DIR" ] || [ -L "$DIR" ]; then
        pass "Directory: $DIR"
    else
        warn "Directory missing: $DIR"
    fi
done

# 2. openclaw.json validity
CONFIG="/root/.openclaw/openclaw.json"
if [ -f "$CONFIG" ]; then
    BYTES=$(wc -c < "$CONFIG" 2>/dev/null | tr -d ' ')
    if node -e "
var c=JSON.parse(require('fs').readFileSync('$CONFIG','utf8'));
var gw=c.gateway||{};var ch=c.channels||{};var ag=c.agents||{};
var port=gw.port||'missing';
var channels=Object.keys(ch).filter(function(k){return ch[k].enabled});
var model=((ag.defaults||{}).model||{}).primary||'not set';
console.log('PORT='+port);
console.log('CHANNELS='+channels.join('|'));
console.log('MODEL='+model);
" > /tmp/.ws_check_config 2>/dev/null; then
        pass "openclaw.json: valid JSON ($BYTES bytes)"
        PORT=$(grep '^PORT=' /tmp/.ws_check_config | cut -d= -f2)
        CHANNELS=$(grep '^CHANNELS=' /tmp/.ws_check_config | cut -d= -f2 | tr '|' ', ')
        MODEL=$(grep '^MODEL=' /tmp/.ws_check_config | cut -d= -f2)
        [ "$PORT" != "missing" ] && pass "Gateway config: port $PORT" || warn "Gateway config: port not set"
        [ -n "$CHANNELS" ] && pass "Channels: $CHANNELS" || warn "Channels: none enabled"
        [ "$MODEL" != "not set" ] && info "Model: $MODEL" || info "Model: not set"
        rm -f /tmp/.ws_check_config
    else
        fail "openclaw.json: invalid JSON ($BYTES bytes)"
    fi
else
    fail "openclaw.json: missing"
fi

# 3. R2 sync status
SYNC_FILE="/tmp/.last-sync"
if [ -f "$SYNC_FILE" ]; then
    SYNC_TIME=$(cat "$SYNC_FILE" 2>/dev/null)
    if [ -n "$SYNC_TIME" ]; then
        SYNC_EPOCH=$(date -d "$SYNC_TIME" +%s 2>/dev/null)
        NOW_EPOCH=$(date +%s)
        if [ -n "$SYNC_EPOCH" ]; then
            AGE_MIN=$(( (NOW_EPOCH - SYNC_EPOCH) / 60 ))
            if [ "$AGE_MIN" -le 30 ]; then
                pass "R2 sync: ${AGE_MIN}m ago"
            else
                warn "R2 sync: ${AGE_MIN}m ago (stale?)"
            fi
        else
            warn "R2 sync: timestamp unparseable ($SYNC_TIME)"
        fi
    else
        warn "R2 sync: file empty"
    fi
else
    warn "R2 sync: /tmp/.last-sync missing (sync may not be running)"
fi

# R2 sync log tail
if [ -f /tmp/r2-sync.log ]; then
    LAST_LOG=$(tail -1 /tmp/r2-sync.log 2>/dev/null)
    [ -n "$LAST_LOG" ] && info "Last sync log: $LAST_LOG"
fi

# 4. Disk usage
DISK_LINE=$(df -h / 2>/dev/null | tail -1)
if [ -n "$DISK_LINE" ]; then
    DISK_PCT=$(echo "$DISK_LINE" | awk '{print $5}' | tr -d '%')
    DISK_USED=$(echo "$DISK_LINE" | awk '{print $3}')
    DISK_AVAIL=$(echo "$DISK_LINE" | awk '{print $4}')
    if [ -n "$DISK_PCT" ] && [ "$DISK_PCT" -gt 90 ] 2>/dev/null; then
        warn "Disk: ${DISK_USED} used, ${DISK_AVAIL} available (${DISK_PCT}%)"
    else
        info "Disk: ${DISK_USED} used, ${DISK_AVAIL} available (${DISK_PCT}%)"
    fi
fi

# 5. API key presence
KEYS=""
[ -n "$ANTHROPIC_API_KEY" ] && KEYS="${KEYS}Anthropic, "
[ -n "$OPENAI_API_KEY" ] && KEYS="${KEYS}OpenAI, "
[ -n "$GOOGLE_API_KEY" ] && KEYS="${KEYS}Google, "
[ -n "$CLOUDFLARE_AI_GATEWAY_API_KEY" ] && KEYS="${KEYS}CF AI Gateway, "
if [ -n "$KEYS" ]; then
    KEYS=$(echo "$KEYS" | sed 's/, $//')
    pass "API keys: $KEYS"
else
    fail "API keys: none found"
fi

# 6. Gateway status
if pgrep -f "openclaw gateway" > /dev/null 2>&1; then
    pass "Gateway process: running"
else
    warn "Gateway process: not running"
fi

# 7. Installed skills & plugins
SKILL_NAMES=$(ls -d /root/.openclaw/skills/*/ 2>/dev/null | xargs -I{} basename {} 2>/dev/null | tr '\n' ', ' | sed 's/, $//')
SKILL_COUNT=$(ls -d /root/.openclaw/skills/*/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$SKILL_COUNT" -gt 0 ]; then
    pass "Installed skills ($SKILL_COUNT): $SKILL_NAMES"
else
    info "Installed skills: none"
fi

PLUGIN_NAMES=$(ls -d /root/.openclaw/extensions/*/ 2>/dev/null | xargs -I{} basename {} 2>/dev/null | tr '\n' ', ' | sed 's/, $//')
PLUGIN_COUNT=$(ls -d /root/.openclaw/extensions/*/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$PLUGIN_COUNT" -gt 0 ]; then
    pass "Installed plugins ($PLUGIN_COUNT): $PLUGIN_NAMES"
else
    warn "Installed plugins: none"
fi

echo ""
echo "--- Workspace Check: $PASS PASS / $WARN WARN / $FAIL FAIL ---"
