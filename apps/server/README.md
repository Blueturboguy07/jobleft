# @jobleft/server

The local server of jobleft. It keeps all of the person's data in one folder, answers the local API on
127.0.0.1 only, and serves the app window. This README gives exact commands and what you will see.
The API itself is in `docs/INTERFACES.md`, section 6. The acceptance outcomes are in `docs/outcomes/server.md`.

## 1. What is in this build

| Part | State |
|---|---|
| The HTTP server: loopback only, launch token, Host and Origin checks, no permissive CORS, body limits, one error shape | Built (`src/server.ts`, `src/http/`) |
| Data folder, single-instance lock, run file, clean stop, parent watch, free port | Built |
| Database: one SQLite file, forward-only migrations in one transaction, refusal of newer data | Built (`src/db/`) |
| Backup, restore, export, delete everything | Built (`src/services/backup.ts`) |
| Extension pairing, status, fill, review | Built (`src/services/pairing.ts`, `src/services/extension.ts`) |
| Settings, notifications, the dev clock | Built |
| Profile, tracker (likes, status, notes, reminders), saved filters, job search and detail, jobs added by link or text, resume files, network contacts, chat history, AI provider settings, publik balance card, boards and crawl runs | INTERIM stand-ins (`src/interim/`). They keep the server whole until the owning lanes merge. See section 13 |
| The server's own page at `/` | Built (`ui-fallback/`). The app window from `apps/ui` replaces it when `apps/ui/dist` exists |
| `apps/server/jobsync/` | A fork of jobsync (MIT) with the four spike S3 patches. It is NOT run or served. See `jobsync/JOBLEFT-FORK.md` |

Routes that need a lane that is not in this build answer `503 not_ready` with a plain sentence and change nothing
(tailoring, a PDF or Word file made from a resume, ATS check, cover letters, match score, H-1B and place lookups,
company facts, interview practice, message drafts, board resolve). An uploaded resume file itself does download
(section 5).

## 2. Before you start

| Need | Check |
|---|---|
| macOS on Apple silicon (Linux works for everything except the Keychain) | `uname -m` shows `arm64` |
| Node 24 or newer | `node --version` shows `v24` or higher |
| pnpm | `pnpm --version` |

From the repository root, run `pnpm install` once. It installs no third-party runtime code for the server: the
server uses only Node's own modules and the workspace packages.

Use a scratch data folder for every test, for example `/private/tmp/jl-eval`. Never point a test at your real folder.

## 3. Start and stop

### 3.1 Start for a headless test

```sh
export JOBLEFT_HOME=/private/tmp/jl-eval
node apps/server/src/main.ts
```

You see (the port and the token differ):

```
jobleft server 0.1.0
Data folder: /private/tmp/jl-eval
Listening on http://127.0.0.1:47821 (127.0.0.1 only)
Open in a browser: http://127.0.0.1:47821/#token=Xy...43 characters
Launch token (send it as the x-jobleft-token header): Xy...
Stop with Ctrl+C (or SIGTERM).
```

The port is the first free one of 47821 to 47830. If all ten are busy, the server takes any free loopback port and
still starts. The same port, token and process id are in `$JOBLEFT_HOME/run/server.json` (mode 0600).
A new token is made at every start. The token of an earlier run stops working.

For the commands in this README, set two shell variables:

```sh
P=$(python3 -c "import json;print(json.load(open('$JOBLEFT_HOME/run/server.json'))['port'])")
T=$(python3 -c "import json;print(json.load(open('$JOBLEFT_HOME/run/server.json'))['token'])")
```

### 3.2 Start for development

```sh
pnpm app:up      # data folder <repo>/.jobleft-dev unless JOBLEFT_HOME is set; prints the address to open
pnpm app:down    # stops it: SIGTERM, then SIGKILL after 10 s
```

`pnpm app:up` starts the server in the background with `JOBLEFT_DEV=1` and writes its log to
`$JOBLEFT_HOME/logs/server.log`. A second `pnpm app:up` prints the address of the running server.

### 3.3 Stop

