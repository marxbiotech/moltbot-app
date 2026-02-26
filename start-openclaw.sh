#!/bin/bash
# Startup script for OpenClaw in Cloudflare Sandbox
# This script:
# 1. Restores config/workspace from R2 via rclone (if configured)
# 2. Runs openclaw onboard --non-interactive to configure from env vars
# 3. Patches config for features onboard doesn't cover (channels, gateway auth)
# 4. Starts a background sync loop (rclone, watches for file changes)
# 5. Starts the gateway

set -e

CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
WORKSPACE_DIR="/root/clawd"
SKILLS_STAGING="/opt/openclaw-skills"
RCLONE_CONF="/root/.config/rclone/rclone.conf"
LAST_SYNC_FILE="/tmp/.last-sync"

# Stop any leftover gateway from a previous invocation.
# `openclaw gateway` starts openclaw-gateway as a daemon child — when the sandbox
# kills the tracked start-openclaw.sh process, the gateway binary survives as an
# orphan. On re-invocation we must explicitly stop it to free port 18789.
openclaw gateway stop 2>/dev/null || true
# Belt-and-suspenders: directly kill the binary if `gateway stop` didn't work
pkill -f openclaw-gateway 2>/dev/null || true
rm -f /tmp/openclaw-gateway.lock "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

# Kill orphaned background sync loops from previous invocations.
# Each start-openclaw.sh spawns a background R2 sync subshell; without cleanup
# they accumulate on repeated restarts, exhausting container resources.
if [ -f /tmp/.r2-sync-pid ]; then
    OLD_SYNC_PID=$(cat /tmp/.r2-sync-pid 2>/dev/null)
    if [ -n "$OLD_SYNC_PID" ] && kill -0 "$OLD_SYNC_PID" 2>/dev/null; then
        kill "$OLD_SYNC_PID" 2>/dev/null || true
        # Also kill any rclone children of the old sync loop
        pkill -P "$OLD_SYNC_PID" 2>/dev/null || true
    fi
