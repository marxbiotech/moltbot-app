#!/bin/bash
# Sync shared skills from shared-knowledge repo into this project's skills/ directory.
# These skills are .gitignored — they only need to exist at Docker build time.
#
# Usage:
#   ./scripts/sync-skills.sh                              # auto-detect ../shared-knowledge
#   SHARED_KNOWLEDGE_PATH=/path/to/repo ./scripts/sync-skills.sh  # explicit path

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SKILLS_DIR="$PROJECT_DIR/skills"

# Find shared-knowledge repo
SK_PATH="${SHARED_KNOWLEDGE_PATH:-$PROJECT_DIR/../shared-knowledge}"
SK_SKILLS="$SK_PATH/skills"

if [ ! -d "$SK_SKILLS" ]; then
    echo "ERROR: shared-knowledge skills not found at: $SK_SKILLS"
    echo "Set SHARED_KNOWLEDGE_PATH to the repo root."
    exit 1
fi

echo "Syncing skills from: $SK_SKILLS"
echo "             to:     $SKILLS_DIR"

SYNCED=0
for skill_dir in "$SK_SKILLS"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name="$(basename "$skill_dir")"

    # Copy skill directory (overwrite if exists)
    cp -r "$skill_dir" "$SKILLS_DIR/$skill_name"
    echo "  + $skill_name"
    SYNCED=$((SYNCED + 1))
done

echo "Synced $SYNCED skill(s)."
