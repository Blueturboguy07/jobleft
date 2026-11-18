#!/usr/bin/env bash
# Updater proof on a macOS GitHub runner (updater-proof.yml). Never run it on a desk Mac: it installs into
# /Applications, starts the app and adds a code-signing certificate. Adapted from the publik template (GSpot).
#
# Usage: apps/shell/test/updater/proof-macos.sh <N jobleft.app> <N+1 jobleft.app> <out dir>
# Env:   TAURI_SIGNING_PRIVATE_KEY(+_PASSWORD) (the real update key, for the N+1 bundle),
#        FEED_PORT (the port the test builds were compiled to use).
#
# 1. Signs N and N+1 with one throwaway code-signing identity (the runner has no Developer ID), in the order and with
#    the flags of apps/shell/scripts/build-macos.sh (every Mach-O inside first, then the app).
# 2. Packs and signs N+1 with apps/shell/scripts/updater-pack-macos.sh and writes the feed with
#    apps/shell/scripts/updater-latest-json.mjs (the release tools), plus three bad feeds.
# 3. Installs N in /Applications and runs its updater self-test against each feed.
# 4. jobleft: from N with its local service running, takes the "yes" answer of the question and checks that jobleft
#    comes back as N+1 with a working local service (single instance, data folder lock, sidecar).
# 5. The restart question is on screen, and nothing is installed before a yes.
set -euo pipefail
N_APP="${1:?N app}"; N1_APP="${2:?N+1 app}"; OUT="${3:?out dir}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SHELL_DIR="$ROOT/apps/shell"
PORT="${FEED_PORT:?FEED_PORT}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d)"; FEED="$WORK/feed"; mkdir -p "$FEED"
INSTALLED=/Applications/jobleft.app
BIN="$INSTALLED/Contents/MacOS/jobleft"
ENT="$SHELL_DIR/src-tauri/Entitlements.plist"
CLI_JS="$(cd "$SHELL_DIR" && node -p "require.resolve('@tauri-apps/cli/tauri.js', { paths: ['.'] })")"
# The default data folder: the restarted app is started by LaunchServices and gets none of this script's environment.
DATA="$HOME/Library/Application Support/jobleft"
PASS=0; FAILS=0
RESULTS="$OUT/results.md"
echo "| Check | Result | Detail |" > "$RESULTS"; echo "|---|---|---|" >> "$RESULTS"
pass() { PASS=$((PASS + 1)); echo "PASS  $1 ${2:+($2)}"; echo "| $1 | PASS | ${2:-} |" >> "$RESULTS"; }
fail() { FAILS=$((FAILS + 1)); echo "FAIL  $1 ${2:+($2)}"; echo "| $1 | **FAIL** | ${2:-} |" >> "$RESULTS"; }
check() { local name="$1" detail="$2"; shift 2; if "$@"; then pass "$name" "$detail"; else fail "$name" "$detail"; fi; }
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist"; }
cdhash() { codesign -dvvv "$1" 2>&1 | sed -n 's/^CDHash=//p'; }
dr() { codesign -d -r- "$1" 2>&1 | sed -n 's/^designated => //p'; }
leaf() { local d; d="$(mktemp -d)"; (cd "$d" && codesign -d --extract-certificates "$1" >/dev/null 2>&1 && shasum -a 256 codesign0 | cut -d' ' -f1); rm -rf "$d"; }
alive() { kill -0 "$1" 2>/dev/null; }
gone() { ! kill -0 "$1" 2>/dev/null; }
jfield() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$1" "$2" 2>/dev/null || true; }
# On-screen windows owned by a process or by UserNotificationCenter (CGWindowList; no permission needed for owner
# and count). The dialog plugin (rfd) shows a question without a parent window with CFUserNotificationDisplayAlert,
# so macOS draws it in UserNotificationCenter, not in the app. A compiled Swift helper first, then the same call
# through JXA. Errors go to $OUT/windows.log.
build_windows_helper() {
  cat > "$WORK/wins.swift" <<'EOF'
import Foundation
import CoreGraphics
let pid = Int(CommandLine.arguments[1])!
let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as NSArray?) as? [NSDictionary] ?? []
let mine = list.filter {
  ($0[kCGWindowOwnerPID as String] as? NSNumber)?.intValue == pid
    || ($0[kCGWindowOwnerName as String] as? String) == "UserNotificationCenter"
}
let names = mine.map { "\($0[kCGWindowOwnerName as String] ?? "?"):\($0[kCGWindowName as String] ?? "")" }
FileHandle.standardError.write("swift: \(list.count) on-screen windows, \(mine.count) of pid \(pid) or UserNotificationCenter \(names)\n".data(using: .utf8)!)
print(mine.count)
EOF
  cat > "$WORK/wins.js" <<'EOF'