fi

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
        rclone copy "r2:${R2_BUCKET}/openclaw/" "$CONFIG_DIR/" $RCLONE_FLAGS --exclude='skills/**' --exclude='extensions/**' -v 2>&1 || echo "WARNING: config restore failed with exit code $?"
        echo "Config restored"
    elif rclone ls "r2:${R2_BUCKET}/clawdbot/clawdbot.json" $RCLONE_FLAGS 2>/dev/null | grep -q clawdbot.json; then
        echo "Restoring from legacy R2 backup..."
        rclone copy "r2:${R2_BUCKET}/clawdbot/" "$CONFIG_DIR/" $RCLONE_FLAGS --exclude='skills/**' --exclude='extensions/**' -v 2>&1 || echo "WARNING: legacy config restore failed with exit code $?"
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
        rclone copy "r2:${R2_BUCKET}/workspace/" "$WORKSPACE_DIR/" $RCLONE_FLAGS --exclude='skills/**' --exclude='skills-bundled/**' --exclude='repos/**' -v 2>&1 || echo "WARNING: workspace restore failed with exit code $?"
        echo "Workspace restored"
    fi

    # Restore AWS session credentials (from /aws_auth MFA)
    # If session.json exists in R2 and hasn't expired, restore it so Bedrock works
    # immediately without re-running /aws_auth after container restart.
    if rclone ls "r2:${R2_BUCKET}/aws/session.json" $RCLONE_FLAGS 2>/dev/null | grep -q session.json; then
        mkdir -p /root/.aws
        rclone copy "r2:${R2_BUCKET}/aws/" /root/.aws/ $RCLONE_FLAGS --include='session.json' 2>&1 || true
        if [ -f /root/.aws/session.json ]; then
            EXPIRED=$(node -e "
                try {
                    const s = JSON.parse(require('fs').readFileSync('/root/.aws/session.json','utf8'));
                    console.log(new Date(s.Expiration) < new Date() ? 'yes' : 'no');
                } catch(e) { console.log('yes'); }
            " 2>/dev/null)
            if [ "$EXPIRED" = "yes" ]; then
                echo "AWS session expired, removing stale credentials"
                rm -f /root/.aws/session.json
            else
                echo "AWS session restored from R2 (still valid)"
            fi
        fi
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

# ============================================================
# INSTALL SKILLS from Docker image staging → ~/.openclaw/skills/
# ============================================================
# Currently only cloudflare_browser. Most commands are now plugins (extensions/).
# Docker image (/opt/openclaw-skills/) is the single source of truth.
# R2 never stores skills (excluded from both config and workspace sync).
# Clean legacy names first, then copy fresh from staging every boot.
for name in aws-auth ssh-check ssh-setup sk-doctor sk-git-check sk-git-sync sk-workspace-check cloudflare-browser \
            aws_auth ssh_check ssh_setup sk_doctor git_check git_sync git_repos ws_check sys_info net_check cloudflare_browser; do
    rm -rf "$CONFIG_DIR/skills/$name"
done
mkdir -p "$CONFIG_DIR/skills"
for skill_dir in "$SKILLS_STAGING"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    cp -r "$skill_dir" "$CONFIG_DIR/skills/$skill_name"
done
echo "Skills installed to $CONFIG_DIR/skills/"

# ============================================================
# INSTALL PLUGINS from Docker image staging → ~/.openclaw/extensions/
# ============================================================
# Plugins use registerCommand() which executes WITHOUT the AI agent,
# bypassing the exec tool entirely. Docker image is the single source of truth.
# Each plugin may include a scripts/ dir with shell scripts to install to PATH.
PLUGIN_STAGING="/opt/openclaw-extensions"
if [ -d "$PLUGIN_STAGING" ]; then
    mkdir -p "$CONFIG_DIR/extensions"
    for plugin_dir in "$PLUGIN_STAGING"/*/; do
        [ -d "$plugin_dir" ] || continue
        plugin_name=$(basename "$plugin_dir")
        rm -rf "$CONFIG_DIR/extensions/$plugin_name"
        cp -r "$plugin_dir" "$CONFIG_DIR/extensions/$plugin_name"
        # Install scripts to PATH (e.g. scripts/ssh_check.sh → /usr/local/bin/ssh_check)
        if [ -d "$plugin_dir/scripts" ]; then
            for script in "$plugin_dir"/scripts/*.sh; do
                [ -f "$script" ] || continue
                cmd_name=$(basename "$script" .sh)
                cp "$script" "/usr/local/bin/$cmd_name"
                chmod +x "/usr/local/bin/$cmd_name"
            done
        fi
    done
    # Remove stale plugins not in staging (handles renames like telegram-webhook → telegram-tools)
    for local_dir in "$CONFIG_DIR/extensions"/*/; do
        [ -d "$local_dir" ] || continue
        local_name=$(basename "$local_dir")
        if [ ! -d "$PLUGIN_STAGING/$local_name" ]; then
            echo "Removing stale plugin: $local_name"
            rm -rf "$local_dir"
        fi
    done
    echo "Plugins installed: $(ls "$PLUGIN_STAGING" | tr '\n' ' ')"
fi

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

    if [ -z "$AUTH_ARGS" ]; then
        # No direct API key provider (e.g. Bedrock-only) — onboard has no --auth-choice
        # for Bedrock. Skip onboard; the config patch section below creates a working config.
        echo "No onboard-compatible auth provider, skipping onboard (config patch will handle setup)"
    else
        openclaw onboard --non-interactive --accept-risk \
            --mode local \
            $AUTH_ARGS \
            --gateway-port 18789 \
            --gateway-bind lan \
            --skip-channels \
            --skip-skills \
            --skip-health

        echo "Onboard completed"
    fi
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

// ── TOOL POLICY CHAIN: aggressively clear ALL layers that could deny exec ──
// command-dispatch: tool routes slash commands directly to exec without LLM.
// The tool policy chain is: tools.profile → tools.byProvider.profile →
// tools.allow/deny → tools.byProvider.allow/deny → agents.<id>.tools →
// group policies → sandbox tool policy.
// "deny always wins" — ANY layer denying exec breaks command-dispatch.
// We must clear every possible layer, especially from R2-restored config.

config.tools = config.tools || {};

// Layer 1: tools.profile — base permission level
config.tools.profile = 'full';

// Layer 2: tools.byProvider — R2 config may have per-provider restrictions
// Nuke the entire byProvider section to remove any provider-level exec denials
delete config.tools.byProvider;

// Layer 3: tools.allow/deny — explicit allow/deny lists
config.tools.allow = config.tools.allow || [];
if (!config.tools.allow.includes('exec')) {
    config.tools.allow.push('exec');
}
// Remove exec and group:runtime from deny list
if (Array.isArray(config.tools.deny)) {
    config.tools.deny = config.tools.deny.filter(function(t) {
        return t !== 'exec' && t !== 'group:runtime' && t !== 'group:all';
    });
}

// Layer 4: tools.exec — exec-specific security settings
// Default is 'deny' which blocks all shell commands
// NOTE: ToolExecSchema is .strict() — only known keys allowed.
//   Valid keys: security, ask, node, pathPrepend, safeBins, backgroundMs,
//   timeoutSec, cleanupMs, notifyOnExit, notifyOnExitEmptySuccess, applyPatch.
//   askFallback is NOT valid here (only in exec-approvals.json).
config.tools.exec = config.tools.exec || {};
config.tools.exec.security = 'full';
config.tools.exec.ask = 'off';
// Remove any stale invalid keys that may have been written by earlier deploys
delete config.tools.exec.askFallback;

// Layer 5: tools.exec.safeBins — binaries that bypass approval entirely
// Add all skill wrapper names so command-dispatch exec calls never get blocked
config.tools.exec.safeBins = [
    'bash', 'sh', 'node', 'git', 'ssh', 'ssh-keygen', 'ssh-keyscan', 'aws', 'pgrep', 'curl',
    'ws_check', 'sys_info', 'net_check', 'aws_auth', 'ssh_setup', 'ssh_check',
    'git_sync', 'git_check', 'git_repos', 'cloudflare_browser'
];

// Layer 6: tools.sandbox.tools — sandbox TOOL POLICY (separate from sandbox mode!)
// R2 config may have tools.sandbox.tools.deny including exec
delete config.tools.sandbox;

// Layer 7: Disable sandbox mode — we're inside a Cloudflare Sandbox container,
// no Docker-in-Docker available. Without this, exec reports
// "currently restricted in sandbox mode" and command-tool: exec fails.
config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};
config.agents.defaults.sandbox = { mode: 'off' };

