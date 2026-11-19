#!/usr/bin/env bash
# Cut one jobleft release, for every system it ships (macOS Apple silicon, Windows x64), with one command.
# docs/updates.md, "Cut a release".
#
# Usage: scripts/publik-release.sh <version> [--summary "one sentence"] [--notes-file notes.md] [--no-publish]
#                                  [--skip-clean-mac-check] [--no-wait-windows]
#
#   --summary       the first line of the release notes and the "notes" of latest.json
#                   (default: "A maintenance release. Nothing in the app changed.")
#   --notes-file    the whole release body instead of the generated one
#   --no-publish    stop with a checked DRAFT
#   --skip-clean-mac-check  do not run clean-mac-check.yml on the draft
#   --no-wait-windows       after publishing, do not wait for the windows workflow that publishing starts
#
# Steps (run it again after any stop: every step skips what is already done, and a half-done draft is resumed):
#   1. Checks: on main, clean tree, in step with origin/main; the tag v<version> is free; <version> is above the
#      latest release; this Mac has the Developer ID identity, the notary profile and enough free disk.
#   2. The version in the six files a bump changes (apps/shell/scripts/release-version.mjs); one commit, pushed to
#      main (never forced). Set PUBLIK_RELEASE_TRAILER to add a trailer line to that commit.
#   3. A DRAFT release v<version> on that commit.
#   4. The CI build: publik-build.yml on that commit (the macOS app, not signed; the Windows installer and its update
#      signature, made with the repo's update key secret). A run that fails only in its test steps (known flaky
#      tests) is started again, up to 3 runs in all. ci.yml must be green on the commit.
#   5. Windows: the installer and its .sig from that run, checked against the app's public key, on the draft.
#   6. macOS: the app from that run, signed on this Mac with the Developer ID (inner binaries first, hardened runtime,
#      Entitlements.plist), notarized and stapled, the dmg around it (signed, notarized, stapled) and the update
#      bundle (.app.tar.gz + .sig, signed with the update key from the keychain): build-macos.sh --app. On the draft.
#   7. Every file is downloaded back from the draft and checked: sha256 = GitHub's digest; the update signatures with
#      the app's public key and version; Info.plist and installer versions; codesign, spctl ("Notarized Developer
#      ID") and stapler for the dmg and both copies of the app; one designated requirement; the publik app token as
#      in the last release. Then latest.json (absolute GitHub URLs), its signature latest.json.sig and SHA256SUMS.txt
#      are written, uploaded, downloaded back and checked again.
#   8. clean-mac-check.yml on the draft: a clean runner downloads the dmg with quarantine on and opens the app.
#   9. Publish. Then: the tag is on the release commit, every asset URL answers, latest.json is byte for byte the
#      checked one, and the windows workflow that publishing starts leaves every asset as it was.
# It stops before publishing on any failed check. It starts no app on this Mac and prints no secret (the update key
# is read by apps/shell/scripts/updater-pack-macos.sh and updater-sign-file.sh, never by this script).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

APP=jobleft
BUNDLE_ID=com.publik.jobleft
TEAM=R5R3ZS54LV
IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Mann Bellani (R5R3ZS54LV)}"
NOTARY_PROFILE="${NOTARY_PROFILE:-publik}"
MIN_FREE_MB="${MIN_FREE_MB:-1536}"
DEFAULT_SUMMARY="A maintenance release. Nothing in the app changed."
VERSION=""; SUMMARY=""; NOTES_FILE=""; PUBLISH=1; CLEAN_CHECK=1; WAIT_WINDOWS=1
DRAFT_NOTE=""

say() { printf '\n==> %s\n' "$*"; }
ok() { printf 'ok    %s\n' "$*"; }
info() { printf 'info  %s\n' "$*"; }
die() { printf '\nSTOP  %s\n' "$*" >&2; printf '%s\n' "${DRAFT_NOTE:-Nothing was published.}" >&2; exit 1; }
usage() { sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --summary) SUMMARY="${2:?--summary needs a sentence}"; shift 2 ;;
    --notes-file) NOTES_FILE="${2:?--notes-file needs a file}"; shift 2 ;;
    --no-publish) PUBLISH=0; shift ;;
    --skip-clean-mac-check) CLEAN_CHECK=0; shift ;;
    --no-wait-windows) WAIT_WINDOWS=0; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) [ -z "$VERSION" ] || die "give one version"; VERSION="${1#v}"; shift ;;
  esac
