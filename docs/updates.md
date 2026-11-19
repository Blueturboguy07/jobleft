# Updates

jobleft updates itself with `tauri-plugin-updater`. Every update package is signed with the publik update key. The
app checks each package against the public key in `apps/shell/src-tauri/tauri.conf.json` before it installs anything.
The code is a copy of the publik template (GSpot, `src-tauri/src/updates.rs`) with the jobleft changes below.

## How it works

- The app reads `https://publikhq.com/api/updates/jobleft/latest.json`. publik serves the `latest.json` asset of the
  scan-approved release tag, byte for byte. publik does not sign or change it, so the release `latest.json` must be
  complete and correct. The route answers 404 until a scan-approved release carries a `latest.json` asset. A 404 is
  silent in the background check, and a manual check shows it as an error.
- The app checks 10 s after launch and then once a day. "Check for Updates…" in the menu bar menu checks at once.
  `PUBLIK_NO_AUTO_UPDATE=1` turns off the automatic checks (the CI workflows set it).
- macOS: the app downloads the new `jobleft.app`, verifies it, and asks "Install and Restart" or "Later". On the yes,
  it puts the new app in place of the old one, stops the local service and restarts. If the user cannot write to the
  app's folder, macOS asks for an admin password after the yes.
- Windows: the app downloads the installer, verifies it, and asks "Restart and Install" or "Later". On the yes, it
  stops the local service (so that `node.exe` and the server files are free), and the installer runs with a progress
  bar only, then opens jobleft again.
- The signature must also name the version that `latest.json` announces (`requireSignedVersion`). The app never
  installs an older version.
- A failed automatic check goes to stderr only. A failed manual check shows the error.
- Code: `apps/shell/src-tauri/src/updates.rs`. Proof: `.github/workflows/updater-proof.yml`.

### Differences from the template

| What | Template (GSpot) | jobleft | Why |
|---|---|---|---|
| macOS install | in the background, then "Restart" | after "Install and Restart" (`INSTALL_IN_BACKGROUND = false`) | The local service reads its server and UI files from the bundle while it runs. A bundle swapped in the background serves the new UI and loads new modules into the old service until the restart. |
| Before the new version takes over | nothing | the local service stops (`updates::on_before_restart`, `stop_server`) | Windows: the installer must replace `node.exe`. macOS: the new copy must find the data folder free. |
| Timer | tokio | a thread with `std::thread::sleep` | The shell has no direct tokio dependency. |
| Log | `log` crate | stderr | The shell has no logger. |
| Self-test | `version`, `check`, `install`, `prompt` | also `restart`, and `PUBLIK_UPDATE_SELF_TEST_SIDECAR=1` | The proof takes the yes with the local service up. |

## The key

| Where | What |
|---|---|
| Release Mac, login keychain, service `publik-update-key` | `mann-private` (private key), `mann-password` (its password), `mann-public` (public key) |
| GitHub secrets on this repo | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (used by `windows.yml`, `publik-build.yml` and `updater-proof.yml`) |
| `apps/shell/src-tauri/tauri.conf.json` | `plugins.updater.pubkey` (public, key ID `F5E0515C77912BD0`) |

Keep a backup of the private key and its password. Without them, installed copies can never update again.

## Cut a release

On the release Mac (it has the Developer ID identity, the notary profile `publik` and the update key in the keychain),
from a clean checkout of `main`:

```sh
scripts/publik-release.sh <version>          # for example: scripts/publik-release.sh 0.1.10
```

That one command does the whole release for macOS and Windows, and stops before publishing on any failed check:

1. Checks: on `main`, clean tree, in step with `origin/main`; the tag is free; the version is above the latest
   release; enough free disk.
2. Sets the version in the six files a bump changes (`apps/shell/scripts/release-version.mjs`), commits and pushes to
   `main` (never forced). `PUBLIK_RELEASE_TRAILER` adds a trailer line to that commit.
3. Makes a DRAFT release on that commit.
4. Runs `publik-build.yml` on that commit and waits for it (a run that fails only in its test steps is run again, up to
   3 runs). `ci.yml` must be green on the commit.
5. Windows: puts the installer and its `.sig` from that run on the draft, after it checks them with the app's public key.
6. macOS: signs the app from that run on this Mac (inner binaries first, hardened runtime, `Entitlements.plist`),
   notarizes and staples it, makes the dmg (signed, notarized, stapled) and the update bundle (`.app.tar.gz` + `.sig`,
   signed with the update key from the keychain): `apps/shell/scripts/build-macos.sh --app`. Puts them on the draft.
7. Downloads every file back from the draft and checks it: the sha256 against GitHub's digest; the update signatures
   with the app's public key and version; the Info.plist and installer versions; codesign, spctl ("Notarized
   Developer ID") and stapler for the dmg and both copies of the app; one designated requirement; the publik app token
   as in the last release. Then it writes `latest.json` (absolute GitHub URLs), signs it (`latest.json.sig`), writes
   `SHA256SUMS.txt`, uploads them, downloads them back and checks them again.
8. Runs `clean-mac-check.yml` on the draft.
9. Publishes. Then it checks that the tag is on the release commit, every asset URL answers, the public `latest.json`
   is byte for byte the checked one, and the `windows` workflow that publishing starts leaves every asset as it was.

After any stop, fix the cause and run the same command again: each step skips what is done, and a half-done draft is
resumed. `--no-publish` stops with a checked draft. `--summary "..."` sets the release notes' first line and the notes
in `latest.json`. `scripts/publik-release.sh --help` lists every option. The script starts no app and prints no secret;
its working files are in `.cache/publik-release/v<version>/` (git-ignored; delete the folder after the release).

