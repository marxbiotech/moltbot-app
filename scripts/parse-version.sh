#!/bin/bash
#
# parse-version.sh - Parse OpenClaw-based version and calculate next version
#
# Version format: v<year>.<month>.<day>-<patch>
#   e.g., v2026.2.26-0 means based on OpenClaw v2026.2.26, first release
#
# Usage:
#   ./scripts/parse-version.sh <current-version> bump
#   ./scripts/parse-version.sh <current-version> rebase <openclaw-version>
#
# Commands:
#   bump   - Increment the patch suffix (v2026.2.26-0 → v2026.2.26-1)
#   rebase - Set new OpenClaw base version, reset suffix to 0
#
# Examples:
#   ./scripts/parse-version.sh v2026.2.26-0 bump              # v2026.2.26-1
#   ./scripts/parse-version.sh v2026.2.26-3 bump              # v2026.2.26-4
#   ./scripts/parse-version.sh v2026.2.26-3 rebase 2026.3.1   # v2026.3.1-0
#
# Exit codes:
#   0 - Success
#   1 - Invalid arguments or version format
#

set -euo pipefail

RED='\033[0;31m'
NC='\033[0m'

if [ $# -lt 2 ]; then
  echo -e "${RED}Error: Invalid number of arguments${NC}" >&2
  echo "Usage: $0 <current-version> bump" >&2
  echo "       $0 <current-version> rebase <openclaw-version>" >&2
  exit 1
fi

current_version=$1
command=$2

# Parse current version: v<year>.<month>.<day>-<patch>
if [[ $current_version =~ ^v?([0-9]+\.[0-9]+\.[0-9]+)-([0-9]+)$ ]]; then
  base="${BASH_REMATCH[1]}"
  suffix="${BASH_REMATCH[2]}"
else
  echo -e "${RED}Error: Invalid version format: $current_version${NC}" >&2
  echo "Expected format: v2026.2.26-0 or 2026.2.26-0" >&2
  exit 1
fi

case $command in
  bump)
    new_version="v${base}-$((suffix + 1))"
    ;;
  rebase)
    if [ $# -ne 3 ]; then
      echo -e "${RED}Error: rebase requires an OpenClaw version${NC}" >&2
      echo "Usage: $0 <current-version> rebase <openclaw-version>" >&2
      echo "Example: $0 v2026.2.26-0 rebase 2026.3.1" >&2
      exit 1
    fi
    new_base=$3
    # Strip optional v prefix from openclaw version
    new_base="${new_base#v}"
    # Validate format
    if [[ ! $new_base =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo -e "${RED}Error: Invalid OpenClaw version format: $3${NC}" >&2
      echo "Expected format: 2026.3.1 or v2026.3.1" >&2
      exit 1
    fi
    new_version="v${new_base}-0"
    ;;
  *)
    echo -e "${RED}Error: Invalid command: $command${NC}" >&2
    echo "Must be one of: bump, rebase" >&2
    exit 1
    ;;
esac

echo "$new_version"