done
[ -n "$VERSION" ] || { usage; exit 1; }
printf '%s' "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || die "the version must be x.y.z, not $VERSION"
SUMMARY="${SUMMARY:-$DEFAULT_SUMMARY}"
[ -z "$NOTES_FILE" ] || [ -s "$NOTES_FILE" ] || die "no such notes file: $NOTES_FILE"

TAG="v$VERSION"
DMG="${APP}_${VERSION}_aarch64.dmg"
TGZ="${APP}_${VERSION}_aarch64.app.tar.gz"
EXE="${APP}_${VERSION}_x64-setup.exe"
BINARIES=("$DMG" "$TGZ" "$TGZ.sig" "$EXE" "$EXE.sig")
WORK="$ROOT/.cache/publik-release/$TAG"
mkdir -p "$WORK"

# ---------- helpers ----------
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist"; }
cdhash() { codesign -dvvv "$1" 2>&1 | sed -n 's/^CDHash=//p'; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
# Deletes a folder this script made under $WORK (never anything else).
purge() { case "$1" in "$WORK"/?*) [ ! -e "$1" ] || find "$1" -depth -delete ;; *) die "purge outside $WORK: $1" ;; esac; }
free_mb() { df -m "$ROOT" | awk 'NR==2 {print $4}'; }
need_disk() {
  local free; free="$(free_mb)"
  [ "$free" -ge "$MIN_FREE_MB" ] || die "only ${free} MB free on this disk; this step needs ${MIN_FREE_MB} MB (MIN_FREE_MB). Free some space and run the script again."
}
release_json() { gh release view "$TAG" -R "$REPO" --json "$1" -q "$2" 2>/dev/null; }
has_asset() { printf '%s\n' "$ASSETS" | grep -qxF "$1"; }
refresh_assets() { ASSETS="$(release_json assets '.assets[].name' || true)"; }
digests() { release_json assets '.assets[] | "\(.name) \(.digest)"'; }
assert_draft() { [ "$(release_json isDraft .isDraft)" = true ] || die "$TAG is not a draft any more; nothing is uploaded to a published release"; }
upload() { assert_draft; gh release upload "$TAG" -R "$REPO" --clobber "$@" >/dev/null; for f in "$@"; do ok "uploaded $(basename "$f") ($(du -h "$f" | cut -f1 | tr -d ' '))"; done; }
download() { gh release download "$TAG" -R "$REPO" -p "$1" -D "$2" --clobber; }
# The newest run of a workflow for a commit and event: "<id> <status> <conclusion>".
run_for() {
  gh run list -R "$REPO" -w "$1" -c "$2" -e "$3" -L 20 --json databaseId,status,conclusion,createdAt \
    -q 'sort_by(.createdAt) | reverse | .[0] | select(. != null) | "\(.databaseId) \(.status) \(.conclusion)"'
}
# Waits for a run to finish; prints its conclusion.
wait_run() {
  local id="$1" waited=0 st
  while :; do
    st="$(gh run view "$id" -R "$REPO" --json status,conclusion -q '"\(.status) \(.conclusion)"' 2>/dev/null || echo "unknown ")"
    case "$st" in completed*) printf '%s\n' "${st#completed }"; return 0 ;; esac
    [ "$waited" -lt "${2:-7200}" ] || { echo timeout; return 0; }
    sleep 30; waited=$((waited + 30))
  done
}
# True when every failed step of a run is a test step (the known flaky tests), so a new run is worth it.
only_tests_failed() {
  local bad
  bad="$(gh run view "$1" -R "$REPO" --json jobs -q '.jobs[] | select(.conclusion == "failure") | .steps[] | select(.conclusion == "failure") | .name')"
  [ -n "$bad" ] && ! printf '%s\n' "$bad" | grep -qvE '^(Test|Test result|Tests on Windows)$'
}
# The Tauri CLI signs the update files (apps/shell/scripts/updater-pack-macos.sh, updater-sign-file.sh). Without the
# workspace install (node_modules), the version locked in pnpm-lock.yaml runs through npx.
ensure_tauri_cli() {
  [ -z "${TAURI_CLI:-}" ] || return 0
  (cd apps/shell && node -p "require.resolve('@tauri-apps/cli/tauri.js', { paths: ['.'] })" >/dev/null 2>&1) && return 0
  local v
  v="$(sed -n "s/^  '@tauri-apps\/cli@\([0-9][0-9.]*\)':.*/\1/p" pnpm-lock.yaml | head -1)"
  [ -n "$v" ] || die "no @tauri-apps/cli version in pnpm-lock.yaml"
  mkdir -p "$WORK/bin"
  printf '#!/bin/sh\ncd "%s" || exit 1\nexec npx --yes "@tauri-apps/cli@%s" "$@"\n' "$WORK/bin" "$v" > "$WORK/bin/tauri"
  chmod 755 "$WORK/bin/tauri"
  export TAURI_CLI="$WORK/bin/tauri"
  info "Tauri CLI: @tauri-apps/cli@$v through npx"
}
# A run started now by workflow_dispatch: waits until it is listed and prints its id.
dispatched_run() {
  local wf="$1" since="$2" id="" i
  for i in $(seq 1 30); do
    id="$(gh run list -R "$REPO" -w "$wf" -e workflow_dispatch -L 10 --json databaseId,createdAt \
      -q "map(select(.createdAt >= \"$since\")) | sort_by(.createdAt) | .[0].databaseId // empty")"
    [ -z "$id" ] || break
    sleep 5
  done
  [ -n "$id" ] || die "the $wf run that was just started does not show up"
  printf '%s\n' "$id"
}

# ---------- 1. checks ----------
say "1. Checks"
for tool in gh git node python3 shasum xcrun codesign spctl hdiutil ditto lipo; do
  command -v "$tool" >/dev/null || die "$tool is missing"
done
gh auth status >/dev/null 2>&1 || die "gh is not logged in"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
BASE_URL="https://github.com/$REPO/releases/download/$TAG/"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "check out main first (the release branch)"
[ -z "$(git status --porcelain)" ] || die "the working tree is not clean (git status)"
git fetch -q origin main --tags
case "$IDENTITY" in "Developer ID Application:"*) ;; *) die "$IDENTITY is not a Developer ID Application identity" ;; esac
security find-identity -v -p codesigning | grep -qF "$IDENTITY" || die "no signing identity \"$IDENTITY\" in the keychain"
ok "signing identity: $IDENTITY"
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 || die "the notary profile \"$NOTARY_PROFILE\" does not work (xcrun notarytool store-credentials)"
ok "notary profile: $NOTARY_PROFILE"
ok "free disk: $(free_mb) MB (a step that downloads needs $MIN_FREE_MB MB)"

