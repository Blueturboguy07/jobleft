#!/usr/bin/env bash
# Live update proof on a GitHub macOS runner (.github/workflows/live-update-proof.yml). NEVER run it on a desk Mac: it
# installs jobleft into /Applications, writes TCC rows (sudo), starts the app and clicks its dialogs.
#
# Usage: apps/shell/test/live-proof/macos.sh <from_tag> <expect_version> <out dir>
#   from_tag        the release a user has: its dmg is downloaded from GitHub (the file publik's listing links),
#                   with the quarantine flag a browser sets, and installed as a user does (copied from the dmg)
#   expect_version  what the app must run after its own updater has asked the LIVE feed
#                   (https://publikhq.com/api/updates/jobleft/latest.json). The from_tag version itself: the app must
#                   find no update and stay as it is (the check of this harness before a new version is live).
#
# The app starts the normal way (open, LaunchServices), with no test hook and no feed override: the release build reads
# its feed URL from its own config. Two variables go to the app through launchd, and neither touches the updater:
# DO_NOT_TRACK=1 (a runner is not a user) and PUBLIK_ORIGIN=http://127.0.0.1:9, so that the sign-in gate of the local
# service makes no install on publik (the gate then shows "publik is not reachable"; nobody signs in, and the
# microphone, camera and screen capture stay unused).
# Every assertion is a PASS/FAIL line in <out>/results.md and the job summary; INFO lines are evidence, not assertions.
set -uo pipefail
FROM_TAG="${1:?from_tag}"; EXPECT="${2:?expect_version}"; OUT="${3:?out dir}"
FROM="${FROM_TAG#v}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${GITHUB_REPOSITORY:-Blueturboguy07/jobleft}"
APP_ID=com.publik.jobleft
FEED_URL="https://publikhq.com/api/updates/jobleft/latest.json"
INSTALLED=/Applications/jobleft.app
DATA="$HOME/Library/Application Support/jobleft"
USER_DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
SYSTEM_DB="/Library/Application Support/com.apple.TCC/TCC.db"
UI="$HERE/ui.applescript"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d)"; mkdir -p "$WORK/dl"
RESULTS="$OUT/results.md"; PASS=0; FAILS=0
printf '| Check | Result | Detail |\n|---|---|---|\n' > "$RESULTS"
pass() { PASS=$((PASS + 1)); echo "PASS  $1 ${2:+($2)}"; echo "| $1 | PASS | ${2:-} |" >> "$RESULTS"; }
fail() { FAILS=$((FAILS + 1)); echo "FAIL  $1 ${2:+($2)}"; echo "| $1 | **FAIL** | ${2:-} |" >> "$RESULTS"; }
info() { echo "INFO  $1"; echo "| $1 | info | ${2:-} |" >> "$RESULTS"; }
check() { local name="$1" detail="$2"; shift 2; if "$@"; then pass "$name" "$detail"; else fail "$name" "$detail"; fi; }
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null; }
cdhash() { codesign -dvvv "$1" 2>&1 | sed -n 's/^CDHash=//p'; }
dr() { codesign -d -r- "$1" 2>&1 | sed -n 's/^designated => //p'; }
jfield() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$1" "$2" 2>/dev/null || true; }
shot() { screencapture -x "$OUT/$1.png" 2>/dev/null || echo "screencapture $1: not allowed on this runner"; }
ui() { osascript "$UI" "$@" 2>&1; }
# The jobleft shell processes from /Applications (the local service is "node").
app_pids() { pgrep -x jobleft 2>/dev/null | while read -r p; do case "$(ps -o comm= -p "$p" 2>/dev/null)" in "$INSTALLED"/*) echo "$p" ;; esac; done; }
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
health() { local port; port="$(jfield "$DATA/run/shell.json" port)"; curl -fs --max-time 5 "http://127.0.0.1:${port:-1}/api/v1/health" 2>/dev/null || true; }
health_version() { health | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("version",""))' 2>/dev/null || true; }
# The text of the update dialog: the dialog plugin shows it with CFUserNotificationDisplayAlert, so macOS draws it in
# UserNotificationCenter; a sheet would be a window of jobleft itself. Both are read.
dialog_text() {
  ui dump UserNotificationCenter > "$WORK/dialog.txt"
  grep -q "^window 1" "$WORK/dialog.txt" || ui dump jobleft >> "$WORK/dialog.txt"
  cat "$WORK/dialog.txt"
}
no_dialog_with() { ! dialog_text | grep -qF "$1"; }
wait_dialog() {  # <text> <seconds>: true once a dialog with that text is on screen
  local i
  for i in $(seq 1 "$2"); do dialog_text | grep -qF "$1" && return 0; sleep 1; done
  return 1
}
click_in_dialog() {  # <button>: clicks it in UserNotificationCenter, else in jobleft
  local r; r="$(ui click UserNotificationCenter "$1")"
  case "$r" in clicked*) echo "$r (UserNotificationCenter)"; return 0 ;; esac
  r="$(ui click jobleft "$1")"; echo "$r (jobleft)"
  case "$r" in clicked*) return 0 ;; esac
  return 1
}
wait_log() {  # <file> <regex> <seconds>
  local i
  for i in $(seq 1 "$3"); do grep -qE "$2" "$1" 2>/dev/null && return 0; sleep 1; done
  return 1
}
wait_new_pid() {  # <old pid or empty> <seconds>: prints the pid of a jobleft shell that is not the old one
  local i p
  for i in $(seq 1 "$2"); do
    for p in $(app_pids); do [ "$p" != "${1:-}" ] && { echo "$p"; return 0; }; done
    sleep 1
  done
  return 1
}
stop_all() {
  local p
  for p in $(app_pids); do kill -TERM "$p" 2>/dev/null; done
  for _ in $(seq 1 15); do [ -z "$(app_pids)" ] && break; sleep 1; done
  pkill -KILL -f "^$INSTALLED/Contents/MacOS/" 2>/dev/null || true
}
# Launch as a user does (LaunchServices), the app's stdout and stderr in files. The first launch of the quarantined
# copy shows Gatekeeper's question; it is answered "Open", as a person answers it.
launch() {  # <log name>: sets APP_PID
  local i r
  rm -f "$DATA/run/shell.json"
  open -a "$INSTALLED" --stdout "$OUT/$1.out" --stderr "$OUT/$1.err"
  APP_PID=""
  for i in $(seq 1 90); do
    APP_PID="$(app_pids | head -1)"
    [ -n "$APP_PID" ] && [ -f "$DATA/run/shell.json" ] && break
    if ui dump CoreServicesUIAgent | grep -q "^window 1"; then
      ui dump CoreServicesUIAgent > "$OUT/gatekeeper-question.txt"
      shot gatekeeper-question
      r="$(ui click CoreServicesUIAgent Open)"
      info "Gatekeeper's first-launch question was answered: $r" "$(grep -m1 -i 'downloaded from the internet' "$OUT/gatekeeper-question.txt" | cut -c1-160)"
    fi
    sleep 1
  done
}

echo "macOS $(sw_vers -productVersion) ($(sw_vers -buildVersion)), $(uname -m); from $FROM_TAG, expect $EXPECT"
printf '%s' "$FROM" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "from_tag must be v<x.y.z>"; exit 2; }
printf '%s' "$EXPECT" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "expect_version must be x.y.z"; exit 2; }
UPDATE=0; [ "$EXPECT" != "$FROM" ] && UPDATE=1

echo "==> 0. What the live feed announces now"
curl -fsS --max-time 20 -o "$OUT/live-feed.json" "$FEED_URL" || echo "{}" > "$OUT/live-feed.json"
FEED_V="$(jfield "$OUT/live-feed.json" version)"
check "the live feed ($FEED_URL) announces $EXPECT" "it announces ${FEED_V:-nothing}" test "$FEED_V" = "$EXPECT"

echo "==> 1. Download $FROM_TAG as a user does, with the quarantine flag a browser sets"
DMG_NAME="jobleft_${FROM}_aarch64.dmg"
DMG_URL="https://github.com/$REPO/releases/download/$FROM_TAG/$DMG_NAME"
curl -fsSL --retry 3 -o "$WORK/dl/$DMG_NAME" "$DMG_URL"
check "downloaded $DMG_NAME from the release" "$DMG_URL, sha256 $(shasum -a 256 "$WORK/dl/$DMG_NAME" 2>/dev/null | cut -c1-16)…" test -s "$WORK/dl/$DMG_NAME"
Q="0083;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)"
xattr -w com.apple.quarantine "$Q" "$WORK/dl/$DMG_NAME"
SP="$(spctl -a -t open --context context:primary-signature -vv "$WORK/dl/$DMG_NAME" 2>&1)"; echo "$SP" > "$OUT/spctl-dmg.txt"
check "Gatekeeper accepts the quarantined dmg: Notarized Developer ID" "$(echo "$SP" | tr '\n' ' ' | cut -c1-200)" grep -q "source=Notarized Developer ID" "$OUT/spctl-dmg.txt"

echo "==> 2. Install: copy jobleft.app from the dmg to /Applications"
stop_all
MNT="$WORK/mnt"; mkdir -p "$MNT"
hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$WORK/dl/$DMG_NAME" > /dev/null
[ -e "$INSTALLED" ] && rm -R "$INSTALLED"
ditto "$MNT/jobleft.app" "$INSTALLED"
hdiutil detach "$MNT" -quiet || hdiutil detach "$MNT" -force -quiet
# Finder keeps the flag on the copy; ditto from the quarantined image does too, and it is set again to be sure.
xattr -w -r com.apple.quarantine "$Q" "$INSTALLED"
check "the installed app carries the quarantine flag" "$(xattr -p com.apple.quarantine "$INSTALLED" 2>/dev/null)" xattr -p com.apple.quarantine "$INSTALLED"
SP="$(spctl -a -t exec -vv "$INSTALLED" 2>&1)"; echo "$SP" > "$OUT/spctl-installed-before.txt"
check "Gatekeeper accepts the installed app: Notarized Developer ID" "$(echo "$SP" | tr '\n' ' ' | cut -c1-200)" grep -q "source=Notarized Developer ID" "$OUT/spctl-installed-before.txt"
check "the installed app is $FROM" "$(plist "$INSTALLED" CFBundleShortVersionString)" test "$(plist "$INSTALLED" CFBundleShortVersionString)" = "$FROM"
DR_BEFORE="$(dr "$INSTALLED")"; CD_BEFORE="$(cdhash "$INSTALLED")"
{ codesign -dvvv "$INSTALLED"; codesign -d -r- "$INSTALLED"; } > "$OUT/codesign-before.txt" 2>&1
echo "designated requirement: $DR_BEFORE"
check "designated requirement recorded" "$DR_BEFORE" test -n "$DR_BEFORE"

echo "==> 3. TCC: allowed rows for camera, microphone, screen capture and accessibility, bound to the app's requirement"
printf '%s' "$DR_BEFORE" | csreq -r- -b "$WORK/dr.bin"
bash "$HERE/tcc-root.sh" schema "$USER_DB" > "$OUT/tcc-schema-user.txt" 2>&1
bash "$HERE/tcc-root.sh" schema "$SYSTEM_DB" > "$OUT/tcc-schema-system.txt" 2>&1
sed -n 1p "$OUT/tcc-schema-system.txt"
# Camera and microphone are per user; screen capture and accessibility are in the system database.
GRANTS="kTCCServiceCamera:$USER_DB kTCCServiceMicrophone:$USER_DB kTCCServiceScreenCapture:$SYSTEM_DB kTCCServiceAccessibility:$SYSTEM_DB"
for g in $GRANTS; do
  svc="${g%%:*}"; db="${g#*:}"
  r="$(bash "$HERE/tcc-root.sh" grant "$db" "$svc" "$APP_ID" "$WORK/dr.bin" 2>&1)"; echo "$r"
  bash "$HERE/tcc-root.sh" show "$db" "$svc" "$APP_ID" "$WORK/$svc-before.bin" > "$OUT/tcc-$svc-before.json" 2>&1
  check "[TCC] $svc row written ($( [ "$db" = "$SYSTEM_DB" ] && echo system || echo user ) TCC.db)" "$(cut -c1-180 "$OUT/tcc-$svc-before.json")" \
    grep -q '"auth_value": 2' "$OUT/tcc-$svc-before.json"
done

echo "==> 4. The UI can be driven (System Events)"
UI_OK=no
osascript -e 'tell application "System Events" to get name of every process whose background only is false' > "$OUT/ui-preflight.txt" 2>&1 && UI_OK=yes
info "System Events answers (Accessibility for the runner): $UI_OK" "$(head -c 200 "$OUT/ui-preflight.txt")"

echo "==> 5. Start the installed app the normal way"
launchctl setenv DO_NOT_TRACK 1
launchctl setenv PUBLIK_ORIGIN http://127.0.0.1:9
dig +short publikhq.com A > "$OUT/publikhq-addresses.txt" 2>/dev/null || true
# Evidence of the app's own requests: its TCP connections, sampled every second (the shell process only).
( while :; do lsof -nP -a -iTCP -c jobleft 2>/dev/null | sed "s/^/$(date -u +%H:%M:%S) /"; sleep 1; done ) > "$OUT/connections.txt" 2>&1 &
SAMPLER=$!
# And every new TLS connection with the process that opened it (macOS tcpdump: pktap, -k), when the runner allows it.
bash "$HERE/tcc-root.sh" capture "$OUT/syn-443.txt" &
launch app-1
PID1="$APP_PID"
check "jobleft started from /Applications" "pid ${PID1:-none}: $(ps -o command= -p "${PID1:-0}" 2>/dev/null)" alive "$PID1"
check "its window opened and its local service answers" "$(jfield "$DATA/run/shell.json" windowShown) $(health | cut -c1-120)" \
  test "$(jfield "$DATA/run/shell.json" windowShown)" = True -a -n "$(health)"
sleep 3; shot launched

echo "==> 6. The updater's first check (10 s after launch) against the live feed"
wait_log "$OUT/app-1.err" '^updates: ' 180
grep '^updates: ' "$OUT/app-1.err" | head -5
check "no check failed" "$(grep -m1 'the check failed' "$OUT/app-1.err")" bash -c "! grep -q 'the check failed' '$OUT/app-1.err'"
if [ "$UPDATE" = 0 ]; then
  check "the updater asked the live feed: $FROM is the latest version" "$(grep -m1 '^updates: ' "$OUT/app-1.err")" \
    grep -qx "updates: $FROM is the latest version" "$OUT/app-1.err"
  sleep 5
  check "no update question" "" no_dialog_with "is ready"
  check "the app keeps running as $FROM" "pid $PID1, Info.plist $(plist "$INSTALLED" CFBundleShortVersionString), local service $(health_version)" \
    test "$(alive "$PID1" && echo up)/$(plist "$INSTALLED" CFBundleShortVersionString)/$(health_version)/$(cdhash "$INSTALLED")" = "up/$FROM/$FROM/$CD_BEFORE"
  CUR_PID="$PID1"
else
  check "the updater downloaded and verified $EXPECT" "$(grep -m1 '^updates: ' "$OUT/app-1.err")" \
    grep -qx "updates: jobleft $EXPECT is ready" "$OUT/app-1.err"
  QOK=no; wait_dialog "jobleft $EXPECT is ready" 30 && QOK=yes
  cp "$WORK/dialog.txt" "$OUT/question-1.txt"; shot question-1
  check "the question is on screen: jobleft $EXPECT is ready, Install and Restart or Later" "$(grep -m1 'is ready' "$OUT/question-1.txt" | cut -c1-160)" \
    test "$QOK" = yes
  check "nothing is installed before the answer" "Info.plist $(plist "$INSTALLED" CFBundleShortVersionString)" \
    test "$(plist "$INSTALLED" CFBundleShortVersionString)/$(cdhash "$INSTALLED")" = "$FROM/$CD_BEFORE"

  echo "==> 7a. The answer Later"
  r="$(click_in_dialog Later)"; echo "$r"
  check "Later is clicked" "$r" test "${r#clicked}" != "$r"
  sleep 5
  check "Later: the question closes" "" no_dialog_with "is ready"
  check "Later: the app keeps running, on $FROM" "pid $PID1 $(alive "$PID1" && echo up), Info.plist $(plist "$INSTALLED" CFBundleShortVersionString), local service $(health_version)" \
    test "$(alive "$PID1" && echo up)/$(plist "$INSTALLED" CFBundleShortVersionString)/$(cdhash "$INSTALLED")/$(health_version)" = "up/$FROM/$CD_BEFORE/$FROM"
  shot after-later

  echo "==> 7b. Check for Updates… offers the downloaded update again; the answer Install and Restart"
  r="$(ui menu jobleft "Check for Updates")"; echo "$r" | tee "$OUT/menu-1.txt"
  MENU1=no; case "$r" in clicked*) MENU1=yes ;; esac
  if [ "$MENU1" = yes ] && wait_dialog "jobleft $EXPECT is ready" 30; then
    pass "Check for Updates… (menu bar item) asks again for the downloaded $EXPECT" "$r"
  else
    fail "Check for Updates… (menu bar item) asks again for the downloaded $EXPECT" "$r"
    # What a person can also do: quit and open the app again. The question comes back with the first check.
    info "fallback: quit and open jobleft again to get the question" ""
    stop_all; launch app-2; PID1="$APP_PID"
    wait_log "$OUT/app-2.err" "^updates: jobleft $EXPECT is ready" 180
    wait_dialog "jobleft $EXPECT is ready" 30
  fi
  cp "$WORK/dialog.txt" "$OUT/question-2.txt"; shot question-2
  r="$(click_in_dialog "Install and Restart")"; echo "$r"
  check "Install and Restart is clicked" "$r" test "${r#clicked}" != "$r"

  echo "==> 7c. The restart into $EXPECT"
  for _ in $(seq 1 90); do alive "$PID1" || break; sleep 1; done
  check "the old process ($FROM) has ended" "pid $PID1" bash -c "! kill -0 $PID1 2>/dev/null"
  NEW_PID="$(wait_new_pid "$PID1" 120)"
  for _ in $(seq 1 90); do [ "$(jfield "$DATA/run/shell.json" pid)" = "${NEW_PID:-x}" ] && break; sleep 1; done
  check "jobleft started again by itself, as a new process from /Applications" "new pid ${NEW_PID:-none}: $(ps -o command= -p "${NEW_PID:-0}" 2>/dev/null)" alive "$NEW_PID"
  check "Info.plist on disk says $EXPECT" "$(plist "$INSTALLED" CFBundleShortVersionString)" test "$(plist "$INSTALLED" CFBundleShortVersionString)" = "$EXPECT"
  RUN_CD="$(codesign -dvvv "${NEW_PID:-0}" 2>&1 | sed -n 's/^CDHash=//p')"; DISK_CD="$(cdhash "$INSTALLED")"
  check "the running process is the code on disk (cdhash of pid $NEW_PID = cdhash of the bundle)" "$RUN_CD" test -n "$RUN_CD" -a "$RUN_CD" = "$DISK_CD"
  check "the running app's window and local service are up, and the service reports $EXPECT" "windowShown=$(jfield "$DATA/run/shell.json" windowShown) health=$(health | cut -c1-100)" \
    test "$(jfield "$DATA/run/shell.json" windowShown)/$(health_version)" = "True/$EXPECT"
  check "no temp bundle left next to the app" "$(ls -d /Applications/*tauri* 2>/dev/null)" test -z "$(ls -d /Applications/*tauri* 2>/dev/null)"
  check "no manual download: the only jobleft file this job downloaded is $DMG_NAME" "$(ls "$WORK/dl" | tr '\n' ' ')" test "$(ls "$WORK/dl")" = "$DMG_NAME"
  shot restarted
  CUR_PID="$NEW_PID"
  sleep 20 # the new copy's own first check runs 10 s after its launch
fi

echo "==> 8. Check for Updates… in the menu bar item: the app's answer"
r="$(ui menu jobleft "Check for Updates")"; echo "$r" | tee "$OUT/menu-check.txt"
ANSWER=""
if wait_dialog "is the latest version" 40; then ANSWER="$(grep -m1 -oE "jobleft [0-9.]+ is the latest version\." "$WORK/dialog.txt")"
elif grep -q "already checking" "$WORK/dialog.txt"; then
  click_in_dialog OK; sleep 15; r="$(ui menu jobleft "Check for Updates")"; echo "$r"
  wait_dialog "is the latest version" 40 && ANSWER="$(grep -m1 -oE "jobleft [0-9.]+ is the latest version\." "$WORK/dialog.txt")"
fi
cp "$WORK/dialog.txt" "$OUT/menu-answer.txt"; shot menu-answer
check "Check for Updates… answers \"jobleft $EXPECT is the latest version.\"" "${ANSWER:-$(tr '\n' ' ' < "$WORK/dialog.txt" | cut -c1-200)}; $r" \
  test "$ANSWER" = "jobleft $EXPECT is the latest version."
r="$(click_in_dialog OK)"; echo "$r"; sleep 2
check "the answer closes with OK" "$r" no_dialog_with "is the latest version"

if [ "$UPDATE" = 1 ]; then
  echo "==> 9. Quit and open again: the background check of $EXPECT itself"
  kill -TERM "$CUR_PID" 2>/dev/null
  for _ in $(seq 1 20); do alive "$CUR_PID" || break; sleep 1; done
  check "$EXPECT quits on SIGTERM (no dialog open)" "pid $CUR_PID" bash -c "! kill -0 $CUR_PID 2>/dev/null"
  stop_all
  launch app-3; CUR_PID="$APP_PID"
  wait_log "$OUT/app-3.err" '^updates: ' 120
  check "after a new start, $EXPECT asks the live feed: $EXPECT is the latest version" "$(grep -m1 '^updates: ' "$OUT/app-3.err")" \
    grep -qx "updates: $EXPECT is the latest version" "$OUT/app-3.err"
fi

echo "==> 10. Diagnostic: SIGTERM while a dialog of the app is open (known issue; not an assertion)"
r="$(ui menu jobleft "Check for Updates")"
if wait_dialog "is the latest version" 30 && alive "$CUR_PID"; then
  shot sigterm-dialog
  kill -TERM "$CUR_PID" 2>/dev/null
  QUIT=no; for _ in $(seq 1 15); do alive "$CUR_PID" || { QUIT=yes; break; }; sleep 1; done
  info "SIGTERM with the update dialog open: the app quit within 15 s: $QUIT" "pid $CUR_PID; $r"
else
  info "SIGTERM with a dialog open: no dialog to test with" "$r"
fi
stop_all
kill "$SAMPLER" 2>/dev/null
bash "$HERE/tcc-root.sh" capture-stop

echo "==> 11. After: code identity, Gatekeeper and the TCC rows"
DR_AFTER="$(dr "$INSTALLED")"
{ codesign -dvvv "$INSTALLED"; codesign -d -r- "$INSTALLED"; } > "$OUT/codesign-after.txt" 2>&1
check "[identity] the app on disk is $EXPECT" "$(plist "$INSTALLED" CFBundleShortVersionString)" test "$(plist "$INSTALLED" CFBundleShortVersionString)" = "$EXPECT"
check "[identity] designated requirement unchanged" "$DR_AFTER" test "$DR_AFTER" = "$DR_BEFORE"
check "[identity] bundle id unchanged" "$(plist "$INSTALLED" CFBundleIdentifier)" test "$(plist "$INSTALLED" CFBundleIdentifier)" = "$APP_ID"
check "[identity] codesign --verify --deep --strict" "" codesign --verify --deep --strict "$INSTALLED"
SP="$(spctl -a -t exec -vv "$INSTALLED" 2>&1)"; echo "$SP" > "$OUT/spctl-installed-after.txt"
check "[identity] Gatekeeper still accepts the app: Notarized Developer ID" "$(echo "$SP" | tr '\n' ' ' | cut -c1-200)" grep -q "source=Notarized Developer ID" "$OUT/spctl-installed-after.txt"
for g in $GRANTS; do
  svc="${g%%:*}"; db="${g#*:}"
  bash "$HERE/tcc-root.sh" show "$db" "$svc" "$APP_ID" "$WORK/$svc-after.bin" > "$OUT/tcc-$svc-after.json" 2>&1
  check "[TCC] $svc: the row is still there, allowed" "$(cut -c1-160 "$OUT/tcc-$svc-after.json")" grep -q '"auth_value": 2' "$OUT/tcc-$svc-after.json"
  REQ="$(csreq -r "$WORK/$svc-after.bin" -t 2>/dev/null)"
  check "[TCC] $svc: the stored csreq is the requirement recorded before the update" "$REQ" test -n "$REQ" -a "$REQ" = "$DR_BEFORE"
  check "[TCC] $svc: the updated app satisfies the stored csreq (codesign --verify -R <stored blob>)" "" \
    codesign --verify --test-requirement="$WORK/$svc-after.bin" "$INSTALLED"
done
info "The runner cannot show a TCC consent prompt. tccd allows a client without a prompt when its row is allowed and the code satisfies the row's stored csreq; the checks above make that same check for each of the four grants." ""

echo "==> Evidence of the app's own requests (not assertions)"
ADDRS="$(tr '\n' '|' < "$OUT/publikhq-addresses.txt" | sed 's/|$//')"
if [ -n "$ADDRS" ] && grep -qE "(${ADDRS//./\\.}):443" "$OUT/connections.txt"; then
  info "the jobleft process opened a connection to publikhq.com" "$(grep -m1 -E "(${ADDRS//./\\.}):443" "$OUT/connections.txt" | cut -c1-200)"
else
  info "no sampled connection of the jobleft process to publikhq.com ($ADDRS) (a short request can fall between samples)" ""
fi
if grep -q "proc jobleft" "$OUT/syn-443.txt" 2>/dev/null; then
  info "TLS connections opened by the jobleft process (tcpdump)" "$(grep "proc jobleft" "$OUT/syn-443.txt" | grep -oE '> [0-9.]+\.443' | sort -u | tr '\n' ' ' | cut -c1-200)"
fi
info "the app's own log lines" "$(cat "$OUT"/app-*.err 2>/dev/null | grep '^updates: ' | tr '\n' ';' | cut -c1-300)"

launchctl unsetenv DO_NOT_TRACK; launchctl unsetenv PUBLIK_ORIGIN
cp -R "$DATA/logs" "$OUT/app-data-logs" 2>/dev/null || true
echo
echo "$PASS passed, $FAILS failed"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### macOS live update proof: $FROM_TAG -> $EXPECT: $PASS passed, $FAILS failed"; echo; cat "$RESULTS"; } >> "$GITHUB_STEP_SUMMARY"
fi
[ "$FAILS" -eq 0 ]