| How | Result |
|---|---|
| Ctrl+C, `kill <pid>` (SIGTERM), SIGINT or SIGHUP | Stops within 5 s. `run/server.json` and `run/server.lock` are removed. Exit code 0 |
| The parent dies (`JOBLEFT_PARENT_PID` set, the shell is killed with `kill -9`) | The server sees it within 1 s and stops the same way |
| `kill -9 <server pid>` | Every confirmed save is on disk. The next start takes over the stale lock. No repair step |

### 3.4 Exit codes

| Code | Meaning |
|---|---|
| 0 | Stopped cleanly |
| 1 | Could not start (for example no free port), or an internal error stopped a running server: one plain line on stderr (no stack trace, no path), the run file and the lock removed, every confirmed save on disk |
| 2 | The data folder was refused and left untouched: written by a newer build, read-only, disk full, or not a jobleft database. The reason is printed on stderr |
| 3 | Another jobleft server already uses this data folder. The first one keeps running |

### 3.5 Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `JOBLEFT_HOME` | `~/Library/Application Support/jobleft` | The data folder |
| `JOBLEFT_PORT` | first free of 47821 to 47830 | The port to try first |
| `JOBLEFT_LAUNCH_TOKEN` | a new random token | The launch token. It is removed from the environment at start and never logged |
| `JOBLEFT_PARENT_PID` | none | Stop within 10 s after this process is gone |
| `JOBLEFT_UI_DIR` | `apps/ui/dist` when it exists, else the server's own page | The UI to serve at `/` |
| `JOBLEFT_DEV` | off | `1` enables `POST /api/v1/dev/clock` (time-skip) and contract checks of every answer in the log |
| `JOBLEFT_OFFLINE` | off | `1` = no outbound request at all. Crawl, AI and publik answer `503 offline` at once |
| `JOBLEFT_NOW`, `JOBLEFT_CLOCK_OFFSET` | real time | Freeze or shift the app clock (`72h`, `-30m`, `3d`) |
| `JOBLEFT_HOST_MAP` | none | JSON map from a real job-board host to a loopback stand-in (section 9) |
| `JOBLEFT_PUBLIK_BASE_URL` | `https://publikhq.com/api/v1` | Point it at the loopback stand-in for tests (section 9). Nothing is sent to publik unless the person connects |
| `JOBLEFT_PUBLIK_APP_TOKEN` | none | No real publik app token exists yet, so connecting answers a plain "not available" message. For tests, any text (for example `stand-in`) turns the connect flow on, but ONLY when `JOBLEFT_PUBLIK_BASE_URL` is a loopback address; with any other address it is ignored (section 9.4) |
| `JOBLEFT_SECRET_STORE` | `keychain` on macOS | `memory` keeps keys in memory only (use it for tests; keys are forgotten at stop) |
| `JOBLEFT_LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |
| `JOBLEFT_QUIET` | off | `1` = print nothing at start (used by `pnpm app:up`) |

## 4. The data folder

Everything personal is inside `$JOBLEFT_HOME`. Nothing personal is written anywhere else: the server sets `TMPDIR`
to `$JOBLEFT_HOME/tmp` and keeps SQLite's temporary data in memory. The one exception is keys, which go to the macOS
Keychain (service `jobleft-<hash of the folder path>`, so each data folder has its own keys).

| Path | What |
|---|---|
| `data/jobleft.db` (+ `-wal`, `-shm` while running) | The one database |
| `files/resumes/` | Uploaded resume files |
| `logs/server.log` | The log (no personal text, no key, no token; see section 11) |
| `tmp/` | Temporary files; emptied at every start and after each backup, export and restore |
| `run/server.json`, `run/server.lock` | Port, token and pid of the running server; the single-instance lock |
| `backups/`, `files/exports/`, `datasets/`, `models/` | Reserved for other lanes |

The folder and its sub-folders are mode 0700. Every file is mode 0600. The server reports the folder at
`GET /api/v1/storage` and on its own page at `/`.

## 5. Calling the API

Every route is in `docs/INTERFACES.md`, section 6.4. Send the token in the `x-jobleft-token` header:

```sh
curl -s http://127.0.0.1:$P/api/v1/health
# {"app":"jobleft","version":"0.1.0","apiVersion":1,"extensionProtocol":1}   (no token needed, no data)
curl -s -H "x-jobleft-token: $T" http://127.0.0.1:$P/api/v1/settings
curl -s -X PUT -H "x-jobleft-token: $T" -H 'content-type: application/json' \
  --data @apps/server/test/persona-profile.json http://127.0.0.1:$P/api/v1/profile