// Layer 8: Per-agent tool restrictions — R2 config may have per-agent denials
// Clear tools restrictions on all agents in agents.list
if (config.agents.list) {
    Object.keys(config.agents.list).forEach(function(agentId) {
        var agent = config.agents.list[agentId];
        if (agent && agent.tools) {
            // Remove any deny list that includes exec
            if (Array.isArray(agent.tools.deny)) {
                agent.tools.deny = agent.tools.deny.filter(function(t) {
                    return t !== 'exec' && t !== 'group:runtime' && t !== 'group:all';
                });
            }
            // Ensure exec is in allow if there's an allow list
            if (Array.isArray(agent.tools.allow) && !agent.tools.allow.includes('exec')) {
                agent.tools.allow.push('exec');
            }
        }
    });
}

// Layer 9: Per-agent defaults tool restrictions
if (config.agents.defaults.tools) {
    if (Array.isArray(config.agents.defaults.tools.deny)) {
        config.agents.defaults.tools.deny = config.agents.defaults.tools.deny.filter(function(t) {
            return t !== 'exec' && t !== 'group:runtime' && t !== 'group:all';
        });
    }
    if (Array.isArray(config.agents.defaults.tools.allow) && !config.agents.defaults.tools.allow.includes('exec')) {
        config.agents.defaults.tools.allow.push('exec');
    }
}

// Layer 10: Group policies — clear any group-level exec denials
if (config.groups) {
    Object.keys(config.groups).forEach(function(groupId) {
        var group = config.groups[groupId];
        if (group && group.tools) {
            if (Array.isArray(group.tools.deny)) {
                group.tools.deny = group.tools.deny.filter(function(t) {
                    return t !== 'exec' && t !== 'group:runtime' && t !== 'group:all';
                });
            }
        }
    });
}

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
}

// Control UI — OpenClaw 2026.2.24 requires allowedOrigins when binding to non-loopback
config.gateway.controlUi = config.gateway.controlUi || {};
if (process.env.WORKER_URL) {
    config.gateway.controlUi.allowedOrigins = [process.env.WORKER_URL.replace(/\/+$/, '')];
}
if (process.env.OPENCLAW_DEV_MODE === 'true') {
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
//   anthropic/claude-sonnet-4-6
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

// Default model fallback (for direct API key users, not using AI Gateway)
// Only applies when no model is already configured (e.g. by a plugin like subscription-auth)
// e.g. DEFAULT_MODEL=google/gemini-3-pro-preview
if (process.env.DEFAULT_MODEL) {
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    var currentModel = config.agents.defaults.model && config.agents.defaults.model.primary;
    if (!currentModel) {
        config.agents.defaults.model = { primary: process.env.DEFAULT_MODEL };
        console.log('Default model set:', process.env.DEFAULT_MODEL);
    } else {
        console.log('Default model skipped (already configured):', currentModel);
    }
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
            { id: 'anthropic/claude-sonnet-4-6', alias: 'Claude Sonnet' },
            { id: 'anthropic/claude-opus-4-6', alias: 'Claude Opus' }
        );
    }
    if (process.env.OPENAI_API_KEY) {
        available.push({ id: 'openai/gpt-4o', alias: 'GPT-4o' });
    }
    // Bedrock models are added dynamically by the BEDROCK MODEL DISCOVERY section below.
    // Static entries removed — ListFoundationModels provides correct model IDs.

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

// Clean up stale amazon-bedrock provider from R2 backups.
// The BEDROCK MODEL DISCOVERY section below will recreate it with correct
// inference profile IDs and provider format. Remove any existing entry to
// prevent conflicts between stale base-model-ID entries and new inference-profile-ID entries.
if (config.models && config.models.providers && config.models.providers['amazon-bedrock']) {
    delete config.models.providers['amazon-bedrock'];
    console.log('Cleaned up stale amazon-bedrock provider (will be recreated by discovery section)');
}

