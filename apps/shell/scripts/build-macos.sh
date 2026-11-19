#!/usr/bin/env bash
# Builds jobleft for macOS so that someone else can open it: Developer ID signature, hardened runtime with the
# entitlements the Node sidecar needs, every Mach-O inside the bundle signed (the notary service refuses one that is
# not), the app notarized and stapled, and the dmg rebuilt around the stapled app, signed, notarized and stapled too
# (an unstapled dmg needs the network to validate and then reads as a corrupt download).
# A notarized build also gets the update bundle: jobleft_<version>_aarch64.app.tar.gz and its .sig, packed from the
# stapled app and signed with the publik update key (apps/shell/scripts/updater-pack-macos.sh, docs/updates.md).
#
# Usage: apps/shell/scripts/build-macos.sh [--skip-notarize] [--app <jobleft.app> --out <dir>]
#   --app <jobleft.app>          do not build: sign, notarize and pack this app, built elsewhere (the
#                                jobleft-macos-arm64-app artifact of publik-build.yml; scripts/publik-release.sh uses
#                                this). The app is signed in place. Its Contents/Resources/publik-app-token.txt must
#                                carry the public publik app token.
#   --out <dir>                  where the dmg and the update bundle go (default: the cargo target bundle folders)
#   NOTARY_PROFILE=<name>        a `xcrun notarytool store-credentials` profile (default: publik)
#   APPLE_SIGNING_IDENTITY=<id>  default "Developer ID Application: Mann Bellani (R5R3ZS54LV)"; a development
#                                certificate is refused (it signs fine and Gatekeeper still blocks it)
#   TAURI_SIGNING_PRIVATE_KEY(+_PASSWORD), else the login keychain item "publik-update-key": the update key
#   (needed only for a notarized build; never printed).
#   The public publik app token comes from apps/shell/publik-app-token.local (scripts/pack.ts); a release without
#   it is refused because "Connect to publik" would be dead in the shipped app.
set -euo pipefail
CALLER_PWD="$PWD"
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
abs() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s' "$CALLER_PWD/$1" ;; esac; }
SKIP_NOTARIZE=0
PREBUILT=""
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-notarize) SKIP_NOTARIZE=1; shift ;;
    --app) PREBUILT="$(abs "${2:?--app needs a path}")"; shift 2 ;;
    --out) OUT="$(abs "${2:?--out needs a folder}")"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done
IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Mann Bellani (R5R3ZS54LV)}"
PROFILE="${NOTARY_PROFILE:-publik}"
case "$IDENTITY" in "Developer ID Application:"*) ;; *) echo "Refusing: '$IDENTITY' is not a Developer ID Application identity." >&2; exit 1 ;; esac
security find-identity -v -p codesigning | grep -qF "$IDENTITY" || { echo "No such identity in the keychain: $IDENTITY" >&2; exit 1; }
export CARGO_TARGET_DIR="$ROOT/.cache/cargo-target"
export APPLE_SIGNING_IDENTITY="$IDENTITY"
ENT="$ROOT/apps/shell/src-tauri/Entitlements.plist"

if [ -n "$PREBUILT" ]; then
  APP="$PREBUILT"
  [ -d "$APP/Contents/MacOS" ] || { echo "Not an app bundle: $APP" >&2; exit 1; }
  if [ "$SKIP_NOTARIZE" = 0 ] && ! grep -qE '^pat_jobleft_[A-Za-z0-9]+$' "$APP/Contents/Resources/publik-app-token.txt" 2>/dev/null; then
    echo "Refusing to release an app without Contents/Resources/publik-app-token.txt (the public publik app token)." >&2; exit 1
  fi
  echo "==> Signing the app built elsewhere: $APP"
else
  if [ "$SKIP_NOTARIZE" = 0 ] && ! grep -qE '^pat_jobleft_[A-Za-z0-9]+$' apps/shell/publik-app-token.local 2>/dev/null; then
    echo "Refusing to build a release without apps/shell/publik-app-token.local (the public publik app token)." >&2; exit 1
  fi
  echo "==> UI, sidecar tree, release bundle"
  pnpm --filter @jobleft/ui build >/dev/null
  node apps/shell/scripts/pack.ts
  TAURI="$(cd "$ROOT/apps/shell" && node -p "require.resolve('@tauri-apps/cli/tauri.js', { paths: ['.'] })")"
  # No updater artifacts here: tauri build would pack the app before it is re-signed below. The update bundle is packed
  # from the final, stapled app at the end.
  ( cd apps/shell && node "$TAURI" build --bundles app,dmg --config '{"bundle":{"createUpdaterArtifacts":false}}' )
  APP="$CARGO_TARGET_DIR/release/bundle/macos/jobleft.app"
  [ -d "$APP" ] || { echo "No jobleft.app was produced." >&2; exit 1; }
fi

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

if [ -n "$PREBUILT" ]; then
  VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
else
  VERSION="$(python3 -c "import json;print(json.load(open('apps/shell/src-tauri/tauri.conf.json'))['version'])")"
fi
DMG_DIR="${OUT:-$CARGO_TARGET_DIR/release/bundle/dmg}"
mkdir -p "$DMG_DIR"
DMG_DIR="$(cd "$DMG_DIR" && pwd)"
DMG="$DMG_DIR/jobleft_${VERSION}_aarch64.dmg"
echo "==> Building the dmg around the signed app: $DMG"
STAGE="$(mktemp -d)"
# An APFS clone (cp -c) takes no disk space; a plain copy when the volume cannot clone.
cp -Rc "$APP" "$STAGE/jobleft.app" 2>/dev/null || { rm -R "$STAGE/jobleft.app" 2>/dev/null; cp -R "$APP" "$STAGE/jobleft.app"; }
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
  echo "==> Update bundle (the stapled app, signed with the update key)"
  UPD="${OUT:-$CARGO_TARGET_DIR/release/bundle/updater}"
  apps/shell/scripts/updater-pack-macos.sh "$APP" "$UPD"
fi
echo
echo "App: $APP"
echo "Dmg: $DMG ($(du -h "$DMG" | cut -f1))"
if [ "$SKIP_NOTARIZE" = 0 ]; then echo "Update bundle: $UPD/jobleft_${VERSION}_aarch64.app.tar.gz (+ .sig)"; else echo "Not notarized: no update bundle (it is made only from a notarized app)."; fi