ObjC.import('CoreGraphics');
function run(argv) {
  const pid = parseInt(argv[0], 10);
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID))) || [];
  return String(list.filter(w => w.kCGWindowOwnerPID === pid || w.kCGWindowOwnerName === 'UserNotificationCenter').length);
}
EOF
  swiftc -O -o "$WORK/wins" "$WORK/wins.swift" >> "$OUT/windows.log" 2>&1 || echo "swiftc failed" >> "$OUT/windows.log"
}
windows_of() {
  local n=""
  [ -x "$WORK/wins" ] && n="$("$WORK/wins" "$1" 2>> "$OUT/windows.log" || true)"
  case "$n" in ''|0) n="$(osascript -l JavaScript "$WORK/wins.js" "$1" 2>> "$OUT/windows.log" || true)"; echo "jxa: $n" >> "$OUT/windows.log" ;; esac
  echo "${n:-0}"
}
field() { python3 -c 'import json,sys; lines=[l for l in open(sys.argv[1]) if l.strip()]; d=json.loads(lines[-1]); print(d.get(sys.argv[2], ""))' "$1" "$2" 2>/dev/null || true; }
# Every jobleft shell and node sidecar from /Applications, stopped.
stop_all() {
  pkill -TERM -f "^$INSTALLED/Contents/MacOS/" 2>/dev/null || true
  for _ in $(seq 1 15); do pgrep -f "^$INSTALLED/Contents/MacOS/" >/dev/null || break; sleep 1; done
  pkill -KILL -f "^$INSTALLED/Contents/MacOS/" 2>/dev/null || true
  rm -f /tmp/com_publik_jobleft_si.sock
}

# Runs the installed app's self-test. Sets RC (124 on a 180 s timeout).
selftest() {
  local mode="$1" report="$2" t=0 pid
  rm -f "$report"
  PUBLIK_UPDATE_SELF_TEST="$mode" PUBLIK_UPDATE_SELF_TEST_OUT="$report" "$BIN" > "$report.stdout" 2> "$report.log" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1; t=$((t + 1))
    if [ "$t" -ge 180 ]; then kill -9 "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; RC=124; return; fi
  done
  RC=0; wait "$pid" || RC=$?
}

build_windows_helper
echo "==> A throwaway code-signing identity (not Developer ID: the runner has no Apple certificate)"
KC="$WORK/proof.keychain-db"; KPW="proof-$RANDOM"
cat > "$WORK/cert.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = jobleft Updater Proof
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 2 -config "$WORK/cert.cnf" -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
/usr/bin/openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "jobleft Updater Proof" -out "$WORK/id.p12" -passout pass:proof
security create-keychain -p "$KPW" "$KC"
security set-keychain-settings -lut 21600 "$KC"
security unlock-keychain -p "$KPW" "$KC"
security import "$WORK/id.p12" -k "$KC" -P proof -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KPW" "$KC" >/dev/null
security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')
ID="$(/usr/bin/openssl x509 -in "$WORK/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')"
sign_one() { codesign --force --options runtime --timestamp=none --entitlements "$ENT" --keychain "$KC" --sign "$ID" "$1"; }
cp /usr/bin/true "$WORK/probe-bin"
if ! sign_one "$WORK/probe-bin" 2>"$WORK/sign.err"; then
  echo "codesign refused the untrusted identity; trusting it for code signing on this runner"; cat "$WORK/sign.err"
  sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$WORK/cert.pem"
  sign_one "$WORK/probe-bin"