// Telegram configuration
// Merge env-driven keys into existing config to preserve runtime changes
// (groups, groupPolicy, historyLimit, reactionLevel, streaming, etc.)
// while ensuring env vars always take precedence for their specific keys.
if (process.env.TELEGRAM_BOT_TOKEN) {
    const dmPolicy = process.env.TELEGRAM_DM_POLICY || 'pairing';
    const existingTelegram = config.channels.telegram || {};
    config.channels.telegram = {
        ...existingTelegram,
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        enabled: true,
        dmPolicy: dmPolicy,
    };
    if (process.env.TELEGRAM_DM_ALLOW_FROM) {
        config.channels.telegram.allowFrom = process.env.TELEGRAM_DM_ALLOW_FROM.split(',');
    } else if (dmPolicy === 'open') {
        config.channels.telegram.allowFrom = ['*'];
    }
    if (process.env.WORKER_URL && process.env.TELEGRAM_WEBHOOK_SECRET) {
        const webhookUrl = process.env.WORKER_URL.replace(/\/+$/, '') + '/telegram/webhook';
        config.channels.telegram.webhookUrl = webhookUrl;
        config.channels.telegram.webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
        // Bind webhook server to 0.0.0.0 so containerFetch can reach it from outside
        config.channels.telegram.webhookHost = '0.0.0.0';
        console.log('Telegram webhook configured:', webhookUrl);
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

// Diagnostic: dump tool policy state so we can verify all layers are clear
console.log('=== TOOL POLICY DUMP ===');
console.log('tools.profile:', config.tools.profile);
console.log('tools.allow:', JSON.stringify(config.tools.allow));
console.log('tools.deny:', JSON.stringify(config.tools.deny || []));
console.log('tools.exec:', JSON.stringify(config.tools.exec));
console.log('tools.byProvider:', config.tools.byProvider ? JSON.stringify(config.tools.byProvider) : 'DELETED');
console.log('tools.sandbox:', config.tools.sandbox ? JSON.stringify(config.tools.sandbox) : 'DELETED');
console.log('agents.defaults.sandbox:', JSON.stringify(config.agents.defaults.sandbox));
console.log('agents.defaults.tools:', config.agents.defaults.tools ? JSON.stringify(config.agents.defaults.tools) : 'none');
console.log('=== END TOOL POLICY DUMP ===');

// Patch auth-profiles.json:
// 1. Override cached API keys with current env var values (handles key rotation)
// 2. Clear error/cooldown stats for ALL profiles on restart (including OAuth/subscription
//    profiles like openai-codex) so OpenClaw gives them a fresh chance
const agentsDir = '/root/.openclaw/agents';
try {
    const fs2 = require('fs');
    const path = require('path');

    // Build a map of provider -> key from env vars
    const envKeys = {};
    if (process.env.ANTHROPIC_API_KEY) envKeys['anthropic'] = process.env.ANTHROPIC_API_KEY;
    if (process.env.GOOGLE_API_KEY) envKeys['google'] = process.env.GOOGLE_API_KEY;
    if (process.env.OPENAI_API_KEY) envKeys['openai'] = process.env.OPENAI_API_KEY;

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
    if (files.length === 0) {
        console.log('No auth-profiles.json files found, skipping patch');
    }
    files.forEach(function(filePath) {
        try {
            var data = JSON.parse(fs2.readFileSync(filePath, 'utf8'));
            var keyPatched = false;
            var statsCleared = false;
            if (data.profiles) {
                Object.keys(data.profiles).forEach(function(profileId) {
                    var profile = data.profiles[profileId];
                    var provider = profile.provider;
                    // Patch API key if env var overrides it
                    if (provider && envKeys[provider] && profile.key !== envKeys[provider]) {
                        console.log('Patching auth profile ' + profileId + ' key in ' + filePath);
                        profile.key = envKeys[provider];
                        keyPatched = true;
                    }
                });
            }
            // Clear error stats for ALL profiles on restart — gives OAuth/subscription
            // profiles (openai-codex, etc.) a fresh chance after container restart
            if (data.usageStats) {
                Object.keys(data.usageStats).forEach(function(profileId) {
                    var stats = data.usageStats[profileId];
                    if (stats.errorCount > 0 || stats.failureCounts || stats.cooldownUntil) {
                        stats.errorCount = 0;
                        delete stats.failureCounts;
                        delete stats.cooldownUntil;
                        statsCleared = true;
                    }
                });
            }
            if (keyPatched || statsCleared) {
                fs2.writeFileSync(filePath, JSON.stringify(data, null, 2));
                var actions = [];
                if (keyPatched) actions.push('keys patched');
                if (statsCleared) actions.push('error stats cleared');
                console.log('Auth profiles updated (' + actions.join(', ') + '): ' + filePath);
            }
        } catch (e) {
            console.log('Could not patch ' + filePath + ': ' + e.message);
        }
    });
} catch (e) {
    console.log('Auth-profiles patch skipped:', e.message);
}
EOFPATCH

# ============================================================
# SYNC auth-profiles.json → auth.json
# ============================================================
# OpenClaw's model resolution reads auth.json (pi-coding-agent format), NOT
# auth-profiles.json. The ensurePiAuthJsonFromAuthProfiles() function bridges
# them, but it's only called during model catalog loading — if the gateway
# receives a message before the catalog loads, the model registry won't find
# OAuth providers like openai-codex.
#
# After R2 restore, auth.json may be missing or stale (e.g. the OAuth flow
# completed and updated auth-profiles.json, which synced to R2, but auth.json
# was written afterward and the container shut down before the next sync cycle
# picked it up).
#
# This script replicates ensurePiAuthJsonFromAuthProfiles() logic: convert
# all auth-profiles credentials → auth.json so the model registry discovers
# OAuth providers on the very first request.
node << 'EOF_AUTH_SYNC'
const fs = require('fs');
const path = require('path');

const agentsDir = '/root/.openclaw/agents';
try {
    const agentEntries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const agentEntry of agentEntries) {
        if (!agentEntry.isDirectory()) continue;
        const agentDir = path.join(agentsDir, agentEntry.name, 'agent');
        const profilesPath = path.join(agentDir, 'auth-profiles.json');
        const authJsonPath = path.join(agentDir, 'auth.json');

        // Design Decision: Empty catch is intentional — if auth-profiles.json is missing
        // (ENOENT) or corrupted, skipping the agent is correct either way. The file will
        // be regenerated by OpenClaw on the next OAuth flow or onboard run.
        let profiles;
        try {
            profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
        } catch { continue; }

        if (!profiles || !profiles.profiles) continue;

        // Read existing auth.json (may not exist)
        // Design Decision: Empty catch is intentional — whether auth.json is missing or
        // corrupted, the correct behavior is identical: rebuild it from auth-profiles.json.
        // A corrupted file is safely overwritten because auth-profiles.json is the source
        // of truth and is synced to R2 independently.
        let authJson = {};
        try {
            authJson = JSON.parse(fs.readFileSync(authJsonPath, 'utf8'));
        } catch {}

        let changed = false;
        for (const [, cred] of Object.entries(profiles.profiles)) {
            const provider = (cred.provider || '').trim().toLowerCase();
            if (!provider) continue;

            let converted = null;
            if (cred.type === 'api_key') {
                const key = (cred.key || '').trim();
                if (key) converted = { type: 'api_key', key };
            } else if (cred.type === 'token') {
                const token = (cred.token || '').trim();
                if (token) converted = { type: 'api_key', key: token };
            } else if (cred.type === 'oauth') {
                const access = (cred.access || '').trim();
                const refresh = (cred.refresh || '').trim();
                const expires = typeof cred.expires === 'number' ? cred.expires : NaN;
                if (access && refresh && isFinite(expires) && expires > 0) {
                    converted = { type: 'oauth', access, refresh, expires };
                } else {
                    console.log('Warning: skipping incomplete OAuth credential for ' +
                        provider + ' (access=' + !!access + ', refresh=' + !!refresh +
                        ', expires=' + cred.expires + ')');
                }
            }

            if (!converted) continue;

            // Skip if auth.json already has an equivalent credential
            if (JSON.stringify(authJson[provider]) === JSON.stringify(converted)) continue;

            authJson[provider] = converted;
            changed = true;
            console.log('Synced auth credential: ' + provider + ' (' + converted.type + ')');
        }

        if (changed) {
            fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
            fs.writeFileSync(authJsonPath, JSON.stringify(authJson, null, 2) + '\n', { mode: 0o600 });
            console.log('auth.json updated: ' + authJsonPath);
        }
    }
} catch (e) {
    if (e.code === 'ENOENT') {
        console.log('auth.json sync: no agents directory, skipping');
    } else {
        console.error('auth.json sync FAILED:', e.message);
    }
}
EOF_AUTH_SYNC

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

            # Also check for AWS session credential changes
            if [ -f /root/.aws/session.json ] && [ /root/.aws/session.json -nt "$MARKER" ]; then
                COUNT=$((COUNT + 1))
            fi

            if [ "$COUNT" -gt 0 ]; then
                echo "[sync] Uploading changes ($COUNT files) at $(date)" >> "$LOGFILE"
                rclone sync "$CONFIG_DIR/" "r2:${R2_BUCKET}/openclaw/" \
                    $RCLONE_FLAGS --exclude='skills/**' --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' \
                    --filter='+ workspace/**/.git/**' --exclude='.git/**' 2>> "$LOGFILE"
                if [ -d "$WORKSPACE_DIR" ]; then
                    rclone sync "$WORKSPACE_DIR/" "r2:${R2_BUCKET}/workspace/" \
                        $RCLONE_FLAGS --exclude='skills/**' --exclude='skills-bundled/**' --exclude='repos/**' --exclude='.git/**' --exclude='node_modules/**' 2>> "$LOGFILE"
                fi
                # Sync AWS session credentials (from /aws_auth MFA)
                if [ -f /root/.aws/session.json ]; then
                    rclone copy /root/.aws/session.json "r2:${R2_BUCKET}/aws/" $RCLONE_FLAGS 2>> "$LOGFILE"
                fi
                date -Iseconds > "$LAST_SYNC_FILE"
                touch "$MARKER"
                echo "[sync] Complete at $(date)" >> "$LOGFILE"
            fi
        done
    ) &
    SYNC_PID=$!
    echo "$SYNC_PID" > /tmp/.r2-sync-pid
    echo "Background sync loop started (PID: $SYNC_PID)"
fi

# ============================================================
# EXEC APPROVALS — headless container, allow everything
# ============================================================
# exec-approvals.json is a SEPARATE file from openclaw.json.
# The effective policy = stricter of tools.exec.* and exec-approvals defaults.
# In headless containers there's no companion app UI, so askFallback must not be 'deny'.
# Write permissive exec-approvals.json to unblock exec tool for skills.
APPROVALS_FILE="/root/.openclaw/exec-approvals.json"
cat > "$APPROVALS_FILE" << 'EOF'
{
  "version": 1,
  "defaults": {
    "security": "full",
    "ask": "off",
    "askFallback": "allow",
    "autoAllowSkills": true,
    "safeBins": [
      "bash", "sh", "node", "git", "ssh", "ssh-keygen", "ssh-keyscan",
      "aws", "pgrep", "curl",
      "ws_check", "sys_info", "net_check", "aws_auth", "ssh_setup", "ssh_check",
      "git_sync", "git_check", "git_repos", "cloudflare_browser"
    ]
  },
  "rules": []
}
EOF
echo "Exec approvals: written $APPROVALS_FILE (security=full, autoAllowSkills=true)"

# Also run openclaw config set commands as a belt-and-suspenders approach
# These CLI commands may write to a different layer than the JSON patch
openclaw config set tools.profile full 2>/dev/null || true
openclaw config set tools.exec.security full 2>/dev/null || true
openclaw config set tools.exec.ask off 2>/dev/null || true
echo "CLI config set: tools.profile=full, exec.security=full, exec.ask=off"

# ============================================================
# BEDROCK MODEL DISCOVERY + MANUAL PROVIDER SETUP
# ============================================================
# OpenClaw's built-in bedrockDiscovery uses ListFoundationModels which returns
# base model IDs (e.g. anthropic.claude-sonnet-4-6). Since Oct 2024, newer models
# require inference profile IDs (e.g. us.anthropic.claude-sonnet-4-6) for on-demand
# invocation. We disable bedrockDiscovery and manually set up the amazon-bedrock
# provider with inference profile IDs.
#
# Flow: list-inference-profiles → curated intersection → manual provider config
# IAM: requires bedrock:ListInferenceProfiles (falls back to static IDs if unavailable)
if [ -n "$AWS_BASE_ACCESS_KEY_ID" ] && [ -n "$AWS_BASE_SECRET_ACCESS_KEY" ]; then
    BR_REGION="${AWS_REGION:-us-east-1}"

    # Use credential_process so the AWS SDK refreshes credentials automatically.
    # The helper returns session creds from /aws_auth (with Expiration for SDK caching),
    # or falls back to base IAM creds with 60-second expiration (forces frequent refresh
    # so /aws_auth's new creds are picked up within a minute — no gateway restart needed).
    mkdir -p /root/.aws
    rm -f /root/.aws/credentials  # Remove stale file — credential_process takes priority

    # Create credential helper script
    cat > /usr/local/bin/aws-cred-helper << 'CREDHELPER'
#!/bin/bash
SESSION_FILE="/root/.aws/session.json"
if [ -f "$SESSION_FILE" ]; then
    cat "$SESSION_FILE"
else
    # Base IAM creds with 60-second expiration — forces SDK to re-check frequently
    # so it picks up /aws_auth's session creds quickly after authentication.
    EXPIRES=$(node -e "console.log(new Date(Date.now()+60000).toISOString())" 2>/dev/null)
    echo "{\"Version\":1,\"AccessKeyId\":\"$AWS_BASE_ACCESS_KEY_ID\",\"SecretAccessKey\":\"$AWS_BASE_SECRET_ACCESS_KEY\",\"Expiration\":\"${EXPIRES}\"}"
fi
CREDHELPER
    chmod +x /usr/local/bin/aws-cred-helper

    cat > /root/.aws/config << AWSCONF
[default]
region = $BR_REGION
credential_process = /usr/local/bin/aws-cred-helper
AWSCONF
    echo "AWS credential_process configured for SDK auto-refresh"

    echo "Discovering Bedrock models in $BR_REGION..."

    # 1. Discover inference profiles (for Anthropic and other models that require them)
    BEDROCK_PROFILES=$(AWS_ACCESS_KEY_ID="$AWS_BASE_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$AWS_BASE_SECRET_ACCESS_KEY" \
        aws bedrock list-inference-profiles \
        --region "$BR_REGION" \
        --type-equals SYSTEM_DEFINED \
        --query 'inferenceProfileSummaries[?status==`ACTIVE`].inferenceProfileId' \
        --output json 2>&1) || true

    if ! echo "$BEDROCK_PROFILES" | head -1 | grep -q '^\['; then
        echo "WARNING: Bedrock inference profile discovery failed: $BEDROCK_PROFILES"
        BEDROCK_PROFILES="[]"
    fi

    # 2. Discover foundation models (for third-party models without inference profiles)
    BEDROCK_MODELS=$(AWS_ACCESS_KEY_ID="$AWS_BASE_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$AWS_BASE_SECRET_ACCESS_KEY" \
        aws bedrock list-foundation-models \
        --region "$BR_REGION" \
        --query 'modelSummaries[?responseStreamingSupported==`true`].modelId' \
        --output json 2>&1) || true

    if ! echo "$BEDROCK_MODELS" | head -1 | grep -q '^\['; then
        echo "WARNING: Bedrock foundation model discovery failed: $BEDROCK_MODELS"
        BEDROCK_MODELS="[]"
    fi

    BEDROCK_PROFILES="${BEDROCK_PROFILES:-[]}" BEDROCK_MODELS="${BEDROCK_MODELS:-[]}" BR_REGION="$BR_REGION" node -e "
    const fs = require('fs');
    const configPath = '/root/.openclaw/openclaw.json';
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const profiles = JSON.parse(process.env.BEDROCK_PROFILES || '[]');
        const foundations = JSON.parse(process.env.BEDROCK_MODELS || '[]');
        const brRegion = process.env.BR_REGION || 'us-east-1';

        // Curated models with metadata for manual provider config.
        // 'match' is substring-matched against discovered IDs.
        // 'needsProfile': true = newer Anthropic models that MUST use inference profile IDs.
        //                 false = third-party models that use base model IDs (no inference profile exists).
        const curated = [
            { match: 'claude-sonnet-4-6', alias: 'Bedrock Sonnet 4.6', name: 'Claude Sonnet 4.6', needsProfile: true, reasoning: false, input: ['text', 'image'], contextWindow: 200000, maxTokens: 8192 },
            { match: 'claude-opus-4-6', alias: 'Bedrock Opus 4.6', name: 'Claude Opus 4.6', needsProfile: true, reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 32000 },
            { match: 'claude-haiku-4-5', alias: 'Bedrock Haiku 4.5', name: 'Claude Haiku 4.5', needsProfile: true, reasoning: false, input: ['text', 'image'], contextWindow: 200000, maxTokens: 8192 },
            { match: 'deepseek.r1', alias: 'DeepSeek R1', name: 'DeepSeek R1', needsProfile: true, reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 8192 },
            { match: 'qwen3-coder', alias: 'Qwen3 Coder', name: 'Qwen3 Coder', needsProfile: false, reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 8192 },
            { match: 'deepseek.v3', alias: 'DeepSeek V3', name: 'DeepSeek V3', needsProfile: false, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192 },
            { match: 'gpt-oss-120b', alias: 'GPT-OSS 120B', name: 'GPT-OSS 120B', needsProfile: false, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192 },
        ];

        // Static fallback — used when BOTH discovery APIs fail.
        // Inference profile IDs for models that need them, base IDs for the rest.
        const staticFallback = [
            { id: 'us.anthropic.claude-sonnet-4-6', match: 'claude-sonnet-4-6' },
            { id: 'us.anthropic.claude-opus-4-6-v1', match: 'claude-opus-4-6' },
            { id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', match: 'claude-haiku-4-5' },
            { id: 'us.deepseek.r1-v1:0', match: 'deepseek.r1' },
            { id: 'qwen.qwen3-coder-next', match: 'qwen3-coder' },
            { id: 'deepseek.v3.2', match: 'deepseek.v3' },
            { id: 'openai.gpt-oss-120b-1:0', match: 'gpt-oss-120b' },
        ];

        // Resolve models: for each curated entry, find the best available ID.
        // Models with needsProfile=true → search inference profiles first.
        // Models with needsProfile=false → search foundation models (base IDs).
        const resolvedModels = [];
        var discoveryUsed = profiles.length > 0 || foundations.length > 0;

        if (discoveryUsed) {
            for (const c of curated) {
                var found = null;
                if (c.needsProfile) {
                    // Search inference profiles for models that require them
                    found = profiles.find(function(id) { return id.includes(c.match); });
                }
                if (!found) {
                    // Search foundation models (base IDs) — works for third-party models
                    // and as fallback for profile models
                    found = foundations.find(function(id) { return id.includes(c.match); });
                }
                if (found) {
                    resolvedModels.push({ id: found, curated: c });
                }
            }
            console.log('Bedrock: ' + resolvedModels.length + ' models (from ' + profiles.length + ' profiles + ' + foundations.length + ' foundation models)');
        } else {
            for (const s of staticFallback) {
                const c = curated.find(function(c) { return c.match === s.match; });
                if (c) {
                    resolvedModels.push({ id: s.id, curated: c });
                }
            }
            console.log('Bedrock: ' + resolvedModels.length + ' models (static fallback)');
        }

        if (resolvedModels.length > 0) {
            // 1. Disable bedrockDiscovery — it uses ListFoundationModels which returns
            //    base model IDs that can't be used for on-demand invocation of newer models.
            config.models = config.models || {};
            config.models.bedrockDiscovery = { enabled: false };

            // 2. Set up manual amazon-bedrock provider.
            //    Mix of inference profile IDs (for Anthropic) and base model IDs (for third-party).
            //    OpenClaw passes model ID as-is to Bedrock API — both types work.
            config.models.providers = config.models.providers || {};
            config.models.providers['amazon-bedrock'] = {
                baseUrl: 'https://bedrock-runtime.' + brRegion + '.amazonaws.com',
                api: 'bedrock-converse-stream',
                auth: 'aws-sdk',
                models: resolvedModels.map(function(m) {
                    return {
                        id: m.id,
                        name: m.curated.name,
                        reasoning: m.curated.reasoning,
                        input: m.curated.input,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: m.curated.contextWindow,
                        maxTokens: m.curated.maxTokens
                    };
                })
            };
            console.log('Bedrock provider: manual config (' + resolvedModels.length + ' models)');
            console.log('bedrockDiscovery: disabled');

            // 3. Update allowlist (for /model menu).
            config.agents = config.agents || {};
            config.agents.defaults = config.agents.defaults || {};
            config.agents.defaults.models = config.agents.defaults.models || {};

            // Remove all old amazon-bedrock entries
            Object.keys(config.agents.defaults.models).forEach(function(key) {
                if (key.startsWith('amazon-bedrock/')) {
                    delete config.agents.defaults.models[key];
                }
            });

            // Add entries (mix of inference profile and base model IDs)
            for (const m of resolvedModels) {
                config.agents.defaults.models['amazon-bedrock/' + m.id] = { alias: m.curated.alias };
            }
            console.log('Bedrock allowlist: ' + resolvedModels.map(function(m) { return m.curated.alias; }).join(', '));
        }

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch(e) {
        console.error('Bedrock setup failed: ' + e.message);
    }
    " 2>&1
fi

# ============================================================
# PATCH: Telegram webhook EADDRINUSE fix (openclaw/openclaw#19831)
# monitorTelegramProvider returns immediately in webhook mode,
# causing auto-restart to bind the same port → crash loop.
# Fix: await abortSignal before returning (matches PR #20309).
# Remove this patch once OpenClaw ships the fix upstream.
# ============================================================
OPENCLAW_DIST="/usr/local/lib/node_modules/openclaw/dist"
WEBHOOK_PATCH_APPLIED=0
WEBHOOK_PATCH_SKIPPED=0
# Patch ALL .js files that contain the unpatched call (not just the first).
# The gateway chunk graph can change between versions, so multiple files may embed
# the same monitorTelegramProvider codepath.
for WEBHOOK_PATCH_TARGET in $(grep -rl --include='*.js' 'await startTelegramWebhook(' "$OPENCLAW_DIST" 2>/dev/null); do
    if ! grep -q 'PATCHED_WEBHOOK_AWAIT' "$WEBHOOK_PATCH_TARGET"; then
        sed -i '/await startTelegramWebhook({/,/^[[:space:]]*return;/{
            /^[[:space:]]*return;/{
                i\			if(opts.abortSignal&&!opts.abortSignal.aborted){await new Promise(r=>{opts.abortSignal.addEventListener("abort",r,{once:true})})}/*PATCHED_WEBHOOK_AWAIT*/
            }
        }' "$WEBHOOK_PATCH_TARGET"
        if grep -q 'PATCHED_WEBHOOK_AWAIT' "$WEBHOOK_PATCH_TARGET"; then
            echo "Telegram webhook patch applied: $(basename "$WEBHOOK_PATCH_TARGET")"
            WEBHOOK_PATCH_APPLIED=$((WEBHOOK_PATCH_APPLIED + 1))
        else
            echo "WARNING: Telegram webhook patch failed to apply to $(basename "$WEBHOOK_PATCH_TARGET")"
        fi
    else
        WEBHOOK_PATCH_SKIPPED=$((WEBHOOK_PATCH_SKIPPED + 1))
    fi
done
if [ "$WEBHOOK_PATCH_APPLIED" -eq 0 ] && [ "$WEBHOOK_PATCH_SKIPPED" -eq 0 ]; then
    echo "Telegram webhook patch: no target files found (may be fixed upstream), skipping"
elif [ "$WEBHOOK_PATCH_APPLIED" -eq 0 ]; then
    echo "Telegram webhook patch: all $WEBHOOK_PATCH_SKIPPED files already patched"
else
    echo "Telegram webhook patch: applied to $WEBHOOK_PATCH_APPLIED file(s), $WEBHOOK_PATCH_SKIPPED already patched"
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
