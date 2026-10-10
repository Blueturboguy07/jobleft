# jobleft on Linux

jobleft also runs on Linux as an AppImage: one file that holds the app, its own copy of Node and the libraries it needs. It is the same app as on the Mac, with the same feed, match scores, resumes, tracker, network and assistant. This page covers installing it, how the Linux build works, and building it yourself.

## Install

1. Download `jobleft_<version>_amd64.AppImage` from the [latest release](RELEASES_URL).
2. Make it executable and run it:

   ```sh
   chmod +x jobleft_*_amd64.AppImage
   ./jobleft_*_amd64.AppImage
   ```

   Or right-click the file, open Properties, turn on "Allow executing file as program", and double-click it.

The first run asks the same questions as on the Mac: job function, job type, place, pay, work authorization, and a resume. Jobs appear within a minute.

To keep it somewhere tidy, move it to `~/Applications` (or `~/.local/bin`) first. The file can live anywhere; your data does not live in it.

### Requirements

| What | Why | If it is missing |
|---|---|---|
| x86_64 (64-bit Intel or AMD) | The AppImage is built for x86_64 | Does not run (no ARM build yet) |
| glibc 2.44 or newer | The build is made on a current Arch system | Does not start. Current rolling distros (Arch, CachyOS, EndeavourOS, Manjaro, openSUSE Tumbleweed) have it; older fixed releases (Ubuntu LTS, Debian stable) may not. Build from source on that system instead (see below). |
| A keyring: GNOME Keyring or KWallet, plus `secret-tool` (package `libsecret`) | Stores your AI keys | Keys go to an encrypted file in the data folder instead. Everything still works. |
| `notify-send` (package `libnotify`) | Follow-up reminders | No pop-up. Reminders still show in the app. |
| A system tray | The tray menu (Open, Check for jobs now, Pause, Quit) | No tray icon. KDE, XFCE, Hyprland bars and most others have one; plain GNOME needs the "AppIndicator and KStatusNotifierItem Support" extension. |
| `wl-copy` (Wayland), or `xclip`/`xsel` (X11) | `--copy` in the network command-line tool only | Use `--out <file>` instead |

If it fails with a FUSE error, run it with `--appimage-extract-and-run`, or install your distro's `fuse` package.

## How it works

The app has three parts. The Linux build uses all three exactly as the Mac build does; only the parts that talk to the operating system differ.

1. **The local service**: a Node server (`apps/server`) that reads the employer boards, keeps the database, scores jobs and runs the AI features. It listens on `127.0.0.1` only. The AppImage carries its own Node 24 runtime, so you do not need Node installed.
2. **The interface**: the web UI (`apps/ui`), served by the local service.
3. **The desktop shell**: a small Tauri app (`apps/shell`, Rust) that starts the service, opens the window once the service answers, and puts the menu in the system tray. On Linux the window is drawn by WebKitGTK.

Closing the window hides it; jobleft keeps checking for jobs from the tray. **Quit jobleft** in the tray menu stops the app and the service. A second launch brings the open window forward instead of starting another copy.

### What is different on Linux

| | macOS | Linux |
|---|---|---|
| Data folder | `~/Library/Application Support/jobleft` | `$XDG_DATA_HOME/jobleft`, normally `~/.local/share/jobleft` |
| AI keys | macOS Keychain | System keyring through `secret-tool` (GNOME Keyring, KWallet); without one, an AES-256-GCM encrypted file in `<data folder>/secrets` |
| Notifications | Notification Center | `notify-send` |
| Copy a draft (CLI) | `pbcopy` | `wl-copy`, `xclip` or `xsel` |
| Menu | Menu bar | System tray |

The encrypted key file (used only without a keyring) stops plain-text search and accidental copies. It cannot stop a program running as your own user from reading it, so a keyring is the better choice. Backups made in Settings → Data and backup never include keys, either way.

Set `JOBLEFT_HOME=/some/folder` before starting the AppImage to use a different data folder (handy for trying it without touching your real data).

### AI on the Linux build

Search, filters, match scores and the tracker use no AI. For tailoring, letters and the assistant, use **a model on this computer** (Ollama, LM Studio or any OpenAI-compatible server) or **your own key** (Anthropic or OpenAI).

The **publik API** option (pay per use, no key) is off in this build. It needs a private app token that only the official releases carry, so "Connect to publik" says so in plain words and everything else works.

## Uninstall

Delete the AppImage. To remove your data too, first use Settings → Data and backup → delete inside the app: it removes the data and the keys saved in your keyring. Removing `~/.local/share/jobleft` by hand leaves the keys behind; they are under services named `jobleft-…` in your keyring app (Seahorse, KWalletManager).

## Build from source

Needs Node 24 or newer, pnpm, Rust (stable), and the WebKitGTK and tray libraries.

```sh
# Arch / CachyOS
sudo pacman -S --needed webkit2gtk-4.1 libayatana-appindicator librsvg libsecret base-devel curl
# Debian / Ubuntu
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libsecret-tools build-essential curl
# Fedora
sudo dnf install webkit2gtk4.1-devel libayatana-appindicator-gtk3-devel librsvg2-devel libsecret
```

Then, from the repository root:

```sh
npx pnpm@12.4.1 install
npx pnpm@12.4.1 --filter @jobleft/ui build
bash apps/shell/scripts/build-linux.sh
```

The AppImage lands in `.cache/cargo-target/release/bundle/appimage/`. The script:

1. fetches the official Node 24 runtime for linux-x64 and checks it against nodejs.org's checksums,
2. packs the server and UI into the bundle (`apps/shell/scripts/pack.ts --target linux-x64`),
3. runs `tauri build --bundles appimage`.

It also works around two problems in the AppImage tooling on current distros:

- `NO_STRIP=true`: linuxdeploy's bundled `strip` is older than today's libraries and fails on them.
- gdk-pixbuf 2.44 and newer has no separate loaders folder, which makes linuxdeploy's GTK plugin fail. The script patches the plugin's cached copy (`~/.cache/tauri/linuxdeploy-plugin-gtk.sh`) to skip folders that do not exist.

An AppImage runs on systems with the same or a newer glibc than the one it was built on. To make one that runs on older distros, build on the oldest system you want to support, for example an Ubuntu 22.04 container.

To run without packaging at all, `npx pnpm@12.4.1 start` opens the app in your browser (data in `.jobleft-dev`).

## Code changes for Linux

For anyone reviewing the port:

| File | Change |
|---|---|
| `apps/server/src/services/secrets.ts` | `secretServiceSecrets` (libsecret `secret-tool`, the secret on stdin) and `fileSecrets` (wraps ai-engine's encrypted file store); Linux picks the keyring, else the file. `JOBLEFT_SECRET_STORE=secret-service\|file\|memory` overrides. |
| `packages/network/src/dev/notify.ts` | `notify-send` on Linux |
| `packages/network/src/cli.ts` | `--copy` through `wl-copy`, `xclip` or `xsel` |
| `apps/shell/src-tauri/src/lib.rs` | XDG data folder and `notify-send` on Linux |
| `apps/shell/scripts/fetch-node.mjs`, `pack.ts` | `linux-x64` target |
| `apps/shell/scripts/build-linux.sh`, `package.json` | The AppImage build (`pnpm --filter @jobleft/shell app:build:linux`) |