fi
sign_app() {
  # The order and flags of apps/shell/scripts/build-macos.sh, without the Apple timestamp: inner binaries first, the
  # bundle seal last.
  local app="$1" f
  while IFS= read -r -d '' f; do
    if file -b "$f" | grep -q "Mach-O"; then sign_one "$f"; fi
  done < <(find "$app/Contents/Resources" "$app/Contents/MacOS" -type f \( -name "*.node" -o -name "*.dylib" -o -name "node" -o -perm -u+x \) -print0)
  sign_one "$app"
}
cp -R "$N_APP" "$WORK/N.app"; cp -R "$N1_APP" "$WORK/jobleft.app"
sign_app "$WORK/N.app"
sign_app "$WORK/jobleft.app"
codesign --verify --strict --deep "$WORK/N.app"
codesign --verify --strict --deep "$WORK/jobleft.app"
N="$(plist "$WORK/N.app" CFBundleShortVersionString)"; N1="$(plist "$WORK/jobleft.app" CFBundleShortVersionString)"
echo "N=$N  N+1=$N1"

echo "==> The N+1 update bundle and the feeds, with the release tools"
"$SHELL_DIR/scripts/updater-pack-macos.sh" "$WORK/jobleft.app" "$FEED"
PKG="$(cd "$FEED" && ls *.app.tar.gz)"
check "release pack names the bundle by version and arch" "$PKG" test "$PKG" = "jobleft_${N1}_aarch64.app.tar.gz"
node "$SHELL_DIR/scripts/updater-latest-json.mjs" --version "$N1" --allow-http --base-url "http://127.0.0.1:$PORT/" \
  --platform "darwin-aarch64=$FEED/$PKG" --notes "updater proof" --out "$FEED/latest-good.json"
# The release form of the same feed (absolute GitHub asset URLs), kept for the record.
node "$SHELL_DIR/scripts/updater-latest-json.mjs" --version "$N1" --base-url "https://github.com/${GITHUB_REPOSITORY:-owner/repo}/releases/download/v$N1/" \
  --platform "darwin-aarch64=$FEED/$PKG" --notes "updater proof" --out "$OUT/latest-release-form.json"
check "release feed has the absolute GitHub asset URL" "$(jfield "$OUT/latest-release-form.json" version)" \
  grep -q "\"url\": \"https://github.com/${GITHUB_REPOSITORY:-owner/repo}/releases/download/v$N1/$PKG\"" "$OUT/latest-release-form.json"
# A signature over the same bundle from another key. The throwaway key has a password, given on the command line:
# without one, Tauri CLI 2.11 waits for a password prompt.
node "$CLI_JS" signer generate --ci -w "$WORK/other.key" -p proof-other < /dev/null >/dev/null 2>&1
cp "$FEED/$PKG" "$WORK/$PKG"
env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD node "$CLI_JS" signer sign -f "$WORK/other.key" -p proof-other --app-version "$N1" "$WORK/$PKG" < /dev/null >/dev/null
node "$SHELL_DIR/test/updater/make-feeds.mjs" "$FEED" darwin-aarch64 "$PKG" "$WORK/$PKG.sig"
cp "$FEED"/latest-*.json "$OUT/"

echo "==> Install N in /Applications"
stop_all
rm -rf "$INSTALLED"; ditto "$WORK/N.app" "$INSTALLED"
N_CDHASH="$(cdhash "$INSTALLED")"; N_DR="$(dr "$INSTALLED")"; N_LEAF="$(leaf "$INSTALLED")"; N_BUNDLE="$(plist "$INSTALLED" CFBundleIdentifier)"
N1_CDHASH="$(cdhash "$WORK/jobleft.app")"
codesign -dvvv "$INSTALLED" > "$OUT/codesign-N.txt" 2>&1; codesign -d -r- "$INSTALLED" >> "$OUT/codesign-N.txt" 2>&1
echo "N: bundle $N_BUNDLE, cdhash $N_CDHASH"; echo "N designated requirement: $N_DR"

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$FEED" > "$OUT/feed-server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do curl -fs "http://127.0.0.1:$PORT/latest-good.json" >/dev/null && break; sleep 1; done

