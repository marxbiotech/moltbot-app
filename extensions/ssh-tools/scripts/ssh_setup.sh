#!/bin/bash
# ssh_setup — Initialize SSH keys for GitHub access (LLM-free execution)
# Usage: ssh_setup (no arguments, idempotent)

PASS=0; WARN=0; FAIL=0
SSH_DIR="/root/.openclaw/workspace/.ssh"
KEY_COMMENT="${MOLTBOT_EMAIL:-openclaw-agent@github}"

pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
warn() { echo "[WARN] $1"; WARN=$((WARN + 1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL + 1)); }

# 1. Create workspace SSH directory
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"
pass "Created directory: $SSH_DIR (700)"

# 2. Generate SSH key (skip if exists)
if [ -f "$SSH_DIR/id_ed25519" ]; then
    pass "SSH key already exists, skipping generation"
else
    if ssh-keygen -t ed25519 -C "$KEY_COMMENT" -f "$SSH_DIR/id_ed25519" -N "" > /dev/null 2>&1; then
        pass "Generated new ed25519 key pair"
    else
        fail "Failed to generate SSH key"
    fi
fi

# 3. Set permissions
if [ -f "$SSH_DIR/id_ed25519" ]; then
    chmod 600 "$SSH_DIR/id_ed25519"
fi
if [ -f "$SSH_DIR/id_ed25519.pub" ]; then
    chmod 644 "$SSH_DIR/id_ed25519.pub"
fi
pass "Permissions set: private=600, public=644"

# 4. Create/fix symlink
if [ -L /root/.ssh ]; then
    TARGET=$(readlink /root/.ssh)
    if [ "$TARGET" = "$SSH_DIR" ]; then
        pass "Symlink already correct: /root/.ssh -> $SSH_DIR"
    else
        rm -f /root/.ssh
        ln -s "$SSH_DIR" /root/.ssh
        pass "Symlink fixed: /root/.ssh -> $SSH_DIR (was $TARGET)"
    fi
elif [ -d /root/.ssh ]; then
    rm -rf /root/.ssh
    ln -s "$SSH_DIR" /root/.ssh
    pass "Replaced real directory with symlink: /root/.ssh -> $SSH_DIR"
else
    ln -s "$SSH_DIR" /root/.ssh
    pass "Created symlink: /root/.ssh -> $SSH_DIR"
fi

# 5. Configure known_hosts
if [ -f "$SSH_DIR/known_hosts" ] && grep -q github.com "$SSH_DIR/known_hosts" 2>/dev/null; then
    pass "known_hosts: github.com already present"
else
    if ssh-keyscan github.com >> "$SSH_DIR/known_hosts" 2>/dev/null; then
        pass "known_hosts: added github.com"
    else
        warn "known_hosts: failed to scan github.com (network issue?)"
    fi
fi

# 6. Display public key
echo ""
if [ -f "$SSH_DIR/id_ed25519.pub" ]; then
    echo "=== PUBLIC KEY (add to GitHub: https://github.com/settings/ssh/new) ==="
    cat "$SSH_DIR/id_ed25519.pub"
    echo "=== END PUBLIC KEY ==="
else
    warn "Public key file not found"
fi

# 7. Test GitHub connectivity
echo ""
GH_OUTPUT=$(ssh -T git@github.com -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes 2>&1 || true)
if echo "$GH_OUTPUT" | grep -q "successfully authenticated"; then
    GH_USER=$(echo "$GH_OUTPUT" | grep -o "Hi [^!]*" | sed 's/Hi //')
    pass "GitHub SSH: authenticated as $GH_USER"
elif echo "$GH_OUTPUT" | grep -q "Permission denied"; then
    warn "GitHub SSH: key not yet added to GitHub"
else
    warn "GitHub SSH: $(echo "$GH_OUTPUT" | head -1 | cut -c1-100)"
fi

echo ""
echo "--- SSH Setup: $PASS PASS / $WARN WARN / $FAIL FAIL ---"

# Reminder if new key was generated
if [ ! -f "$SSH_DIR/id_ed25519.pub.old" ] 2>/dev/null; then
    if echo "$GH_OUTPUT" | grep -q "Permission denied"; then
        echo ""
        echo "New key generated! Add the public key above to GitHub, then test with: ssh -T git@github.com"
    fi
fi
