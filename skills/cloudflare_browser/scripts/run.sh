#!/bin/bash
# cloudflare_browser — Dispatcher for browser automation scripts (LLM-free execution)
# Usage: cloudflare_browser screenshot <url> [output]
#        cloudflare_browser video <urls> [output]

SCRIPT_DIR="$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")"
# Scripts may be colocated (in skills dir) or run from /usr/local/bin
SKILLS_SCRIPTS="/root/clawd/skills/cloudflare_browser/scripts"

find_script() {
    local name="$1"
    if [ -f "$SKILLS_SCRIPTS/$name" ]; then
        echo "$SKILLS_SCRIPTS/$name"
    elif [ -f "$SCRIPT_DIR/$name" ]; then
        echo "$SCRIPT_DIR/$name"
    else
        echo ""
    fi
}

ACTION="$1"
shift 2>/dev/null

case "$ACTION" in
    screenshot)
        SCRIPT=$(find_script "screenshot.js")
        if [ -z "$SCRIPT" ]; then
            echo "[FAIL] screenshot.js not found"
            exit 1
        fi
        exec node "$SCRIPT" "$@"
        ;;
    video)
        SCRIPT=$(find_script "video.js")
        if [ -z "$SCRIPT" ]; then
            echo "[FAIL] video.js not found"
            exit 1
        fi
        exec node "$SCRIPT" "$@"
        ;;
    *)
        echo "Usage: cloudflare_browser <action> [args...]"
        echo ""
        echo "Actions:"
        echo "  screenshot <url> [output.png]    — Take a screenshot of a URL"
        echo "  video <url1,url2,...> [output.mp4] — Capture video of multiple URLs"
        echo ""
        echo "Examples:"
        echo "  cloudflare_browser screenshot https://example.com"
        echo "  cloudflare_browser screenshot https://example.com output.png"
        echo "  cloudflare_browser video \"https://site1.com,https://site2.com\" output.mp4"
        ;;
esac
