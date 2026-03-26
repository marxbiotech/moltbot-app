#!/bin/bash
# ssh_check — SSH health diagnostic (LLM-free execution)
# Usage: ssh_check (no arguments)

PASS=0; WARN=0; FAIL=0
SSH_DIR="/root/.openclaw/workspace/.ssh"

pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
warn() { echo "[WARN] $1"; WARN=$((WARN + 1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL + 1)); }
info() { echo "[INFO] $1"; }

# Early exit if workspace SSH dir doesn't exist at all
if [ ! -d "$SSH_DIR" ]; then
    fail "SSH directory missing: $SSH_DIR"
    echo ""
    echo "Run /ssh_setup to initialize SSH keys."
    echo ""
    echo "--- SSH Check: $PASS PASS / $WARN WARN / $FAIL FAIL ---"
    exit 0
fi

# 1. Symlink integrity
if [ -L /root/.ssh ]; then
    TARGET=$(readlink /root/.ssh)
    if [ "$TARGET" = "$SSH_DIR" ]; then
        pass "Symlink: /root/.ssh -> $SSH_DIR"
    else
        warn "Symlink: /root/.ssh -> $TARGET (expected $SSH_DIR)"
    fi
elif [ -d /root/.ssh ]; then
    fail "Symlink: /root/.ssh is a real directory (keys will be lost on restart)"
elif [ ! -e /root/.ssh ]; then
    fail "Symlink: /root/.ssh does not exist"
fi

# 2. Directory permissions
if [ -d "$SSH_DIR" ]; then
    PERMS=$(stat -c '%a' "$SSH_DIR" 2>/dev/null)
    if [ "$PERMS" = "700" ]; then
        pass "Directory permissions: 700"
    else
        fail "Directory permissions: $PERMS (should be 700)"
    fi
else
    fail "Directory missing: $SSH_DIR (run /ssh_setup)"
fi

# 3. Private key permissions
if [ -f "$SSH_DIR/id_ed25519" ]; then
    PERMS=$(stat -c '%a' "$SSH_DIR/id_ed25519" 2>/dev/null)
    if [ "$PERMS" = "600" ]; then
        pass "Private key permissions: 600"
    else
        fail "Private key permissions: $PERMS (should be 600)"
    fi
else
    fail "Private key: missing ($SSH_DIR/id_ed25519)"
fi

# 4. Public key permissions
if [ -f "$SSH_DIR/id_ed25519.pub" ]; then
    PERMS=$(stat -c '%a' "$SSH_DIR/id_ed25519.pub" 2>/dev/null)
    if [ "$PERMS" = "644" ]; then
        pass "Public key permissions: 644"
    else
        warn "Public key permissions: $PERMS (recommended 644)"
    fi
else
    fail "Public key: missing ($SSH_DIR/id_ed25519.pub)"
fi

# 5. known_hosts
if [ -f "$SSH_DIR/known_hosts" ]; then
    if grep -q github.com "$SSH_DIR/known_hosts" 2>/dev/null; then
        pass "known_hosts: contains github.com"
    else
        warn "known_hosts: exists but missing github.com entry"
    fi
else
    warn "known_hosts: missing (will get interactive prompt on first connect)"
fi

# 6. Key fingerprint
if [ -f "$SSH_DIR/id_ed25519.pub" ]; then
    FP=$(ssh-keygen -lf "$SSH_DIR/id_ed25519.pub" 2>/dev/null)
    if [ -n "$FP" ]; then
        info "Key fingerprint: $FP"
    fi
fi

# 7. GitHub connectivity
GH_OUTPUT=$(ssh -T git@github.com -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes 2>&1 || true)
if echo "$GH_OUTPUT" | grep -q "successfully authenticated"; then
    GH_USER=$(echo "$GH_OUTPUT" | grep -o "Hi [^!]*" | sed 's/Hi //')
    pass "GitHub SSH: authenticated as $GH_USER"
elif echo "$GH_OUTPUT" | grep -q "Permission denied"; then
    fail "GitHub SSH: Permission denied (key not added to GitHub?)"
else
    warn "GitHub SSH: $(echo "$GH_OUTPUT" | head -1 | cut -c1-100)"
fi

echo ""
echo "--- SSH Check: $PASS PASS / $WARN WARN / $FAIL FAIL ---"
