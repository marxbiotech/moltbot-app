#!/bin/bash
# Startup script for OpenClaw in Cloudflare Sandbox
# This script:
# 1. Restores config/workspace/skills from R2 via rclone (if configured)
# 2. Runs openclaw onboard --non-interactive to configure from env vars
# 3. Patches config for features onboard doesn't cover (channels, gateway auth)
# 4. Starts a background sync loop (rclone, watches for file changes)
# 5. Starts the gateway

set -e

CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
WORKSPACE_DIR="/root/clawd"
SKILLS_DIR="/root/clawd/skills"
RCLONE_CONF="/root/.config/rclone/rclone.conf"
LAST_SYNC_FILE="/tmp/.last-sync"

# Stop any leftover gateway from a previous invocation.
# When this script uses `exec openclaw gateway`, the sandbox loses track of the
# process (marks start-openclaw.sh as "killed"), but the gateway keeps running.
# On the next invocation the sandbox thinks no gateway exists and re-runs us,
# so we must explicitly stop the old gateway to free port 18789 and the lock file.
openclaw gateway stop 2>/dev/null || true
rm -f /tmp/openclaw-gateway.lock "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

echo "Config directory: $CONFIG_DIR"

mkdir -p "$CONFIG_DIR"

# ============================================================
# RCLONE SETUP
# ============================================================

r2_configured() {
    [ -n "$R2_ACCESS_KEY_ID" ] && [ -n "$R2_SECRET_ACCESS_KEY" ] && [ -n "$CF_ACCOUNT_ID" ]
}

R2_BUCKET="${R2_BUCKET_NAME:-moltbot-data}"

setup_rclone() {
    mkdir -p "$(dirname "$RCLONE_CONF")"
    cat > "$RCLONE_CONF" << EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = $R2_ACCESS_KEY_ID
secret_access_key = $R2_SECRET_ACCESS_KEY
endpoint = https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
EOF
    touch /tmp/.rclone-configured
    echo "Rclone configured for bucket: $R2_BUCKET"
}

RCLONE_FLAGS="--transfers=16 --fast-list --s3-no-check-bucket"

# ============================================================
# RESTORE FROM R2
# ============================================================