selftest version "$OUT/r-version-N.jsonl"
check "N reports its version" "$(field "$OUT/r-version-N.jsonl" version)" test "$(field "$OUT/r-version-N.jsonl" version)" = "$N"
cp "$FEED/latest-good.json" "$FEED/latest.json"
selftest check "$OUT/r-check-N.jsonl"
check "N finds N+1 on the feed" "result=$(field "$OUT/r-check-N.jsonl" result) new=$(field "$OUT/r-check-N.jsonl" new_version)" \
  test "$(field "$OUT/r-check-N.jsonl" result)/$(field "$OUT/r-check-N.jsonl" new_version)" = "available/$N1"

for case in badsig tampered version; do
  cp "$FEED/latest-$case.json" "$FEED/latest.json"
  R="$OUT/r-$case.jsonl"
  selftest install "$R"
  check "[$case] the update is refused (exit 2)" "exit=$RC; $(field "$R" error | head -c 160)" test "$RC" = 2 -a "$(field "$R" result)" = error
  check "[$case] the app on disk is still N" "$(plist "$INSTALLED" CFBundleShortVersionString)" test "$(plist "$INSTALLED" CFBundleShortVersionString)" = "$N"
  check "[$case] the app on disk is the same code (cdhash)" "$(cdhash "$INSTALLED")" test "$(cdhash "$INSTALLED")" = "$N_CDHASH"
  check "[$case] its signature is intact" "" codesign --verify --strict --deep "$INSTALLED"
done
# The reasons, as tauri-plugin-updater / minisign-verify word them.
check "[badsig] refused because of the key" "" grep -q "created with a different key" "$OUT/r-badsig.jsonl"
check "[tampered] refused because the signature does not verify" "" grep -q "signature verification failed" "$OUT/r-tampered.jsonl"
check "[version] refused because the signed version differs" "" grep -q "signed for version $N1 but the update endpoint announced" "$OUT/r-version.jsonl"

cp "$FEED/latest-good.json" "$FEED/latest.json"
R="$OUT/r-install.jsonl"
selftest install "$R"
check "[good] N downloads, verifies and installs N+1 (exit 0)" "exit=$RC result=$(field "$R" result) new=$(field "$R" new_version)" \
  test "$RC/$(field "$R" result)/$(field "$R" new_version)" = "0/installed/$N1"
check "[good] Info.plist on disk says N+1" "$(plist "$INSTALLED" CFBundleShortVersionString)" test "$(plist "$INSTALLED" CFBundleShortVersionString)" = "$N1"
selftest version "$OUT/r-version-after.jsonl"
check "[good] the app on disk reports N+1" "$(field "$OUT/r-version-after.jsonl" version)" test "$(field "$OUT/r-version-after.jsonl" version)" = "$N1"
check "[good] the installed code is the signed N+1, byte for byte (cdhash)" "$(cdhash "$INSTALLED")" test "$(cdhash "$INSTALLED")" = "$N1_CDHASH"
check "[good] its signature is intact" "" codesign --verify --strict --deep "$INSTALLED"
codesign -dvvv "$INSTALLED" > "$OUT/codesign-after.txt" 2>&1; codesign -d -r- "$INSTALLED" >> "$OUT/codesign-after.txt" 2>&1
check "[TCC] same bundle id" "$(plist "$INSTALLED" CFBundleIdentifier)" test "$(plist "$INSTALLED" CFBundleIdentifier)" = "$N_BUNDLE"
check "[TCC] same signing certificate" "leaf sha256 $(leaf "$INSTALLED" | head -c 16)…" test "$(leaf "$INSTALLED")" = "$N_LEAF"
check "[TCC] same designated requirement" "$(dr "$INSTALLED")" test "$(dr "$INSTALLED")" = "$N_DR"
check "[TCC] N+1 satisfies the requirement recorded for N" "" codesign --verify -R="$N_DR" "$INSTALLED"
check "[TCC] no leftover temp bundle next to the app" "" test -z "$(ls -d /Applications/*tauri* 2>/dev/null)"
selftest check "$OUT/r-check-after.jsonl"
check "[good] N+1 finds no newer version" "$(field "$OUT/r-check-after.jsonl" result)" test "$(field "$OUT/r-check-after.jsonl" result)" = none