```

`apps/server/test/persona-profile.json` is the test persona's profile (Jordan Testwell). Every error has one shape:
`{"error":{"code":"...","message":"One plain sentence."}}`. The codes and HTTP statuses are in `docs/INTERFACES.md`
section 6.2. This build adds `write_failed` (507): the disk refused a save, and nothing was saved.

Useful writes for the "one change of each kind" checks:

| Kind | Request |
|---|---|
| Profile and preferences | `PUT /api/v1/profile` with a `ProfileInput` |
| A job to track | `POST /api/v1/jobs/external` with `{"text":"Data Analyst at Acme\nCompany: Acme\n...","applyUrl":"https://example.com/job/1"}` |
| Like, status, notes, reminders | `PATCH /api/v1/tracker/<jobId>` with `{"liked":true,"status":"applied","notes":[{"text":"..."}],"reminders":[{"at":"2026-10-01T09:00:00Z","text":"...","done":false}]}` (notes and reminders replace the list; keep `id` to keep a note) |
| Saved filter | `POST /api/v1/filters` with `{"name":"...","filter":{},"sort":"recommended"}` |
| Resume file | `curl -X POST -H "x-jobleft-token: $T" -H 'content-type: application/pdf' -H 'x-jobleft-filename: cv.pdf' --data-binary @cv.pdf .../api/v1/resumes/import`. Get the file back as the API serves it: `curl -H "x-jobleft-token: $T" -o back.pdf ".../api/v1/resumes/<resumeId>/export?format=pdf"` (byte for byte the uploaded file; `format=docx` for a Word upload) |
| Contacts (network import) | `curl -X POST -H 'content-type: text/csv' --data-binary @Connections.csv .../api/v1/network/import`, then `PATCH /api/v1/network/contacts/<id>` |
| Chat history | Section 9.3 |

Times are stored exactly as you send them (for example `2026-10-01T09:00:00+02:00` comes back as that text).
Text is stored character for character (any script, emoji, zero-width characters, CR LF, trailing spaces). A body
that is not UTF-8, or that holds a lone UTF-16 surrogate such as `"\ud800"`, answers `400` and nothing is stored; it
is never saved with a replacement character.

A job added as pasted text takes facts only from LABELLED lines: the first line is the title; `Company:`,
`Location:`, `Workplace:` (Remote, Hybrid, On-site; a line that is only one of these words also counts),
`Employment type:` (Full-time, Part-time, Contract, Internship), `Department:` and `Posted:` (`YYYY-MM-DD` or an
RFC 3339 date-time). Pay is read from the text by the crawler's pay parser. Any other fact stays `null`. A date
without a time (in pasted text or a page's JSON-LD `datePosted`) is kept as `YYYY-MM-DDT12:00:00.000Z`, so it is the
same calendar day in every US time zone; a date-time keeps its own instant, in UTC.

### 5.1 Count per kind through the API

While the server runs, this command reads every kind of record through the API (with the token from
`run/server.json`), downloads each uploaded resume file through the API and prints its SHA-256. It changes nothing:

```sh
node apps/server/src/cli.ts api-counts --home $JOBLEFT_HOME
```

You see JSON like this (use it before and after a `kill -9`, a restart, a backup and restore, or an upgrade):

```
{ "server": {"port": 47821, ...}, "profile": 1, "trackedJobs": 1, "likes": 1, "statuses": 1, "notes": 2,
  "reminders": 1, "savedFilters": 1, "resumes": 1, "resumeFiles": 1, "contacts": 2, "chats": 1, "chatMessages": 2,
  "boards": 1, "jobs": 4, "openJobs": 4, "pairedExtensions": 0,
  "files": [{ "resumeId": "res_...", "fileName": "cv.pdf", "bytes": 36313, "sha256": "6226...", "sameAsRecord": true }] }
