#!/usr/bin/env bash
# dev-link.sh -- Symlink the repo into ~/.claude for development
#
# Instead of copying files (like install.sh does), this creates symlinks
# so that edits in the repo are immediately live in Claude Code.
# Run this once after cloning; after that, `git pull` is all you need.
#
# Usage:
#   cd ~/Documents/GitHub/ship-it
#   bash dev-link.sh
#
# To undo:
#   rm ~/.claude/commands/ship-it.md
#   (then re-install if needed)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"
COMMANDS_DIR="${CLAUDE_DIR}/commands"
SKILL_FILE="$SCRIPT_DIR/skills/ship-it/SKILL.md"

# Verify we're in the repo
if [ ! -f "$SKILL_FILE" ]; then
  echo "ERROR: Run this from the ship-it repo root."
  echo "       Expected: $SKILL_FILE"
  exit 1
fi

echo ""
echo "Linking /ship-it skill for development..."
echo ""

# Ensure target directories exist
mkdir -p "$COMMANDS_DIR"

# Link skill file as command
target="$COMMANDS_DIR/ship-it.md"
if [ -L "$target" ] || [ -f "$target" ]; then
  rm "$target"
fi
ln -s "$SKILL_FILE" "$target"
echo "  + ~/.claude/commands/ship-it.md -> $SKILL_FILE"

echo ""
echo "Done! Repo is now live-linked to Claude Code."
echo "  - Edits in the repo take effect immediately"
echo "  - git pull syncs collaborator changes instantly"
echo "  - To undo: rm ~/.claude/commands/ship-it.md"
echo ""