if r2_configured; then
    setup_rclone

    echo "Checking R2 for existing backup..."
    # Check if R2 has an openclaw config backup
    if rclone ls "r2:${R2_BUCKET}/openclaw/openclaw.json" $RCLONE_FLAGS 2>/dev/null | grep -q openclaw.json; then
        echo "Restoring config from R2..."
        rclone copy "r2:${R2_BUCKET}/openclaw/" "$CONFIG_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: config restore failed with exit code $?"
        echo "Config restored"
    elif rclone ls "r2:${R2_BUCKET}/clawdbot/clawdbot.json" $RCLONE_FLAGS 2>/dev/null | grep -q clawdbot.json; then
        echo "Restoring from legacy R2 backup..."
        rclone copy "r2:${R2_BUCKET}/clawdbot/" "$CONFIG_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: legacy config restore failed with exit code $?"
        if [ -f "$CONFIG_DIR/clawdbot.json" ] && [ ! -f "$CONFIG_FILE" ]; then
            mv "$CONFIG_DIR/clawdbot.json" "$CONFIG_FILE"
        fi
        echo "Legacy config restored and migrated"
    else
        echo "No backup found in R2, starting fresh"
    fi

    # Restore workspace
    REMOTE_WS_COUNT=$(rclone ls "r2:${R2_BUCKET}/workspace/" $RCLONE_FLAGS 2>/dev/null | wc -l)
    if [ "$REMOTE_WS_COUNT" -gt 0 ]; then
        echo "Restoring workspace from R2 ($REMOTE_WS_COUNT files)..."
        mkdir -p "$WORKSPACE_DIR"
        rclone copy "r2:${R2_BUCKET}/workspace/" "$WORKSPACE_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: workspace restore failed with exit code $?"
        echo "Workspace restored"
    fi

    # Symlink SSH keys from workspace (persisted via workspace R2 sync)
    # See: docs/onboarding/SSH-Keys.md
    WORKSPACE_SSH="$WORKSPACE_DIR/.ssh"
    if [ -d "$WORKSPACE_SSH" ]; then
        echo "Linking SSH keys from workspace..."
        rm -rf /root/.ssh
        ln -s "$WORKSPACE_SSH" /root/.ssh
        chmod 700 "$WORKSPACE_SSH"
        chmod 600 "$WORKSPACE_SSH"/* 2>/dev/null || true
        chmod 644 "$WORKSPACE_SSH"/*.pub 2>/dev/null || true
        echo "SSH keys linked"
    fi
else
    echo "R2 not configured, starting fresh"
fi

# Clean up ALL known skill names from managed skills dir (~/.openclaw/skills/)
# to prevent OpenClaw from seeing duplicates (e.g. sk_doctor vs sk_doctor2).
# Both hyphen and underscore variants — SKILLS_DIR is canonical via R2 restore.
for name in aws-auth ssh-check ssh-setup sk-doctor sk-git-check sk-git-sync sk-workspace-check cloudflare-browser \
            aws_auth ssh_check ssh_setup sk_doctor git_check git_sync ws_check cloudflare_browser; do
    rm -rf "$CONFIG_DIR/skills/$name"
done

# Install skill scripts to PATH so command-dispatch: tool works
# This runs every startup to pick up R2-restored or newly deployed scripts
for skill_dir in "$SKILLS_DIR"/*/scripts; do
    if [ -d "$skill_dir" ]; then
        skill_name=$(basename "$(dirname "$skill_dir")")
        if [ -f "$skill_dir/run.sh" ]; then
            cp "$skill_dir/run.sh" "/usr/local/bin/$skill_name"
            chmod +x "/usr/local/bin/$skill_name"
        fi
    fi
done
echo "Skill scripts installed to PATH"

# ============================================================
# ONBOARD (only if no config exists yet)
# ============================================================
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, running openclaw onboard..."

    AUTH_ARGS=""
    if [ -n "$CLOUDFLARE_AI_GATEWAY_API_KEY" ] && [ -n "$CF_AI_GATEWAY_ACCOUNT_ID" ] && [ -n "$CF_AI_GATEWAY_GATEWAY_ID" ]; then
        AUTH_ARGS="--auth-choice cloudflare-ai-gateway-api-key \
            --cloudflare-ai-gateway-account-id $CF_AI_GATEWAY_ACCOUNT_ID \
            --cloudflare-ai-gateway-gateway-id $CF_AI_GATEWAY_GATEWAY_ID \
            --cloudflare-ai-gateway-api-key $CLOUDFLARE_AI_GATEWAY_API_KEY"
    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        AUTH_ARGS="--auth-choice apiKey --anthropic-api-key $ANTHROPIC_API_KEY"
    elif [ -n "$OPENAI_API_KEY" ]; then
        AUTH_ARGS="--auth-choice openai-api-key --openai-api-key $OPENAI_API_KEY"
    fi

    openclaw onboard --non-interactive --accept-risk \
        --mode local \
        $AUTH_ARGS \
        --gateway-port 18789 \
        --gateway-bind lan \
        --skip-channels \
        --skip-skills \
        --skip-health

    echo "Onboard completed"
else
    echo "Using existing config"
fi

# ============================================================
# PATCH CONFIG (channels, gateway auth, trusted proxies)
# ============================================================
# openclaw onboard handles provider/model config, but we need to patch in:
# - Channel config (Telegram, Discord, Slack)
# - Gateway token auth
# - Trusted proxies for sandbox networking
# - Base URL override for legacy AI Gateway path
node << 'EOFPATCH'
const fs = require('fs');