```

## 6. Security checks you can run (outcomes O1, O2, O14)

| Try | Expected answer |
|---|---|
| `lsof -nP -iTCP -sTCP:LISTEN \| grep node` | One port, on `127.0.0.1` only. No IPv6 and no second port |
| Any route but `health` and `extension/pair`, with no token or a wrong token | `401 unauthorized` |
| `curl .../api/v1/settings?token=$T` | `400`: tokens are never accepted in a URL |
| `curl --resolve attacker.example:$P:127.0.0.1 -H "x-jobleft-token: $T" http://attacker.example:$P/api/v1/settings` | `403 forbidden_host` (also for `127.0.0.1.attacker.example`) |
| A request with `Origin: http://127.0.0.1:8099`, `Origin: null` or any other site | `403 forbidden_origin`, and no `Access-Control-Allow-Origin` header |
| A form post: `-H 'content-type: text/plain'` (or urlencoded, multipart) | `415 unsupported_media_type`, before any work |
| No Origin but `Sec-Fetch-Site: cross-site` (an image or script tag on another site) | `403` |
| A JSON body over 1 MB, or a raw upload over 10 MB (restore: over 4 GB or over the free disk space) | `413`, nothing stored, the connection closes |
| A body that does not match the contract | `400 bad_request` with the issue paths; no value from the body is echoed |
| A query `limit` outside 1 to 100, or a query key sent twice | `400 bad_request` |
| `/api/v1/admin`, `/api/mcp`, `/api/v1/dev/clock` without `JOBLEFT_DEV=1`, `/%2e%2e/etc/passwd`, `/api/v1/../../etc/passwd` | `404` |
| Outside `/api/`: `/admin`, `/debug`, `/developer`, `/data/jobleft.db`, `/logs/server.log`, `/run/server.json` | `404`. Only the files of the app page are served, and `/` is its `index.html`. There is no fallback page (the app page routes by the part after `#`) |

The page test from a browser: serve any page from another port (`python3 -m http.server 8099`), open it in headless
Chrome with a scratch profile, and try `fetch`, a form post, an image tag and a sandboxed iframe against
`http://127.0.0.1:$P/api/v1/...`. Every one is refused, and no count changes.

## 7. Pairing an extension (outcome O3)

The person approves in the app: the app's page (`/`) has "Pair a browser extension", which shows a 6-digit code for
5 minutes. With curl (the extension id is 32 letters a to p; the Origin must be that extension):

```sh
CODE=$(curl -s -X POST -H "x-jobleft-token: $T" http://127.0.0.1:$P/api/v1/extension/pairing-code | python3 -c "import json,sys;print(json.load(sys.stdin)['code'])")
EXT=abcdefghijklmnopabcdefghijklmnop
PT=$(curl -s -X POST -H "Origin: chrome-extension://$EXT" -H 'content-type: application/json' \
  -d "{\"code\":\"$CODE\",\"extensionId\":\"$EXT\",\"extensionVersion\":\"0.1.0\",\"protocolVersion\":1,\"browser\":\"Chrome\"}" \
  http://127.0.0.1:$P/api/v1/extension/pair | python3 -c "import json,sys;print(json.load(sys.stdin)['pairingToken'])")
curl -s -H "Origin: chrome-extension://$EXT" -H "x-jobleft-pairing: $PT" http://127.0.0.1:$P/api/v1/extension/status
```

| Rule | What you see |
|---|---|
| Before a code is shown, or with a wrong code | `401`. Five wrong codes void the code. More than 10 tries a minute answer `429` |
| A code works once | A second pair with the same code answers `401` |
| The extension on any route that is not an extension route (backup, AI settings, contacts, profile, publik) | `403` |
| List and unpair | `GET /api/v1/extension/pairings`; `DELETE /api/v1/extension/pairings/$EXT`. The next extension call answers `401` |
| Restart | The pairing list is the same; the pairing token still works until you unpair |

`POST /api/v1/extension/fill` fills only what it is sure of (name, email, phone, address, links, the resume file,
answers the person saved). It never answers pay, age, date of birth, criminal history or ID numbers; equal-employment
and work-authorization questions get only the person's own saved answers. `POST /api/v1/extension/review` with
`submittedByUser: true` marks the job Applied.

