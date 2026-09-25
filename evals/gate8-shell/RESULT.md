# Gate 8 (i-shell) result, 2026-09-25T16:06:35.428Z

The unsigned debug bundle `.cache/cargo-target/debug/bundle/macos/jobleft.app`, launched from its executable with a scratch data folder (a fresh one, then a copy of the gate 2 store with 11,957 jobs), judged from outside: files, processes, port, and a probe that ran inside its WKWebView and inside headless Chromium.

| Check | Result | Evidence |
|---|---|---|
| setup.bundle | PASS | .cache/cargo-target/debug/bundle/macos/jobleft.app (251 MB); signature: ad-hoc; node: true; server: Contents/Resources/server/src/main.js; ui: Contents/Resources/ui/index.html |
| O1.first-launch | PASS | window reported 709 ms after the double-click; server on port 47821 healthy: true; the window shows: first-run setup in webkit, viewport 1280x792; shell stderr: "" |
| O12.no-token-in-logs | PASS | logs/sidecar.log (0 bytes) holds neither the launch token nor a person's name |
| O11.never-answers-strangers | PASS | no token 401; DNS-rebinding Host 403; foreign Origin 403; listening on: 127.0.0.1:47821 |
| O9.quit-clean | PASS | shell exited in 203 ms; server process gone: true; port closed: true; run/server.json removed: true; run/shell.json removed: true; total 204 ms |
| O1.later-launch | PASS | window reported 305 ms after launch (target 2 s, allowed 5 s here: a debug build of the shell); feed in WKWebView: 8 cards, first "Forward Deployed Software Engineer - US Government" Match 67 percent, fair match |
| O10.single-instance | PASS | second launch exited with 0 in time; first shell (pid 3505) still runs: true; jobleft shell processes: 1; second's stderr: "" |
| O-visual.wkwebview-vs-chromium | PASS | 8 cards in WKWebView vs 8 in Chromium at 1280x792: same ids, titles, scores, fonts; positions within 12 px; no sideways overflow; window: window 10167 bounds 134,69 1280x820; WKWebView capture 2560x1640 |
| O9.O10.crash-then-relaunch | PASS | after kill -9 of the shell, the server exited by itself in 303 ms (parent pid gone): true; port closed: true; next launch opened a window in 506 ms and answers health 200 (no "already running") |
| O9.quit-again | PASS | second quit: shell 203 ms, server gone true, port closed true |

Verdict: PASS