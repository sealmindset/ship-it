#!/usr/bin/env bash
# install.sh -- Install /ship-it skill into Claude Code
#
# Usage:
#   git clone https://github.com/sealmindset/ship-it.git
#   cd ship-it
#   bash install.sh
#
# Or one-liner:
#   git clone https://github.com/sealmindset/ship-it.git && cd ship-it && bash install.sh

set -euo pipefail

# Resolve the repo directory (where this script lives)
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"
COMMANDS_DIR="${CLAUDE_DIR}/commands"
SHIPIT_DIR="${CLAUDE_DIR}/ship-it"

echo ""
echo "Installing /ship-it skill into Claude Code..."
echo ""

# Verify we're running from the cloned repo
if [ ! -f "$REPO_DIR/skills/ship-it/SKILL.md" ]; then
  echo "ERROR: Cannot find skills/ship-it/SKILL.md in $REPO_DIR"
  echo ""
  echo "Make sure you've cloned the repo and are running from inside it:"
  echo "  git clone https://github.com/sealmindset/ship-it.git"
  echo "  cd ship-it"
  echo "  bash install.sh"
  exit 1
fi

# Create target directories
mkdir -p "$COMMANDS_DIR"
mkdir -p "$SHIPIT_DIR"

# Copy skill entry point as a command
echo "  Copying skill command..."
cp "$REPO_DIR/skills/ship-it/SKILL.md" "$COMMANDS_DIR/ship-it.md"
echo "    + ship-it.md"

# Copy templates
echo "  Copying templates..."
rm -rf "$SHIPIT_DIR/templates"
cp -r "$REPO_DIR/templates" "$SHIPIT_DIR/templates"

# Copy src
echo "  Copying src..."
rm -rf "$SHIPIT_DIR/src"
cp -r "$REPO_DIR/src" "$SHIPIT_DIR/src"

# Verify the copy worked
if [ ! -d "$SHIPIT_DIR/templates" ]; then
  echo ""
  echo "ERROR: Copy failed -- $SHIPIT_DIR/templates does not exist."
  echo "Try running manually:"
  echo "  mkdir -p ~/.claude/ship-it"
  echo "  cp -r $REPO_DIR/templates ~/.claude/ship-it/"
  echo "  cp -r $REPO_DIR/src ~/.claude/ship-it/"
  exit 1
fi

echo ""
echo "Installed successfully!"
echo ""
echo "  Skills installed:"
echo "    /ship-it  -- Ship your code to production"
echo ""
echo "  Files copied to:"
echo "    $COMMANDS_DIR/ship-it.md"
echo "    $SHIPIT_DIR/templates/"
echo "    $SHIPIT_DIR/src/"
echo ""
echo "  IMPORTANT: Restart Claude Code for the skill to take effect."
echo ""
echo "  To get started:"
echo "    cd your-project"
echo "    claude"
echo "    /ship-it"
echo ""