const configPath = '/root/.openclaw/openclaw.json';
console.log('Patching config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

config.gateway = config.gateway || {};
config.channels = config.channels || {};
config.commands = {
  ...config.commands,
  restart: true,
};

// Ensure exec tool is allowed (required for command-dispatch: tool skills)
config.tools = config.tools || {};
config.tools.allow = config.tools.allow || [];
if (!config.tools.allow.includes('exec')) {
    config.tools.allow.push('exec');
}

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
}

if (process.env.OPENCLAW_DEV_MODE === 'true') {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowInsecureAuth = true;
}

// Legacy AI Gateway base URL override:
// ANTHROPIC_BASE_URL is picked up natively by the Anthropic SDK,
// so we don't need to patch the provider config. Writing a provider
// entry without a models array breaks OpenClaw's config validation.

// AI Gateway model override (CF_AI_GATEWAY_MODEL=provider/model-id)
// Adds a provider entry for any AI Gateway provider and sets it as default model.
// Examples:
//   workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast
//   openai/gpt-4o
//   anthropic/claude-sonnet-4-5
if (process.env.CF_AI_GATEWAY_MODEL) {
    const raw = process.env.CF_AI_GATEWAY_MODEL;
    const slashIdx = raw.indexOf('/');
    const gwProvider = raw.substring(0, slashIdx);
    const modelId = raw.substring(slashIdx + 1);

    const accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID;
    const gatewayId = process.env.CF_AI_GATEWAY_GATEWAY_ID;
    const apiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;

    let baseUrl;
    if (accountId && gatewayId) {
        baseUrl = 'https://gateway.ai.cloudflare.com/v1/' + accountId + '/' + gatewayId + '/' + gwProvider;
        if (gwProvider === 'workers-ai') baseUrl += '/v1';
    } else if (gwProvider === 'workers-ai' && process.env.CF_ACCOUNT_ID) {
        baseUrl = 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CF_ACCOUNT_ID + '/ai/v1';
    }

    if (baseUrl && apiKey) {
        const api = gwProvider === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
        const providerName = 'cf-ai-gw-' + gwProvider;

        config.models = config.models || {};
        config.models.providers = config.models.providers || {};
        config.models.providers[providerName] = {
            baseUrl: baseUrl,
            apiKey: apiKey,
            api: api,
            models: [{ id: modelId, name: modelId, contextWindow: 131072, maxTokens: 8192 }],
        };
        config.agents = config.agents || {};
        config.agents.defaults = config.agents.defaults || {};
        config.agents.defaults.model = { primary: providerName + '/' + modelId };
        console.log('AI Gateway model override: provider=' + providerName + ' model=' + modelId + ' via ' + baseUrl);
    } else {
        console.warn('CF_AI_GATEWAY_MODEL set but missing required config (account ID, gateway ID, or API key)');
    }
}

// Default model override (for direct API key users, not using AI Gateway)
// e.g. DEFAULT_MODEL=google/gemini-3-pro-preview
if (process.env.DEFAULT_MODEL) {
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    config.agents.defaults.model = { primary: process.env.DEFAULT_MODEL };
    console.log('Default model override:', process.env.DEFAULT_MODEL);
}