STATE="none"
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  if [ "$(release_json isDraft .isDraft)" = true ]; then STATE=draft; else STATE=published; fi
fi
PREV_TAG="$(gh release list -R "$REPO" --exclude-drafts -L 20 --json tagName,isLatest -q 'map(select(.isLatest)) | .[0].tagName // empty')"
[ -n "$PREV_TAG" ] || PREV_TAG="$(gh release list -R "$REPO" --exclude-drafts -L 1 --json tagName -q '.[0].tagName')"
PREV="${PREV_TAG#v}"
if [ "$STATE" = published ]; then
  info "$TAG is already published: only the checks after publishing run"
else
  [ "$PREV_TAG" != "$TAG" ] || die "$TAG is already the latest release"
  node apps/shell/scripts/release-version.mjs --newer "$VERSION" "$PREV" || die "$VERSION is not above the latest release $PREV_TAG"
  ok "$VERSION is above the latest release $PREV_TAG"
  if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
    die "the tag $TAG exists on origin but has no release; this script never moves a tag"
  fi
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "the tag $TAG exists in this clone only; delete it (git tag -d $TAG) and run again"
  ok "the tag $TAG is free (state of the release: $STATE)"
fi

# ---------- 2. version bump ----------
if [ "$STATE" = published ]; then
  SHA="$(git rev-parse "refs/tags/$TAG^{commit}" 2>/dev/null || true)"
