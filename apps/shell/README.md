# @jobleft/shell

The desktop shell: a Tauri v2 app (`src-tauri`, Rust) that starts the local jobleft server as a sidecar, opens the one
window at `http://127.0.0.1:<port>/#token=<launch token>`, and lives in the menu bar when the window is closed. The
contract is [docs/INTERFACES.md](../../docs/INTERFACES.md) section 5.2; the Node-side constants (`sidecarEnv`,
`READY_TIMEOUT_MS`, `NOTIFICATION_POLL_MS`) are in `src/index.ts`.

What the shell does, in order: make a launch token; start `node src/main.js` from the bundled server tree with
`JOBLEFT_HOME`, `JOBLEFT_LAUNCH_TOKEN`, `JOBLEFT_PARENT_PID` and `JOBLEFT_UI_DIR`; wait for `run/server.json` and a
healthy `GET /api/v1/health` (15 s at most); only then open the window. No blank page and no "starting" page exist.
Closing the window hides it; the menu bar item offers **Open jobleft**, **Check for jobs now**, **Pause checks /
Continue checks**, the time of the last check, and **Quit jobleft**. Every minute it reads `GET /api/v1/notifications`,
shows each one through Notification Center and acks it. Quit (menu, Cmd-Q, SIGTERM or Ctrl-C) sends SIGTERM to the
server and waits up to 5 s; if the shell dies, the server sees the parent pid gone and exits by itself. A second launch
brings the first window forward.

