#!/usr/bin/env bash
# Builds the Linux AppImage: the Node runtime, the sidecar tree, then `tauri build --bundles appimage`.
# Usage: bash apps/shell/scripts/build-linux.sh   (from anywhere; needs Rust, webkit2gtk-4.1, libayatana-appindicator)
# Output: .cache/cargo-target/release/bundle/appimage/jobleft_<version>_amd64.AppImage
set -euo pipefail

SHELL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$SHELL_DIR/../.." && pwd)"
cd "$SHELL_DIR"

node scripts/fetch-node.mjs --target linux-x64
node scripts/pack.ts --target linux-x64

# linuxdeploy-plugin-gtk copies gdk-pixbuf's loaders folder, which gdk-pixbuf 2.44+ no longer has (the loaders are
# built in), and then fails on `cp ''`. Tauri downloads the plugin once into ~/.cache/tauri; fetch it first if needed
# and make it skip folders that do not exist.
PLUGIN="${XDG_CACHE_HOME:-$HOME/.cache}/tauri/linuxdeploy-plugin-gtk.sh"
if [ ! -f "$PLUGIN" ]; then
  mkdir -p "$(dirname "$PLUGIN")"
  curl -fsSL -o "$PLUGIN" https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh
  chmod +x "$PLUGIN"
fi
if ! grep -q 'jobleft: skip missing' "$PLUGIN"; then
  sed -i 's|^\(\s*\)pushd "\$LD_GTK_LIBRARY_PATH"$|\1[ -e "$elem" ] \|\| continue  # jobleft: skip missing\n&|' "$PLUGIN"
fi

# Update information (AppImage spec): tells AppImageUpdate, Gear Lever and similar tools where newer versions are.
# The app itself never checks; a tool asks only when the person tells it to. The build also writes a .zsync file next
# to the AppImage, which goes into each GitHub release with it. Default: the releases of the GitHub repository that
# `origin` points at. JOBLEFT_UPDATE_INFO=<value> sets it by hand; JOBLEFT_UPDATE_INFO=none leaves it out.
UPDATE_INFO="${JOBLEFT_UPDATE_INFO:-}"
if [ -z "$UPDATE_INFO" ]; then
  ORIGIN="$(git -C "$ROOT" remote get-url origin 2>/dev/null || true)"
  if [[ "$ORIGIN" =~ github\.com[:/]([^/]+)/([^/]+)$ ]]; then
    UPDATE_INFO="gh-releases-zsync|${BASH_REMATCH[1]}|${BASH_REMATCH[2]%.git}|latest|jobleft_*_amd64.AppImage.zsync"
  fi
fi
if [ -n "$UPDATE_INFO" ] && [ "$UPDATE_INFO" != "none" ]; then
  export LDAI_UPDATE_INFORMATION="$UPDATE_INFO"
  echo "update information: $UPDATE_INFO"
fi

# NO_STRIP: linuxdeploy's bundled strip is older than current distro libraries (.relr.dyn) and fails on them.
export NO_STRIP=true
export CARGO_TARGET_DIR="$ROOT/.cache/cargo-target"
OUT="$CARGO_TARGET_DIR/release/bundle/appimage"
rm -f "$OUT"/*.AppImage "$OUT"/*.zsync
node "$(node -p "require.resolve('@tauri-apps/cli/tauri.js', { paths: ['.'] })")" build --bundles appimage
# appimagetool writes the .zsync into the folder it ran in; keep it next to the AppImage.
for z in "$SHELL_DIR"/*.zsync "$SHELL_DIR"/src-tauri/*.zsync "$OUT"/*/*.zsync; do [ -f "$z" ] && mv "$z" "$OUT/"; done
ls -la "$OUT"/*.AppImage "$OUT"/*.zsync 2>/dev/null || true
