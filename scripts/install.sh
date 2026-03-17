#!/usr/bin/env sh
set -eu

SCRIPT_URL="${OPENCLAW_VAULT_INSTALLER_URL:-https://raw.githubusercontent.com/openclaw/openclaw/main/extensions/openclaw-vault/scripts/install.mjs}"
TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t openclaw-vault)"
TMP_FILE="$TMP_DIR/install.mjs"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$SCRIPT_URL" -o "$TMP_FILE"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP_FILE" "$SCRIPT_URL"
else
  echo "[vault] Install failed: curl or wget is required." >&2
  exit 1
fi

node "$TMP_FILE" "$@"
