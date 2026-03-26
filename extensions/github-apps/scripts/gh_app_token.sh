#!/bin/bash
# gh_app_token — Generate a GitHub App Installation Token
# Usage: gh_app_token <app-name>
#
# Reads credentials from ~/.github-apps/<app-name>/:
#   app-id            — GitHub App ID
#   private-key.pem   — RSA private key (PEM)
#   installation-id   — Installation ID for the org/repo
#
# Outputs the installation access token to stdout.

set -euo pipefail

APP_NAME="${1:-}"
if [ -z "$APP_NAME" ]; then
    echo "Usage: gh_app_token <app-name>" >&2
    exit 1
fi

APP_DIR="$HOME/.github-apps/$APP_NAME"
if [ ! -d "$APP_DIR" ]; then
    echo "Error: App directory not found: $APP_DIR" >&2
    echo "Available apps:" >&2
    ls "$HOME/.github-apps/" 2>/dev/null || echo "  (none)" >&2
    exit 1
fi

APP_ID=$(cat "$APP_DIR/app-id" 2>/dev/null) || { echo "Error: $APP_DIR/app-id not found" >&2; exit 1; }
INSTALLATION_ID=$(cat "$APP_DIR/installation-id" 2>/dev/null) || { echo "Error: $APP_DIR/installation-id not found" >&2; exit 1; }
PRIVATE_KEY="$APP_DIR/private-key.pem"
[ -f "$PRIVATE_KEY" ] || { echo "Error: $PRIVATE_KEY not found" >&2; exit 1; }

# --- Build JWT (RS256) using openssl ---
NOW=$(date +%s)
IAT=$((NOW - 60))
EXP=$((NOW + 600))

# Base64url encode (no padding, URL-safe)
b64url() {
    openssl base64 -A | tr '+/' '-_' | tr -d '='
}

# Validate PEM key before signing
PEM_CHECK_ERR=$(openssl rsa -in "$PRIVATE_KEY" -check -noout 2>&1) || {
    echo "Error: Invalid RSA private key at $PRIVATE_KEY" >&2
    echo "OpenSSL: $PEM_CHECK_ERR" >&2
    echo "Verify that GITHUB_APPS.$APP_NAME.privateKey is a valid base64-encoded PEM RSA key" >&2
    exit 1
}

HEADER=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
PAYLOAD=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$IAT" "$EXP" "$APP_ID" | b64url)

SIGNATURE=$(printf '%s.%s' "$HEADER" "$PAYLOAD" \
    | openssl dgst -sha256 -sign "$PRIVATE_KEY" -binary \
    | b64url)

JWT="${HEADER}.${PAYLOAD}.${SIGNATURE}"

# --- Exchange JWT for Installation Token ---
# Design Decision: curl network errors (DNS, TLS) cause set -e to abort with no message.
# This is acceptable because the container environment has reliable connectivity to GitHub,
# and the generic exit-on-error is sufficient for the rare network failure case.
TMPFILE=$(mktemp /tmp/gh_app_response.XXXXXX)
trap 'rm -f "$TMPFILE"' EXIT

HTTP_CODE=$(curl -s -o "$TMPFILE" -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $JWT" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/app/installations/$INSTALLATION_ID/access_tokens")
RESPONSE=$(cat "$TMPFILE" 2>/dev/null)

if [ "$HTTP_CODE" != "201" ]; then
    echo "Error: GitHub API returned HTTP $HTTP_CODE for app '$APP_NAME'" >&2
    # Design Decision: No raw response fallback when jq is unavailable — the OpenClaw
    # container image includes jq, so the jq-only path is sufficient for production use.
    if command -v jq &>/dev/null; then
        MSG=$(echo "$RESPONSE" | jq -r '.message // empty')
        [ -n "$MSG" ] && echo "Message: $MSG" >&2
    fi
    exit 1
fi

# Extract token — try jq first, fall back to grep
if command -v jq &>/dev/null; then
    TOKEN=$(echo "$RESPONSE" | jq -r '.token // empty')
else
    TOKEN=$(echo "$RESPONSE" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
fi

if [ -z "$TOKEN" ]; then
    echo "Error: Failed to extract token from response" >&2
    exit 1
fi

echo "$TOKEN"
