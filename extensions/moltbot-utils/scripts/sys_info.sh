#!/bin/bash
# sys_info — System information (LLM-free execution)
# Usage: sys_info (no arguments)

WARN=0

info() { echo "[INFO] $1"; }
warn() { echo "[WARN] $1"; WARN=$((WARN + 1)); }

info "Hostname: $(hostname 2>/dev/null || echo unknown)"
info "Kernel: $(uname -r 2>/dev/null || echo unknown)"

UPTIME_SINCE=$(uptime -s 2>/dev/null)
if [ -n "$UPTIME_SINCE" ]; then
    info "Up since: $UPTIME_SINCE"
else
    info "Uptime: $(uptime 2>/dev/null | sed 's/.*up /up /' | sed 's/,.*//')"
fi

MEM=$(free -h 2>/dev/null | grep Mem)
if [ -n "$MEM" ]; then
    MEM_TOTAL=$(echo "$MEM" | awk '{print $2}')
    MEM_USED=$(echo "$MEM" | awk '{print $3}')
    MEM_AVAIL=$(echo "$MEM" | awk '{print $7}')
    info "Memory: ${MEM_USED} used / ${MEM_TOTAL} total (${MEM_AVAIL} available)"
fi

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

echo ""
echo "--- System Info ---"
[ "$WARN" -gt 0 ] && echo "$WARN warning(s)"