// Model allowlist + fallbacks for /model command
// When multiple providers are configured, populate the model catalog (allowlist)
// so users can switch between them at runtime via /model, and add fallback models.
// Format: agents.defaults.models is an object keyed by model ID, not an array.
{
    const available = [];
    if (process.env.GOOGLE_API_KEY) {
        available.push(
            { id: 'google/gemini-3-flash-preview', alias: 'Gemini 3 Flash' },
            { id: 'google/gemini-3-pro-preview', alias: 'Gemini 3 Pro' },
            { id: 'google/gemini-2.5-flash', alias: 'Gemini 2.5 Flash' },
            { id: 'google/gemini-2.5-pro', alias: 'Gemini 2.5 Pro' },
            { id: 'google/gemini-2.5-flash-lite', alias: 'Gemini 2.5 Flash Lite' }
        );
    }
    if (process.env.ANTHROPIC_API_KEY) {
        available.push(
            { id: 'anthropic/claude-haiku-4-5', alias: 'Claude Haiku' },
            { id: 'anthropic/claude-sonnet-4-5', alias: 'Claude Sonnet' },
            { id: 'anthropic/claude-opus-4-6', alias: 'Claude Opus' }
        );
    }
    if (process.env.OPENAI_API_KEY) {
        available.push({ id: 'openai/gpt-4o', alias: 'GPT-4o' });
    }

    if (available.length >= 2) {
        config.agents = config.agents || {};
        config.agents.defaults = config.agents.defaults || {};

        // Build model catalog (object keyed by model ID) — acts as allowlist for /model
        var catalog = {};
        available.forEach(function(m) {
            catalog[m.id] = { alias: m.alias };
        });
        config.agents.defaults.models = catalog;
        console.log('Model allowlist:', available.map(function(m) { return m.alias; }).join(', '));

        // Build fallbacks (all available models except the current primary)
        var primary = (config.agents.defaults.model && config.agents.defaults.model.primary) || '';
        var fallbacks = available
            .filter(function(m) { return m.id !== primary; })
            .map(function(m) { return m.id; });

        if (fallbacks.length > 0) {
            config.agents.defaults.model = config.agents.defaults.model || {};
            config.agents.defaults.model.fallbacks = fallbacks;
            console.log('Model fallbacks:', fallbacks.join(', '));
        }
    }
}

// Telegram configuration
// Overwrite entire channel object to drop stale keys from old R2 backups
// that would fail OpenClaw's strict config validation (see #47)
if (process.env.TELEGRAM_BOT_TOKEN) {
    const dmPolicy = process.env.TELEGRAM_DM_POLICY || 'pairing';
    config.channels.telegram = {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        enabled: true,
        dmPolicy: dmPolicy,
    };
    if (process.env.TELEGRAM_DM_ALLOW_FROM) {
        config.channels.telegram.allowFrom = process.env.TELEGRAM_DM_ALLOW_FROM.split(',');
    } else if (dmPolicy === 'open') {
        config.channels.telegram.allowFrom = ['*'];
    }
}

// Discord configuration
// Discord uses a nested dm object: dm.policy, dm.allowFrom (per DiscordDmConfig)
if (process.env.DISCORD_BOT_TOKEN) {
    const dmPolicy = process.env.DISCORD_DM_POLICY || 'pairing';
    const dm = { policy: dmPolicy };
    if (dmPolicy === 'open') {
        dm.allowFrom = ['*'];
    }
    config.channels.discord = {
        token: process.env.DISCORD_BOT_TOKEN,
        enabled: true,
        dm: dm,
    };
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = {
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        enabled: true,
    };
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration patched successfully');

// Patch auth-profiles.json to ensure API keys from env vars override cached keys.
// OpenClaw caches API keys in per-agent auth-profiles.json files, which get
// persisted to R2. When a key is rotated via wrangler secret, the cached key
// becomes stale. This patch overwrites cached keys with current env var values.
const glob = require('path');
const agentsDir = '/root/.openclaw/agents';
try {
    const fs2 = require('fs');
    const path = require('path');

    // Build a map of provider -> key from env vars
    const envKeys = {};
    if (process.env.ANTHROPIC_API_KEY) envKeys['anthropic'] = process.env.ANTHROPIC_API_KEY;
    if (process.env.GOOGLE_API_KEY) envKeys['google'] = process.env.GOOGLE_API_KEY;
    if (process.env.OPENAI_API_KEY) envKeys['openai'] = process.env.OPENAI_API_KEY;

    if (Object.keys(envKeys).length === 0) {
        console.log('No API keys in env, skipping auth-profiles patch');
    } else {
        // Find all auth-profiles.json files under agents/
        function findAuthProfiles(dir) {
            var results = [];
            try {
                var entries = fs2.readdirSync(dir, { withFileTypes: true });
                for (var i = 0; i < entries.length; i++) {
                    var entry = entries[i];
                    var full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        results = results.concat(findAuthProfiles(full));
                    } else if (entry.name === 'auth-profiles.json') {
                        results.push(full);
                    }
                }
            } catch (e) {}
            return results;
        }

        var files = findAuthProfiles(agentsDir);
        files.forEach(function(filePath) {
            try {
                var data = JSON.parse(fs2.readFileSync(filePath, 'utf8'));
                var patched = false;
                if (data.profiles) {
                    Object.keys(data.profiles).forEach(function(profileId) {
                        var profile = data.profiles[profileId];
                        var provider = profile.provider;
                        if (provider && envKeys[provider] && profile.key !== envKeys[provider]) {
                            console.log('Patching auth profile ' + profileId + ' key in ' + filePath);
                            profile.key = envKeys[provider];
                            patched = true;
                        }
                    });
                }
                // Clear error stats for patched profiles so OpenClaw doesn't keep them in cooldown
                if (patched && data.usageStats) {
                    Object.keys(data.profiles).forEach(function(profileId) {
                        if (data.usageStats[profileId]) {
                            data.usageStats[profileId].errorCount = 0;
                            delete data.usageStats[profileId].failureCounts;
                            delete data.usageStats[profileId].cooldownUntil;
                        }
                    });
                    fs2.writeFileSync(filePath, JSON.stringify(data, null, 2));
                    console.log('Auth profiles patched and error stats cleared');
                } else if (patched) {
                    fs2.writeFileSync(filePath, JSON.stringify(data, null, 2));
                    console.log('Auth profiles patched');
                }
            } catch (e) {
                console.log('Could not patch ' + filePath + ': ' + e.message);
            }
        });
    }
} catch (e) {
    console.log('Auth-profiles patch skipped:', e.message);
}
EOFPATCH

