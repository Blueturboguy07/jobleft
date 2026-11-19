#!/usr/bin/env bash
# Sign one file with the publik update key (minisign Ed25519, as the update packages are signed), with the version
# bound into the signature's trusted comment, and write <file>.sig next to it. scripts/publik-release.sh signs the feed
# (latest.json) with it.
#
# Usage: apps/shell/scripts/updater-sign-file.sh <file> <version>
# Key:   TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD from the environment; when unset, read from
#        the login keychain item UPDATE_KEY_SERVICE (default "publik-update-key", accounts mann-private and
#        mann-password), as apps/shell/scripts/updater-pack-macos.sh does. Never printed.
# CLI:   TAURI_CLI (a command), else @tauri-apps/cli/tauri.js of apps/shell run with node.
set -euo pipefail
FILE="${1:?file}"
VERSION="${2:?version}"
SHELL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$FILE" ] || { echo "No such file: $FILE" >&2; exit 1; }

if [ -n "${TAURI_CLI:-}" ]; then
  TAURI=("$TAURI_CLI")
else
  CLI_JS="$(cd "$SHELL_DIR" && node -p "require.resolve('@tauri-apps/cli/tauri.js', { paths: ['.'] })" 2>/dev/null || true)"
  [ -n "$CLI_JS" ] || { echo "No Tauri CLI: set TAURI_CLI or run pnpm install." >&2; exit 1; }
  TAURI=(node "$CLI_JS")
fi

SERVICE="${UPDATE_KEY_SERVICE:-publik-update-key}"
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  TAURI_SIGNING_PRIVATE_KEY="$(security find-generic-password -s "$SERVICE" -a "${UPDATE_KEY_ACCOUNT:-mann-private}" -w 2>/dev/null || true)"
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -s "$SERVICE" -a "${UPDATE_KEY_PASSWORD_ACCOUNT:-mann-password}" -w 2>/dev/null || true)"
fi
[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || { echo "No update key: set TAURI_SIGNING_PRIVATE_KEY or add the keychain item $SERVICE." >&2; exit 1; }
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

rm -f "$FILE.sig"
"${TAURI[@]}" signer sign --app-version "$VERSION" "$FILE" < /dev/null >/dev/null
[ -s "$FILE.sig" ] || { echo "No signature was written for $FILE" >&2; exit 1; }
echo "Signature: $FILE.sig (version $VERSION)"