elif [ "$STATE" = draft ]; then
  SHA="$(release_json targetCommitish .targetCommitish)"
  printf '%s' "$SHA" | grep -qE '^[0-9a-f]{40}$' || die "the draft $TAG targets \"$SHA\", not a commit"
  git merge-base --is-ancestor "$SHA" origin/main || die "the draft's commit $SHA is not on origin/main"
  [ "$(git show "$SHA:apps/shell/src-tauri/tauri.conf.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')" = "$VERSION" ] \
    || die "the draft's commit $SHA does not carry version $VERSION"
  ok "resuming the draft $TAG on $SHA"
else
  say "2. Version bump"
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main is not in step with origin/main (pull or push first)"
  if CUR="$(node apps/shell/scripts/release-version.mjs | sed -n 's/^version //p')" && [ -n "$CUR" ]; then :; else
    node apps/shell/scripts/release-version.mjs >&2 || true
    die "the six version files do not agree"
  fi
  if [ "$CUR" = "$VERSION" ]; then
    ok "the six version files already say $VERSION (HEAD $(git rev-parse --short HEAD))"
  else
    node apps/shell/scripts/release-version.mjs --newer "$VERSION" "$CUR" || die "$VERSION is not above $CUR in the version files"
    node apps/shell/scripts/release-version.mjs --set "$VERSION" | sed 's/^/      /'
    git add package.json apps/server/package.json apps/shell/package.json apps/shell/src-tauri/tauri.conf.json \
      apps/shell/src-tauri/Cargo.toml apps/shell/src-tauri/Cargo.lock
    MSG_FILE="$WORK/commit-message.txt"
    { printf '%s: version bump for the release\n\n' "$VERSION"
      printf 'The version is %s in the six files of every bump (scripts/publik-release.sh).\n' "$VERSION"
      [ -z "${PUBLIK_RELEASE_TRAILER:-}" ] || printf '\n%s\n' "$PUBLIK_RELEASE_TRAILER"; } > "$MSG_FILE"
    git commit -q -F "$MSG_FILE"
    git push -q origin HEAD:main
    ok "committed and pushed the bump: $(git rev-parse --short HEAD)"
  fi
  SHA="$(git rev-parse HEAD)"
  [ "$SHA" = "$(git rev-parse origin/main)" ] || { git fetch -q origin main; [ "$SHA" = "$(git rev-parse origin/main)" ] || die "origin/main is not the release commit $SHA"; }
fi

# ---------- notes ----------
NOTES="$WORK/notes.md"
if [ -n "$NOTES_FILE" ]; then cp "$NOTES_FILE" "$NOTES"; else
  cat > "$NOTES" <<EOF
$SUMMARY

Installed copies of $APP 0.1.9 or later update to this version by themselves: the app asks before it installs.

## Files

- \`$DMG\`: macOS, Apple silicon. Signed with the publik Developer ID, notarized, stapled (the app and the dmg).
- \`$EXE\`: Windows x64 installer (NSIS). Not code-signed.
- \`$TGZ\` and \`.sig\`: the macOS update package (the stapled app) and its update signature.
- \`$EXE.sig\`: the update signature of the Windows installer.
- \`latest.json\` and \`latest.json.sig\`: the update feed for this version and its signature (the update key).
- \`SHA256SUMS.txt\`: the sha256 of each file.
EOF
fi
FEED_NOTES="$APP $VERSION: $SUMMARY"

if [ "$STATE" != published ]; then
  # ---------- 3. draft ----------
  say "3. Draft release"
  if [ "$STATE" = none ]; then
    gh release create "$TAG" -R "$REPO" --draft --target "$SHA" --title "$APP $VERSION" --notes-file "$NOTES" >/dev/null
    ok "draft $TAG on $SHA"
  else
    ok "draft $TAG exists"
  fi
  DRAFT_NOTE="Nothing was published: the release $TAG stays a DRAFT. Run the script again to resume."
  refresh_assets

  # ---------- 4. CI build ----------
  say "4. CI build (publik-build.yml on $SHA)"
  RUN=""
  for attempt in 1 2 3; do
    read -r id status conclusion <<< "$(run_for publik-build.yml "$SHA" workflow_dispatch || true)"
    if [ -n "${id:-}" ] && { [ "$status" != completed ] || [ "$conclusion" = success ]; }; then
      RUN="$id"; info "run $RUN ($status${conclusion:+ $conclusion}): https://github.com/$REPO/actions/runs/$RUN"
    else
      [ "$(git rev-parse origin/main)" = "$SHA" ] || die "no successful publik-build run for $SHA, and origin/main has moved on: workflow_dispatch can only build the branch head"
      since="$(date -u -v-30S +%Y-%m-%dT%H:%M:%SZ)"
      gh workflow run publik-build.yml -R "$REPO" --ref main >/dev/null
      RUN="$(dispatched_run publik-build.yml "$since")"
      info "started run $RUN: https://github.com/$REPO/actions/runs/$RUN"
    fi
    c="$(wait_run "$RUN")"
    [ "$c" != success ] || break
    if only_tests_failed "$RUN" && [ "$attempt" -lt 3 ]; then
      info "run $RUN failed in its test steps only (known flaky tests): a new run"
      RUN=""; continue
    fi
    die "publik-build run $RUN ended: $c (https://github.com/$REPO/actions/runs/$RUN)"
  done
  [ -n "$RUN" ] || die "no successful publik-build run"
  [ "$(gh run view "$RUN" -R "$REPO" --json headSha -q .headSha)" = "$SHA" ] || die "run $RUN did not build $SHA"
  ok "publik-build run $RUN built $SHA: success"
  TOKEN_STEPS="$(gh run view "$RUN" -R "$REPO" --json jobs -q '[.jobs[].steps[] | select(.name == "The tree carries the publik app token and the usage-count client") | .conclusion] | join(" ")')"
  [ "$TOKEN_STEPS" = "success success" ] || die "run $RUN: the publik app token step did not pass on both systems ($TOKEN_STEPS)"
  ok "run $RUN: the macOS app and the Windows installer carry the publik app token (its CI step passed on both)"
  read -r cid cstatus cconclusion <<< "$(run_for ci.yml "$SHA" push || true)"
  if [ -n "${cid:-}" ]; then
    [ "$cstatus" = completed ] || cconclusion="$(wait_run "$cid")"
    [ "$cconclusion" = success ] || die "ci.yml on $SHA: $cconclusion (https://github.com/$REPO/actions/runs/$cid); keep CI green before a release"
    ok "ci.yml on $SHA: success (run $cid)"
  else
    info "no ci.yml push run for $SHA (the commit was not pushed by itself)"
  fi

  # ---------- 5. Windows ----------
  say "5. Windows installer"
  if has_asset "$EXE" && has_asset "$EXE.sig"; then
    ok "$EXE and its .sig are on the draft"
  else
    need_disk
    W="$WORK/windows"; purge "$W"; mkdir -p "$W"
    gh run download "$RUN" -R "$REPO" -n jobleft-windows-setup -D "$W"
    [ -s "$W/$EXE" ] && [ -s "$W/$EXE.sig" ] || die "the run's jobleft-windows-setup artifact has no $EXE and $EXE.sig"
    node apps/shell/scripts/updater-latest-json.mjs --version "$VERSION" --base-url "$BASE_URL" \
      --platform "windows-x86_64=$W/$EXE" --out "$W/check.json" 2>&1 | sed 's/^/      /' \
      || die "$EXE.sig does not verify with the app's public key or does not name $VERSION"
    upload "$W/$EXE" "$W/$EXE.sig"
    purge "$W"
  fi

  # ---------- 6. macOS ----------
  say "6. macOS app: Developer ID, notarization, dmg, update bundle"
  refresh_assets
  if has_asset "$DMG" && has_asset "$TGZ" && has_asset "$TGZ.sig"; then
    ok "$DMG, $TGZ and its .sig are on the draft"
  else
    need_disk
    M="$WORK/macos"; purge "$M"; mkdir -p "$M/in" "$M/out"
    gh run download "$RUN" -R "$REPO" -n jobleft-macos-arm64-app -D "$M/in"
    /usr/bin/ditto -x -k "$M/in/jobleft-macos-arm64.app.zip" "$M/in"
    rm -f "$M/in/jobleft-macos-arm64.app.zip"
    A="$M/in/jobleft.app"
    [ "$(plist "$A" CFBundleShortVersionString)" = "$VERSION" ] || die "the built app says $(plist "$A" CFBundleShortVersionString), not $VERSION"
    [ "$(lipo -archs "$A/Contents/MacOS/jobleft")" = arm64 ] || die "the built app is not arm64"
    ensure_tauri_cli
    NOTARY_PROFILE="$NOTARY_PROFILE" APPLE_SIGNING_IDENTITY="$IDENTITY" apps/shell/scripts/build-macos.sh --app "$A" --out "$M/out" \
      || die "build-macos.sh --app failed (signing, notarization, dmg or update bundle); see above"
    for f in "$DMG" "$TGZ" "$TGZ.sig"; do [ -s "$M/out/$f" ] || die "build-macos.sh did not write $f"; done
    upload "$M/out/$DMG" "$M/out/$TGZ" "$M/out/$TGZ.sig"
    purge "$M"
  fi

  # ---------- 7. download back, check, feed ----------
  say "7. Download back and check every file; the feed"
  need_disk
  V="$WORK/verify"; purge "$V"; mkdir -p "$V"
  for f in "${BINARIES[@]}"; do download "$f" "$V"; done
  check_digests() {  # every file in $1 that is on the release has GitHub's sha256
    local name digest n=0
    while read -r name digest; do
      [ -f "$1/$name" ] || continue
      [ "sha256:$(sha "$1/$name")" = "$digest" ] || die "$name: the downloaded file does not match GitHub's digest $digest"
      n=$((n + 1))
    done < <(digests)
    ok "$n file(s) match GitHub's sha256 digests"
  }
  check_digests "$V"

  # The previous release's app token, read from its update bundle as a stream (nothing written to disk).
  PREV_TGZ="${APP}_${PREV}_aarch64.app.tar.gz"
  PREV_TOKEN_SHA="$(gh release download "$PREV_TAG" -R "$REPO" -p "$PREV_TGZ" -O - 2>/dev/null \
    | tar -xzOf - jobleft.app/Contents/Resources/publik-app-token.txt 2>/dev/null | shasum -a 256 | cut -d' ' -f1 || true)"
  EMPTY_SHA="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  [ -n "$PREV_TOKEN_SHA" ] && [ "$PREV_TOKEN_SHA" != "$EMPTY_SHA" ] || die "could not read the app token of $PREV_TAG to compare"

  check_app() {  # <app> <what>: every check of a released app; sets APP_CDHASH
    local a="$1" what="$2" out dr tok
    [ "$(plist "$a" CFBundleShortVersionString)" = "$VERSION" ] || die "$what: Info.plist says $(plist "$a" CFBundleShortVersionString), not $VERSION"
    [ "$(plist "$a" CFBundleIdentifier)" = "$BUNDLE_ID" ] || die "$what: bundle id $(plist "$a" CFBundleIdentifier)"
    codesign --verify --deep --strict "$a" 2>/dev/null || die "$what: codesign --verify --deep --strict fails"
    out="$(spctl -a -t exec -vv "$a" 2>&1)" || die "$what: Gatekeeper refuses it: $out"
    case "$out" in *"source=Notarized Developer ID"*) ;; *) die "$what: Gatekeeper source is not Notarized Developer ID: $out" ;; esac
    xcrun stapler validate "$a" >/dev/null 2>&1 || die "$what: no valid stapled ticket"
    dr="$(codesign -d -r- "$a" 2>&1 | sed -n 's/^designated => //p')"
    case "$dr" in "identifier \"$BUNDLE_ID\" and anchor apple generic and "*"certificate leaf[subject.OU] = $TEAM") ;;
      *) die "$what: unexpected designated requirement: $dr" ;; esac
    tok="$a/Contents/Resources/publik-app-token.txt"
    grep -qE '^pat_jobleft_[A-Za-z0-9]+$' "$tok" || die "$what: no publik app token in Contents/Resources"
    [ "$(sha "$tok")" = "$PREV_TOKEN_SHA" ] || die "$what: the publik app token is not the one $PREV_TAG ships"
    APP_CDHASH="$(cdhash "$a")"
    ok "$what: version $VERSION, $BUNDLE_ID, codesign valid, spctl: accepted, Notarized Developer ID, stapled, cdhash $APP_CDHASH"
    ok "$what: designated requirement: $dr"
    ok "$what: publik app token present, the same as in $PREV_TAG"
  }

  # The dmg and the app inside it (mounting starts nothing).
  out="$(spctl -a -t open --context context:primary-signature -vv "$V/$DMG" 2>&1)" || die "$DMG: Gatekeeper refuses it: $out"
  case "$out" in *"source=Notarized Developer ID"*) ;; *) die "$DMG: Gatekeeper source is not Notarized Developer ID: $out" ;; esac
  xcrun stapler validate "$V/$DMG" >/dev/null 2>&1 || die "$DMG: no valid stapled ticket"
  codesign --verify "$V/$DMG" 2>/dev/null || die "$DMG: its signature does not verify"
  ok "$DMG: spctl: accepted, Notarized Developer ID; stapled; signed"
  MNT="$V/mnt"; mkdir -p "$MNT"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$V/$DMG" >/dev/null || die "$DMG does not mount"
  [ -L "$MNT/Applications" ] || { hdiutil detach "$MNT" -force -quiet; die "$DMG has no Applications link"; }
  ( check_app "$MNT/jobleft.app" "the app in $DMG"; printf '%s' "$APP_CDHASH" > "$V/dmg-cdhash" ) || { hdiutil detach "$MNT" -force -quiet; exit 1; }
  hdiutil detach "$MNT" -quiet || hdiutil detach "$MNT" -force -quiet
  DMG_CDHASH="$(cat "$V/dmg-cdhash")"

  # The update bundle: the same signed app, no AppleDouble files.
  ! tar -tzf "$V/$TGZ" | grep -q '/\._' || die "$TGZ carries AppleDouble files"
  [ "$(tar -tzf "$V/$TGZ" | head -1)" = "jobleft.app/" ] || die "$TGZ does not start with jobleft.app/"
  mkdir -p "$V/x"; tar -xzf "$V/$TGZ" -C "$V/x"
  check_app "$V/x/jobleft.app" "the app in $TGZ"
  [ "$APP_CDHASH" = "$DMG_CDHASH" ] || die "the app in $TGZ is not the app in $DMG (cdhash $APP_CDHASH vs $DMG_CDHASH)"
  ok "the update bundle and the dmg carry the same app (cdhash $APP_CDHASH)"
  purge "$V/x"

  # The Windows installer's own version resource.
  PV="$(node apps/shell/scripts/pe-version.mjs "$V/$EXE")" || die "$EXE has no version resource"
  printf '%s\n' "$PV" | grep -qxF "ProductVersion=$VERSION" || die "$EXE: $(printf '%s' "$PV" | tr '\n' ' ')"
  printf '%s\n' "$PV" | grep -qxF "FileVersion=$VERSION.0" || die "$EXE: $(printf '%s' "$PV" | tr '\n' ' ')"
  ok "$EXE: ProductVersion $VERSION, FileVersion $VERSION.0"

  # The feed, from the files as they are on the release; then its own signature and the sums.
  node apps/shell/scripts/updater-latest-json.mjs --version "$VERSION" --base-url "$BASE_URL" \
    --platform "darwin-aarch64=$V/$TGZ" --platform "windows-x86_64=$V/$EXE" --notes "$FEED_NOTES" --out "$V/latest.json" 2>&1 \
    | sed 's/^/      /' || die "the update signatures on the draft do not verify"
  [ -s "$V/latest.json" ] || die "no latest.json was written"
  ensure_tauri_cli
  apps/shell/scripts/updater-sign-file.sh "$V/latest.json" "$VERSION" >/dev/null || die "could not sign latest.json"
  ( cd "$V" && for f in "$DMG" "$EXE" "$EXE.sig" "$TGZ" "$TGZ.sig" latest.json latest.json.sig; do shasum -a 256 "$f"; done ) > "$V/SHA256SUMS.txt"
  node apps/shell/scripts/updater-verify-feed.mjs --feed "$V/latest.json" --feed-sig "$V/latest.json.sig" --dir "$V" \
    --base-url "$BASE_URL" --expect-platforms darwin-aarch64,windows-x86_64 | sed 's/^/      /' || die "the feed does not verify"
  upload "$V/latest.json" "$V/latest.json.sig" "$V/SHA256SUMS.txt"

  # Downloaded back: byte for byte what was checked, and the sums hold for every file.
  B="$V/back"; mkdir -p "$B"
  for f in latest.json latest.json.sig SHA256SUMS.txt; do
    download "$f" "$B"
    cmp -s "$V/$f" "$B/$f" || die "$f on the release is not the file that was checked"
  done
  ( cd "$V" && shasum -a 256 -c "$B/SHA256SUMS.txt" >/dev/null ) || die "SHA256SUMS.txt does not hold for the downloaded files"
  check_digests "$B"
  node apps/shell/scripts/updater-verify-feed.mjs --feed "$B/latest.json" --feed-sig "$B/latest.json.sig" --dir "$V" \
    --base-url "$BASE_URL" --expect-platforms darwin-aarch64,windows-x86_64 >/dev/null || die "the feed on the release does not verify"
  ok "latest.json, latest.json.sig and SHA256SUMS.txt on the draft are the checked files; SHA256SUMS.txt holds for all 7 files"
  cp "$V/latest.json" "$WORK/latest.json"
  digests > "$WORK/digests.checked"
  purge "$V"

  # ---------- 8. clean Mac check ----------
  say "8. Clean Mac check of the draft dmg (clean-mac-check.yml)"
  if [ "$CLEAN_CHECK" = 1 ]; then
    DMG_DIGEST="$(grep "^$DMG " "$WORK/digests.checked" | cut -d' ' -f2)"
    if [ -f "$WORK/clean-mac-check.ok" ] && [ "$(cut -d' ' -f2 "$WORK/clean-mac-check.ok")" = "$DMG_DIGEST" ]; then
      ok "clean-mac-check passed for this dmg before (run $(cut -d' ' -f1 "$WORK/clean-mac-check.ok"))"
    else
      since="$(date -u -v-30S +%Y-%m-%dT%H:%M:%SZ)"
      gh workflow run clean-mac-check.yml -R "$REPO" --ref main -f tag="$TAG" -f version="$VERSION" >/dev/null
      CM="$(dispatched_run clean-mac-check.yml "$since")"
      info "run $CM: https://github.com/$REPO/actions/runs/$CM"
      c="$(wait_run "$CM" 3600)"
      [ "$c" = success ] || die "clean-mac-check run $CM: $c (https://github.com/$REPO/actions/runs/$CM)"
      printf '%s %s\n' "$CM" "$DMG_DIGEST" > "$WORK/clean-mac-check.ok"
      ok "clean-mac-check run $CM: success (download with quarantine, Gatekeeper, install, launch)"
    fi
  else
    info "skipped (--skip-clean-mac-check)"
  fi

  # ---------- 9. publish ----------
  if [ "$PUBLISH" = 0 ]; then
    say "Checked DRAFT, not published (--no-publish): https://github.com/$REPO/releases (tag $TAG)"
    exit 0
  fi
  say "9. Publish"
  digests > "$WORK/digests.before"
  cmp -s "$WORK/digests.before" "$WORK/digests.checked" || die "the draft's files changed since they were checked; run the script again"
  gh release edit "$TAG" -R "$REPO" --draft=false --latest >/dev/null
  DRAFT_NOTE="The release $TAG IS published. Fix forward with a new version; do not change its files."
  ok "published $TAG"
fi

# ---------- after publishing ----------
say "Checks of the published release"
[ -f "$WORK/digests.before" ] || digests > "$WORK/digests.before"
git fetch -q origin --tags
TAG_SHA="$(git rev-parse "refs/tags/$TAG^{commit}" 2>/dev/null || true)"
[ -n "$TAG_SHA" ] || die "the tag $TAG does not exist on origin"
[ -z "${SHA:-}" ] || [ "$TAG_SHA" = "$SHA" ] || die "the tag $TAG is on $TAG_SHA, not on the release commit $SHA"
ok "tag $TAG is on $TAG_SHA"
[ "$(release_json isDraft .isDraft)" = false ] || die "$TAG is still a draft"
for f in "${BINARIES[@]}" latest.json latest.json.sig SHA256SUMS.txt; do
  code="$(curl -sS -L -r 0-0 -o /dev/null -w '%{http_code}' "$BASE_URL$f")" \
    || code="no answer"
  case "$code" in 200|206) ;; *) die "$BASE_URL$f answers HTTP $code" ;; esac
done
ok "all ${#BINARIES[@]} files and the 3 feed files answer at $BASE_URL"
if [ -f "$WORK/latest.json" ]; then
  curl -sS -L -o "$WORK/latest.public.json" "${BASE_URL}latest.json"
  cmp -s "$WORK/latest.json" "$WORK/latest.public.json" || die "the public latest.json is not the checked one"
  ok "the public latest.json is byte for byte the checked one (version $VERSION)"
fi
if [ "$WAIT_WINDOWS" = 1 ]; then
  WR=""
  for i in $(seq 1 20); do
    WR="$(gh run list -R "$REPO" -w windows.yml -e release -L 10 --json databaseId,headBranch -q "map(select(.headBranch == \"$TAG\")) | .[0].databaseId // empty")"
    [ -z "$WR" ] || break
    sleep 15
  done
  if [ -n "$WR" ]; then
    info "windows workflow started by publishing: run $WR; waiting for its \"Attach to the release\" step"
    waited=0
    while :; do
      st="$(gh run view "$WR" -R "$REPO" --json status,jobs -q '[.status, ([.jobs[].steps[]? | select(.name == "Attach to the release") | .status] | first // "none")] | join(" ")')"
      case "$st" in completed*|*" completed") break ;; esac
      [ "$waited" -lt 5400 ] || { info "gave up waiting after 90 minutes"; break; }
      sleep 60; waited=$((waited + 60))
    done
    digests > "$WORK/digests.after"
    cmp -s "$WORK/digests.before" "$WORK/digests.after" || die "the release's files changed after publishing (see $WORK/digests.before and .after)"
    ok "after the windows run $WR: every file on $TAG is unchanged ($(wc -l < "$WORK/digests.after" | tr -d ' ') files, same digests)"
  else
    info "no windows workflow run for $TAG showed up"
  fi
fi
say "Released: https://github.com/$REPO/releases/tag/$TAG"
echo "publik takes in new releases at 10:00 UTC; after its scan, https://publikhq.com/api/updates/$APP/latest.json announces $VERSION."