## 8. Backup, restore, export, delete (outcomes O7, O8)

```sh
curl -s -X POST -H "x-jobleft-token: $T" -o backup.zip http://127.0.0.1:$P/api/v1/backup
unzip -l backup.zip        # data/jobleft.db, files/resumes/..., manifest.json (counts, sizes, SHA-256 of each file)
curl -s -X POST -H "x-jobleft-token: $T" -H 'content-type: application/zip' --data-binary @backup.zip http://127.0.0.1:$P/api/v1/restore
# {"restored":{"profile":1,"trackedJobs":...,"notes":...,"resumeFiles":...,"contacts":...,"chats":...,"jobs":...}}
curl -s -H "x-jobleft-token: $T" -o export.zip http://127.0.0.1:$P/api/v1/export
curl -s -X POST -H "x-jobleft-token: $T" -H 'content-type: application/json' -d '{"confirm":"delete everything"}' http://127.0.0.1:$P/api/v1/data/delete
```

| Fact | Detail |
|---|---|
| What a backup holds | Every record (crawled jobs included, so liked and tracked jobs keep their details) and every uploaded file. No key (keys are in the Keychain), no launch token, no pairing token (pairings are removed from the copy) |
| Seal | The last line of the zip comment is `jobleft-backup v1 sha256=<hex>`: the SHA-256 of every byte before it. Any cut, changed or added byte is detected |
| Restore | Checks the whole file first (seal, names, sizes, CRC-32, SHA-256, SQLite integrity, schema version). Then it replaces the current data. It never mixes old and new data and never makes duplicates. This computer's extension pairings are kept |
| Refused files | A cut backup, one changed byte, a random zip, random bytes, a file with `../` names or links: `400` with "Nothing was changed.", and the current data is as it was |
| Restore into a fresh install | Start a server on an empty folder, then restore. A backup from an older build is upgraded on restore |
| Export | Readable files: `profile.json`, `tracker.json`, `saved-jobs.ndjson`, `saved-filters.json`, `resumes.json` and the uploaded files, `network-contacts.csv` and `.json`, `chats.json`, `boards.json`, `settings.json`. No key or token |
| Counts per kind | With the server running: `node apps/server/src/cli.ts api-counts --home <folder>` (section 5.1, through the API, with file hashes). With the server stopped: `node apps/server/src/cli.ts counts --home <folder>` prints the same numbers as the backup manifest |

## 9. Test stand-ins: job boards, AI and publik (outcomes O5, O9, O10, O15)

### 9.1 Start them

```sh
node apps/server/scripts/mock-servers.ts --dir /private/tmp/jl-mocks
```

It prints the exact `export` lines to use. Every request to a stand-in is logged (time, path, headers, body) to
`/private/tmp/jl-mocks/requests.ndjson`, and also per stand-in to `boards-requests.ndjson`, `ai-requests.ndjson` and
`publik-requests.ndjson` in the same folder. Search `boards-requests.ndjson` for "Testwell": a crawl sends nothing
personal. `ai-requests.ndjson` holds what you chose to send to the AI stand-in (your chat text), and nothing else.

The addresses below are the defaults; when a port is taken, the script takes a free one and prints it.

| Stand-in | Address | What |
|---|---|---|
| Job boards | `http://127.0.0.1:4010` | Greenhouse, Lever and Ashby list endpoints, served from `/private/tmp/jl-mocks/boards.json`. The file is read on every request: edit it to add, change or remove postings. It starts with one Greenhouse board, `mockco`, with 3 jobs |
| AI server | `http://127.0.0.1:4020/v1` | OpenAI-compatible; model `mock-model` |
| publik | `http://127.0.0.1:4030/api/v1` | Installs, wallet, revoke, chat. `curl -X POST -d '{"micros":0}' http://127.0.0.1:4030/__admin/balance` empties the balance |

Start jobleft in the same shell after the two `export` lines (`JOBLEFT_HOST_MAP`, `JOBLEFT_PUBLIK_BASE_URL`), with
`JOBLEFT_DEV=1` if you want the time-skip.

