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

# NO_STRIP: linuxdeploy's bundled strip is older than current distro libraries (.relr.dyn) and fails on them.
export NO_STRIP=true
export CARGO_TARGET_DIR="$ROOT/.cache/cargo-target"
node "$(node -p "require.resolve('@tauri-apps/cli/tauri.js', { paths: ['.'] })")" build --bundles appimage
ls -la "$CARGO_TARGET_DIR"/release/bundle/appimage/*.AppImage
