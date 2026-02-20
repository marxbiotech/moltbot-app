#!/bin/bash
# aws_auth — Authenticate AWS Bedrock with MFA (LLM-free execution)
# Usage: aws_auth <6-digit-mfa-code>

MFA_CODE="$1"
REGION="${AWS_REGION:-us-east-1}"

# Validate MFA code
if [ -z "$MFA_CODE" ]; then
    echo "Usage: aws_auth <6-digit-mfa-code>"
    echo ""
    echo "Authenticates AWS Bedrock using STS assume-role with MFA."
    echo "Requires: AWS_ROLE_ARN, AWS_MFA_SERIAL, AWS_BASE_ACCESS_KEY_ID, AWS_BASE_SECRET_ACCESS_KEY"
    echo "Optional: AWS_REGION (default: us-east-1)"
    exit 0
fi

if ! echo "$MFA_CODE" | grep -qE '^[0-9]{6}$'; then
    echo "[FAIL] Invalid MFA code: '$MFA_CODE' (must be exactly 6 digits)"
    exit 1
fi

# Check required env vars
if [ -z "$AWS_ROLE_ARN" ]; then
    echo "[FAIL] AWS_ROLE_ARN not set"
    exit 1
fi

if [ -z "$AWS_MFA_SERIAL" ]; then
    echo "[FAIL] AWS_MFA_SERIAL not set"
    exit 1
fi

# Check aws CLI
if ! command -v aws > /dev/null 2>&1; then
    echo "[FAIL] aws CLI not found in PATH"
    exit 1
fi

echo "[INFO] Assuming role: $AWS_ROLE_ARN"
echo "[INFO] MFA device: $AWS_MFA_SERIAL"
echo "[INFO] Region: $REGION"
echo ""

# 1. Assume role with MFA
# Use AWS_BASE_* creds (renamed in env.ts to avoid colliding with AWS SDK credential chain)
STS_OUTPUT=$(AWS_ACCESS_KEY_ID="$AWS_BASE_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$AWS_BASE_SECRET_ACCESS_KEY" \
    aws sts assume-role \
    --role-arn "$AWS_ROLE_ARN" \
    --serial-number "$AWS_MFA_SERIAL" \
    --token-code "$MFA_CODE" \
    --role-session-name "OpenClawSession" \
    --duration-seconds 43200 \
    --output json 2>&1)

if [ $? -ne 0 ]; then
    echo "[FAIL] STS assume-role failed:"
    echo "$STS_OUTPUT"
    exit 1
fi

# Parse credentials
ACCESS_KEY=$(echo "$STS_OUTPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).Credentials.AccessKeyId))" 2>/dev/null)
SECRET_KEY=$(echo "$STS_OUTPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).Credentials.SecretAccessKey))" 2>/dev/null)
SESSION_TOKEN=$(echo "$STS_OUTPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).Credentials.SessionToken))" 2>/dev/null)
EXPIRATION=$(echo "$STS_OUTPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).Credentials.Expiration))" 2>/dev/null)

if [ -z "$ACCESS_KEY" ] || [ -z "$SECRET_KEY" ] || [ -z "$SESSION_TOKEN" ]; then
    echo "[FAIL] Failed to parse STS credentials"
    echo "$STS_OUTPUT"
    exit 1
fi

echo "[PASS] STS credentials obtained (expires: $EXPIRATION)"

# 2. Write session credentials for the credential_process helper
# start-openclaw.sh configures ~/.aws/config with credential_process = aws-cred-helper.
# The helper reads /root/.aws/session.json (this file) and returns it to the AWS SDK.
# Because session creds have Expiration, the SDK auto-refreshes — no gateway restart needed.
mkdir -p /root/.aws
cat > /root/.aws/session.json << AWSEOF
{"Version":1,"AccessKeyId":"$ACCESS_KEY","SecretAccessKey":"$SECRET_KEY","SessionToken":"$SESSION_TOKEN","Expiration":"$EXPIRATION"}
AWSEOF
echo "[PASS] Session credentials written (SDK will auto-refresh)"

# bedrockDiscovery and model allowlist are pre-configured at container startup
# (start-openclaw.sh), so no config changes or gateway restart needed here.
# The AWS SDK reads ~/.aws/credentials on each request automatically.

# 3. Switch default model to bedrock if configured
# BEDROCK_DEFAULT_MODEL is a pattern (e.g. "claude-sonnet-4-6"), not a full model ID.
# Resolve it against the allowlist in config to get the correct full model ID
# (e.g. "amazon-bedrock/anthropic.claude-sonnet-4-6-v1").
if [ -n "$BEDROCK_DEFAULT_MODEL" ]; then
    BEDROCK_DEFAULT_MODEL="$BEDROCK_DEFAULT_MODEL" node -e "
    const fs = require('fs');
    const configPath = '/root/.openclaw/openclaw.json';
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const pattern = process.env.BEDROCK_DEFAULT_MODEL;

        // Find matching model in the allowlist (agents.defaults.models)
        const models = (config.agents && config.agents.defaults && config.agents.defaults.models) || {};
        const match = Object.keys(models).find(function(id) {
            return id.startsWith('amazon-bedrock/') && id.includes(pattern);
        });

        if (match) {
            config.agents.defaults.model = config.agents.defaults.model || {};
            config.agents.defaults.model.primary = match;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            console.log('[PASS] Default model switched to: ' + match);
        } else {
            console.error('[WARN] No bedrock model matching pattern: ' + pattern);
            console.error('[WARN] Available models: ' + Object.keys(models).filter(function(id) { return id.startsWith('amazon-bedrock/'); }).join(', '));
        }
    } catch(e) {
        console.error('[WARN] Could not set default model: ' + e.message);
    }
    " 2>&1
fi

echo ""
echo "[PASS] AWS Bedrock authenticated! Session active for 12 hours."
echo "Session expires: $EXPIRATION"