### 9.2 Crawl a stand-in board

```sh
curl -s -X POST -H "x-jobleft-token: $T" -H 'content-type: application/json' -d '{"ats":"greenhouse","board":"mockco"}' http://127.0.0.1:$P/api/v1/boards
curl -s -X POST -H "x-jobleft-token: $T" -H 'content-type: application/json' -d '{}' http://127.0.0.1:$P/api/v1/crawl/run
curl -s -H "x-jobleft-token: $T" http://127.0.0.1:$P/api/v1/crawl/status     # running, boards done, lastRun
curl -s -H "x-jobleft-token: $T" http://127.0.0.1:$P/api/v1/crawl/report     # per board, with reasons
curl -s -H "x-jobleft-token: $T" "http://127.0.0.1:$P/api/v1/jobs?limit=20"
```

| Rule | Detail |
|---|---|
| Politeness | 1 request a second per host, robots.txt obeyed, User-Agent `jobleft-build/0.1 (research build; no personal data)`, no redirects followed |
| The person's changes | A crawl never changes a like, status, note or reminder. Tracker rows are separate from postings |
| Facts from a board | As the board states them. Pay keeps its exact amounts (a Greenhouse `pay_input_ranges` of 1850 to 2225 cents is `18.5` to `22.25` a `hour`, never rounded). A Greenhouse posted date is `first_published` only: a job without it has `postedAt: null`, even though `updated_at` (the last edit) is there. A missing work model, employment type, department or place is `null` |
| Closing | A job closes only when a board was read in full and the job was not seen for 48 hours, and never when over half of a board would close at once. A failing, unreachable or offline board closes nothing |
| Closed jobs | They leave the job list and search, keep their details, and stay in the Liked and Applied views with `status: "closed"` and every note |
| Seeing a close now | With `JOBLEFT_DEV=1`: remove the job from `boards.json`, move the clock with `curl -X POST -H "x-jobleft-token: $T" -H 'content-type: application/json' -d '{"offset":"72h"}' http://127.0.0.1:$P/api/v1/dev/clock`, and crawl again. `-d '{}'` resets the clock |
| Speed | The crawl runs in a worker thread. Reads answer in milliseconds while it runs |
| Scheduler | A catch-up run 5 s after start (never before the server answers), then every `crawl.intervalHours` (settings) |

### 9.3 Chat with the stand-in AI

```sh
curl -s -X PUT -H "x-jobleft-token: $T" -H 'content-type: application/json' \
  -d '{"provider":"local","localKind":"openai_compatible","baseUrl":"http://127.0.0.1:4020/v1","model":"mock-model"}' http://127.0.0.1:$P/api/v1/ai/settings
curl -sN -X POST -H "x-jobleft-token: $T" -H 'content-type: application/json' \
  -d '{"requestId":"r1","messages":[{"role":"user","content":"Hello"}]}' http://127.0.0.1:$P/api/v1/ai/chat
curl -s -H "x-jobleft-token: $T" http://127.0.0.1:$P/api/v1/ai/chats
```

The chat streams `start`, `delta` events and `done` (with `chatId`). The person's message is saved before the call;
the answer is saved when it ends (a cut answer is saved with `incomplete: true`). If the server stops during an answer,
the person's message is kept and the unfinished answer is not. Only the chosen provider is ever
called: when it fails, the stream ends with an `error` event in plain words, and nothing goes anywhere else. A key is
saved with `PUT /api/v1/ai/key`; only its last 4 characters come back.

### 9.4 The publik balance card with the stand-in

