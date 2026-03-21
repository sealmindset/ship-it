#!/usr/bin/env bash
# install.sh -- Install or update /ship-it skill into Claude Code
#
# Install from a cloned repo:
#   git clone https://github.com/sealmindset/ship-it.git
#   cd ship-it && bash install.sh
#
# Install via curl (no clone needed):
#   curl -fsSL https://raw.githubusercontent.com/sealmindset/ship-it/main/install.sh | bash
#
# Update (same command either way):
#   curl -fsSL https://raw.githubusercontent.com/sealmindset/ship-it/main/install.sh | bash
#   -- or from the cloned repo: git pull && bash install.sh

set -euo pipefail

GITHUB_REPO="sealmindset/ship-it"
GITHUB_BRANCH="main"
GITHUB_RAW="https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}"
CLAUDE_DIR="${HOME}/.claude"
COMMANDS_DIR="${CLAUDE_DIR}/commands"
SHIPIT_DIR="${CLAUDE_DIR}/ship-it"
VERSION_FILE="${SHIPIT_DIR}/VERSION"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()  { echo "  $*"; }
ok()    { echo "  + $*"; }
warn()  { echo "  WARN: $*"; }
fail()  { echo ""; echo "  ERROR: $*"; echo ""; exit 1; }

installed_version() {
  if [ -f "$VERSION_FILE" ]; then
    cat "$VERSION_FILE" | tr -d '[:space:]'
  else
    echo "none"
  fi
}

remote_version() {
  curl -fsSL "${GITHUB_RAW}/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "unknown"
}

# ---------------------------------------------------------------------------
# Determine source: local repo or download from GitHub
# ---------------------------------------------------------------------------

detect_source() {
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"

  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/skills/ship-it/SKILL.md" ] && [ -d "$SCRIPT_DIR/templates" ]; then
    SOURCE="local"
    REPO_DIR="$SCRIPT_DIR"
  else
    SOURCE="remote"
    REPO_DIR=""
  fi
}

# ---------------------------------------------------------------------------
# Download repo to a temp directory (for curl installs)
# ---------------------------------------------------------------------------

download_repo() {
  TMPDIR_REPO="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_REPO"' EXIT

  echo ""
  echo "Downloading latest /ship-it skill..."
  echo ""

  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 --branch "$GITHUB_BRANCH" \
      "https://github.com/${GITHUB_REPO}.git" "$TMPDIR_REPO/ship-it" 2>/dev/null \
      || fail "Could not download from GitHub. Check your internet connection."
    REPO_DIR="$TMPDIR_REPO/ship-it"
  else
    curl -fsSL "https://github.com/${GITHUB_REPO}/archive/refs/heads/${GITHUB_BRANCH}.tar.gz" \
      -o "$TMPDIR_REPO/ship-it.tar.gz" \
      || fail "Could not download from GitHub. Check your internet connection."
    tar -xzf "$TMPDIR_REPO/ship-it.tar.gz" -C "$TMPDIR_REPO" \
      || fail "Could not extract download."
    REPO_DIR="$TMPDIR_REPO/ship-it-${GITHUB_BRANCH}"
  fi

  [ -f "$REPO_DIR/skills/ship-it/SKILL.md" ] || fail "Download incomplete -- skills/ship-it/SKILL.md not found."
  [ -d "$REPO_DIR/templates" ]                || fail "Download incomplete -- templates/ not found."
}

# ---------------------------------------------------------------------------
# Install skill
# ---------------------------------------------------------------------------

install_skill() {
  mkdir -p "$COMMANDS_DIR"
  mkdir -p "$SHIPIT_DIR"

  # Copy skill entry point as a command
  echo "  Copying skill command..."
  cp "$REPO_DIR/skills/ship-it/SKILL.md" "$COMMANDS_DIR/ship-it.md"
  ok "ship-it.md"

  # Copy templates
  echo "  Copying templates..."
  rm -rf "$SHIPIT_DIR/templates"
  cp -r "$REPO_DIR/templates" "$SHIPIT_DIR/templates"

  # Copy src
  echo "  Copying src..."
  rm -rf "$SHIPIT_DIR/src"
  cp -r "$REPO_DIR/src" "$SHIPIT_DIR/src"

  # Verify
  [ -d "$SHIPIT_DIR/templates" ] || fail "Copy failed -- templates directory missing."
  [ -d "$SHIPIT_DIR/src" ]       || fail "Copy failed -- src directory missing."

  # Write version file
  if [ -f "$REPO_DIR/VERSION" ]; then
    cp "$REPO_DIR/VERSION" "$VERSION_FILE"
  else
    echo "0.0.0" > "$VERSION_FILE"
  fi
}

# ---------------------------------------------------------------------------
# Report results
# ---------------------------------------------------------------------------

report() {
  local new_ver
  new_ver="$(installed_version)"

  echo ""
  if [ "$ACTION" = "update" ]; then
    echo "Updated successfully! (v${OLD_VERSION} -> v${new_ver})"
  else
    echo "Installed successfully! (v${new_ver})"
  fi

  echo ""
  echo "  Skills installed:"
  echo "    /ship-it  -- Ship your code to production"
  echo ""
  echo "  Files copied to:"
  echo "    $COMMANDS_DIR/ship-it.md"
  echo "    $SHIPIT_DIR/templates/"
  echo "    $SHIPIT_DIR/src/"
  echo ""
  echo "  IMPORTANT: Restart Claude Code for changes to take effect."
  echo ""
  echo "  To get started:"
  echo "    cd your-project"
  echo "    claude"
  echo "    /ship-it"
  echo ""
  echo "  To update later:"
  echo "    curl -fsSL https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/install.sh | bash"
  echo ""
}

# ---------------------------------------------------------------------------
# Check for updates
# ---------------------------------------------------------------------------

check_update() {
  local current remote
  current="$(installed_version)"
  remote="$(remote_version)"

  if [ "$remote" = "unknown" ]; then
    echo "Could not check for updates. Verify your internet connection."
    return 1
  fi

  if [ "$current" = "$remote" ]; then
    echo "You're already on the latest version (v${current})."
    return 0
  fi

  echo "Update available: v${current} -> v${remote}"
  return 2
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  OLD_VERSION="$(installed_version)"
  if [ "$OLD_VERSION" = "none" ]; then
    ACTION="install"
  else
    ACTION="update"
  fi

  echo ""
  if [ "$ACTION" = "update" ]; then
    echo "Updating /ship-it skill (currently v${OLD_VERSION})..."
  else
    echo "Installing /ship-it skill into Claude Code..."
  fi
  echo ""

  detect_source
  if [ "$SOURCE" = "remote" ]; then
    download_repo
  fi

  install_skill
  report
}

if [ "${1:-}" = "check" ]; then
  check_update
  exit $?
fi

main
