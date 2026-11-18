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

1. Set the new version in `apps/shell/src-tauri/tauri.conf.json`, `apps/shell/src-tauri/Cargo.toml` and the
   `package.json` files. Push.
2. Make a draft release: `gh release create v<v> --draft --title "jobleft <v>" --notes-file notes.md`.
3. Run `windows.yml` on that commit with `release_tag: v<v>`. It attaches `jobleft_<v>_x64-setup.exe` and
   `jobleft_<v>_x64-setup.exe.sig` to the draft (both or neither).
4. On the release Mac, run `apps/shell/scripts/build-macos.sh`. After notarization it writes
   `.cache/cargo-target/release/bundle/updater/jobleft_<v>_aarch64.app.tar.gz` and its `.sig` (the stapled app,
   signed with the update key from the keychain). The `.app.tar.gz` is the stapled Developer ID app, so an update
   keeps the TCC permissions.
5. Write the feed. The script refuses a signature that does not verify or names another version:
   ```sh
   mkdir -p out && cp .cache/cargo-target/release/bundle/updater/jobleft_<v>_aarch64.app.tar.gz* out/
   gh release download v<v> -p 'jobleft_<v>_x64-setup.exe*' -D out
   node apps/shell/scripts/updater-latest-json.mjs --version <v> \
     --base-url https://github.com/Blueturboguy07/jobleft/releases/download/v<v>/ \
     --platform darwin-aarch64=out/jobleft_<v>_aarch64.app.tar.gz \
     --platform windows-x86_64=out/jobleft_<v>_x64-setup.exe \
     --notes-file notes.md --out out/latest.json
   ```
6. Upload the rest to the draft: the dmg, `jobleft_<v>_aarch64.app.tar.gz` and its `.sig`, `latest.json` and
   `SHA256SUMS.txt`. Run `clean-mac-check.yml` with the draft tag. Publish the release. Installed copies update when
   publik approves the release and serves its `latest.json`.

`publik-build.yml` makes the unsigned macOS app without an update bundle: an update bundle of that app must never ship.
Its Windows installer comes with its `.sig`. A pipeline that takes over the macOS step needs
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and must run
`apps/shell/scripts/updater-pack-macos.sh` after stapling.

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