```sh
export JOBLEFT_PUBLIK_BASE_URL='http://127.0.0.1:4030/api/v1' JOBLEFT_PUBLIK_APP_TOKEN=stand-in
node apps/server/src/main.ts      # in a fresh shell with JOBLEFT_HOME set
curl -s -X POST -H "x-jobleft-token: $T" -H 'content-type: application/json' -d '{"disclosureAccepted":true,"disclosureVersion":1}' http://127.0.0.1:$P/api/v1/publik/connect
# {"state":"connected","wallet":{"claimState":"anonymous","balanceMicros":2000000,...,"topUpUrl":"https://publikhq.com/claim/stand-in",...}}
curl -s -X PUT -H "x-jobleft-token: $T" -H 'content-type: application/json' -d '{"provider":"publik"}' http://127.0.0.1:$P/api/v1/ai/settings
curl -s -X POST -d '{"micros":0}' http://127.0.0.1:4030/__admin/balance          # empty the stand-in balance
curl -sN -X POST -H "x-jobleft-token: $T" -H 'content-type: application/json' -d '{"requestId":"r2","messages":[{"role":"user","content":"hi"}]}' http://127.0.0.1:$P/api/v1/ai/chat
# data: {"type":"error","error":{"code":"insufficient_balance","message":"Your publik balance is too low for this request ($0.00 left). Add money at the link below, then try again.","link":{...}}}
curl -s -X POST -H "x-jobleft-token: $T" http://127.0.0.1:$P/api/v1/publik/disconnect   # the key is deleted
```

Money is `balanceMicros` (millionths of a dollar) and every message says "balance" in dollars. The publik key is kept
in the secret store only: never in the database, a backup, an export or a log. Nothing is sent to publik before the
person connects, and there is no balance check at start.

## 10. Speed with 100,000 jobs (outcome O9)

```sh
node apps/server/src/cli.ts seed-jobs --home /private/tmp/jl-speed --count 100000   # about 15 to 45 s
JOBLEFT_HOME=/private/tmp/jl-speed node apps/server/src/main.ts
```

`seed-jobs` adds SYNTHETIC postings (company "Synthetic Employer N") for speed tests only (about 11 s, 113 MB).
Measured on an Apple M-series Mac: first data answer 0.2 to 1.5 s after launch (0.84, 0.23, 0.23, 0.23, 0.23 s in
five launches on 2026-09-25) (the first start after seeding builds a search index once);
`GET /api/v1/jobs` about 2 to 10 ms; a word search about 15 to 60 ms; a filtered search about 50 to 180 ms; reads
during a crawl of 4 boards with 5,000 postings each: worst 67 ms.

## 11. Failures, upgrades and offline (outcomes O5, O10, O11, O12)

### 11.1 A full or read-only data folder

```sh
hdiutil create -size 30m -fs HFS+ -volname jlfull /private/tmp/jlfull.dmg
mkdir -p /private/tmp/jlfull-mnt && hdiutil attach /private/tmp/jlfull.dmg -mountpoint /private/tmp/jlfull-mnt -nobrowse
JOBLEFT_HOME=/private/tmp/jlfull-mnt/home node apps/server/src/main.ts &
dd if=/dev/zero of=/private/tmp/jlfull-mnt/filler bs=1m count=200     # fills the disk
# a save now answers 507 write_failed: "Nothing was saved because the disk ... is full. Your earlier data is unchanged."
rm /private/tmp/jlfull-mnt/filler; hdiutil detach /private/tmp/jlfull-mnt
```

A save can still succeed for a short while after the disk fills, because SQLite reuses space it already has; such a
save is on disk. `chmod 500 $JOBLEFT_HOME/data` while the server runs makes every save answer `507` with "read-only".
Every change that spans several records (a status and its history entry, a restore) is one transaction.

### 11.2 Upgrades

```sh
node apps/server/src/cli.ts fixture --home /private/tmp/jl-old --schema 1        # a folder as an older build left it
node apps/server/src/cli.ts counts --home /private/tmp/jl-old
JOBLEFT_HOME=/private/tmp/jl-old node apps/server/src/main.ts                   # upgrades it; counts and file hashes match
node apps/server/src/cli.ts fixture --home /private/tmp/jl-new --schema future   # a folder a NEWER build wrote
JOBLEFT_HOME=/private/tmp/jl-new node apps/server/src/main.ts                   # exit 2: "written by a newer jobleft"; files unchanged
```

The fixture holds the test persona: profile, a like, a status with history, a note with non-Latin text and emoji,
a reminder, a saved filter, a resume file, a contact and a chat. Every pending upgrade step runs in one transaction:
if it fails (read-only folder, full disk), the file is exactly as it was and the server does not start (exit 2).
A newer folder is read with SQLite's `immutable` flag first, so the refusal writes nothing, not even `-wal` files.