echo "==> Restart: from N with its local service running, the yes answer of the question"
stop_all
rm -rf "$INSTALLED"; ditto "$WORK/N.app" "$INSTALLED"
rm -rf "$DATA/run"
R="$OUT/r-restart.jsonl"; rm -f "$R"
# No publik app token in these builds: the local service runs no sign-in gate and sends nothing.
PUBLIK_UPDATE_SELF_TEST=restart PUBLIK_UPDATE_SELF_TEST_SIDECAR=1 PUBLIK_UPDATE_SELF_TEST_OUT="$R" \
  JOBLEFT_AUTO_CRAWL=0 JOBLEFT_SEED_BOARDS=none "$BIN" > "$R.stdout" 2> "$R.log" &
OLD_PID=$!
T=0; while alive "$OLD_PID" && [ "$T" -lt 180 ]; do sleep 1; T=$((T + 1)); done
RC=0; if alive "$OLD_PID"; then kill -9 "$OLD_PID" 2>/dev/null || true; RC=124; else wait "$OLD_PID" || RC=$?; fi
cp "$DATA/run/self-test-sidecar.json" "$OUT/restart-sidecar-N.json" 2>/dev/null || true
SIDE_PID="$(jfield "$OUT/restart-sidecar-N.json" pid)"
check "[restart] the local service of N was up when the update started" "pid ${SIDE_PID:-none} port $(jfield "$OUT/restart-sidecar-N.json" port)" test -n "$SIDE_PID"
check "[restart] N installs N+1 and restarts on the yes (exit 0)" "exit=$RC result=$(field "$R" result) new=$(field "$R" new_version)" \
  test "$RC/$(field "$R" result)/$(field "$R" new_version)" = "0/restarting/$N1"
check "[restart] the local service of N has stopped" "pid ${SIDE_PID:-none}" gone "${SIDE_PID:-0}"
check "[restart] Info.plist on disk says N+1" "$(plist "$INSTALLED" CFBundleShortVersionString)" test "$(plist "$INSTALLED" CFBundleShortVersionString)" = "$N1"
check "[restart] the installed code is the signed N+1 (cdhash)" "$(cdhash "$INSTALLED")" test "$(cdhash "$INSTALLED")" = "$N1_CDHASH"
# The new copy: started by LaunchServices (`open -n`), with none of this script's environment, in the default data
# folder. It must get past the single-instance check and the data-folder lock, start its service and open its window.
NEW_PID=""
for _ in $(seq 1 90); do
  if [ -f "$DATA/run/shell.json" ]; then NEW_PID="$(jfield "$DATA/run/shell.json" pid)"; [ -n "$NEW_PID" ] && break; fi
  sleep 1
done
cp "$DATA/run/shell.json" "$OUT/restart-shell-N1.json" 2>/dev/null || true
cp "$DATA/run/server.json" "$OUT/restart-server-N1.json" 2>/dev/null || true
ps -axo pid,lstart,command | grep -F "$INSTALLED/Contents/MacOS/" | grep -v grep > "$OUT/restart-processes.txt" || true
NEW_CMD="$(ps -o command= -p "${NEW_PID:-0}" 2>/dev/null || true)"
check "[restart] jobleft is running again, as a new process from /Applications" "old pid $OLD_PID, new pid ${NEW_PID:-none} ($NEW_CMD)" \
  test -n "$NEW_PID" -a "$NEW_PID" != "$OLD_PID" -a "${NEW_CMD#"$BIN"}" != "$NEW_CMD"