Data lives in `~/Library/Application Support/jobleft` (or `JOBLEFT_HOME`). The shell writes `run/shell.json`
(`{ pid, port, windowShown, at }`) while it runs and `logs/sidecar.log` (the server's stdout and stderr).

## Commands

Run these in the repository root.

| Command | What it does |
|---|---|
| `pnpm --filter @jobleft/shell test` | Run the Node-side tests (`node --test "test/*.test.ts"`) |
| `pnpm --filter @jobleft/shell typecheck` | Type-check (`tsc -p tsconfig.json`, no output files) |
| `pnpm --filter @jobleft/ui build` | Build the UI the bundle ships (`apps/ui/dist`) |
| `pnpm --filter @jobleft/shell pack` | Build the sidecar tree under `src-tauri/resources/` (see below) |
| `pnpm --filter @jobleft/shell app:build` | `pack`, then `tauri build --debug --bundles app`: an unsigned `jobleft.app` at `.cache/cargo-target/debug/bundle/macos/jobleft.app` |
| `pnpm --filter @jobleft/shell tauri dev` | Run the shell from source against the packed tree (set `CARGO_TARGET_DIR` to the shared folder first) |
| `apps/shell/scripts/build-windows.ps1` | On Windows only: `build-macos.sh`'s counterpart, the whole build as one command (the UI, the sidecar tree, `jobleft_<version>_x64-setup.exe`, then install, start, health, stop). `--skip-smoke` stops after the installer |

Cargo output goes to the shared target folder `.cache/cargo-target` (`CARGO_TARGET_DIR`), never into the package. The
Tauri CLI (`@tauri-apps/cli`, a dev dependency) is run by its file in the pnpm store, because `pnpm exec tauri` drops the
link on this workspace's install policy.

## What the bundle contains

| Path in `jobleft.app/Contents` | Source | Made by |
|---|---|---|
| `MacOS/jobleft` | `src-tauri/src` | `tauri build` |
| `MacOS/node` | `src-tauri/binaries/node-aarch64-apple-darwin`: the official Node 24.18.0 arm64 binary from nodejs.org, checked against its `SHASUMS256.txt` | `node apps/shell/scripts/fetch-node.mjs` (downloads, verifies the sha, extracts; skips when present). Windows: `--target win-x64` puts `node-x86_64-pc-windows-msvc.exe` next to it |
| `Resources/server/` | `apps/server` (src, ui-fallback, package.json) with every `@jobleft/*` package it needs under `node_modules/@jobleft/<name>` and the production third-party packages flat under `node_modules/<name>` (from `pnpm deploy --prod`; `onnxruntime-node` keeps only its darwin/arm64 binary). Every `.ts` file is transpiled to `.js` by esbuild, file by file, so workers and `import.meta.url` paths still work; Node never strips types inside `node_modules` | `scripts/pack.ts` |
| `Resources/ui/` | `apps/ui/dist` | `scripts/pack.ts` |
| `Resources/publik-app-token.txt` | the public publik app token (`pat_jobleft_...`) from `JOBLEFT_PUBLIK_APP_TOKEN` or the git-ignored `apps/shell/publik-app-token.local`; empty when neither exists. With it, the shell starts the server with `JOBLEFT_PUBLIK_ALLOW_LIVE=1`; without it, "Connect to publik" is refused in plain words | `scripts/pack.ts` |

`src-tauri/binaries/`, `src-tauri/resources/` and `src-tauri/gen/` are build inputs and outputs; git ignores them.

## Windows

The same shell builds on Windows (`cfg(windows)` branches in `src/lib.rs`): the sidecar is `node.exe`, the data folder is
`%APPDATA%\jobleft`, the quit path is `POST /api/v1/shutdown` with the launch token (Windows has no SIGTERM), alerts are
toasts through the notification plugin, and the installer is NSIS per user (`installMode: currentUser`; WebView2 is
fetched by the bootstrapper when a machine lacks it). `.github/workflows/windows.yml` runs the tests on windows-latest,
builds the installer (`pack.ts --target win-x64`, `tauri build --bundles nsis`), installs it silently, starts the app,
checks health, stops it through the shutdown route, and attaches `jobleft_<version>_x64-setup.exe` to a release.
The installer is not code-signed yet (publik lists it as unsigned).

`pnpm --filter @jobleft/shell app:build` does not work on Windows: it is macOS-only (`$(cd ../.. && pwd)` is POSIX
syntax and `--bundles app` is a macOS target). `apps/shell/scripts/build-windows.ps1` is the counterpart of
`build-macos.sh`; it runs the sequence above as one command and then smoke-tests the result the way the workflow does.
It needs the Visual Studio Build Tools (`Microsoft.VisualStudio.Component.VC.Tools.x86.x64` is the MSVC C++ x64/x86
build tools component); `cl.exe` does not have to be on PATH, because cargo finds it through the same Visual Studio
detection CI relies on. The installer lands at `.cache/cargo-target/release/bundle/nsis/` (the workflow builds
without `CARGO_TARGET_DIR`, so on CI it is `apps/shell/src-tauri/target/release/bundle/nsis/`). A first build
compiles every Rust dependency, so it takes several minutes.

### What the Windows smoke test checks

The smoke test replaces the install at `%LOCALAPPDATA%\jobleft` (derived from `productName` and `installMode` in
`src-tauri/tauri.conf.json`, checked before anything is removed), installs over it, and starts the app against a
scratch `JOBLEFT_HOME` under `%TEMP%`. The real data folder `%APPDATA%\jobleft` is never read or written. Quit any
running `jobleft.exe` first: a second launch is handed to the running one by the single-instance plugin, which would
leave this launch waiting for run files that never arrive.

Every assertion is there because something stale can otherwise make a broken build look green. So the script never
searches the disk for a `jobleft.exe` to fall back on, and the run files it reads are this launch's own:

| Assertion | What it catches |
|---|---|
| The installer exits 0 | A silent NSIS failure. The run stops there instead of testing whatever an earlier build installed |
| `%LOCALAPPDATA%\jobleft\jobleft.exe` exists and was just written | An installer that exits 0 without installing |
| No `jobleft.exe` is running before the install | A launch the single-instance plugin would hand to another process |
| `run/server.json` is deleted before the launch and not older than it | A stale run file from an earlier run passing as this one's |
| `run/shell.json` names the pid this script launched | A run file belonging to some other jobleft |
| Both pids are gone afterwards | A smoke test that leaves the machine in a worse state than it found it |

A successful run deletes its scratch folder. A failed one keeps it and prints the path, because the sidecar log in it
is what says why.

## Test hooks (environment; the app never sets them)

| Variable | Effect |
|---|---|
| `JOBLEFT_HOME` | The data folder (a scratch folder under `/private/tmp` for a check) |
| `JOBLEFT_SHELL_NODE`, `JOBLEFT_SHELL_SERVER` | A Node binary and a server tree outside the bundle (`<server>/src/main.js` must exist) |
| `JOBLEFT_SHELL_PROBE` | A JavaScript file to run in the window 4 s after it opens; what it leaves in `document.title` after the prefix `PROBE:` lands in `run/probe.json` (evals/gate8-shell uses it to compare WKWebView with Chromium) |
| Everything the server reads (`JOBLEFT_AUTO_CRAWL`, `JOBLEFT_SEED_BOARDS`, `JOBLEFT_DEV`, ...) | Passed through to the sidecar |

## Rules

- ESM TypeScript that Node 24 runs directly on the Node side; Rust 2021 in `src-tauri`. No signing or notarizing here
  (gate G-release).
- Types that cross a package boundary live in `@jobleft/contracts`. Contracts change by addition only.
- Third-party code: read it first, install with scripts off, copy only MIT, Apache-2.0 or BSD code, and record each
  copy in `THIRD_PARTY_NOTICES.md`. The Rust dependencies are `tauri`, `tauri-plugin-single-instance`, `serde_json`
  and `libc` (all MIT or Apache-2.0).
- No personal data in any request, file or test. Tests use the fake persona "Jordan Testwell" (jordan.testwell@example.com).