Installed copies update when publik approves the release at its next intake and serves its `latest.json`. Then run
the live proof (below) from the previous release to the new one.

`publik-build.yml` makes the unsigned macOS app without an update bundle: an update bundle of that app must never ship.
Its Windows installer comes with its `.sig`. `scripts/publik-release.sh` signs that app with the Developer ID and
packs the update bundle only after stapling (`apps/shell/scripts/updater-pack-macos.sh`).

`tauri build` without the key fails when `createUpdaterArtifacts` is on. For a local build without the key, add
`--config '{"bundle":{"createUpdaterArtifacts":false}}'` (`app:build` in `apps/shell/package.json` does).

## Roll back

The app installs only a version higher than its own. You cannot push an older version.

1. Stop the bad release at once: withdraw it in publik, or delete its `latest.json` asset. Copies that did not
   update yet stay on the old version.
2. Revert the bad change, give it a higher version (for example 0.1.10 after a bad 0.1.9), and cut a release. Copies
   on the bad version update to it.

Do not turn on `allowDowngrades`. It removes the only guard against an old, signed release served as a new one.

## Rotate the key

The public key is compiled into each copy, so a new key reaches users only through an update.

1. Make a new key: `node "$(cd apps/shell && node -p "require.resolve('@tauri-apps/cli/tauri.js', { paths: ['.'] })")" signer generate -w new.key`.
   Store the private key, its password and the public key in the keychain items and the repo secrets (new names
   first, so the old key stays available).
2. Put the new public key in `tauri.conf.json`. Release this version signed with the OLD key.
3. From the next release on, sign with the new key. Copies that skipped the bridge release can still update only to a
   release signed with the old key, so keep the old key until you accept that those copies stop updating.
4. If the private key leaks, cut the bridge release at once. A leaked key alone cannot push an update: the attacker
   must also control the feed on publikhq.com.

## Test

Run `updater-proof.yml`. It builds 0.0.1 and 0.0.2, installs 0.0.1 on `macos-latest` and `windows-latest`, and checks
that 0.0.1 refuses three bad feeds and then updates to 0.0.2. On Windows the good update runs with the local service
up. On macOS, 0.0.1 takes the yes with the local service up, and jobleft must come back as 0.0.2 with a working local
service and its window. Then it starts 0.0.1 once more and checks that the question is on screen while the app keeps
running and nothing is installed yet. Start it by hand (workflow_dispatch).

The app has a test hook for this: `PUBLIK_UPDATE_SELF_TEST=version|check|install|restart` runs the updater with no
window and no prompt and prints one JSON line. `prompt` runs the background path and shows the real question. The
hook does not click the buttons. `PUBLIK_UPDATE_SELF_TEST_SIDECAR=1` starts the local service first.

## Prove a release live

`live-update-proof.yml` (run it by hand, on `main`) takes a user's copy of a published release and lets it update
itself from the LIVE feed `https://publikhq.com/api/updates/jobleft/latest.json`, on `macos-latest` and
`windows-latest`:

```sh
gh workflow run live-update-proof.yml -f from_tag=v0.1.9 -f expect_version=0.1.10
```

- `from_tag`: the release a user has. Its dmg / setup.exe is downloaded from the GitHub release (on macOS with the
  quarantine flag, and Gatekeeper must accept it as "Notarized Developer ID") and installed as a user installs it.
- `expect_version`: what the app must run at the end. Give the `from_tag` version itself to check the harness while
  no newer version is live: the app must report "no update" and stay as it is.

The app starts the normal way: no test hook, no feed override, automatic checks on. It gets `DO_NOT_TRACK=1` and
`PUBLIK_ORIGIN=http://127.0.0.1:9`, so the local service's sign-in gate makes no install on publik; the updater reads
neither. Nobody signs in; the microphone, camera and screen capture stay unused.

| Step | macOS (`apps/shell/test/live-proof/macos.sh`) | Windows (`apps/shell/test/live-proof/windows.ps1`) |
|---|---|---|
| Before | installs with a mouse drag in Finder from the dmg window to its Applications link (a copy made by `ditto` or by Finder's AppleScript runs from App Translocation, where an update cannot replace the app; the harness checks that the app runs from `/Applications`); records the designated requirement (DR); writes allowed TCC rows for camera, microphone (user TCC.db), screen capture and accessibility (system TCC.db), each with the DR as its `csreq` (`csreq -r- -b`; the privileged steps are in `tcc-root.sh`) | silent per-user install; the UI driver must read and click a test dialog first |
| The question | answered "Later": the app must keep running on the old version; then "Check for Updates…" in the menu bar item must ask again; answered "Install and Restart" | answered "Later": the app must keep running on the old version; quit, start again; answered "Restart and Install" |
| After | the app comes back by itself as `expect_version` (Info.plist, the running process's cdhash, the local service's version); DR unchanged; spctl accepts it; each TCC row is still there and the updated app satisfies its stored `csreq`; "Check for Updates…" answers "jobleft <v> is the latest version." | the app's own installer runs and jobleft comes back by itself as `expect_version` (exe, uninstall entry, running process, local service) |

A GitHub runner cannot show a TCC consent prompt. tccd allows a client without a prompt when its row is allowed and
the client's code satisfies the row's stored `csreq`; the macOS job makes that same check for each of the four grants,
so it is the proof that an update asks for no permission again. The `unit` job runs `cargo test`, with the daily
check on a fake clock (`schedule_tests` in `src/updates.rs`). Results: the job summaries (PASS/FAIL per check) and the
`live-update-proof-*` artifacts (logs, dialog text, screenshots).