check "[restart] the old process is gone" "pid $OLD_PID" gone "$OLD_PID"
check "[restart] the new copy opened its window (run/shell.json)" "windowShown=$(jfield "$DATA/run/shell.json" windowShown)" \
  test "$(jfield "$DATA/run/shell.json" windowShown)" = True
HPORT="$(jfield "$DATA/run/shell.json" port)"
HEALTH="$(curl -fs --max-time 5 "http://127.0.0.1:${HPORT:-1}/api/v1/health" 2>/dev/null || true)"
echo "$HEALTH" > "$OUT/restart-health.json"
check "[restart] its local service answers health" "port ${HPORT:-none}" grep -q '"jobleft"' "$OUT/restart-health.json"
screencapture -x "$OUT/restart-macos.png" 2>/dev/null || echo "screencapture unavailable"
if [ -n "$NEW_PID" ]; then kill -TERM "$NEW_PID" 2>/dev/null || true; for _ in $(seq 1 15); do alive "$NEW_PID" || break; sleep 1; done; fi
check "[restart] the new copy quits cleanly on SIGTERM" "pid ${NEW_PID:-none}" gone "${NEW_PID:-0}"
stop_all

echo "==> The restart question, from N again (the background check as users get it)"
rm -rf "$INSTALLED"; ditto "$WORK/N.app" "$INSTALLED"
R="$OUT/r-prompt.jsonl"; rm -f "$R"
BEFORE="$(windows_of 0)"
PUBLIK_UPDATE_SELF_TEST=prompt PUBLIK_UPDATE_SELF_TEST_OUT="$R" "$BIN" > "$R.stdout" 2> "$R.log" &
APP_PID=$!
for _ in $(seq 1 120); do grep -q '"asking"' "$R" 2>/dev/null && break; kill -0 "$APP_PID" 2>/dev/null || break; sleep 1; done
sleep 5
ALIVE=no; kill -0 "$APP_PID" 2>/dev/null && ALIVE=yes
check "[prompt] N asks to restart and keeps running (no forced restart)" "result=$(field "$R" result) running=$ALIVE version=$(field "$R" version)" \
  test "$(field "$R" result)/$ALIVE/$(field "$R" version)" = "asking/yes/$N"
# jobleft installs only after the yes (updates.rs, INSTALL_IN_BACKGROUND): the local service reads the bundle.
check "[prompt] nothing is installed before a yes" "$(plist "$INSTALLED" CFBundleShortVersionString), waits_for_yes=$(field "$R" install_waits_for_yes)" \
  test "$(plist "$INSTALLED" CFBundleShortVersionString)/$(cdhash "$INSTALLED")/$(field "$R" install_waits_for_yes)" = "$N/$N_CDHASH/True"
WINS=0
for _ in $(seq 1 10); do WINS="$(windows_of "$APP_PID")"; [ "${WINS:-0}" -gt "${BEFORE:-0}" ] 2>/dev/null && break; sleep 1; done
check "[prompt] the question is on screen" "$WINS window(s) of the app or its system alert, $BEFORE before launch" \
  test "${WINS:-0}" -gt "${BEFORE:-0}"
screencapture -x "$OUT/prompt-macos.png" 2>/dev/null || echo "screencapture unavailable"
kill "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true
sleep 2; echo "after the app quit: $(windows_of 0)" >> "$OUT/windows.log"

stop_all
security delete-keychain "$KC" 2>/dev/null || true
rm -rf "$INSTALLED"
echo
echo "$PASS passed, $FAILS failed"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo "### macOS updater proof: $PASS passed, $FAILS failed"; echo; cat "$RESULTS"; } >> "$GITHUB_STEP_SUMMARY"
[ "$FAILS" -eq 0 ]