### 11.3 Offline

With `JOBLEFT_OFFLINE=1`, or with every network interface off: the server starts, and profile, tracker, notes,
resumes, contacts, saved and liked jobs, search over stored jobs, backup and restore all work. A crawl answers
`503 offline` within 3 s ("This computer seems to be offline ... Your jobs are unchanged."). A publik connect
answers at once (there is no publik app token in this build). An AI call to a provider that cannot be reached ends
within 10 s with a plain error. Nothing needs a download at start.

## 12. Logs (outcome O8)

`$JOBLEFT_HOME/logs/server.log`, rotated at 5 MB. At the default level it holds start, stop, crawl and error events,
and no line per request, so a request (refused or not) writes nothing to the data folder. With `JOBLEFT_LOG_LEVEL=debug`
a request line holds the time, method, route NAME, status and duration; never the path, the query, a body, a token or
a key. Error text is redacted: the home folder becomes `~`,
quoted strings, e-mail addresses and long token-like strings are masked.

## 13. Interim stand-ins and the merge

The server owns `pairings`, `srv_kv`, `srv_notifications` and the routes of `docs/INTERFACES.md` section 8
"@jobleft/server". The other records live in tables named `srv_*`, apart from the owning lanes' tables, so a merge
never collides. At integration, each lane's package replaces its stand-in in `src/app.ts` and `src/routes.ts`:

| Stand-in (`src/interim/`) | Replaced by |
|---|---|
| `profile.ts`, `tracker.ts`, `filters.ts`, `chats.ts`, `jobs.ts` (search, the `srv_job_index` table and its triggers on `jobs`) | `@jobleft/store` |
| `resumes.ts` | `@jobleft/resume` |
| `network.ts` | `@jobleft/network` |
| `ai.ts`, `publik.ts`, `services/secrets.ts` | `@jobleft/ai-engine` |
| `boards.ts`, `crawl-worker.ts` | `@jobleft/boards` |
| `external.ts` | `@jobleft/sources-other` |
| `company-key.ts` | `@jobleft/static-data` `companyKey` |
| `services/extension.ts` fill | the extension lane's answer engine |

Data saved in an interim table is not moved into a lane's table automatically yet.

## 14. Tests

```sh
pnpm --filter @jobleft/server test        # 44 tests: security, records, kill -9, backup, pairing, lifecycle, AI, crawl, add by link, exact board facts
pnpm --filter @jobleft/server typecheck
```

The jobsync fork's own unit tests need jobsync's dependencies, which are not part of the workspace. Install them once
outside the repository (806 packages, about 1 GB, no install scripts run), add `jsdom` (an optional peer of vitest that
npm does not install on its own), and make the Prisma client there. Then run the tests:

```sh
D=/private/tmp/jl-jobsync-deps
mkdir -p $D/prisma
cp apps/server/jobsync/package.json apps/server/jobsync/package-lock.json $D/
cp apps/server/jobsync/prisma/schema.prisma $D/prisma/
(cd $D && npm ci --ignore-scripts --no-audit --no-fund && npm install --no-save --ignore-scripts --no-audit --no-fund jsdom@26.1.0)
(cd $D && CHECKPOINT_DISABLE=1 DATABASE_URL=file:$D/none.db node node_modules/prisma/build/index.js generate --schema prisma/schema.prisma)
JOBSYNC_DEPS=$D/node_modules apps/server/scripts/jobsync-tests.sh
rm -rf $D                                       # when done
```

`prisma generate` fetches Prisma's own engine files once from Prisma's server, unless `PRISMA_QUERY_ENGINE_LIBRARY` and
`PRISMA_SCHEMA_ENGINE_BINARY` point at local copies (set them for both commands). Result on 2026-09-25: 229 test files,
2,795 tests, all passed. With `generate --no-engine` instead (no engine at all), only `backupRoundTrip.spec.ts` fails,
because it needs a real SQLite engine.

The tests start servers on scratch folders under `/private/tmp` and remove them. They use only loopback stand-ins.
