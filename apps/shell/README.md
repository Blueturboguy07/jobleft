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

Cargo output goes to the shared target folder `.cache/cargo-target` (`CARGO_TARGET_DIR`), never into the package. The
Tauri CLI (`@tauri-apps/cli`, a dev dependency) is run by its file in the pnpm store, because `pnpm exec tauri` drops the
link on this workspace's install policy.

## What the bundle contains

| Path in `jobleft.app/Contents` | Source | Made by |
|---|---|---|
| `MacOS/jobleft` | `src-tauri/src` | `tauri build` |
| `MacOS/node` | `src-tauri/binaries/node-aarch64-apple-darwin`: the official Node 24.18.0 arm64 binary from nodejs.org, checked against its `SHASUMS256.txt` | by hand (once): download `node-v24.18.0-darwin-arm64.tar.gz` and `SHASUMS256.txt` from `https://nodejs.org/dist/v24.18.0/`, verify with `shasum -a 256 -c`, copy `bin/node` to that path |
| `Resources/server/` | `apps/server` (src, ui-fallback, package.json) with every `@jobleft/*` package it needs under `node_modules/@jobleft/<name>` and the production third-party packages flat under `node_modules/<name>` (from `pnpm deploy --prod`; `onnxruntime-node` keeps only its darwin/arm64 binary). Every `.ts` file is transpiled to `.js` by esbuild, file by file, so workers and `import.meta.url` paths still work; Node never strips types inside `node_modules` | `scripts/pack.ts` |
| `Resources/ui/` | `apps/ui/dist` | `scripts/pack.ts` |

`src-tauri/binaries/`, `src-tauri/resources/` and `src-tauri/gen/` are build inputs and outputs; git ignores them.

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
