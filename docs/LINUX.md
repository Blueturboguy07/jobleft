# jobleft on Linux

jobleft also runs on Linux as an AppImage: one file that holds the app, its own copy of Node and the libraries it needs. It is the same app as on the Mac, with the same feed, match scores, resumes, tracker, network and assistant. This page covers installing it, how the Linux build works, and building it yourself.

## Install

1. Download `jobleft_<version>_amd64.AppImage` from the [latest release](https://github.com/Dayv0ps/jobleft/releases/latest).
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
| A keyring: GNOME Keyring or KWallet, plus `secret-tool` (package `libsecret`) | Stores your AI keys | Keys go to an encrypted file in the data folder instead, also when the keyring is installed but not running or locked. Everything still works. |
| `notify-send` (package `libnotify`) | Follow-up reminders | No pop-up. Reminders still show in the app. |
| A system tray | The tray menu (Open, Check for jobs now, Pause, Quit) | No tray icon. KDE, XFCE, Hyprland bars and most others have one; plain GNOME needs the "AppIndicator and KStatusNotifierItem Support" extension. |
| `wl-copy` (Wayland), or `xclip`/`xsel` (X11) | `--copy` in the network command-line tool only | Use `--out <file>` instead |

If it fails with a FUSE error, run it with `--appimage-extract-and-run`, or install your distro's `fuse` package.

### Troubleshooting

**Starting it again does nothing, or the command returns at once.** jobleft runs once per account. A second start only brings the open window forward, and the window may be hidden in the tray. To start fresh, close every copy first:

```sh
pkill -f jobleft          # the background service stops with the app
./jobleft_*_amd64.AppImage
```

**The window is blank.** WebKitGTK, which draws the window, cannot use its newer renderer with some graphics drivers. With the NVIDIA driver, jobleft turns that renderer off by itself (since v0.1.3-linux.2). With any other driver, close every copy (see above) and start it with:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./jobleft_*_amd64.AppImage
```

If it is still blank, add `WEBKIT_DISABLE_COMPOSITING_MODE=1` as well. Setting `WEBKIT_DISABLE_DMABUF_RENDERER=0` keeps the renderer on, even with NVIDIA.

**The window says jobleft could not start its local service.** The reason is in `~/.local/share/jobleft/logs/sidecar.log`.

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
| AI keys | macOS Keychain | System keyring through `secret-tool` (GNOME Keyring, KWallet); when there is none or it does not answer, an AES-256-GCM encrypted file in `<data folder>/secrets` |
| Notifications | Notification Center | `notify-send` |
| Copy a draft (CLI) | `pbcopy` | `wl-copy`, `xclip` or `xsel` |
| Menu | Menu bar | System tray |

The encrypted key file (used only when the keyring is missing or not working) stops plain-text search and accidental copies. It cannot stop a program running as your own user from reading it, so a keyring is the better choice. Backups made in Settings → Data and backup never include keys, either way.

Set `JOBLEFT_HOME=/some/folder` before starting the AppImage to use a different data folder (handy for trying it without touching your real data).

### AI on the Linux build

Search, filters, match scores and the tracker use no AI. For tailoring, letters and the assistant, use **a model on this computer** (Ollama, LM Studio or any OpenAI-compatible server) or **your own key** (Anthropic or OpenAI).

The **publik API** option (pay per use, no key) is off in this build. It needs a private app token that only the official releases carry, so "Connect to publik" says so in plain words and everything else works.

## Update

jobleft never checks for updates by itself. When a new version comes out, either:

- **Replace the file by hand.** Download the new AppImage from the [latest release](https://github.com/Dayv0ps/jobleft/releases/latest), make it executable, delete the old one, and start the new one.
- **Use an update tool.** The AppImage carries its own update information, so [AppImageUpdate](https://github.com/AppImageCommunity/AppImageUpdate) finds the newest release and downloads only the parts that changed:

  ```sh
  appimageupdatetool jobleft_*_amd64.AppImage
  ```

  Other AppImage managers that read update information work the same way. A tool contacts GitHub only when you run it.

Quit jobleft from the tray menu before replacing the file. Your data is not in the AppImage, so an update keeps everything: profile, resumes, tracker, boards and saved keys stay in `~/.local/share/jobleft`. A newer version upgrades its database the first time it starts.

To hear about new versions, open the repository on GitHub and choose **Watch → Custom → Releases**.

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

The script also embeds update information, which tells AppImage update tools where newer versions are. By default it points at the GitHub releases of the repository your `origin` remote names, for example `gh-releases-zsync|Dayv0ps|jobleft|latest|jobleft_*_amd64.AppImage.zsync`. Set `JOBLEFT_UPDATE_INFO=<value>` to choose another, or `JOBLEFT_UPDATE_INFO=none` to leave it out. The build then writes `jobleft_<version>_amd64.AppImage.zsync` next to the AppImage; upload it with every release. Check what a build carries with `./jobleft_*_amd64.AppImage --appimage-updateinformation`.

An AppImage runs on systems with the same or a newer glibc than the one it was built on. To make one that runs on older distros, build on the oldest system you want to support, for example an Ubuntu 22.04 container.

To run without packaging at all, `npx pnpm@12.4.1 start` opens the app in your browser (data in `.jobleft-dev`).

## Publish an update

For whoever publishes the Linux builds. This fork tracks the original repository as the `upstream` remote.

1. Bring in the original's changes and test them:

   ```sh
   git fetch upstream
   git checkout linux-appimage
   git merge upstream/main
   npx pnpm@12.4.1 install
   npx pnpm@12.4.1 -r test
   ```

2. Build and push:

   ```sh
   npx pnpm@12.4.1 --filter @jobleft/ui build
   bash apps/shell/scripts/build-linux.sh
   git push origin linux-appimage
   ```

3. Publish a release with **both** files from `.cache/cargo-target/release/bundle/appimage/`. Without the `.zsync` file, update tools cannot update:

   ```sh
   cd .cache/cargo-target/release/bundle/appimage
   gh release create v<version>-linux.<n> jobleft_*_amd64.AppImage jobleft_*_amd64.AppImage.zsync \
     --repo <owner>/jobleft --target linux-appimage --title "jobleft <version> for Linux (AppImage)" --notes "..."
   ```

   Name the tag after the app version: `v0.1.4-linux.1` for the first Linux build of 0.1.4, `v0.1.3-linux.2` for a Linux-only fix on 0.1.3. The update information always follows the *latest* release, so mark only finished builds as latest, never drafts or pre-releases. Put the AppImage's `sha256sum` in the release notes.

## Code changes for Linux

For anyone reviewing the port:

| File | Change |
|---|---|
| `apps/server/src/services/secrets.ts` | `secretServiceSecrets` (libsecret `secret-tool`, the secret on stdin) and `fileSecrets` (wraps ai-engine's encrypted file store); `linuxSecrets` uses the keyring and falls back to the file when a keyring write fails. `JOBLEFT_SECRET_STORE=secret-service\|file\|memory` overrides. |
| `packages/network/src/dev/notify.ts` | `notify-send` on Linux |
| `packages/network/src/cli.ts` | `--copy` through `wl-copy`, `xclip` or `xsel` |
| `apps/shell/src-tauri/src/lib.rs` | XDG data folder and `notify-send` on Linux |
| `apps/shell/scripts/fetch-node.mjs`, `pack.ts` | `linux-x64` target |
| `apps/shell/scripts/build-linux.sh`, `package.json` | The AppImage build (`pnpm --filter @jobleft/shell app:build:linux`), with update information and a `.zsync` file |
