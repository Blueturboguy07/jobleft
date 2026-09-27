#!/usr/bin/env bash
# Builds jobleft for macOS so that someone else can open it: Developer ID signature, hardened runtime with the
# entitlements the Node sidecar needs, every Mach-O inside the bundle signed (the notary service refuses one that is
# not), the app notarized and stapled, and the dmg rebuilt around the stapled app, signed, notarized and stapled too
# (an unstapled dmg needs the network to validate and then reads as a corrupt download).
#
# Usage: apps/shell/scripts/build-macos.sh [--skip-notarize]
#   NOTARY_PROFILE=<name>        a `xcrun notarytool store-credentials` profile (default: publik)
#   APPLE_SIGNING_IDENTITY=<id>  default "Developer ID Application: Mann Bellani (R5R3ZS54LV)"; a development
#                                certificate is refused (it signs fine and Gatekeeper still blocks it)
#   The public publik app token comes from apps/shell/publik-app-token.local (scripts/pack.ts); a release without
#   it is refused because "Connect to publik" would be dead in the shipped app.
set -euo pipefail
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
SKIP_NOTARIZE=0
[ "${1:-}" = "--skip-notarize" ] && SKIP_NOTARIZE=1
IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Mann Bellani (R5R3ZS54LV)}"
PROFILE="${NOTARY_PROFILE:-publik}"
case "$IDENTITY" in "Developer ID Application:"*) ;; *) echo "Refusing: '$IDENTITY' is not a Developer ID Application identity." >&2; exit 1 ;; esac
security find-identity -v -p codesigning | grep -qF "$IDENTITY" || { echo "No such identity in the keychain: $IDENTITY" >&2; exit 1; }
if [ "$SKIP_NOTARIZE" = 0 ] && ! grep -qE '^pat_jobleft_[A-Za-z0-9]+$' apps/shell/publik-app-token.local 2>/dev/null; then
  echo "Refusing to build a release without apps/shell/publik-app-token.local (the public publik app token)." >&2; exit 1
fi
export CARGO_TARGET_DIR="$ROOT/.cache/cargo-target"
export APPLE_SIGNING_IDENTITY="$IDENTITY"
ENT="$ROOT/apps/shell/src-tauri/Entitlements.plist"

echo "==> UI, sidecar tree, release bundle"
pnpm --filter @jobleft/ui build >/dev/null
node apps/shell/scripts/pack.ts
TAURI="$(ls -d "$ROOT"/node_modules/.pnpm/@tauri-apps+cli@*/node_modules/@tauri-apps/cli | tail -1)/tauri.js"
( cd apps/shell && node "$TAURI" build --bundles app,dmg )
APP="$CARGO_TARGET_DIR/release/bundle/macos/jobleft.app"
[ -d "$APP" ] || { echo "No jobleft.app was produced." >&2; exit 1; }

echo "==> Signing every Mach-O inside the bundle (Node, the fit-model runtime), then the app"
# Inner binaries first, the bundle seal last; --deep is not used because it signs in the wrong order for nested code.
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q "Mach-O"; then codesign --force --options runtime --timestamp --entitlements "$ENT" --sign "$IDENTITY" "$f"; fi
done < <(find "$APP/Contents/Resources" "$APP/Contents/MacOS" -type f \( -name "*.node" -o -name "*.dylib" -o -name "node" -o -perm -u+x \) -print0)
codesign --force --options runtime --timestamp --entitlements "$ENT" --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

if [ "$SKIP_NOTARIZE" = 0 ]; then
  echo "==> Notarizing jobleft.app (profile $PROFILE)"
  ZIP="$(mktemp -d)/jobleft.zip"
  /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
  xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$APP"
  rm -f "$ZIP"
fi

VERSION="$(python3 -c "import json;print(json.load(open('apps/shell/src-tauri/tauri.conf.json'))['version'])")"
DMG_DIR="$CARGO_TARGET_DIR/release/bundle/dmg"
mkdir -p "$DMG_DIR"
DMG="$DMG_DIR/jobleft_${VERSION}_aarch64.dmg"
echo "==> Building the dmg around the signed app: $DMG"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/jobleft.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "jobleft" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
codesign --force --sign "$IDENTITY" --timestamp "$DMG"
if [ "$SKIP_NOTARIZE" = 0 ]; then
  echo "==> Notarizing the dmg"
  xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$APP"
  xcrun stapler validate "$DMG"
  spctl -a -t exec -vv "$APP"
fi
echo
echo "App: $APP"
echo "Dmg: $DMG ($(du -h "$DMG" | cut -f1))"