# ============================================================
# BACKGROUND SYNC LOOP
# ============================================================
if r2_configured; then
    echo "Starting background R2 sync loop..."
    (
        MARKER=/tmp/.last-sync-marker
        LOGFILE=/tmp/r2-sync.log
        touch "$MARKER"

        while true; do
            sleep 30

            CHANGED=/tmp/.changed-files
            {
                find "$CONFIG_DIR" -newer "$MARKER" -type f -printf '%P\n' 2>/dev/null
                find "$WORKSPACE_DIR" -newer "$MARKER" \
                    -not -path '*/node_modules/*' \
                    -not -path '*/.git/*' \
                    -type f -printf '%P\n' 2>/dev/null
            } > "$CHANGED"

            COUNT=$(wc -l < "$CHANGED" 2>/dev/null || echo 0)

            if [ "$COUNT" -gt 0 ]; then
                echo "[sync] Uploading changes ($COUNT files) at $(date)" >> "$LOGFILE"
                rclone sync "$CONFIG_DIR/" "r2:${R2_BUCKET}/openclaw/" \
                    $RCLONE_FLAGS --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' \
                    --filter='+ workspace/**/.git/**' --exclude='.git/**' 2>> "$LOGFILE"
                if [ -d "$WORKSPACE_DIR" ]; then
                    rclone sync "$WORKSPACE_DIR/" "r2:${R2_BUCKET}/workspace/" \
                        $RCLONE_FLAGS --exclude='skills/**' --exclude='skills-bundled/**' --exclude='.git/**' --exclude='node_modules/**' 2>> "$LOGFILE"
                fi
                date -Iseconds > "$LAST_SYNC_FILE"
                touch "$MARKER"
                echo "[sync] Complete at $(date)" >> "$LOGFILE"
            fi
        done
    ) &
    echo "Background sync loop started (PID: $!)"
fi

# ============================================================
# START GATEWAY
# ============================================================
echo "Starting OpenClaw Gateway..."
echo "Gateway will be available on port 18789"
echo "Dev mode: ${OPENCLAW_DEV_MODE:-false}"

if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan --token "$OPENCLAW_GATEWAY_TOKEN"
else
    echo "Starting gateway with device pairing (no token)..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan
fi
