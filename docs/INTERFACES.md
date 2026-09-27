# jobleft interfaces

Version: contracts 1.1.0 (1.0.0 plus the match lane's optional fields, section 8, the network lane's additive network records, fields and routes, and the extension lane's additive extension protocol fields and routes, section 7), local API v1, extension protocol v1. Written by the foundation commit, 2026-09-25.
Contract additions since 1.0.0 are listed where they belong (search for "Added by").

This document is the contract between the lanes. Lanes build in parallel from it. It tells each lane what it
owns, what it exports, what it may import, which tables and routes it serves, and which environment variables,
CLIs and data files exist. The acceptance outcomes in `docs/outcomes/` refer to "the endpoints in
docs/INTERFACES.md": they are the routes in section 6.

## 0. How to use this document

| Rule | Detail |
|---|---|
| Source of truth | The code wins: `packages/contracts/src` for records and routes, each package's `src/index.ts` for its exports. This document explains them. Blocks marked GENERATED are copied from the code by `node scripts/gen-interfaces.ts` |
| Status words | **Built**: real code in the foundation commit. **Stub**: the export exists with its final signature and its body throws `not implemented yet: <name> (lane: <package>)`. **Planned**: the lane adds it with the name given here |
| Ownership | A lane changes only its own package folder, its own tables and its own routes (the Owner column in section 6.4). It never edits another lane's package |
| Using another lane's work early | Import the stub. It type-checks now and works once the owning lane lands. Do not copy or re-implement another lane's export |
| Changing an interface | Additive only (section 1.4). Change the code, run `pnpm --filter @jobleft/contracts run gen` when contracts changed, run `node scripts/gen-interfaces.ts`, and update the prose here, in one commit |
| Persona | Tests and fixtures use only "Jordan Testwell" (jordan.testwell@example.com). Shared typed fixtures: `packages/contracts/test/fixtures.ts` |

## 1. Runtime, layout and dependency rules

### 1.1 Runtime

- Node 24 or newer runs every `.ts` file directly (type stripping). There is no build step for Node code. `tsc` only type-checks (`noEmit`).
- ESM only. Relative imports end in `.ts`. Type-only imports use `import type` (`verbatimModuleSyntax`).
- Erasable syntax only: no `enum`, no `namespace`, no parameter properties, no decorators (`erasableSyntaxOnly`).
- Workspace packages are imported by name (`@jobleft/crawler`). pnpm links them, and Node strips types because the real path is outside `node_modules`.
- Browser code (apps/ui, apps/extension) imports only `@jobleft/contracts`. Everything else is Node-only.

### 1.2 Dependency graph (who may import whom)

| Package | May import (workspace) |
|---|---|
| `@jobleft/contracts` | nothing |
| `@jobleft/parsers` | contracts |
| `@jobleft/crawler` | contracts, parsers |
| `@jobleft/static-data` | contracts |
| `@jobleft/ai-engine` | contracts |
| `@jobleft/sources-ats` | contracts, parsers, crawler |
| `@jobleft/sources-other` | contracts, parsers, crawler |
| `@jobleft/match` | contracts, parsers, static-data |
| `@jobleft/store` | contracts, crawler, static-data |
| `@jobleft/boards` | contracts, crawler, sources-ats, static-data |
| `@jobleft/resume` | contracts, ai-engine, static-data |
| `@jobleft/network` | contracts, ai-engine, static-data |
| `@jobleft/server` (apps/server) | every package |
| `@jobleft/ui`, `@jobleft/extension`, `@jobleft/shell` | contracts |

No cycles. A lane that needs a new edge in this graph asks for it in its report; it does not add it silently.

### 1.3 Third-party dependencies

- Add a dependency only to your own package: `pnpm --filter <package> add <name>@<exact version>`. Installs never run scripts (`ignoreScripts: true` in `pnpm-workspace.yaml`).
- Read a package before you run it. Copy code only from MIT, Apache-2.0 or BSD sources, and record each copy in `THIRD_PARTY_NOTICES.md` (source URL and commit, licence, the files that hold it). AGPL and GPL code is reference only.
- A dependency whose install script is essential (for example a native build): read the script, add the package to `allowBuilds` in `pnpm-workspace.yaml`, run the script explicitly, and record why in `THIRD_PARTY_NOTICES.md` section 4.
- Disk is tight: one `node_modules` per worktree, the shared pnpm store, one Cargo target dir (`.cache/cargo-target` in the main checkout, shared by every worktree). Delete build output you create when you finish.

### 1.4 Change rules (additive only)

1. Never remove or rename a field, a route, an enum value, a table column or an export. Never change a meaning or a type.
2. A new field is optional or nullable, and readers treat "missing" as unknown.
3. A new enum value is allowed. Every reader handles values it does not know: it shows nothing and never crashes.
4. A new route is allowed. A changed route is a new route with a new path.
5. A table change is a new migration that adds a column or a table. No migration rewrites or drops user data.
6. A breaking change needs the owner's approval and a new version (`/api/v2`, protocol 2).

### 1.5 Facts are true or unknown

Everywhere: `null` means unknown or not stated. Never fill it with a default (no "$0", no "Onsite", no "United
States", no "Mid Level", no crawl time as a posted date, no "50%" match, no "No H-1B" from missing data). A shown
fact can name its evidence (`FactEvidence`). Links are absolute `http` or `https` URLs; the schemas refuse any other
scheme. Job text is plain text and is shown as text, never as markup.

## 2. The data folder (`JOBLEFT_HOME`)

All personal data lives in one folder. Nothing personal is written anywhere else (no temp copies outside it, no
logs outside it). Secrets live in the OS secret store, never in a plain-text file.

| Path (under `$JOBLEFT_HOME`) | What | Owner |
|---|---|---|
| `data/jobleft.db` (+ `-wal`, `-shm`) | The one SQLite database (section 3) | store opens it; owners in section 3 |
| `files/resumes/` | Uploaded resume files and generated resume and letter files | resume |
| `files/exports/` | Files the person exports | server |
| `datasets/` | Updated dataset releases (verified before use; shipped copies live in the app) | static-data |
| `models/` | The fit model (bge-small-en-v1.5), downloaded once and verified | ai-engine |
| `secrets/` | Only with `JOBLEFT_SECRET_STORE=file`: `secrets.enc` (AES-256-GCM) and `master.key`, both 0600. Backups and exports MUST leave this folder out | ai-engine |
| `ai/state.json`, `ai/unsent.json` | The ai-engine CLI only: key-free AI settings and publik connection state (the server keeps these in `settings`), and the last message that was not sent | ai-engine |
| `backups/` | Backup files the person asks for | server |
| `logs/` | Logs with no personal data, no keys, no tokens, no resume or chat text | server |
| `tmp/` | Temporary files; emptied at start and after each step | every Node package |
| `network-dev/standin.json` | Stand-in jobs, likes, persona profile and AI address for the network lane's own CLI and dev server only (never a connection's data); gone once apps/server wires the real ones | network (dev tool) |
| `run/network-dev.json`, `logs/network-dev.log` | The network dev server's `{ pid, port, token, startedAt }` (0600, removed on exit) and its log (method, route name, status, time; no data) | network (dev tool) |
| `run/server.json` | `{ pid, port, token, version, startedAt }`, mode 0600; removed on clean exit | server |
| `run/server.lock` | Single-instance lock (one server per data folder): `{ pid, procStart, lockedAt, nonce }`. A lock whose process is gone, or whose pid now belongs to another program (start time differs), is stale and is taken over | server |
| `run/restore-journal.json` | Present only while a restore swaps folders; at start the server finishes or undoes an interrupted restore before it empties `tmp/` | server |

Defaults: macOS `~/Library/Application Support/jobleft`, Windows `%APPDATA%\jobleft`, others
`~/.local/share/jobleft`. The server (main.ts) sets `TMPDIR` and `SQLITE_TMPDIR` to `$JOBLEFT_HOME/tmp` and runs every
connection with `temp_store = MEMORY`, so no temporary copy lands in the system temp folder. Keys go to the macOS
Keychain, one service per data folder (`jobleft-<first 12 hex of sha256(folder path)>`). `pnpm app:up` uses `<repo>/.jobleft-dev` (ignored by git). Tests use a folder under
`/private/tmp`. The folder is created with mode 0700 and files with 0600. `homeLayout(home)` in apps/server
(Built) returns every path.

## 3. The database: one SQLite file, one owner per table

Engine: `node:sqlite` (built into Node; no native module). `openDatabase(path)` in `@jobleft/store` (Built) sets
`page_size = 16384` on a new file (spike S2), then WAL, `synchronous = NORMAL` and `foreign_keys = ON`.

Migrations (server: Built, `apps/server/src/db/`): every pending server step runs in ONE transaction; a file with a step
of an owner this build does not know, or a newer version, is refused before any write (it is read with SQLite's
`immutable` flag, so not even a -wal file appears), and a read-only folder is refused before any write.
Migrations: each owner creates and changes only its own tables, with forward-only numbered steps recorded in
`schema_migrations(owner TEXT, version INTEGER, applied_at TEXT, PRIMARY KEY (owner, version))`. Each step runs in one
transaction. The server runs the owners in this order at start: crawler, store, boards, static-data, sources-other,
resume, network, ai-engine, server. A database with a version newer than the build knows is refused with a plain
message and left untouched.

| Table(s) | Owner | Notes |
|---|---|---|
| `jobs`, `jobs_fts`, `boards` | crawler | Built. `jobs` holds every stored posting: ATS boards, other feeds (`ats = 'feed:<sourceId>'`, planned) and added jobs (`ats = 'external'`, `board = 'url'` or `'text'`, planned). Crawler schema 2 added the columns the `Job` contract needs: `page_url`, `apply_link`, `places_json`, `work_model`, `remote_scope_json`, `employment`, `levels_json`, `years_min`, `years_max`, `statements_json`, `evidence_json`, `pay_ranges`, `board_updated_at`, `role_key`, and the closing bookkeeping `miss_count`, `first_missed_at`. `canonical_url` is no longer unique (two ids on one board are two jobs even with one page link). `duplicate_of` is set only for a repeat of the same company, title AND places from ANOTHER board. `boards` is board health plus the last outcome (`last_status`, `last_reason_code`, `last_reason`, `last_listed`, `last_checked_at`), conditional-request validators (`etag`, `last_modified`, `validators_url`), the mass-close hold (`held_streak`, `held_since`), the not-found net (`notfound_streak`, `notfound_since`) and a mock `origin`. Read contract `Job` records with `queryJobs` / `getJobById` / `toContractJob` |
| `job_sources` | crawler | Built. Every source that listed a posting: `(job, source_id, url)` with name and first/last seen (the same posting from two boards keeps both credits) |
| `crawler_runs`, `crawler_run_boards` | crawler | Built. One row per crawl run (reason, state, counts) and one per board of the run (pending or done, status, reason code and sentence, counts). A run cut short resumes with its pending boards. The boards lane can read run history from here (`lastRunReport`, `crawlProgress`) instead of keeping its own |
| `crawler_hosts`, `crawler_robots`, `crawler_meta` | crawler | Built. Per host: the last request time (pacing across runs) and a wait the host asked for; robots.txt files (24 hours); the crawl lease and the clock offset left by `simulate` |
| `schema_migrations`, `store_meta`, `store_jobs`, `job_docs`, `job_keys`, `job_tombstones`, `facet_tags`, `companies`, `job_head_fts`, `job_body_fts`, `job_title_fts`, `job_vectors`, `fit_runs`, `tracker`, `tracker_history`, `tracker_notes`, `tracker_reminders`, `saved_filters`, `profile`, `chats`, `chat_messages`, `notifications`, `settings` | store | Built (store schema 1). The store keeps its own copy of every posting in `store_jobs` + `job_docs` (it never creates or writes the crawler's `jobs`/`jobs_fts`); the crawler's rows reach it through `JobStore.syncFromCrawler()` or the upsert APIs. `job_vectors`: float16 BLOB per (row, model) with the hash of the embedded text. `settings` is key-value JSON (other packages' small settings go here through `SettingsStore`). `job_skills` was not needed (skills live in the job record and the filter arrays) |
| `board_prefs`, `board_checks`, `crawl_runs`, `crawl_board_reports`, `board_pending_links`, `host_pacing`, `robots_cache` | boards | Built (migrations `boards` v1, v2). `board_prefs`: user boards and choices (follow, hide, disable; a board the person added keeps its name). `board_checks`: what each board check saw (state, failures in a row, last good check, open jobs, next check date). `crawl_runs`, `crawl_board_reports`: refresh history for the report. `board_pending_links`: links pasted while offline. `host_pacing`: the per-host request schedule every process shares. `robots_cache`: robots.txt answers reused for 10 minutes across processes |
| `company_facts`, `company_fact_labels` | static-data | Built. Facts per company key with source and date, freshness, last error and paid cost; cached Wikidata labels of people and places |
| `source_state`, `source_runs`, `source_requests`, `source_host_slots`, `feed_postings` | sources-other | Built (migrations 1 and 2). `source_state`: on or off, last run, last problem, 429 wait, ETag, run lease. `source_runs` and `source_requests`: the rolling 24-hour counts (limits survive restarts and hold across processes). `source_host_slots`: the pacer shared by every process. `feed_postings`: each posting as each feed lists it (see "Reading feed jobs" under `@jobleft/sources-other`) |
| `resumes`, `tailor_proposals`, `cover_letters` | resume | Built (resume lane). `resumes` holds base resumes and tailored versions (`kind`, `base_resume_id`, `job_id`, `version`) |
| `network_contacts`, `network_meta` | network | Built. `network_contacts`: one row per connection plus the person's tracking (stage, note, follow-up, plan, reminded date, "in latest file"). `network_meta`: key-value facts of the tool (company-key fingerprint, last import counts, approved AI destinations); never a name, email or note. The network service sets `PRAGMA secure_delete = ON` on the connection it is given and ends each delete with `wal_checkpoint(TRUNCATE)`, so deleted text leaves no copy in the database or `-wal` file |
| `practice_sessions`, `practice_items` | ai-engine | Planned |
| `pairings` | server | Built. Extension id, sha256 of the pairing token (hex), browser, extension version, paired and last-seen times |
| `srv_kv`, `srv_notifications` | server | Built. The server's key-value JSON (app settings, key-free AI and publik state, the folder's creation time) and the notifications the shell shows |
| `srv_profile`, `srv_tracker`, `srv_tracker_history`, `srv_tracker_notes`, `srv_tracker_reminders`, `srv_saved_filters`, `srv_resumes`, `srv_contacts`, `srv_chats`, `srv_chat_messages`, `srv_boards`, `srv_crawl_runs`, `srv_saved_answers`, `srv_extension_reviews` | server (INTERIM) | Built. Stand-ins for the records of lanes not merged into the server branch (store, resume, network, boards, extension). The `srv_` prefix keeps them apart from the owning lanes' tables; each lane's package replaces its stand-in at integration (apps/server/README.md section 13) |
| `srv_job_index` (+ triggers `srv_job_index_ai`, `_au`, `_ad` on `jobs`; indexes `srv_jobs_apply`, `srv_jobs_key` on `jobs`) | server (INTERIM) | Built. A narrow copy of the searchable facts of open, non-duplicate jobs, kept in step by triggers that use built-in SQL only (any connection can fire them). Derived data only: dropping it loses nothing. The store lane's search replaces it |

Job id: `makeJobId(ats, board, externalId)` in `@jobleft/store` (Built) gives `"<ats>:<board>:<externalId>"` in lower
case for ATS and board. Every `jobId` in the contracts and routes is this id. A tracker row outlives its job: a closed
posting keeps its row in `jobs` (soft close, `closed_at`), so tracked and liked jobs keep their details.

Other readers: a package that needs another owner's table reads it through that owner's exported functions, or
through columns this section names. Nobody writes another owner's table.

## 4. Environment variables

| Variable | Read by | Default | Meaning |
|---|---|---|---|
| `JOBLEFT_HOME` | server, CLIs | OS default (section 2) | The data folder |
| `JOBLEFT_PORT` | server | first free of 47821 to 47830 | Listen port. `0` = the same range |
| `JOBLEFT_LAUNCH_TOKEN` | server | a new random token | The launch token the shell made. Never logged |
| `JOBLEFT_PARENT_PID` | server | none | The shell's pid. The server exits within 10 s after that process is gone |
| `JOBLEFT_UI_DIR` | server | `apps/ui/dist` when it exists | The built UI to serve at `/` |
| `JOBLEFT_DEV` | server | off | `1` enables `POST /api/v1/dev/clock` and readable logs |
| `JOBLEFT_OFFLINE` | server, store | off | `1` = no outbound request at all (crawl and AI answer `offline`; the store never downloads the fit model) |
| `JOBLEFT_NOW` | every Node package through `nowMs()` | real time | Freeze the clock (RFC 3339). Time-skip for tests |
| `JOBLEFT_CLOCK_OFFSET` | same | `0` | Run the clock ahead or behind: `72h`, `-30m`, `3d`, `90s`, `1500ms` |
| `JOBLEFT_TZ` | network | the system time zone (or `TZ`) | The person's time zone for "today" (follow-up dates and reminders), e.g. `America/Chicago` |
| `JOBLEFT_NO_OS_NOTIFY` | network dev tool | off | `1` = the network dev server and CLI show no macOS notification (tests) |
| `JOBLEFT_HOST_MAP` | crawler `hostMapFromEnv()` (Built) | none | JSON map from a real ATS host to a LOOPBACK mock origin, for example `{"boards-api.greenhouse.io":"http://127.0.0.1:4010"}` |
| `JOBLEFT_BOARD_DIRECTORY` | boards CLI (`loadActiveDirectory`) | none | Use this board directory file instead of the installed or shipped one; `none` = an empty directory (tests and demos) |
| `JOBLEFT_REFRESH_HOURS` | boards CLI and dev server | `6` | Hours between scheduled refreshes |
| `JOBLEFT_PAID_FETCH_URL` | boards CLI and dev server | none | A LOOPBACK stand-in of the paid page fetch (`POST <url>/fetch` with `{ url, js, maxPriceMicros }` answers `{ url, html, costMicros }`). Unset = no paid lookup is offered. The app passes sources-other's metered client instead |
| `JOBLEFT_PAID_FETCH_PRICE_MICROS` | boards CLI and dev server | `4000` | The price the stand-in shows for one paid page fetch |
| `JOBLEFT_PUBLIK_BASE_URL` | ai-engine, sources-other | `https://publikhq.com/api/v1` | Lanes and tests MUST point this at a local stand-in. No lane calls publikhq.com |
| `JOBLEFT_SOURCE_KEY_<ID>` | sources-other CLI only | none | A source key for the `jobleft-sources` CLI (for example `JOBLEFT_SOURCE_KEY_THEMUSE`). Read, never saved or printed. The app uses the OS secret store (`SECRET_NAMES.sourceKey(id)`) |
| `JOBLEFT_SOURCE_TIMEOUT_MS` | sources-other CLI | `15000` | Per-request timeout of other-source requests |
| `JOBLEFT_PUBLIK_APP_TOKEN` | ai-engine | none | The publik app token. None exists yet (gate G-publik); without it, connect answers a plain error. The server's interim publik client uses it only when `JOBLEFT_PUBLIK_BASE_URL` is a loopback address (tests), and ignores it otherwise |
| `JOBLEFT_MODEL_BASE_URL` | ai-engine, store | the Hugging Face `BAAI/bge-small-en-v1.5` files at revision `5c38ec7c` | Where the fit model is downloaded from, once (tests use a local stand-in). The store also accepts a `file://` URL or a folder path (copied, verified the same way) |
| `JOBLEFT_AI_HOST_MAP` | ai-engine | none | JSON map from an own-key vendor host (`api.openai.com`, `api.anthropic.com`, `openrouter.ai`, `generativelanguage.googleapis.com`) to a LOOPBACK stand-in origin. Other hosts and non-loopback targets are refused |
| `JOBLEFT_SECRET_STORE` | ai-engine | `keychain` on macOS, else `file` | `keychain` (macOS Keychain), `file` (AES-256-GCM file in `$JOBLEFT_HOME/secrets/`), `memory` (tests) |
| `JOBLEFT_ORT_MODULE` | ai-engine | none | Path of an installed `onnxruntime-node` entry for the fit model (until the app build bundles it) |
| `JOBLEFT_PUBLIK_ALLOW_LIVE` | ai-engine (`createEngineFromEnv`) | off | Until `1`, the app token is ignored for any publik address that is not loopback, so no build contacts the live service before gate G-publik |
| `JOBLEFT_DATASET_MANIFEST_URL` | static-data | none until the owner names the release location | Where newer dataset releases are listed (tests use a local stand-in) |
| `JOBLEFT_LOG_LEVEL` | server | `info` | `error`, `warn`, `info`, `debug`. No level logs personal text, keys or tokens |
| `JOBLEFT_SECRET_STORE` | server | `keychain` on macOS, else `memory` | `memory` keeps keys in memory only (tests); keys are then forgotten at stop |
| `JOBLEFT_QUIET` | server | off | `1` = main.ts prints nothing at start (the address and token go only to `run/server.json`; `pnpm app:up` uses it) |
| `JOBLEFT_IMPORT_TIMEOUT_MS` | resume | `30000` | Time limit for reading an uploaded resume (and for the ATS check of a PDF) in its worker thread |
| `JOBLEFT_PDF_FONT`, `JOBLEFT_PDF_FONT_BOLD` | resume | a system Arial, Liberation Sans or DejaVu Sans | TrueType fonts to embed when a PDF needs letters outside the standard fonts |
| `CARGO_TARGET_DIR` | shell builds | `<main checkout>/.cache/cargo-target` | The one shared Cargo target dir (every worktree uses the main checkout's) |

The User-Agent of every crawl request is fixed in code: `USER_AGENT` = `DEFAULT_USER_AGENT` =
`jobleft-build/0.1 (research build; no personal data)`. It is never read from the environment, a profile, git, a
config file or a flag. `makeConfig` refuses a `userAgent` that differs from it, the CLI refuses `--user-agent`, and
`new HttpClient({ userAgent })` refuses any other value.

## 5. Start the whole app

### 5.1 `pnpm app:up` and `pnpm app:down` (development)

Status: Built by the server lane (`scripts/app-up.ts`, `scripts/app-down.ts`). They do exactly this:

`pnpm app:up`

1. Set `JOBLEFT_HOME` to `<repo>/.jobleft-dev` unless it is already set. Create it (mode 0700).
2. If `$JOBLEFT_HOME/run/server.json` names a live jobleft server (its `GET /api/v1/health` answers `app: "jobleft"`), print its UI address and exit 0.
3. Make a launch token (`newLaunchToken()`), start `node apps/server/src/main.ts` detached, with `JOBLEFT_LAUNCH_TOKEN`, `JOBLEFT_HOME`, `JOBLEFT_DEV=1`, and `JOBLEFT_UI_DIR` when `apps/ui/dist` exists. Logs go to `$JOBLEFT_HOME/logs/server.log`.
4. Wait up to 15 s for `GET /api/v1/health`. On time-out, print the last log lines and exit 1.
5. Print `http://127.0.0.1:<port>/#token=<token>` and exit 0.

`pnpm app:down`

1. Read `$JOBLEFT_HOME/run/server.json`. With no file, print "nothing is running" and exit 0.
2. Check the pid is a jobleft server (health answers and the token matches). Send SIGTERM. Wait up to 10 s, then SIGKILL.
3. Remove `run/server.json`. Exit 0.

### 5.2 Shell and server (the packaged app)

| Step | Contract |
|---|---|
| Launch | The shell makes a new launch token and starts the server sidecar with `sidecarEnv()` (apps/shell, Built): `JOBLEFT_HOME`, `JOBLEFT_LAUNCH_TOKEN`, `JOBLEFT_PARENT_PID`, `JOBLEFT_UI_DIR` |
| Port | The server takes the first free port of 47821 to 47830 (`DEFAULT_PORT`, `PORT_SPAN`), or `JOBLEFT_PORT`. The shell reads the port from `run/server.json` |
| Ready | The shell waits for `GET /api/v1/health` (up to `READY_TIMEOUT_MS`), then opens the window at `http://127.0.0.1:<port>/#token=<token>` |
| Single instance | One server per data folder (`run/server.lock`). A second launch focuses the first window and exits |
| Window closed | The app keeps running in the menu bar; the crawl scheduler and reminders continue |
| Notifications | The shell polls `GET /api/v1/notifications` every `NOTIFICATION_POLL_MS` and acks each one it shows |
| Quit | The shell sends SIGTERM. The server stops the scheduler, finishes or rolls back the open transaction, closes the database, removes `run/server.json` and exits within 5 s |
| Shell crash | The server sees the parent pid gone and exits within 10 s |
| Restart | A new launch token each time; old tokens stop working. Extension pairings survive |

## 6. Local API

Code: `packages/contracts/src/api.ts` (`LOCAL_API`, 97 routes). Typed client: `createLocalApiClient()` in
`@jobleft/contracts` (Built).

### 6.1 Security rules (every rule is a MUST)

1. Listen on `127.0.0.1` only. Never on `0.0.0.0`, `::` or a LAN address. No second port (no debug inspector).
2. Host check: the `Host` header must be exactly `127.0.0.1:<port>` or `localhost:<port>`. Anything else answers 403 `forbidden_host` (stops DNS rebinding; `127.0.0.1.attacker.example` fails).
3. Origin check: a request with an `Origin` header is refused (403 `forbidden_origin`) unless the Origin is the app's own UI origin (`http://127.0.0.1:<port>` or `http://localhost:<port>`), or `chrome-extension://<id>` of a paired extension on a route with auth `pairing` (or the `pair` route). Origin `null` is always refused.
4. No permissive CORS. The server never sends `Access-Control-Allow-Origin: *` or echoes a foreign Origin. For a paired extension origin it may answer the preflight for the extension routes only.
5. Auth: every route needs its token, except `health` and `pair`. `launch` routes need `x-jobleft-token: <launch token>`. `pairing` routes need `x-jobleft-pairing: <pairing token>` from the matching extension Origin. A token in a URL query string is refused. No cookie is ever used. Token comparison is constant-time.
6. Writes (POST, PUT, PATCH) accept only `application/json`, or the raw media types the route lists. A plain cross-site form post (`text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data`) answers 415 before any work.
7. Body limits: JSON 1 MiB (`JSON_BODY_LIMIT`), raw uploads 10 MiB (`RAW_BODY_LIMIT`). Larger answers 413 and nothing is stored.
8. Validation: every body and query is checked against its contract (`validate()`) before any work. Invalid input answers 400 with the issue paths and stores nothing.
9. Error bodies and logs never hold a key, a token, resume text, chat text, network rows, a stack trace or a path with the account name.
10. No route serves a file from outside the data folder. Downloads come from records, not from paths in the request.
11. `health` reveals no personal data, no data-folder path and no counts.

How the server enforces them (Built, `apps/server/src/server.ts`), in this order: dot segments (`..`, `%2e%2e`) and
backslashes in the raw path answer 404 before the URL is normalised; Host; Origin; a request with no Origin but a
browser `Sec-Fetch-Site` of `cross-site` or `same-site` is refused on `/api/` (image and script tags); OPTIONS is
answered only for a paired extension on its own routes (or the pair route), with its exact Origin, never `*`; a
token-like query key (`token`, `key`, `auth`, ...) or the launch token anywhere in the query answers 400; the route's
token; launch routes refuse an extension Origin and pairing routes refuse any other Origin; media type; body size;
body and query contracts (a query key sent twice answers 400); for writes, a read-only data folder answers 507
`write_failed` before any work. Every answer carries `x-content-type-options: nosniff`, `x-frame-options: DENY`,
`cross-origin-resource-policy: same-origin`, `referrer-policy: no-referrer`; API answers add `cache-control: no-store`.
The UI is served with a CSP of `default-src 'self'` (inline styles allowed for Ant Design, no inline scripts,
`connect-src 'self'`, `frame-ancestors 'none'`). Outside `/api/` only real files of the UI folder are served; `/` is its
`index.html`, and any other path that is not a file answers 404 (no fallback page: the UI routes by the URL fragment).
A query `limit` outside 1 to 100 answers 400, as it does in a search body. Exception to rule 7: `restore` streams its upload to `tmp/` with a
4 GiB limit and first checks the free disk space against the declared length.

### 6.2 Errors

Every error answers with this body (`ApiErrorSchema`): `{ "error": { "code", "message", "details"?, "retryAfterSeconds"?, "link"? } }`.
`message` is one plain sentence. `link` is at most one link. For `insufficient_balance` it is the publik top-up link
(`PublikWallet.topUpUrl`) and the message says the balance ran out, in dollars ("balance", never "credits").

| Code | HTTP | When |
|---|---|---|
| `bad_request` | 400 | The body or query does not match the contract |
| `unauthorized` | 401 | Missing or wrong token |
| `forbidden_origin` | 403 | A foreign or `null` Origin |
| `forbidden_host` | 403 | A Host header other than 127.0.0.1 or localhost with the server's port |
| `not_found` | 404 | No such route or record |
| `conflict` | 409 | Already exists (a board already added), or a guarded delete |
| `needs_profile` | 409 | Needs a profile (match, Top Matched) |
| `needs_provider` | 409 | Needs an AI provider; the message offers to set one up |
| `payload_too_large` | 413 | Over the body limit |
| `unsupported_media_type` | 415 | A write that is not JSON or a listed raw type |
| `unsupported_source` | 422 | A link on a provider jobleft does not support |
| `forbidden_source` | 422 | A link on a never-crawl host (nothing was sent to it) |
| `too_early` | 425 | A source's own limit; `retryAfterSeconds` says when |
| `rate_limited` | 429 | Too many calls to this route |
| `insufficient_balance` | 402 | The publik balance is too low; one `link` |
| `provider_error` | 502 | The AI provider failed; the message names the real problem |
| `provider_timeout` | 504 | The AI provider did not answer in time |
| `not_ready` | 503 | For example the fit model is not downloaded yet |
| `offline` | 503 | No network (or `JOBLEFT_OFFLINE=1`) for a step that needs it |
| `internal` | 500 | A bug. Plain message, no details |
| `write_failed` | 507 | The disk refused a save (full or read-only); nothing was saved. `details.reason` is `full`, `read_only`, `io` or `corrupt`. Added by the server lane (additive) |

### 6.3 Conventions

- JSON in UTF-8. Times are RFC 3339 in UTC. Dates are `YYYY-MM-DD`. Money is integer micros of a US dollar.
- Query values are strings on the wire. Numbers use digits only; booleans are `true` or `false`.
- Lists that page take `cursor` and `limit` (1 to 100) and answer `nextCursor` (null at the end) and a true `total`. Cursors are opaque, stable while new rows arrive, and never repeat or skip a row.
- Raw uploads send the bytes with their media type and the file name in `x-jobleft-filename` (URI-encoded).
- Downloads (`file`) send `content-type` and `content-disposition: attachment; filename="..."`.
- The chat stream (`sse`) is `text/event-stream`. Each event is one `data: <ChatStreamEvent JSON>` line and a blank line. It starts with `start` and always ends with `done` or `error`. A stream cut short ends with `done` and `incomplete: true`; the partial text stays. `proposal` events carry changes the assistant wants to make; nothing changes until `POST /api/v1/ai/proposals/:proposalId`.

### 6.4 Routes (GENERATED from `LOCAL_API`)

Auth: `none` = public; `launch` = UI and shell (`x-jobleft-token`); `pairing` = the paired extension
(`x-jobleft-pairing`). Owner = the lane that implements the route's logic (apps/server wires every route).
Record names in backticks are schemas in `packages/contracts/schemas/`.

<!-- BEGIN GENERATED: routes -->
| Name | Method | Path | Auth | Owner | Query | Body | Response | What |
|---|---|---|---|---|---|---|---|---|
| `health` | GET | `/api/v1/health` | none | server | — | — | `Health` | Liveness and versions. Reveals no data. |
| `getSettings` | GET | `/api/v1/settings` | launch | server | — | — | `AppSettings` | App settings |
| `putSettings` | PUT | `/api/v1/settings` | launch | server | — | `AppSettings` | `AppSettings` | Change app settings |
| `storage` | GET | `/api/v1/storage` | launch | store | — | — | `StorageInfo` | Where the data lives and how big it is |
| `backup` | POST | `/api/v1/backup` | launch | server | — | — | file | Download one backup file of everything, uploaded files included (never a key or a token) |
| `restore` | POST | `/api/v1/restore` | launch | server | — | raw: application/zip, application/octet-stream | `{ restored }` | Restore a backup file; a damaged or foreign file is refused and nothing changes |
| `exportAll` | GET | `/api/v1/export` | launch | server | — | — | file | Download all personal data as readable files (no keys) |
| `deleteAllData` | POST | `/api/v1/data/delete` | launch | server | — | `{ confirm }` | `Ok` | Delete every personal record and file in the data folder |
| `listNotifications` | GET | `/api/v1/notifications` | launch | server | — | — | `Notification[]` | Notifications waiting for the shell to show |
| `ackNotification` | POST | `/api/v1/notifications/:notificationId/ack` | launch | server | — | — | `Ok` | Mark a notification shown (it is never shown again) |
| `exportJobs` | GET | `/api/v1/export/jobs` | launch | store | — | — | file | Download saved jobs with their source credits (NDJSON) |
| `shutdown` | POST | `/api/v1/shutdown` | launch | server | — | `{}` | `Ok` | Stop the server cleanly (the desktop shell uses it to quit; Windows has no SIGTERM) |
| `devClock` | POST | `/api/v1/dev/clock` | launch | server | — | `{ offset?, now? }` | `{ now }` | Time-skip for tests (JOBLEFT_DEV=1 only) |
| `listJobs` | GET | `/api/v1/jobs` | launch | store | `{ q?, sort?, cursor?, limit?, status? }` | — | `JobSearchResponse` | Simple search with the saved default filter |
| `searchJobs` | POST | `/api/v1/jobs/search` | launch | store | — | `JobSearchRequest` | `JobSearchResponse` | Search with the full filter set |
| `getJob` | GET | `/api/v1/jobs/:jobId` | launch | store | — | — | `JobDetail` | One job with company, match, tracker and network count |
| `addExternalJob` | POST | `/api/v1/jobs/external` | launch | sources-other | — | `ExternalJobRequest` | `{ job, tracker }` | Add a job from a URL or pasted text (External tab) |
| `keywordGaps` | GET | `/api/v1/jobs/:jobId/keyword-gaps` | launch | resume | `{ resumeId }` | — | `KeywordGapReport` | Keyword gaps of a resume for a job |
| `listTracker` | GET | `/api/v1/tracker` | launch | store | `{ view, status? }` | — | `TrackerList` | Liked, Applied, External, hidden, closed and tracked (everything the person did) views |
| `updateTracker` | PATCH | `/api/v1/tracker/:jobId` | launch | store | — | `TrackerPatch` | `TrackerEntry` | Like, hide, set status, notes, reminders |
| `listFilters` | GET | `/api/v1/filters` | launch | store | — | — | `SavedFilter[]` | Saved filters |
| `createFilter` | POST | `/api/v1/filters` | launch | store | — | `{ name, filter, sort, alert?, q? }` | `SavedFilter` | Save a filter |
| `updateFilter` | PUT | `/api/v1/filters/:filterId` | launch | store | — | `{ name, filter, sort, alert?, q? }` | `SavedFilter` | Change a saved filter |
| `deleteFilter` | DELETE | `/api/v1/filters/:filterId` | launch | store | — | — | `Ok` | Delete a saved filter |
| `getProfile` | GET | `/api/v1/profile` | launch | store | — | — | `Profile` | The profile |
| `putProfile` | PUT | `/api/v1/profile` | launch | store | — | `ProfileInput` | `Profile` | Replace the editable profile |
| `listResumes` | GET | `/api/v1/resumes` | launch | resume | — | — | `Resume[]` | Base resumes and tailored versions |
| `importResume` | POST | `/api/v1/resumes/import` | launch | resume | — | raw: application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document | `{ resume, proposedProfile }` | Upload a PDF or Word resume; returns it and a proposed profile to confirm |
| `createResume` | POST | `/api/v1/resumes` | launch | resume | — | `{ name, targetTitle? }` | `Resume` | Create a base resume from the profile |
| `getResume` | GET | `/api/v1/resumes/:resumeId` | launch | resume | — | — | `Resume` | One resume |
| `updateResume` | PATCH | `/api/v1/resumes/:resumeId` | launch | resume | — | `{ name?, targetTitle?, isPrimary?, document? }` | `Resume` | Rename, set target title, make primary, edit the document |
| `deleteResume` | DELETE | `/api/v1/resumes/:resumeId` | launch | resume | `{ withVersions? }` | — | `{ deleted }` | Delete a resume; a base with versions needs withVersions=true (else 409) |
| `tailorResume` | POST | `/api/v1/resumes/:resumeId/tailor` | launch | resume | — | `{ jobId }` | `TailorProposal` | Draft a tailored version for a job (nothing saved yet) |
| `acceptTailoring` | POST | `/api/v1/resumes/:resumeId/versions` | launch | resume | — | `{ proposalId, acceptChangeIds }` | `Resume` | Save a tailored version with the accepted changes |
| `fitCheck` | GET | `/api/v1/resumes/:resumeId/fit-check` | launch | resume | — | — | `{ fitsOnePage, leftOut }` | Does it fit one page, and what would be left out |
| `exportResume` | GET | `/api/v1/resumes/:resumeId/export` | launch | resume | `{ format }` | — | file | Download as a one-page PDF or a Word file |
| `atsCheck` | POST | `/api/v1/resumes/:resumeId/ats-check` | launch | resume | — | — | `AtsReport` | Grade the exported PDF |
| `listCoverLetters` | GET | `/api/v1/cover-letters` | launch | resume | `{ jobId }` | — | `CoverLetter[]` | Cover letters for a job |
| `createCoverLetter` | POST | `/api/v1/cover-letters` | launch | resume | — | `{ jobId, resumeId }` | `CoverLetter` | Draft a cover letter (truth-gated) |
| `updateCoverLetter` | PATCH | `/api/v1/cover-letters/:letterId` | launch | resume | — | `{ text?, instruction? }` | `CoverLetter` | Edit by hand (text) or by request (instruction); truth rules hold |
| `exportCoverLetter` | GET | `/api/v1/cover-letters/:letterId/export` | launch | resume | `{ format }` | — | file | Download a cover letter as a one-page PDF or a Word file (added in contracts 1.1.0) |
| `getMatch` | GET | `/api/v1/match/:jobId` | launch | match | — | — | `MatchResult` | Match score of a job (409 needs_profile without a profile) |
| `fitIndexStatus` | GET | `/api/v1/index/status` | launch | store | — | — | `FitIndexStatus` | Fit indexing: indexed, waiting, last run, model |
| `crawlStatus` | GET | `/api/v1/crawl/status` | launch | boards | — | — | `CrawlProgress` | Crawl progress (boards done of total) |
| `crawlRun` | POST | `/api/v1/crawl/run` | launch | boards | — | `{ boardIds? }` | `{ started, message, nextAllowedAt }` | Start a refresh now (all due boards, or the listed ones) |
| `crawlReport` | GET | `/api/v1/crawl/report` | launch | boards | — | — | `{ run, boards }` | Last run, per board, with reasons |
| `listBoards` | GET | `/api/v1/boards` | launch | boards | `{ q?, view?, cursor?, limit? }` | — | `{ items, total, nextCursor }` | Directory and user boards |
| `resolveBoard` | POST | `/api/v1/boards/resolve` | launch | boards | — | `{ url, acceptPaidLookup? }` | `BoardResolveResponse` | Find the board behind a careers or job link (adds nothing) |
| `addBoard` | POST | `/api/v1/boards` | launch | boards | — | `{ ats, board, region? }` | `BoardEntry` | Add a confirmed board (409 conflict when already added) |
| `updateBoard` | PATCH | `/api/v1/boards/:boardId` | launch | boards | — | `{ followed?, hidden?, disabled? }` | `BoardEntry` | Follow, hide or disable a board |
| `exportBoards` | GET | `/api/v1/boards/export` | launch | boards | — | — | file | Download the directory and user boards (NDJSON) |
| `listSources` | GET | `/api/v1/sources` | launch | sources-other | — | — | `SourceInfo[]` | Every source: crawled or not, why, status |
| `updateSource` | PATCH | `/api/v1/sources/:sourceId` | launch | sources-other | — | `{ enabled }` | `SourceInfo` | Turn a source on or off |
| `setSourceKey` | PUT | `/api/v1/sources/:sourceId/key` | launch | sources-other | — | `{ key }` | `SourceInfo` | Save the key a source needs (kept in the secret store, never echoed) |
| `deleteSourceKey` | DELETE | `/api/v1/sources/:sourceId/key` | launch | sources-other | — | — | `SourceInfo` | Forget a source key |
| `h1bLookup` | GET | `/api/v1/lookup/h1b` | launch | static-data | `{ company }` | — | `H1bLookup` | H-1B filing summary for a company name (found or unknown, never "no") |
| `placeLookup` | GET | `/api/v1/lookup/place` | launch | static-data | `{ text }` | — | `PlaceLookup` | Resolve a place text |
| `getCompany` | GET | `/api/v1/companies/:companyKey` | launch | static-data | — | — | `Company` | Company facts (kept, sourced, dated) |
| `refreshCompany` | POST | `/api/v1/companies/:companyKey/refresh` | launch | static-data | — | `{ allowPaid, maxPriceMicros? }` | `Company` | Read company facts again; paid lookups only with allowPaid and a price cap |
| `listDatasets` | GET | `/api/v1/data-sources` | launch | static-data | — | — | `DatasetInfo[]` | Shipped datasets with date, licence and attribution |
| `updateDatasets` | POST | `/api/v1/data-sources/update` | launch | static-data | — | — | `DatasetInfo[]` | Fetch newer dataset releases; a bad release keeps the old data |
| `importNetwork` | POST | `/api/v1/network/import` | launch | network | — | raw: text/csv, text/plain | `NetworkImportSummary` | Import Connections.csv (raw text body) |
| `listContacts` | GET | `/api/v1/network/contacts` | launch | network | `{ companyKey?, stage?, q?, due?, withFollowUp?, inPlan?, noCompany?, limit?, offset? }` | — | `NetworkContact[]` | Contacts, filtered |
| `networkCoverage` | GET | `/api/v1/network/coverage` | launch | network | — | — | `CompanyCoverage[]` | Target companies with and without connections |
| `rankContacts` | GET | `/api/v1/network/rank` | launch | network | `{ companyKey, jobId? }` | — | `ContactRank[]` | Who to message first at a company, with reasons |
| `updateContact` | PATCH | `/api/v1/network/contacts/:contactId` | launch | network | — | `{ stage?, note?, followUpOn?, inPlan? }` | `NetworkContact` | Stage, note, follow-up date, plan |
| `deleteContact` | DELETE | `/api/v1/network/contacts/:contactId` | launch | network | — | — | `Ok` | Delete one contact and everything about it |
| `deleteNetwork` | DELETE | `/api/v1/network` | launch | network | — | — | `{ ok, deleted, logCleared? }` | Delete all network data (the user's own file is untouched) |
| `draftOutreach` | POST | `/api/v1/network/contacts/:contactId/draft` | launch | network | — | `{ variant, jobId?, template?, confirmRemote? }` | `OutreachDraft` | Draft a short message (sends only this contact, this job and a short summary) |
| `previewDraft` | POST | `/api/v1/network/contacts/:contactId/draft/preview` | launch | network | — | `{ variant, jobId? }` | `DraftPreview` | What a draft would send and to whom (nothing is sent) |
| `networkCompanies` | GET | `/api/v1/network/companies` | launch | network | — | — | `NetworkCompanyGroup[]` | Companies in the network with counts; blank and placeholder companies grouped apart |
| `explainCompanyMatch` | GET | `/api/v1/network/match` | launch | network | `{ companyKey, companyName? }` | — | `CompanyMatchExplanation` | How a company count was made: names counted and near names not counted, with reasons |
| `networkPlan` | GET | `/api/v1/network/plan` | launch | network | — | — | `CoffeeChatPlanEntry[]` | The coffee-chat plan by company, in rank order, with a next step each |
| `planTopContacts` | POST | `/api/v1/network/plan` | launch | network | — | `{ companyKey, count, jobId? }` | `NetworkContact[]` | Put the top N people at a company into the coffee-chat plan |
| `getAiSettings` | GET | `/api/v1/ai/settings` | launch | ai-engine | — | — | `AiSettings` | Provider settings (never the key) |
| `putAiSettings` | PUT | `/api/v1/ai/settings` | launch | ai-engine | — | `AiSettingsUpdate` | `{ settings, check }` | Choose a provider; runs the setup check |
| `setAiKey` | PUT | `/api/v1/ai/key` | launch | ai-engine | — | `{ key, provider?, vendor?, baseUrl? }` | `AiSettings` | Save the key of the current provider (secret store; only the last 4 characters come back) |
| `deleteAiKey` | DELETE | `/api/v1/ai/key` | launch | ai-engine | — | — | `AiSettings` | Forget the key |
| `checkAi` | POST | `/api/v1/ai/check` | launch | ai-engine | — | — | `ProviderCheck` | Test the provider now |
| `listModels` | GET | `/api/v1/ai/models` | launch | ai-engine | — | — | `{ models }` | Models the provider says it has |
| `chat` | POST | `/api/v1/ai/chat` | launch | ai-engine | — | `ChatRequest` | SSE `ChatStreamEvent` | Chat (streams ChatStreamEvent) |
| `listChats` | GET | `/api/v1/ai/chats` | launch | ai-engine | — | — | `{ id, title, jobId, updatedAt }[]` | Saved conversations (on the laptop) |
| `getChat` | GET | `/api/v1/ai/chats/:chatId` | launch | ai-engine | — | — | `ChatThread` | One conversation |
| `deleteChat` | DELETE | `/api/v1/ai/chats/:chatId` | launch | ai-engine | — | — | `Ok` | Delete a conversation for real |
| `decideProposal` | POST | `/api/v1/ai/proposals/:proposalId` | launch | ai-engine | — | `{ approveActionIds }` | `{ applied, declined, failed?, notes? }` | Approve some actions of an assistant proposal; the rest are declined |
| `startPractice` | POST | `/api/v1/practice/sessions` | launch | ai-engine | — | `{ jobId, restart? }` | `PracticeSession` | Interview practice made for one job (continues the open session of that job unless restart is true) |
| `practiceFeedback` | POST | `/api/v1/practice/feedback` | launch | ai-engine | — | `{ sessionId, questionId, answer }` | `{ feedback, sampleAnswer, placeholders, mode?, costMicros? }` | Feedback on an answer (no invented achievements; placeholders marked) |
| `listPracticeItems` | GET | `/api/v1/practice/items` | launch | ai-engine | `{ jobId? }` | — | `PracticeItem[]` | The personal question bank |
| `savePracticeItem` | POST | `/api/v1/practice/items` | launch | ai-engine | — | `{ jobId, kind, question?, answer?, feedback?, notes? }` | `PracticeItem` | Save a question, answer or debrief for a job |
| `updatePracticeItem` | PATCH | `/api/v1/practice/items/:itemId` | launch | ai-engine | — | `{ question?, answer?, feedback?, notes? }` | `PracticeItem` | Edit a saved practice item |
| `deletePracticeItem` | DELETE | `/api/v1/practice/items/:itemId` | launch | ai-engine | — | — | `Ok` | Delete a saved practice item |
| `cancelAi` | POST | `/api/v1/ai/requests/:requestId/cancel` | launch | ai-engine | — | — | `{ cancelled }` | Cancel a running AI request (stops upstream too) |
| `getPublik` | GET | `/api/v1/publik` | launch | ai-engine | — | — | `PublikConnection` | publik connection and balance |
| `connectPublik` | POST | `/api/v1/publik/connect` | launch | ai-engine | — | `{ disclosureAccepted, disclosureVersion }` | `PublikConnection` | Connect after the disclosure (no key is typed) |
| `disconnectPublik` | POST | `/api/v1/publik/disconnect` | launch | ai-engine | — | — | `PublikConnection` | Disconnect: the key is deleted and nothing spends the balance |
| `refreshPublik` | POST | `/api/v1/publik/refresh` | launch | ai-engine | — | — | `PublikConnection` | Read the balance again |
| `pairingCode` | POST | `/api/v1/extension/pairing-code` | launch | server | — | — | `PairingCode` | Show a 6-digit pairing code (5 minutes) |
| `pair` | POST | `/api/v1/extension/pair` | none | server | — | `PairRequest` | `PairResponse` | Pair the extension with a code (Origin must be the extension) |
| `listPairings` | GET | `/api/v1/extension/pairings` | launch | server | — | — | `PairingInfo[]` | Paired extensions (the person sees each one) |
| `deletePairing` | DELETE | `/api/v1/extension/pairings/:extensionId` | launch | server | — | — | `Ok` | Unpair one extension; its token stops working at once |
| `unpair` | DELETE | `/api/v1/extension/pairing` | pairing | server | — | — | `Ok` | The extension unpairs itself |
| `extensionStatus` | GET | `/api/v1/extension/status` | pairing | server | — | — | `ExtensionStatus` | Paired state and profile completeness |
| `fill` | POST | `/api/v1/extension/fill` | pairing | server | — | `FillRequest` | `FillResponse` | Values for the form fields of an application page |
| `review` | POST | `/api/v1/extension/review` | pairing | server | — | `ReviewResult` | `ReviewResponse` | What the user reviewed and whether the user submitted |
| `extensionCheck` | POST | `/api/v1/extension/check` | pairing | server | — | `{}` | `ExtensionStatus` | The same answer as extensionStatus, sent as a POST: a browser sends no Origin header with a GET from an extension, and the app requires the extension Origin on every pairing route |
| `extensionPage` | POST | `/api/v1/extension/page` | pairing | server | — | `PageInfoRequest` | `PageInfo` | Which job a page address is, whether the person applied, and the resumes to attach (the address only; no page text) |
| `extensionDrafts` | POST | `/api/v1/extension/drafts` | pairing | server | — | `DraftRequest` | `DraftResponse` | Draft answers for open questions after the person saw the price (never written into a form by the app) |
| `extensionAddJob` | POST | `/api/v1/extension/add-job` | pairing | server | — | `PageInfoRequest` | `PageInfo` | Add the job on the person's current tab to jobleft (the same read as add-by-link; the person pressed the button) |
<!-- END GENERATED: routes -->

## 7. Extension protocol

Code: `packages/contracts/src/extension.ts` (protocol version 1). Transport: HTTP from the extension's service worker
to the local API. Content scripts never call the app directly.

| Step | Who | What |
|---|---|---|
| Port | person, then extension | The app shows its port next to the pairing code (`PairingCode.port`, added in 1.1). The person types the code and the port in the popup. The extension talks to that one port and never scans others: another local program could answer `app: "jobleft"` and collect the code or the token. A paired port that stops answering gives "not running" (the person can unpair and pair again with the app's new port); a `401` there drops the pairing |
| Start pairing | person, in the app | The person clicks "Show a pairing code". The UI calls `POST /api/v1/extension/pairing-code` and shows a 6-digit code (valid 5 minutes) and the app's port. This click is the approval |
| Pair | extension | The person types the code and the port in the extension popup. `GET /api/v1/health` on that port, then `POST /api/v1/extension/pair` with `PairRequest` to that port only (the code is valid only in the app that showed it). The Origin must be `chrome-extension://<extensionId>`. Five wrong codes void the code. The answer `PairResponse` holds the pairing token (the app keeps only its hash). Pairing the same extension id again replaces its old entry and old token |
| Keep | extension | The token and the port live only in `chrome.storage.local`, set to trusted contexts (content scripts cannot read it). Every later call sends `x-jobleft-pairing` from the same Origin, to the paired port only |
| List and unpair | person, in the app | `GET /api/v1/extension/pairings`, `DELETE /api/v1/extension/pairings/:extensionId`. The token stops working at once. The extension can unpair itself with `DELETE /api/v1/extension/pairing` |
| Status | extension | `GET /api/v1/extension/status`: paired, app version, profile completeness |
| Page | extension | `POST /api/v1/extension/page` with `PageInfoRequest { pageUrl }` (added in contracts 1.1), only when the person clicks the extension button on a tab that is not a blocked board. The app answers `PageInfo`: the job this address is (match by page key: tracking parameters ignored, job ids kept; `pageKey()` in apps/extension), whether the tracker already says Applied, the resumes, and the suggested resume (the version for this job, else the default). Every resume can be attached: an uploaded one as its own file, one made or tailored in the app as the PDF the app exports when a fill needs it (the Word file when the PDF font lacks a letter) |
| Fill | extension | Only when the person starts a fill. The extension lists the visible fields of the one application form (never hidden, zero-size, off-screen or see-through fields, never other forms, never password fields) as `FillRequest`, with the 1.1 hints (`autocomplete`, `placeholder`, `inputType`, `entry`, `context`, `combobox`, `accept`). The app answers `FillResponse`: values (1.1: each with `item`, the profile item in words, and `topic`), the resume file to attach (1.1: `resumeId`), drafts for open questions only when drafting is free, `notes` (1.1: why each other field was left empty) and `draftOffer` (1.1: the provider and the most one draft can cost, in micros). Option values are the option's index in the list the extension sent. For a `combobox` field the value is the wanted text and `topic` names the strict matcher the extension runs on the options it sees when it opens the list |
| Drafts | person, then extension | `POST /api/v1/extension/drafts` with `DraftRequest` (added in 1.1), only after the person saw the price in dollars and pressed "Make drafts". `maxCostMicros` is the most the person agreed to; the app refuses a request that would cost more and charges only drafts it made. `DraftResponse` carries the drafts, `costMicros`, the balance after, and the skipped questions. A draft goes into the form only when the person presses Insert |
| Review | person, then extension | The extension fills, reads each value back (a value the page rejects or clears is "not filled"), marks each changed field, shows the report (filled with the profile item, kept, needs you with the reason) and offers undo. The extension never submits, never presses a key, never presses next, save or continue, and never solves a CAPTCHA |
| Record | extension | `POST /api/v1/extension/review` with `ReviewResult` (1.1: `resumeId`, the resume that was attached). `submittedByUser` is true only when the person confirmed they submitted. Then the app marks the job Applied, once per job (a second confirm keeps one entry) |

The app side of `fill`: `answerFill(request, { profile, resume, draftOffer, draft?, jobId })` in `@jobleft/extension`
(pure; the stand-in app uses it too), so the app and the extension agree on topics and strict option matching. The
server lane should call it from the `fill` route; `draft` is passed only for a free (local) provider.

What the extension never gets: network contacts, AI keys, the publik key, backups, provider settings, the whole
profile. Sensitive questions (EEO, work authorization, sponsorship, pay expectation, date of birth, age, criminal
history, ID numbers) stay empty unless the person saved an answer for that exact topic; pay, age, date of birth,
criminal history and ID numbers are never answered. The extension never reads, fills or adds anything on LinkedIn,
Indeed or Glassdoor (every country domain and subdomain), and the app refuses those page addresses on the page,
fill, drafts, add-job and review routes (422 `forbidden_source`), so a broken or spoofed client gets nothing either.
Support levels (`ATS_SUPPORT` in apps/extension): Greenhouse, Lever, Ashby and Workable supported; Workday partial
(built last); iCIMS partial (not testable: no live iCIMS request is allowed); everything else "not supported".

## 8. Packages and apps

### `@jobleft/contracts`

Status: **Built** (18 tests). Purpose: every record that crosses a package boundary, the local API and the extension
protocol. One builder gives each contract its JSON Schema, its TypeScript type and run-time validation.

| Export | What |
|---|---|
| Builder | `str`, `num`, `int`, `bool`, `enm`, `lit`, `arr`, `obj(required, optional)`, `rec`, `nullable`, `union`, `anyValue`, `named`; types `Schema<T>`, `Infer<S>`, `JsonSchema` |
| Validation | `validate(schema, value) -> { ok, value } or { ok: false, issues[] }`, `isValid`, `parse` (throws `ContractError`) |
| Records | `Job`, `JobSummary`, `Pay`, `Place`, `RemoteScope`, `SourceAttribution`, `Company`, `H1bSummary`, `Profile`, `ProfileInput`, `Resume`, `ResumeDocument`, `ImportReport`, `AtsReport`, `KeywordGapReport`, `TailorProposal`, `TruthViolation`, `CoverLetter`, `MatchResult`, `MatchSummary`, `TrackerEntry`, `TrackerPatch`, `NetworkContact`, `NetworkImportSummary`, `ContactRank`, `CompanyCoverage`, `OutreachDraft`, `NetworkCompanyGroup`, `CompanyMatchExplanation`, `CoffeeChatPlanEntry`, `DraftPreview`, `PublikWallet`, `PublikConnection`, `AiSettings`, `ProviderCheck`, `ChatRequest`, `ChatStreamEvent`, `ActionProposal`, `ChatThread`, `PracticeSession`, `PracticeItem`, `JobFilter`, `JobSearchRequest`, `JobSearchResponse`, `JobListItem`, `SavedFilter`, `BoardEntry`, `BoardResolveResponse`, `SourceInfo`, `CrawlProgress`, `CrawlBoardReport`, `FitIndexStatus`, `DatasetInfo`, `H1bLookup`, `PlaceLookup`, `StorageInfo`, `Notification`, extension messages. Each has a `<Name>Schema` |
| Helpers | `bandFor(percent)` (STRONG 85+, GOOD 70 to 84, FAIR below 70), `summarizeMatch`, `experienceLevelOf(level)`, `formatDollars(micros)` (floors; "<$0.01" for a positive balance under a cent), `nowMs()` and `nowIso()` (time-skip), `parseDuration` |
| Local API | `LOCAL_API`, `RouteName`, `RouteBody<K>`, `RouteQuery<K>`, `RouteResponse<K>`, `matchRoute(method, path)`, `buildPath(path, params)`, `createLocalApiClient(opts)`, `LocalApiError`, headers (`LAUNCH_TOKEN_HEADER` = `x-jobleft-token`, `PAIRING_TOKEN_HEADER` = `x-jobleft-pairing`, `FILE_NAME_HEADER`), `DEFAULT_PORT` = 47821, `PORT_SPAN` = 10, `ERROR_CODES`, `ERROR_STATUS`, `ApiErrorSchema` |
| Interfaces | `Embedder` (`model`, `dims`, `embed(texts)`), `SecretStore` (`get`, `set`, `delete`), `SECRET_NAMES` |
| Registry | `SCHEMAS`, `schemaDocument(name)`, `CONTRACTS_VERSION` |

Data files: `packages/contracts/schemas/<Name>.schema.json` (68 files, generated; `pnpm --filter @jobleft/contracts run gen`).

Additive changes by lanes (1.4 rules): `ProviderCheck.link` (optional `{ label, url }`: at most one link that fixes the
problem, for example the publik top-up link on `balance_too_low`; ai-engine lane).
Details and change rules: `packages/contracts/README.md`.

### `@jobleft/parsers`

Status: **Built** (parsers lane, 54 tests; `pnpm --filter @jobleft/parsers test`). Pure functions only: no network, no clock, no files. Deterministic.
Purpose: every fact of a posting (pay, seniority, required years, places, US or not, work model and remote area,
employment type, posting statements), each with `FactEvidence`, or `null`/`[]` when the posting does not state it.
Everything the crawler, sources-other (added jobs) and store need is in `extractFacts`.

| Export | Signature | Notes |
|---|---|---|
| `extractFacts` | `(input: PostingInput) => PostingFacts` | The one call. `PostingFacts` = `{ pay, places, isUs, workModel, remoteScope, employmentType, level, levels, yearsRequired, statements, evidence, description, warnings }` in contract shapes (`Pay`, `Place[]`, `RemoteScope`, `ExperienceLevel[]`, `PostingStatements`, `JobEvidence`). Never throws; a failed reader leaves its fact null and adds a warning. `description` is the whole plain text (never cut) |
| `PostingInput` | `{ title, location?, locations?, addresses?, countries?, descriptionHtml?, description?, pay?: BoardPay[], workplaceType?, remote?, employmentType?, seniority?, experienceMonths?, extraText? }` | Board fields that carry facts. `pay` is the board's pay field (period may be null); `extraText` is board text next to the body (Lever `salaryDescription`, Ashby pay summary) |
| `postingsFromBoard`, `fromGreenhouse`, `fromLever`, `fromAshby`, `fromWorkable`, `fromRecruitee`, `fromPersonio`, `fromJsonLd`, `detectFormat`, `fromBoard` | `(json) => PostingInput` (and a list for a whole board) | Reads the fact fields of each public format. JSON-LD `estimatedSalary` is never read |
| `fromRawJob` | `(raw: RawJobLike, extra?) => PostingInput` | The crawler's `RawJob` (structural type) to `PostingInput`: `extractFacts(fromRawJob(raw))` in `normalizeJob` |
| `parsePay`, `payFromBoard` | `(text, { country?, title?, placeWords? }) => { pay: Pay, evidence } \| null` | Single figures (`min = max`), "up to" (`min: null`), "from"/"+" (`max: null`), tiers (`ranges`), OTE and add-ons excluded, many currencies and number styles. `source` is `description` or `board_field` |
| `payMeetsMinimum`, `paySortKey`, `formatPay`, `PAY_FILTER_RULE`, `yearlyPay` | `(pay, minYearly, currency?) => boolean \| null` ... | The one pay rule for filters, sorts and cards: the top of the range (or the only figure), per year (2,080 hours, 260 days, 52 weeks, 12 months), in the filter's currency; unknown pay is `null` |
| `parsePlaces`, `parseLocationText`, `placesFromText`, `placeFromAddress`, `usFromFacts`, `countryName` | `(text, { context? }) => Place[]` ... | Every place; `region` is the US state or Canadian province code when known; `country` ISO alpha-2; `placeId` stays null (static-data resolves it). `parseLocationText` also returns work-model words and remote regions of a location field |
| `parseWorkModel` | `(text, { workplaceType?, remote?, location?, locations?, title? }) => { workModel, remoteScope, evidence }` | Strictest stated reading wins; `remoteScope.regions` are ISO codes or `WORLDWIDE`, `EU`, `EMEA`, `APAC`, `LATAM`, `NA`, `AMER`; `remoteScope.text` keeps the posting's words (state lists, time zones, distance) |
| `parseYearsRequired` | `(text) => { min, max, evidence } \| null` | Experience requirements only; lowest alternative; preferred never replaces required |
| `parseLevel`, `readTitle`, `levelsOf`, `bucketsForYears`, `bucketsFromBoardSeniority`, `BUCKETS` | `parseLevel({ title, text?, years?, boardSeniority?, employmentType? }) => { level, levels, evidence }`; `levelsOf(level, years) => ExperienceLevel[]` | One or two adjacent buckets |
| `parseStatements`, `parseEmploymentType` | `(text) => PostingStatements & { evidence }`; `(field, text, title) => { value, evidence }` | EEO boilerplate is never a statement |
| `htmlToText`, `unescapeEncodedHtml`, `decodeEntities` | `(s: string) => string` | Blocks become lines, `li` becomes "- ", table cells " \| ", entities decode (twice-encoded too), scripts and styles vanish |
| Spike API (kept) | `levelFromTitle`, `levelFromDescription`, `parsePayFromText`, `annualize`, `isUsLocation`, `isRemoteText`, `parseNumber` | Same signatures as the S1 port; better rules |

CLI `jobleft-parse` (`packages/parsers/src/cli.ts`): `text [FILE|-] [--title T] [--location L] [--workplace W] [--html]`,
`board <FILE|loopback URL> [--format F] [--table|--ndjson]`, `rule`. It fetches only loopback URLs (a local mock board).
`packages/parsers/scripts/serve-board.ts <file> [--port N]` serves a file as a mock board on 127.0.0.1.

For the crawler lane: call `extractFacts` in `normalizeJob` with the adapter's fields (`fromGreenhouse` and friends show
which board fields matter), and store `pay.ranges`, every place, `remoteScope`, `levels`, `yearsRequired`, `statements`
and `evidence`. Keep board pay unrounded (the S1 `makePay` rounds $17.68 to $18). When a board shows pay outside the
description (Greenhouse pay box, Lever salary range, Ashby compensation), store that text with the posting so a reader
can see it (parsers O14).

### `@jobleft/crawler`

Status: **Built** (the S1 port grown into the production crawler by the crawler lane; 96 tests). Purpose: fetch public
job boards politely, normalise without inventing, store, keep current on a schedule, and close a posting only when two
complete readings agree it is gone. How to run it and every rule it keeps: `packages/crawler/README.md`.

| Export | Signature |
|---|---|
| Types | `Ats` (= contract `CrawlAtsId`), `BoardRef { ats, board, company, region?, origin? }` (`origin`: a loopback mock server for this board, tests only), `RawJob` (+ optional `places`, `payRanges`, `payEvidence`, `boardUpdatedAt`, `workModeEvidence`), `RawPay`, `Job` (alias `CrawledJob`; + optional contract facts `pageUrl`, `applyLink`, `places`, `workModel`, `remoteScope`, `employment`, `levels`, `yearsRequired`, `statements`, `evidence`, `payRanges`, `boardUpdatedAt`, `roleKey`), `BoardStats`, `HttpGetter { getJson(url) }`, `Source`, `SourceRegistry` |
| `Source` | `{ ats; fullBoardListing: boolean; fetchBoard(board, http): Promise<RawJob[]>; host?(board): string; conditional?: boolean }`. `conditional` = the board is read with ONE request, so ETag / If-Modified-Since can answer for the whole board |
| Config | `CrawlerConfig` (see the README section 8), `DEFAULT_CONFIG`, `DEFAULT_USER_AGENT`, `makeConfig(partial)`, `loadConfigFile(path)`, `checkUserAgent(ua)`, `productTokenOf(ua)`, `ConfigError` |
| Hosts | `forbiddenHostOf(host, allowHeldBack?)` (`never`: LinkedIn, Indeed, Glassdoor, SmartRecruiters; `held_back`: Workday, iCIMS, Oracle, UKG, Taleo), `forbiddenReason`, `HELD_BACK_FAMILIES`, `isPrivateAddress`, `isLocalName`, `loopbackOrigin` |
| `HttpClient` | `new HttpClient({ fetchImpl?, pacer?, timeoutMs?, maxBodyBytes?, maxRequests?, retries?, retryDelayMs?, respectRobots?, hostMap?, userAgent?, robotsTimeoutMs?, maxRetryAfterMs?, defaultRetryAfterMs?, tripWaitMs?, allowHeldBack?, lookup?, state? })`; `getJson(url, opts?)`, `getText(url, accept?, opts?)`, `fetchOk(url, { accept?, signal?, origin?, validators?, retries? })`, `forBoard(opts): BoardHttp`, `hostKey(hostOrUrl, origin?)`, `waitLeft(host)`, `snapshot(host?)`, `isTripped(host)`, `totalRequests`, `budgetLeft`, `userAgent`, `stats`. Default transport: `nodeTransport()` (node:http/https: exact headers, address check at connect time) |
| Errors | `HttpError`, `BlockedError` (403, 429), `NotFoundError`, `NotModifiedError` (304), `RedirectError`, `NotJobDataError` (web page, broken or cut-off JSON, wrong shape), `TooLargeError`, `RequestTimeoutError`, `CutOffError`, `NetworkError`, `AbortedError`, `RobotsError`, `DeniedHostError`, `HeldBackHostError`, `PrivateAddressError`, `BudgetError`, `HostTrippedError`, `HostFailingError`, `HostWaitError`, `HostMapError`, `BoardDeadlineError`, `TooManyJobsError`; `describeFailure(e): { status, code, message, blameless, cooldownMs? }` (the plain sentence of every failure) |
| `Pacer` | `new Pacer(intervalMs = 1000, now?, sleep?)`; `wait(host, extraIntervalMs?)` (gap = interval + `marginMs` 100), `blockUntil(host, ms)`, `blockedUntil(host)`, `seed(host, lastRequestMs)` |
| robots | `parseRobots(body, productToken): RobotsRules { allows(pathWithQuery), crawlDelayMs }`, `ALLOW_ALL`, `DISALLOW_ALL` |
| Identity | `USER_AGENT` = `jobleft-build/0.1 (research build; no personal data)`, `PRODUCT_TOKEN` = `jobleft-build` (research build; see section 4) |
| Host map | `checkHostMap(map)`, `hostMapFromEnv(env?)` (loopback targets only; never-crawl hosts refused) |
| Normalise | `normalizeJob(board, raw): Job \| null`, `skipReason(raw)`, `httpUrl(v)`, `roleKeyOf(company, title, places)`, `canonicalizeUrl(url, { stripGhJid? })` (keeps `gh_jid`), `normalizeCompany`, `normalizeTitle`, `dedupHash`, `dedupeBatch`, `partitionNew`, `contentHash`, `cleanText`; places: `splitPlaces`, `parsePlace`, `isGenericPlace`, `remoteRegions`, `workModelOf`. Optional parsers hooks: when `@jobleft/parsers` exports `parsePlaces`, `parseYearsRequired`, `parseStatements` or `levelsOf`, `normalizeJob` uses them (after a contract check); until then those facts stay unknown |
| Lifecycle | `boardQualifies`, `sweepableBoards`, `shouldSweep`, `closeTooBroad`, `emptyFeedShouldClose`, `cooldownFor`, `emptyStats`, constants (`DEFAULT_SWEEP_GRACE_MS` 48 h, `MAX_CLOSE_SHARE` 0.5, `EMPTY_FEED_MIN_STREAK` 3, cooldown 6 h doubling to 24 h) |
| `Store` | `new Store(pathOrDatabase, { fts?, busyTimeoutMs? })` (runs crawler migrations; `SchemaTooNewError` for a newer file); `upsertJob(job, nowIso)`, `recordReading(ats, board, listedIds, nowIso, policy)`, `recordNotModified`, `pendingMisses`, `closeUnseenForBoard`, `countUnseenForBoard`, `closeBoardEmpty`, `ensureBoard(ats, board, company, region?, origin?)`, `getBoard`, `listBoards`, `isCooledDown`, `recordSuccess`, `recordUnchanged`, `recordFailure(…, { cooldownMs?, notFound? })`, `recordOutcome`, `getValidators`, `setValidators`, `hostState()`, `hostWaits`, `getMeta`, `setMeta`, `schemaVersion`, `count`, `search`, `transaction`, `db`; `CRAWLER_SCHEMA_VERSION` = 2, `ATS_NAMES` |
| Contract jobs | `queryJobs(db, { status?, q?, board?, includeDuplicates?, limit?, cursor?, companyKey? }): { total, open, closed, items: Job[], nextCursor }`, `getJobById(db, id)`, `toContractJob(row, sources, opts)`, `jobIdOf(ats, board, externalId)` (same rule as store `makeJobId`), `simpleCompanyKey` (the app passes static-data `companyKey` instead), `ftsQuery(words)` |
| `crawl` | `crawl(boards, { store, http, sources?, now?, graceMs?, emptyFeedMs?, onBoard?, confirmGapMs?, confirmDelayMs?, perHostConcurrency?, globalConcurrency?, maxJobsPerBoard?, boardDeadlineMs?, force?, retryFailing?, runs?, runId?, signal?, notFoundCloseMs?, onProgress? }): Promise<RunReport>`. One transaction per board. A board whose ATS has no adapter fails with a reason and sends nothing. `BoardResult` has `status` (`ok`, `failed`, `cooled`, `blocked`, `host-skipped`, `deferred`, `robots`, `forbidden`), `reasonCode`, `reason`, `notModified`, `missing`, `confirmed`, `skipReasons` |
| Runs | `Runs(store)`: `create`, `interrupted`, `pendingBoards`, `adopt`, `boardDone`, `finish`, `latest`, `lastFinished`, `recent`, `acquireLease`, `touchLease`, `releaseLease` |
| Scheduler | `runOnce(deps, { reason, boards, force?, retryFailing?, signal?, resume? })` (resumes a cut-short run first), `new Scheduler({ ...deps, boards: () => BoardRef[] })` with `start({ catchUp })`, `stop()`, `runNow(boards?)`, `progress(): CrawlProgress`, `lastReport(): { run, boards: CrawlBoardReport[] }`; `planDue(store, boards, now, settings, waitLeft?)`, `retryDelayMs(failures, refreshMs)` (1 h, 4 h, 12 h, 1 d, 2 d, 4 d, 7 d at a 24 h refresh), `jitterMs`, `scheduleSettings(config)`, `simulate(deps, forMs)` (time-skip), `crawlerClock(store, { fixedMs?, extraOffsetMs? })`, `crawlProgress`, `lastRunReport`, `httpForRun`, `allMockBoards` |
| Board lists | `parseBoardList(json): { boards, skipped: { entry, reason }[], duplicates }`, `boardFromUrl(url)` (Greenhouse, Lever and Ashby board and job links; sends nothing) — in `src/boardlist.ts`, used by the CLI |
| Adapters | `SOURCES` (greenhouse, lever, ashby; all `conditional`), `greenhouse`, `lever`, `ashby`, `mapGreenhouse`, `mapLever`, `mapAshby`, `hostFor(ats, region?)`, `PAY_QUERY`, helpers in `sources/util.ts` (+ `unmappable`) |
| Test kit | `packages/crawler/testkit/mock-boards.ts`: `startMockBoards({ boards, robots, logFile })` (Greenhouse, Lever and Ashby on one loopback port, ETag, request log, misbehaving modes) and a CLI (`--port --boards --log --robots`) |

CLI `jobleft-crawl` (`node packages/crawler/src/cli.ts`): `run`, `status`, `jobs`, `daemon`, `simulate`, `verify`,
`clock`, `report`, `search` (and the S1 commands `crawl`, `probe`). Flags and outputs: `packages/crawler/README.md`.
Environment: `JOBLEFT_HOME`, `JOBLEFT_HOST_MAP`, `JOBLEFT_NOW`, `JOBLEFT_CLOCK_OFFSET`, `JOBLEFT_OFFLINE`.

Closing rule (crawler O3, O4): a posting closes only when its board answered with its whole list cleanly (a
`fullBoardListing` source, no failure, at least one posting, at most 5% unreadable) and a second reading confirms it is
gone, either `confirmGapMs` (2 h) after the first miss or, in the same run, when it was last seen `graceMs` (48 h) ago.
The mass-close guard holds a reading that would close over half of a board with 10 or more open jobs, until 3 held
readings over 24 hours agree. A clean empty board closes after 3 empty checks over 7 days; a board "not found" on 3
checks over 14 days closes as gone (`closed_reason = 'board_gone'`, contract `board_empty`).

Still planned: the `feed:<id>` and `external` families in `jobs` (sources-other writes them; the `Job` type's `ats`
is `CrawlAtsId` today), per-request retry counts in the run's request total when a process is killed.

### `@jobleft/sources-ats`

Status: **Built** (sources-ats lane, 2026-09-25). Purpose: the Workable, Recruitee, Personio, Teamtailor and Gem
adapters, the ATS source list (crawled or not, why, checked when), and ATS detection from a URL. Reviewed and not built:
BambooHR, Breezy, JazzHR (no documented public feed) and Rippling (terms not verifiable); see `docs/sources/`. Owns:
routes marked `sources-ats` (none; `listSources` merges its list). Contract change (additive): `CRAWL_ATS_IDS` gained
`teamtailor` and `gem`; `ATS_IDS` gained `jazzhr` and `rippling`.

<!-- BEGIN GENERATED: sig:packages/sources-ats -->
```ts
export { ATS_SOURCES, allSources, BUILTIN_SOURCES, crawledAtsIds } from './registry.ts';
export { ashbyOverallPay, greenhouseUrlFor, GREENHOUSE_EU_HOST } from './adapters/builtins.ts';
export { parseEuropeanPay } from './pay-text.ts';
export { cleanDescription, descriptionText, statedPay, textField } from './util.ts';
export { decodeEntitiesFull, stripControls } from './entities.ts';
export { polishRaw, polishSource } from './polish.ts';
export { atsName, classifyUrl, detectAts, neverContactHost } from './detect.ts';
export type { AtsDetection, UrlClassification, UrlVerdict } from './detect.ts';
export { atsHost, boardHost, normalRegion, SUBDOMAIN_FAMILIES } from './hosts.ts';
export { ATS_SOURCE_DETAILS, ATS_SOURCE_LIST, notCrawledReason } from './source-list.ts';
export type { AtsSourceDetail, AtsSourceEntry } from './source-list.ts';
export { gem, gemUrl, mapGem } from './adapters/gem.ts';
export { mapPersonio, personio, personioBody, personioUrl } from './adapters/personio.ts';
export { mapRecruitee, recruitee, recruiteePay, recruiteeUrl } from './adapters/recruitee.ts';
export { mapTeamtailorItem, teamtailor, TEAMTAILOR_MAX_PAGES, TEAMTAILOR_PAGE_SIZE, teamtailorJobId, teamtailorPageUrl, } from './adapters/teamtailor.ts';
export { mapWorkable, workable, workableUrl } from './adapters/workable.ts';
export { BoardTokenError, FeedFormatError, PagingError, SourceChangedError } from './errors.ts';
export { child, childText, children, decodeXmlEntities, parseXml, text } from './xml.ts';
export type { XmlElement, XmlNode } from './xml.ts';
export { plainReason } from './report.ts';
export { buildHealthReport } from './report.ts';
export type { AtsHealth, BoardHealth, HealthReport } from './report.ts';
export { politeFetch } from './polite-fetch.ts';
export type { PoliteFetchOptions } from './polite-fetch.ts';
```
<!-- END GENERATED: sig:packages/sources-ats -->

Key signatures (the block above only lists the re-exports of `src/index.ts`):

| Export | Signature and meaning |
|---|---|
| `ATS_SOURCES` | `SourceRegistry` = `{ workable, recruitee, personio, teamtailor, gem }`. `BUILTIN_SOURCES` = the crawler's `greenhouse`, `lever`, `ashby` run through this package's repairs (Greenhouse EU host and posted date, every Lever place, Ashby overall pay, clean text). `allSources()` returns `{ ...BUILTIN_SOURCES, ...ATS_SOURCES }`: use it, not `{ ...SOURCES, ...ATS_SOURCES }` |
| `detectAts` | `(url: string) => AtsDetection \| null`; `AtsDetection { ats: AtsId; board: string \| null; region: string \| null; jobId: string \| null; crawlable: boolean }`. Pure string work. Board tokens are lower case; `region` is `"eu"` (Lever, Greenhouse EU links), `"com"` (Personio .com), `"na"` (Teamtailor North America), or the Workday `wdN` shard |
| `classifyUrl` | `(url, notCrawledReason?) => { verdict: 'crawlable' \| 'job_link_without_board' \| 'not_crawled' \| 'never' \| 'unknown' \| 'invalid'; detection; message }`; `message` is one plain sentence. Pass `notCrawledReason` to name the reason |
| `neverContactHost` | `(hostname) => { name, why } \| null` for LinkedIn, Indeed, Glassdoor, SmartRecruiters, Workday, iCIMS, Taleo, Oracle, UKG |
| `atsHost` | `(ats: CrawlAtsId, region: string \| null) => string`. For the sub-domain families (Recruitee, Personio, Teamtailor) it is the parent domain |
| `boardHost` | `(ref: { ats, board, region? }) => string`: the exact host of one board (`acme.recruitee.com`, `acme.jobs.personio.com`, `acme.na.teamtailor.com`) |
| `ATS_SOURCE_LIST` | `ReadonlyArray<Omit<SourceInfo, 'enabled' \| 'keySet' \| 'status'>>`. Ids: `ats:<family>` for ATS families, `site:linkedin`, `site:indeed`, `site:glassdoor`. `ATS_SOURCE_DETAILS` adds `ats`, `docsFile`, `quote`, `quoteSource` |
| `buildHealthReport` | `(run: RunReport, store: Store) => HealthReport`: per board (status, plain reason, flag, last checked, listed, read, new, updated, closed, open) and per ATS totals that add up |
| `plainReason` | `(crawlerError: string) => string`: one plain sentence for a failed board (404, 429, 5xx, timeout, HTML, invalid JSON, cut-off XML, redirect, robots, ...) |
| `politeFetch` | `(opts?) => typeof fetch`: a `fetchImpl` for `HttpClient` that keeps 1 s (+100 ms) between the sending of any two requests to a host, obeys Retry-After (429 and 503) per host, keeps a robots.txt `Crawl-delay` between every two requests to a host (the crawler's `Pacer` applies it only from the second request after robots.txt; a delay over `maxWaitMs`, 60 s, fails the request at once), does not let those waits use up the request timeout (`timeoutMs`, set it to the `HttpClient`'s), reads bodies with a size limit while they stream (`maxBodyBytes`, 64 MiB), turns Latin-1 feeds into UTF-8, remembers why a robots.txt could not be read (`robotsProblemFor`), and refuses never-contact hosts before any request |

Rules: every adapter uses only the `HttpGetter` it is given (the XML adapters also need its `getText`, which the
crawler's `HttpClient` has); `fullBoardListing` is true for all five: one answer is the whole board, and the paged
Teamtailor adapter reads every page and fails the board when a page fails, repeats, or passes 100 pages; a listing that
has lost its list field fails the board (it never looks empty); a listed job without id or title is returned as
`unreadable`, never dropped silently; board tokens are checked before any request (a sub-domain token must be a DNS
label, a path token a slug), so a token cannot point a request at another host; links that are not absolute http(s)
are dropped; extra escape layers (`&amp;lt;p&amp;gt;`) are removed from descriptions and short fields before the crawler's `htmlToText`; never a request to SmartRecruiters, Workday, iCIMS, Oracle, UKG or
Taleo. The server uses `allSources()`. Greenhouse boards accept `"region": "eu"` (host `boards-api.eu.greenhouse.io`; that host is not in the approved-hosts table (section 9, Outbound hosts) until the owner adds it).

CLI `jobleft-ats` (`packages/sources-ats/src/cli.ts`, run from the repository root with `node packages/sources-ats/src/cli.ts`):
`sources [--json]`, `detect <url>... [--json]`, `crawl --boards <file> --db <file> [--out <report.json>] [--log <requests.ndjson>]
[--grace-hours 48] [--max-requests 3000] [--now <RFC 3339>]`, `jobs --db <file> [--ats] [--board] [--status open|closed|all] [--full] [--json]`,
`report --db <file> [--json]`, `standin --dir <folder> [--port 4600] [--log <file>] [--boards-out <file>] [--map-out <file>]`.
Environment: `JOBLEFT_HOST_MAP` (each sub-domain board needs its own entry; `standin` prints a ready map), `JOBLEFT_OFFLINE=1`
(crawl sends nothing), `JOBLEFT_NOW`. The package README has a walkthrough.

### `@jobleft/sources-other`

Status: **Built** (49 tests, no live request). Purpose: non-ATS feeds (each OFF until the person turns it on),
add-a-job by URL or text, and the metered fetch and search client (paid, OFF until the person turns it on, price
shown first in dollars). Owns: tables `source_state`, `source_runs`, `source_requests`, `source_host_slots`,
`feed_postings`; routes `addExternalJob`, `listSources`, `updateSource`, `setSourceKey`, `deleteSourceKey`.
Package README (commands, stand-in feeds, checks per outcome): `packages/sources-other/README.md`. Source notes:
`docs/sources/{remoteok,themuse,hn-whoishiring,github-lists,remotive,usajobs,adzuna}.md`.

<!-- BEGIN GENERATED: sig:packages/sources-other -->
```ts
export type { FeedContext, FeedFacts, FeedHttp, FeedPosting, FeedRequestOptions, FeedResponse, FeedResult, JobFeed, KeyReader, } from './types.ts';
export { ALL_FEEDS, LISTED_ONLY, OTHER_FEEDS, ROBOTS_EXCEPTIONS, feedById, keyEnvName } from './catalog.ts';
export { parseRemoteOk, remoteOk, REMOTEOK_CREDIT, REMOTEOK_URL } from './feeds/remoteok.ts';
export { parseRemotive, remotive, REMOTIVE_CREDIT, REMOTIVE_URL } from './feeds/remotive.ts';
export { MUSE_BASE, MUSE_CREDIT, MUSE_SLICE, museUrl, parseMusePage, theMuse } from './feeds/themuse.ts';
export { parseUsajobsPage, parseUsajobsSecret, usajobs, usajobsUrl } from './feeds/usajobs.ts';
export { HN_CREDIT, HN_SEARCH_URL, hnItemUrl, hnPostUrl, hnWhoIsHiring, parseHnComment, parseHnThread, pickHiringThread } from './feeds/hn.ts';
export type { HnThreadRef } from './feeds/hn.ts';
export { GITHUB_FEEDS, GITHUB_LISTS, parseListings, parseSpeedyMarkdown, rawUrl, speedyId } from './feeds/github.ts';
export type { GithubList } from './feeds/github.ts';
export { DbPacer, FeedClient, FeedError, MemoryPacer, NEVER_CRAWL, parseJsonBody, shapeError } from './http.ts';
export type { FeedClientOptions, FeedErrorCode, HostPacer } from './http.ts';
export { NewerSchemaError, OWNER, SCHEMA_VERSION, migrateSourcesOther } from './db.ts';
export { DAY_MS, backoffMs, finishRun, getState, nextAllowed, recordRequest, reserveRun, setEnabled } from './limits.ts';
export type { RunReason, Wait, WaitReason } from './limits.ts';
export { MASS_CLOSE_CONFIRM_MS, MASS_CLOSE_MIN_OPEN, MASS_CLOSE_SHARE, applyFeedResult, jobKeyOf, plainProblem, refreshSources } from './runner.ts';
export type { RefreshOptions, SkipReason, SourceRunResult } from './runner.ts';
export { SHOWN_SQL, creditLine, enabledSources, ephemeralJobs, exportFeedJobs, feedJobs, openJobsFor } from './view.ts';
export type { FeedJobQuery } from './view.ts';
export { SourceService, SourceServiceError, envSecretStore } from './service.ts';
export type { RefreshReport, SourceServiceOptions } from './service.ts';
export { atsBoardFromUrl, discoverBoards } from './discover.ts';
export type { AtsLink, BoardCandidate, DiscoveryReport } from './discover.ts';
export { countryCode, employmentTypeOf, fixMojibake, makePay, parseRemoteScope, payFromSalaryField, payFromText, placeFromText, safeHttpUrl, scopeOpenToUs, } from './text.ts';
export { jobFromText, jobFromUrl } from './external.ts';
export type { ExternalJobDraft } from './external.ts';
export { METERED_PRICES_MICROS, MeteredFetchError, createMeteredFetchClient } from './metered.ts';
export type { MeteredFetchClient } from './metered.ts';
```
<!-- END GENERATED: sig:packages/sources-other -->

The foundation interface is unchanged; the changes are additive: optional fields on `FeedHttp` (`request`),
`FeedContext` (`etag`), `FeedResult` (`postings`, `unreadableIds`, `unreadableWithoutId`, `skipped`, `notModified`,
`etag`, `notes`, `problem`) and `JobFeed` (`hosts`, `requestLimits`, `keyHelp`, `checkKey`). `OTHER_FEEDS` is filled.

Sources (`ALL_FEEDS`; ids are the `sourceId` of `SourceAttribution`):

| Id | Crawled | Key | Host | Limit |
|---|---|---|---|---|
| `remoteok` | yes | no | `remoteok.com` | 4 runs in any 24 h, 1 h apart |
| `themuse` | yes | yes (`api_key` URL parameter, the only form The Muse takes) | `www.themuse.com` | 2 runs in any 24 h, 6 h apart, 900 requests |
| `hn-whoishiring` | yes | no | `hn.algolia.com` | 2 runs in any 24 h, 6 h apart |
| `gh-simplify-internships`, `gh-vanshb03-internships`, `gh-vanshb03-newgrad`, `gh-speedyapply-swe`, `gh-speedyapply-ai` | yes | no | `raw.githubusercontent.com` | 4 runs in any 24 h, 1 h apart |
| `remotive` | no: robots.txt disallows `/api/*` | no | (`remotive.com`) | cannot be turned on |
| `usajobs` | no: robots.txt disallows `/`; owner decision | yes (`<email> <key>`: key in `Authorization-Key`, email in `User-Agent`, its host only) | (`data.usajobs.gov`) | cannot be turned on |
| `adzuna` (`LISTED_ONLY`) | no: terms forbid storage | yes | none | no adapter |

Wiring for the server (`SourceService`):

| Call | Route or use | Notes |
|---|---|---|
| `new SourceService({ store, secrets, hostMap?, offline?, timeoutMs?, pacer?, now? })` | once at start | `store` is the crawler `Store` on the app database; runs this lane's migration |
| `list(): Promise<SourceInfo[]>` | `GET /api/v1/sources` | Merge with `ATS_SOURCE_LIST` from sources-ats. `status.lastProblem` starts with its UTC time |
| `update(id, { enabled })` | `PATCH /api/v1/sources/:sourceId` | Throws `SourceServiceError` `not_found` (404) or `conflict` (409, not crawled) |
| `setKey(id, key)`, `deleteKey(id)` | `PUT`, `DELETE /api/v1/sources/:sourceId/key` | `bad_request` (400) for a key in the wrong form; the answer never holds the key |
| `refresh({ ids?, reason: 'manual' })` | with `crawlRun`, or its own button | Every result says what happened; a source that is too soon returns `skipReason: 'too_early'` and `nextAllowedAt` (answer 425 `too_early` when nothing ran) |
| `refreshInBackground(...)` | UI refresh button | Returns at once |
| `runDue('launch')`, `runDue('schedule')` | launch catch-up; tray timer (every 15 minutes is fine) | Runs only sources that are on and due; safe to call often and from two places at once |
| `jobFromUrl(url, http)`, `jobFromText(text, applyUrl)` | `POST /api/v1/jobs/external` | Pass the crawler's shared `HttpClient`. `FeedError.code` `never_crawl` = 422 `forbidden_source`; `not_found`, `shape` ("not a job posting") = plain messages |
| `createMeteredFetchClient({ enabled, baseUrl, key })` | metered fetch and search | Refuses every call while `enabled()` is false; planned publik routes `POST <base>/fetch`, `POST <base>/search` (gate G-publik) |

Reading feed jobs (for the store lane). Feed postings are rows of the crawler's `jobs` table with
`ats = "feed:<sourceId>"`, `board = "<sourceId>"`, `job_id = <the source's id>`; the job id is
`feed:<sourceId>:<sourceId>:<id>`. Each source that lists a posting has one `feed_postings` row:

| Column | Meaning |
|---|---|
| `source_id`, `external_id` | The source and its id for the posting (primary key) |
| `job_ats`, `job_board`, `job_ext_id`, `job_key` | The `jobs` row that holds the posting. When two sources list the same posting (same canonical URL), both rows point at one `jobs` row, which may be an ATS row |
| `source_name`, `url`, `credit_text`, `credit_url` | `SourceAttribution.name`, `.url` (the posting on that source, exactly as the source wrote it) and `.credit` |
| `apply_url`, `canonical_url` | The employer's apply page when the source gives one; the crawler's canonical URL |
| `posted_at`, `places_json`, `work_model`, `remote_scope_json`, `employment_type`, `level`, `pay_json`, `is_us`, `statements_json`, `evidence_json` | Facts as the source states them (contract shapes, JSON). `null` = not stated. When set, they win over the crawler's text-derived columns |
| `first_seen_at`, `last_seen_at` | `SourceAttribution.firstSeenAt`, `.lastSeenAt` |
| `status`, `closed_at`, `closed_reason` | `open` or `closed` on that source (`source_removed`). The `jobs` row closes only when no source lists it |

Rules for showing them (the reference is `feedJobs()` in `src/view.ts`): `Job.sources` has one entry per
`feed_postings` row of the job (plus the ATS entry for an ATS row), each with its credit; `creditLine(job.sources)` is
the credit text for notifications, alerts and exports. The crawler's `duplicate_of` (same company and title, another
URL) must not hide a feed row: two postings with the same title at one company are two jobs (sources-other O10). Jobs
whose only sources are turned off (`source_state.enabled = 0`) are hidden from the job list, never deleted; tracked
jobs stay in the tracker. `status.openJobs` counts the same way.

Rules: a key goes only to its source's host (in a header, or for The Muse in the URL, which jobleft always redacts);
the fixed `USER_AGENT` goes everywhere except USAJOBS's own host (its terms ask for the registered email); every
request obeys robots.txt (`ROBOTS_EXCEPTIONS` is empty; only the owner adds to it); redirects are never followed; with
`JOBLEFT_HOST_MAP` set, an unmapped host is refused (stand-in mode); per-query partners whose terms forbid storage are
never saved (`storable: false`); an error, an empty answer, a cut-off or partial answer never closes or deletes jobs.
CLI (Built): `node packages/sources-other/src/cli.ts <list|enable|disable|refresh|due|simulate|jobs|export|runs|discover|standin|standin-set|standin-reset>`
(bin `jobleft-sources`). Stand-in feeds for tests: `standin --dir <d>` (one loopback port per real host, editable
fixtures, switchable failures, a request log with keys redacted).

### `@jobleft/boards`

Status: **Built** (boards lane). Purpose: the board directory (3,581 rows from JobSync's MIT lists, checked against the
providers; a stated source and licence in the file header), the person's boards and choices, link-to-board resolution
(including employer pages that embed a board and `gh_jid` links), board health with dead-board back-off, crawl planning
and the scheduler, a directory refresh with dead-token pruning, and Common Crawl discovery. Owns: tables `board_prefs`,
`board_checks`, `crawl_runs`, `crawl_board_reports`, `board_pending_links`, `host_pacing`, `robots_cache`; routes `crawlStatus`,
`crawlRun`, `crawlReport`, `listBoards`, `resolveBoard`, `addBoard`, `updateBoard`, `exportBoards`; data files
`packages/boards/data/board-directory.json` and `board-directory-pruned.json`. Package README: `packages/boards/README.md`.

| Export | What |
|---|---|
| `BoardService` | `new BoardService({ db, directory, http, sources, now?, newHttp?, paid?, offline?, resolveDeadlineMs? })`. `list({ q?, view?, cursor?, limit? })`, `get(id)`, `resolve(url, { acceptPaidLookup? })` (adds nothing; answers within 25 s), `add({ ats, board, region? })` (throws `BoardError('conflict')` when the person already added it), `update(id, { followed?, hidden?, disabled? })`, `export()` (NDJSON lines: every `BoardEntry` field plus `source`, `boardUrl`, `apiUrl`), `due(now, { intervalHours, catchUp })`, `recordCheck(id, outcome, { now?, storeOpenJobs? })`, `hiddenBoards()` (the store lane leaves these boards' jobs out of the feed), `counts()`, `listPending()`, `addPending()`, `removePending()` |
| `CrawlScheduler` | `new CrawlScheduler({ boards, crawlStore, http, sources, intervalHours, now?, onProgress?, newHttp?, offline?, batchSize?, graceMs? })` (`DEFAULT_GRACE_MS` 24 h). `start({ catchUp })`, `stop()`, `runNow(boardIds?)`, `runOnce({ boardIds?, reason?, intervalHours? })`, `progress()`, `lastReport()` |
| `BoardError` | `code`: `conflict`, `not_found`, `bad_request`, `unsupported_source`, `forbidden_source` (map to the local API error codes) |
| `PaidPageFetcher` | `{ enabled, prices(), fetchPage(url, { js, maxPriceMicros }) }`, structurally sources-other's `MeteredFetchClient`. Used only when the person accepts the offer |
| Directory | `BoardDirectory` (`size`, `get`, `has`, `all`, `ids`, `search(q, limit)`), `loadActiveDirectory({ home?, env? })` (`JOBLEFT_BOARD_DIRECTORY`, then `$JOBLEFT_HOME/datasets/board-directory.json`, then the shipped file), `readDirectoryFile`, `parseDirectoryFile`, `nameKey`, `nameWords`, `BUNDLED_DIRECTORY_PATH`, `DIRECTORY_FORMAT` (`jobleft-board-directory/1`). A directory row is a static-data `DirectoryRow` plus `id`, `lastVerified`, `status` (`live`, `suspect`, `unverified`) |
| Links and pages | `detectBoardFromUrl(url)` (pure), `detectBoard(url, { http })` (reads pages), `scanPage(html, pageUrl)` (pure), `parseLink`, `boardPageUrl`, `boardApiUrl`, `boardApiHost`, `PROVIDER_NAMES`, `forbiddenProvider`, `unsupportedProvider`, `jobSite` |
| Polite network | `createBoardHttp({ pacer, hostMap?, fetchImpl?, timeoutMs?, maxRequests?, offline?, onRequest? })` (a crawler `HttpClient` that also honours Retry-After, refuses iCIMS, Oracle, UKG and Taleo too, records redirect targets instead of following them), `SqlitePacer(dbPath, intervalMs)` (the per-host schedule in the database, shared by every process), `BusyPacer`, `httpStateFor`, `offlineFromEnv` |
| Checks | `verifyBoard(ats, board, region, http, sources)`, `classifyError`, `boardSources(registry)`, `unreadableRegion(ats, region)` (Greenhouse EU boards have no public feed: refused plainly, never sent to the US host), `UNREACHABLE_AFTER` (2), `backoffMs(failures)` (1 day, doubling, at most 30 days) |
| Ids | `boardId(ats, board, region?)`, `parseBoardId(id)`, `isCrawlAts` |

<!-- BEGIN GENERATED: sig:packages/boards -->
```ts
export { boardId, parseBoardId, isCrawlAts } from './ids.ts';
export { BoardDirectory, BUNDLED_DIRECTORY_PATH, DIRECTORY_FORMAT, PRUNED_DIRECTORY_PATH, installedDirectoryPath, loadActiveDirectory, nameKey, nameWords, parseDirectoryFile, readDirectoryFile, toFileRow, } from './directory.ts';
export type { DirectoryEntry, DirectoryFile, DirectoryFileRow, DirectorySource, DirectoryStatus, LoadedDirectory } from './directory.ts';
export { PROVIDER_NAMES, boardApiHost, boardApiUrl, boardPageUrl, detectBoardFromUrl, parseLink, } from './detect.ts';
export type { LinkBoard, UrlDetection } from './detect.ts';
export { scanPage } from './page.ts';
export type { Evidence, PageBoard, PageScan } from './page.ts';
export { forbiddenProvider, isForbiddenHost, jobSite, unsupportedProvider } from './hosts.ts';
export { BusyPacer, ForbiddenHostError, HostBusyError, OfflineError, RedirectLog, SqlitePacer, createBoardHttp, httpStateFor, networkCode, offlineFromEnv, redirectLogFor, } from './http.ts';
export type { BoardHttpOptions, BoardHttpState } from './http.ts';
export { boardSources, unreadableRegion } from './sources.ts';
export { classifyError, verifyBoard } from './verify.ts';
export type { CheckFailure, VerifyResult } from './verify.ts';
export { migrateBoards, SCHEMA_VERSION } from './db.ts';
export { BoardError, BoardService, UNREACHABLE_AFTER, backoffMs, priceText } from './service.ts';
export type { BoardErrorCode, BoardServiceOptions, CheckOutcome, ListView, PaidPageFetcher } from './service.ts';
export { CrawlScheduler, DEFAULT_GRACE_MS, outcomeOf } from './scheduler.ts';
export type { SchedulerOptions } from './scheduler.ts';
export { detectBoard } from './discover.ts';
export type { DetectBoardResult } from './discover.ts';
```
<!-- END GENERATED: sig:packages/boards -->

Rules: every resolve and refresh request goes through the polite client (one pacer per database, 1.1 s between
requests to one host, robots.txt, Retry-After); forbidden hosts (LinkedIn, Indeed, Glassdoor, SmartRecruiters,
Workday, iCIMS, Oracle, UKG, Taleo) get no request, also not as a redirect or embed target; an employer name comes
from the board or the directory, never from link text or a guess; one failed check never makes a board unreachable,
two in a row do, with a stated next check date; a failed, empty or broken answer never closes jobs (the scheduler passes `graceMs` 24 h to `crawl()`: a job missing
from a fully read board for 24 hours closes); a 429 waits at least its Retry-After (15 minutes or more), a 403 6 hours
doubling; a host that cannot be reached leaves its boards unchecked, and a host outage never makes boards
unreachable; a directory
update never removes, renames or re-enables a person's boards or choices; no paid lookup without the person's
acceptance of a price shown in dollars. CLI `jobleft-boards` (`packages/boards/src/cli.ts`; from the root:
`node packages/boards/src/cli.ts <command>` or `pnpm --filter @jobleft/boards run boards <command>`): `list`,
`count`, `search`, `show`, `export`, `resolve`, `add`, `follow|unfollow|hide|unhide|disable|enable`, `pending`,
`jobs`, `refresh`, `status`, `report`, `directory info|check|load|unload|refresh`, `serve` (a loopback development
server for the board routes with the section 6.1 rules). Scripts: `scripts/build-directory.ts`, `scripts/cc-discover.ts`,
`scripts/mock-hosts.ts`.

Overlaps to settle when the lanes merge: `detectBoardFromUrl` recognises board links on its own (sources-ats
`detectAts` was a stub when this lane was built); the directory file lives in `packages/boards/data/` (static-data's
`loadDirectoryRows` can read it by path; this lane does not edit static-data).

### `@jobleft/store`

Status: **Built** (lane/store). Purpose: the one database, job search and fit indexing, and the
person's records. Owns: the tables in section 3; routes `storage`, `exportJobs`, `listJobs`, `searchJobs`, `getJob`,
`listTracker`, `updateTracker`, `listFilters`, `createFilter`, `updateFilter`, `deleteFilter`, `getProfile`,
`putProfile`, `fitIndexStatus`.

<!-- BEGIN GENERATED: sig:packages/store -->
```ts
export { openDatabase, migrate, tx, StoreError, STORE_SCHEMA_VERSION, storeVersion, type OpenOptions } from './db.ts';
export { JobStore, crawlRowToInput, type SearchContext, type ImportResult } from './jobstore.ts';
export { FitIndex, profileTextOf, priorityFilterOf, type FitIndexOptions, type ModelInfo } from './fit.ts';
export { TrackerStore, FilterStore, ProfileStore, ChatStore, NotificationStore, SettingsStore, DEFAULT_SETTINGS, emptyProfileInput, canonicalJobId, } from './userdata.ts';
export { type CompanyInput, type UpsertStats } from './writer.ts';
export { normalizeInput, companyKeyOf, embedTextOf, EMBED_RECIPE } from './record.ts';
export { parseQuery, rewriteSpecialTokens, localCompanyKey } from './text.ts';
export { SynthGenerator, type SynthCompany } from './synth.ts';
export { MODEL_ID, MODEL_DIMS, MODEL_REVISION, MODEL_FILES, MODEL_TOTAL_BYTES, DEFAULT_MODEL_BASE_URL, MODEL_FOLDER, checkModel, ensureModel, defaultModelSource, modelDirIn, type ModelFile, type ModelSource, } from './embed/model.ts';
export { createBgeEmbedder, type LocalEmbedder } from './embed/onnx.ts';
/** The contract job id of a crawled posting: "<ats>:<board>:<externalId>", lower-case ATS and board. */
export declare function makeJobId(ats: string, board: string, externalId: string): string;
```
<!-- END GENERATED: sig:packages/store -->

Status: **Built** (lane/store). The block above is the export list; the hand-written summary below gives the signatures
that other lanes call. Commands and outcomes: `packages/store/README.md`.

| Export | Signature and meaning |
|---|---|
| `openDatabase` | `(path, opts?: { readOnly?, busyTimeoutMs? }) => DatabaseSync`. New file: mode 0600, `page_size 16384`, incremental auto-vacuum, then WAL. Folder 0700 |
| `migrate` | `(db) => { from, to }`. Store schema 1; a newer file is refused with a plain `StoreError('conflict')` and left untouched |
| `StoreError` | `Error` with `code`: `bad_request`, `not_found`, `conflict`, `needs_profile`, `not_ready`, `internal` (map with `ERROR_STATUS`) |
| `JobStore` | `new JobStore(db)`. `get(id)` (alias ids of merged copies work; closed jobs are returned), `search(req, ctx)`, `upsertJobs(items, { now?, source? })`, `refreshScope(scope, items, { now?, source? })` (a complete listing: missing jobs close; an empty listing closes nothing; closing over half of a scope of 10 or more is held), `closeJobs(ids, reason?, now?)`, `upsertCompanies(list, now?)`, `saveExternal(job, now?)`, `exportSaved()`, `storage(dbPath, dataDir)`, `vacuum(full?)`, `syncFromCrawler(now?)` |
| `SearchContext` | `{ profileVector: Float32Array \| null; h1b: H1bIndex \| null; places: PlaceIndex \| null; now; fit?: FitIndex \| null; fitUnavailable?: 'needs_profile' \| 'not_ready' }` (fields after `now` are additions) |
| `FitIndex` | `new FitIndex(db, embedder \| null, opts?: { model?, modelInfo?, priorityFilter?, now? })`. `status(): FitIndexStatus`, `runOnce(limit?, signal?)`, `runAll(signal?, onBatch?, limit?)` (one recorded run, 0 when nothing waits), `profileVector(text)`, `queue()`, `request(rids)`, `setEmbedder(e)` |
| `TrackerStore` | `get(jobId)`, `list(view, status?)`, `patch(jobId, patch, now, opts?: { external? })`. The job must exist (else `not_found`) |
| `FilterStore`, `ProfileStore`, `ChatStore`, `NotificationStore`, `SettingsStore` | As in the block of the foundation commit; additions: `FilterStore.get(id)`, `ProfileStore.clear()` |
| `normalizeInput` | `(input, nowIso, defaultSource?) => { job, error }`: the lenient import shape (README "Import format") to a validated contract `Job`. Missing facts stay `null`/`[]` |
| `profileTextOf`, `embedTextOf` | The texts fit indexing embeds (no contact details, no EEO answers) |
| `createBgeEmbedder`, `ensureModel`, `checkModel`, `MODEL_*` | bge-small-en-v1.5 fp32 on ONNX Runtime CPU (never CoreML, never the int8 model), pinned revision and sha256 per file; `ensureModel` resumes a cut download and deletes a file that fails its checksum |
| `SynthGenerator` | Deterministic synthetic jobs and company facts (realistic text lengths) |

Rules the store keeps (store outcomes O1 to O15): words come from FTS5 (contentless, porter, `remove_diacritics 2`;
`C++`, `C#`, `.NET`, `Node.js`, `401(k)` are rewritten to plain tokens on both sides; quotes and operator words are
plain words; a query with nothing searchable returns the normal list). Filters run over typed arrays in RAM; an unknown
fact fails a filter unless `includeUnknown` names it; exclude filters win. Sorts: `recommended` (word tiers, then posted
day, then how many facts the posting states), `most_recent` (posted time; unknown last), `top_matched` (cosine to the
profile vector over every candidate; jobs without a current vector follow, marked `fitScore: null`). Ties break by row
number, so the order is stable. Totals count exactly the rows paging reaches; the first page is a top-k pick and later
pages are slices of a kept order (the cursor also carries the last sort key, so paging continues after a restart).
Closed and hidden jobs never appear or count. Closed jobs that nobody tracks are removed; tracked ones stay (Closed view).
Dedupe: same id, same canonical link (tracking parameters removed, `gh_jid` kept) or same Greenhouse/Lever/Ashby posting
id = one row; same company key, title, places and text from another site = one row unless the posting ids differ or both
links are different pages of one site. Fit indexing embeds a job only when its embed text changes (hash per vector).

Integration notes for the server lane: `new StoreService(home)` (`packages/store/src/service.ts`) wires everything the
store owns (database, migrations, JobStore, FitIndex with the worker-thread embedder, the person's records, the model
download). After each crawl run, call `jobs.syncFromCrawler()` (the crawler's `Store` on the same file; its FTS can be
turned off with `{ fts: false }`). The embedder runs in a worker thread because ONNX Runtime's `run()` blocks its
thread. Overlap: `@jobleft/ai-engine` plans `createLocalEmbedder`; the store ships its own (lane spec) and `FitIndex`
accepts any `Embedder` whose `model` is `bge-small-en-v1.5`, so either can be passed.

CLI `jobleft-store` (`node packages/store/src/cli.ts <command>`): `init`, `import-jobs <file.ndjson> [--complete]`,
`seed --synthetic <n>`, `gen --synthetic <n> --out <file>`, `close`, `sync-crawler`, `search`, `get`, `profile`,
`tracker`, `filters`, `index`, `status`, `stats`, `model status|download|verify`, `vacuum`, `export-saved`, `serve`,
`bench`. `serve` is a loopback test server for the store's routes of section 6 (same paths, bodies and error shapes,
rules of 6.1); the app server lane replaces it.

### `@jobleft/static-data`

Status: **Built** (lane static-data, 29 tests; `loadSkills` and `loadDirectoryRows` are still stubs, outside this
lane). Purpose: the shipped datasets and lookups, `companyKey`, company facts and signed dataset releases. Owns: tables
`company_facts` and `company_fact_labels` (migrations recorded in `schema_migrations` as owner `static-data`); routes
`h1bLookup`, `placeLookup`, `getCompany`, `refreshCompany`, `listDatasets`, `updateDatasets`. Built datasets ship in
`packages/static-data/dist/` (`datasets.json` names each file with its sha256, version, sequence, data date, licence
and attribution); hand-reviewed inputs are in `packages/static-data/data/` (`company-aliases.json`,
`company-identifiers.json`, `place-aliases.json`, `release-keys.json`). Package README: exact commands and outputs.

| Export | Signature | Notes |
|---|---|---|
| `companyKey` | `(name: string) => string` | Case, accents, punctuation, "&"/"+" vs "and", a leading "the" and legal suffixes removed; ordinary words kept |
| `loadAliases` | `(opts) => CompanyAliases` | `keysFor(name)`; the index also has `entryForKey(key)` and `canonicalKey(key)` |
| `loadH1bIndex` | `(opts) => H1bIndex` | `lookup(name, { jobTitle? }) => H1bLookupDetail` (status `found` or `unknown`, never "no"; `reason` when unknown), `dataset()`. Reloads when a newer release is installed |
| `loadPlaceIndex` | `(opts) => PlaceIndex` | `resolve(text) => PlaceLookupDetail` (adds `workModel`, `remoteScope`, `unresolved`), `distanceMiles(a, b)`, `within(placeId, miles)`, `dataset()`. Place ids: `gnis:<id>`, `ne:<id>`, `geonames:<id>`, `region:US-TX`, `country:CA` |
| `h1bTagFor`, `passesH1bFilter` | `(statements, summary) => { tag, reason, label }`, `(tag) => boolean` | The one rule for the card tag and the H-1B filter (the post's words win; clearance and citizenship get their own words) |
| `CompanyFacts` | `new CompanyFacts({ db, h1b, aliases, fetchText, paid, now?, freshForMs?, enricher?, identifiers? })` | `note(name)`, `get(key)` (no request), `refresh(key, { allowPaid, maxPriceMicros?, force?, name? })` (free sources only when expired; concurrent calls share one set of requests; a failure keeps old facts), `expireAll()` |
| `createStaticDataRoutes` | `(opts: { dataDir, db, fetchText, paid?, manifestUrl?, fetchImpl? }) => StaticDataRoutes` | Handlers for the six routes; apps/server wires them |
| `listDatasets`, `updateDatasets` | as generated below | Shipped datasets plus the live fact sources; the updater installs only signed, newer, exact files |

Extra response fields (unknown keys are allowed by the contracts, so the routes return them as they are):
`H1bSummaryDetail` adds `label`, `matchedBy` (`alias`, `name`, `trade_name`), `aliasBasis`, `recentFilings`,
`recentWindow`, `newHireFilings`, `clientSiteShare`, `entities` (each filer with FEIN and per-file counts),
`excludedEntities`, `files`, `sourceUrl`, `counting`, `statusRule`, `naics`. `CompanyDetail` adds `factsStatus`
(fetched, last error, per-source status) and `paidLookup` (last cost as "$0.01 from your balance").

<!-- BEGIN GENERATED: sig:packages/static-data -->
```ts
import type { CrawlAtsId, DatasetInfo } from '@jobleft/contracts';
import { type CompanyAliases } from './aliases.ts';
import type { StaticDataOptions } from './datasets/store.ts';
import { type H1bIndex } from './h1b/index.ts';
import { type PlaceIndex } from './places/index.ts';
export type { StaticDataOptions } from './datasets/store.ts';
export { companyKey, splitDba, nameTokens, COMPANY_KEY_VERSION, LEGAL_SUFFIXES } from './company-key.ts';
export type { CompanyAliases, AliasIndex, AliasEntry } from './aliases.ts';
export type { H1bIndex, H1bLookupDetail, H1bSummaryDetail, H1bEntityDetail } from './h1b/index.ts';
export { LIKELY_MIN_FILINGS, LIKELY_MIN_RECENT, LIKELY_MIN_NEW_HIRE } from './h1b/index.ts';
export type { PlaceIndex, PlaceLookupDetail, WorkModel } from './places/index.ts';
export { normPlace } from './places/normalize.ts';
export { h1bTagFor, passesH1bFilter, type H1bTag, type H1bTagResult } from './h1b/tag.ts';
export { roleFamilyOf, normalizeTitle, SOC_MAJOR_GROUPS, type RoleFamily } from './h1b/role-family.ts';
export { CompanyFacts, migrateCompanyFacts, DEFAULT_FRESH_MS, type CompanyFactsOptions, type CompanyDetail, type PaidSearch, type SourceStatus } from './facts/company-facts.ts';
export { ruleEnricher, checkProposed, type PaidEnricher, type ProposedFact, type SearchResult, type EnrichTarget } from './facts/enrich.ts';
export { installReleases, verifyEnvelope, loadReleaseKeys, type UpdateOutcome, type ReleaseKey } from './datasets/release.ts';
export { LIVE_FACT_SOURCES } from './datasets/list.ts';
export { PoliteFetch, USER_AGENT } from './net/polite-fetch.ts';
export interface SkillDictionary {
    /** The canonical name for a term ("k8s" -> "Kubernetes", "JS" -> "JavaScript"), or null when unknown. */
    canonical(term: string): string | null;
    aliases(canonical: string): string[];
    /** Skills named in a text, canonical, in order of first appearance. "Java" never matches "JavaScript". */
    extract(text: string): string[];
}
/** One row of the shipped board directory. */
export interface DirectoryRow {
    ats: CrawlAtsId;
    board: string;
    region: string | null;
    company: string;
    /** Where the row came from (for THIRD_PARTY_NOTICES and the directory header). */
    source: string;
}
/** The reviewed brand-to-filer alias table (data/company-aliases.json). */
export declare function loadAliases(opts: StaticDataOptions): CompanyAliases;
/** The H-1B sponsor index. Works offline; reloads when a newer verified release is installed. */
export declare function loadH1bIndex(opts: StaticDataOptions): H1bIndex;
/** The place index. Works offline; reloads when a newer verified release is installed. */
export declare function loadPlaceIndex(opts: StaticDataOptions): PlaceIndex;
export declare function loadSkills(opts: StaticDataOptions): SkillDictionary;
export declare function loadDirectoryRows(opts: StaticDataOptions): DirectoryRow[];
/** Every dataset with its date, licence and attribution (GET /api/v1/data-sources), plus the live fact sources. */
export declare function listDatasets(opts: StaticDataOptions): DatasetInfo[];
/** Downloads, verifies (signature, size and sha256 from the signed release manifest) and swaps in newer releases. A bad release changes nothing. */
export declare function updateDatasets(opts: StaticDataOptions & {
    releaseManifestUrl: string;
    fetchImpl?: typeof fetch;
}): Promise<DatasetInfo[]>;
export { createStaticDataRoutes, type StaticDataRoutes, type StaticDataRouteOptions } from './routes.ts';
```
<!-- END GENERATED: sig:packages/static-data -->

Rules: H-1B counts are certified H-1B rows only, per filer entity (exact `EMPLOYER_NAME` and FEIN), per official
file, with the date window (2024-10-01 to 2026-06-30), US federal fiscal years and a partial-year mark; a missing
company is `unknown`, never "no"; brand-to-filer aliases come from a reviewed table, never from a similarity score;
same-name filers under another FEIN in another state are left out; place and sponsor lookups work offline;
company-fact requests carry only what names the company (a Wikidata id, a CIK, a legal name, the company name).
Releases: the manifest at `JOBLEFT_DATASET_MANIFEST_URL` must be signed (Ed25519) by a key in
`data/release-keys.json` (only a loopback-only test key exists yet), newer than the data in use, and every file must
match its size and sha256; a bad release changes nothing and sets `lastUpdateError`.
Deviation from the plan: GeoNames forbids automated download in robots.txt, so the shipped place table uses USGS GNIS
(US) and Natural Earth (world), both public domain; `build-places --geonames <dir>` accepts GeoNames files a person
downloaded. CLI `jobleft-data` (`node packages/static-data/src/cli.ts`): `h1b <company> [--title]`, `place <text>`,
`within "<center> | <place> ..." [--miles]`, `company <name> [--refresh] [--allow-paid ...]`, `datasets`,
`update [--manifest <url>]`, `mock-release [--mode]`, `mock-facts [--scenario] [--fail]`, `count-lca --lca <file>
--contains <text>`, `fetch-lca --out <dir>`, `build-h1b --lca <files>`, `build-places [--src] [--geonames]`.

### `@jobleft/ai-engine`

Status: **Built** by the ai-engine lane (providers, setup check, keys, publik client, structured answers, stand-ins,
route handlers, CLI), except the assistant presets, chat history, action proposals and interview practice (routes
`listChats`, `getChat`, `deleteChat`, `decideProposal`, `startPractice`, `practiceFeedback`, the practice item routes and
their tables are still **Planned**). How to run it: `packages/ai-engine/README.md`. Purpose: every AI call, the publik
connection and wallet, secrets, embeddings, the assistant and interview practice. Owns: tables `practice_sessions`, `practice_items`;
routes `getAiSettings`, `putAiSettings`, `setAiKey`, `deleteAiKey`, `checkAi`, `listModels`, `chat`, `cancelAi`,
`listChats`, `getChat`, `deleteChat`, `decideProposal`, `startPractice`, `practiceFeedback`, `listPracticeItems`,
`savePracticeItem`, `updatePracticeItem`, `deletePracticeItem`, `getPublik`, `connectPublik`, `disconnectPublik`,
`refreshPublik`.

<!-- BEGIN GENERATED: sig:packages/ai-engine -->
```ts
export { AiError, asAiError, isAiError, toApiError, type AiErrorCode } from './errors.ts';
export type { AiChunk, AiClient, AiCompletion, AiMessage, AiRequest, AiTool, AiToolCall, JsonRequest, ProviderDriver, } from './types.ts';
export { PUBLIK_APP_SLUG, PUBLIK_DEFAULT_BASE_URL, PUBLIK_DEFAULT_MODEL, PUBLIK_DISCLOSURE, PUBLIK_DISCLOSURE_VERSION, PUBLIK_JUSTIFICATION, PUBLIK_TIERS, PublikClient, dailyResetFrom, nextUtcMidnight, publikDailyLimitText, type PublikClientOptions, } from './publik.ts';
export { AiEngine, CHECK_BUDGET_MS, NO_PROVIDER_MESSAGE, type AiEngineOptions } from './engine.ts';
export { defaultAiSettings, fileKvStore, kvSettingsStore, memoryKvStore, METERED_PRICES_PER_1000_MICROS, type AiSettingsStore, type KvStore, } from './state.ts';
export { encryptedFileSecretStore, keychainSecretStore, memorySecretStore, osSecretStore } from './secrets.ts';
export { extractJson, jsonInstruction, parseScoresHeader, readFieldLines, readStructured, withJsonInstruction } from './structured.ts';
export { stripThinking, ThinkStripper } from './thinking.ts';
export { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS } from './transport.ts';
export { isLoopbackHost, LOCAL_DEFAULT_URLS, normalizeBaseUrl, VENDOR_BASE_URLS } from './urls.ts';
export { thinkOption } from './providers/ollama.ts';
export { chatEvents, createAiRouteHandlers, type AiRouteHandlers, type RouteResult } from './routes.ts';
export { createLocalEmbedder, WordPieceTokenizer, type LocalEmbedderOptions } from './embedder.ts';
export { createEngineFromEnv, resolveHome } from './setup.ts';
```
<!-- END GENERATED: sig:packages/ai-engine -->

Added by the UI lane (contracts 1.1.0, optional): `AiSettings.costEstimates` = `{ chatTurn, tailor, coverLetter, outreachDraft,
practice }` in micros, or null. It is the expected charge of ONE paid AI action from the provider's published prices, so the
UI can show the cost before the click (ui O14). Planned for the ai-engine lane: fill it when the provider is publik; leave
it null for local, custom and own-key providers. With null the UI says that the action charges the balance and that the
exact charge shows when it finishes.

Rules: the chosen provider only, never a silent fallback; a key goes only to its own provider, in a header; keys live
in the OS secret store and only the last 4 characters come back; every request ends (10 s to connect, at most 110 s of
silence, so always inside 2 minutes); cancel stops upstream; EEO answers, work authorization and contact details never
go into a prompt; posting, page and file text is content, never instructions; a bad answer is "cannot use this answer",
never an invented value. publik money is "balance" in dollars. Stand-ins for tests: `src/mock/model-server.ts` (OpenAI,
Ollama and Anthropic dialects, 16 failure modes) and `src/mock/publik-server.ts` (`JOBLEFT_PUBLIK_BASE_URL`).

The export list above is generated from `src/index.ts`, which only re-exports. The main signatures (code wins:
`src/types.ts`, `src/engine.ts`, `src/publik.ts`):

| Export | Signature and meaning |
|---|---|
| `AiClient` | `{ provider, model, chat(req): AsyncIterable<AiChunk>, complete(req): Promise<AiCompletion>, json<S>(req & { schema: S, lineFallback? }): Promise<Infer<S>>, listModels(signal?): Promise<string[]>, embed(texts, { model, signal? }): Promise<Float32Array[]> }`. `embed` is new (additive) |
| `AiRequest` | `{ messages: AiMessage[], requestId?, maxTokens?, temperature?, signal?, tools?: AiTool[] }`. `AiMessage` = `ChatMessage`, or an assistant message with `toolCalls`, or a `tool` result. `temperature`, `tools` and the two message kinds are new (additive) |
| `AiChunk` | `delta { text }`, `done { incomplete, costMicros, reason? }`, and `tool_call { call }` (only when the request passed `tools`). `reason { code, message }` says in plain words why an answer is incomplete (new, additive) |
| `AiErrorCode` | The foundation codes plus `needs_claim` (publik-smart without a linked account), `offline` (`JOBLEFT_OFFLINE=1` and a non-loopback provider), `bad_request` (invalid settings) and `not_ready` (secret store or fit model not usable). Additive |
| `toApiError(err)` | `{ status, body: ApiError }` for the local API: `no_provider` is 409 `needs_provider`; `insufficient_balance` and `needs_claim` are 402 with exactly one `link`; `timeout` is 504; the other provider problems are 502 `provider_error` with the plain message |
| `AiEngineOptions` | Foundation fields plus `state?: KvStore` (key-free engine state; the server passes its `SettingsStore`, which has the same `getJson`/`setJson`), `env?` (reads `JOBLEFT_OFFLINE`, `JOBLEFT_AI_HOST_MAP`) and `appVersion?`. Without `state`, publik connections and key hints live in memory only |
| `AiEngine` | Foundation methods, plus `setMeteredFetch(on)`, `clearProvider()`, `forgetAllKeys()` (for delete-all-data), `listModels()`, `describe()` (the active-provider label), `detectLocal()`, `idle()` (waits for the balance re-read after a paid call), `keySlot(settings)`. `updateSettings` refuses a `local` address that is not loopback |
| `PublikClient` | Foundation methods, plus `walletFrom(body)`, `failure(status, headers, raw)` (the plain 402 message with one `top_up_url`), `static costFromHeaders(headers)`; `gatewayKey()` and `onDisconnect()` are internal to the engine. `connect(v)` refuses a disclosure version other than `PUBLIK_DISCLOSURE_VERSION` |
| Constants | `PUBLIK_DISCLOSURE` (the two sentences), `PUBLIK_JUSTIFICATION` (why it costs money, contract section 12), `PUBLIK_TIERS`, `PUBLIK_DEFAULT_MODEL` (`publik-balanced`), `METERED_PRICES_PER_1000_MICROS` (search $5, page $2, JS page $4), `DEFAULT_CONNECT_TIMEOUT_MS` (10 s), `DEFAULT_IDLE_TIMEOUT_MS` (110 s) |
| Secrets | `osSecretStore(service, { fileDir?, env? })`: macOS Keychain through `/usr/bin/security` (the secret goes on stdin, never in argv), else, or with `JOBLEFT_SECRET_STORE=file`, `encryptedFileSecretStore(dir)` (AES-256-GCM, files 0600, folder 0700). `keychainSecretStore`, `memorySecretStore` |
| Structured answers | `readStructured(text, schema, { incomplete, lineFallback? })`, `extractJson`, `parseScoresHeader` (the "SCORES:" line), `readFieldLines` (a generic "field: value" reader for flat schemas) |
| Routes | `createAiRouteHandlers(engine)`: the logic of `getAiSettings`, `putAiSettings`, `setAiKey`, `deleteAiKey`, `checkAi`, `listModels`, `chat` (one streamed answer; no history yet), `cancelAi`, `getPublik`, `connectPublik`, `disconnectPublik`, `refreshPublik`, each `(input) => Promise<{ status, json } or { status: 200, sse }>`. `chatEvents(engine, req)` gives the `ChatStreamEvent` stream |
| Fit model | `createLocalEmbedder({ modelDir, threads?, baseUrl?, allowDownload?, ortModule? })`: bge-small-en-v1.5, pinned sha256, WordPiece tokenizer (`WordPieceTokenizer`). ONNX Runtime (`onnxruntime-node`) is loaded at run time and is NOT a dependency yet: without it the embedder answers `not_ready` |
| Setup | `createEngineFromEnv({ env?, home? })` (what the CLI uses), `resolveHome(env?)` |

For the UI lane (publik contract section 12): show `PUBLIK_DISCLOSURE` before `connectPublik`, and right after it
succeeds show the balance card: the balance line (`formatDollars(wallet.balanceMicros)`), `PUBLIK_JUSTIFICATION`, and one
button that opens `wallet.topUpUrl` ("Link this computer & pick a plan" while `claimState` is `anonymous`, "Add a plan or
pack" once claimed). A 402 shows the error message and exactly one link (`error.link`). Money is "balance" in dollars.

Added by the network fix round (additive): `GET /api/v1/ai/chats/:chatId` carries the conversation's undecided
proposals (`ChatThread.proposals`, still in memory only), and deciding a proposal appends one plain record of the
decision (done, declined, not done and why) to the conversation. publik's daily spending limit for the computer is
`PublikWallet.daily` (cap and used today when publik reports them, the reset time, and when a step was refused); a
429 `daily_cap_reached` gives every AI step the same words (`publikDailyLimitText`): this step would go over the
limit, nothing was charged, smaller steps may still run, and the reset in the person's own clock.

Key slots: a key belongs to one provider address. `own_key.<vendor>` for own keys; `custom@<hash of origin>` and
`local@<hash of origin>` for addresses. Secret name: `SECRET_NAMES.providerKey(slot)`. Changing the address means the
key must be saved again: the old key never goes to the new address.

CLI (`packages/ai-engine/src/cli.ts`, run with `node`): `providers`, `status`, `detect`, `use publik|local|custom|own-key|none`,
`key set|forget`, `check`, `models`, `chat`, `json`, `publik connect|status|disconnect`, `metered status|on|off`, `serve`,
`mock-model`, `mock-publik`, `secrets forget-all`.

### `@jobleft/resume`

Status: **Built** (resume lane; 55 tests; commands in `packages/resume/README.md`). Purpose: import, base resumes and
tailored versions, keyword gaps, tailoring with the truth gate, cover letters, one-page PDF and Word export, and the
ATS check. Owns: tables `resumes` (base resumes and tailored versions, `kind` = base or tailored), `tailor_proposals`,
`cover_letters` (migrations owner `resume`, version 1); files in `files/resumes/`; routes `listResumes`,
`importResume`, `createResume`, `getResume`, `updateResume`, `deleteResume`, `tailorResume`, `acceptTailoring`,
`fitCheck`, `exportResume`, `atsCheck`, `keywordGaps`, `listCoverLetters`, `createCoverLetter`, `updateCoverLetter`,
`exportCoverLetter` (new in contracts 1.1.0).

<!-- BEGIN GENERATED: sig:packages/resume -->
```ts
import type { AtsReport, ImportReport, Job, KeywordGapReport, Profile, ProfileInput, ResumeDocument, TruthViolation } from '@jobleft/contracts';
import type { SkillDictionary } from '@jobleft/static-data';
/** Largest resume upload (resume O2). */
export declare const MAX_RESUME_BYTES: number;
/**
 * Reads a PDF, Word (.docx) or plain-text resume in a worker thread (30 s limit). Never throws for a bad file:
 * `report.outcome` is "failed" with `report.failure` and a plain message in `report.warnings[0]`.
 */
export declare function importResume(bytes: Uint8Array, fileName: string, mimeType: string): Promise<{
    document: ResumeDocument;
    report: ImportReport;
    proposedProfile: ProfileInput;
}>;
/** A base resume document from the profile (header copied character for character). */
export declare function documentFromProfile(profile: Profile): ResumeDocument;
/** Facts in a draft (resume document or letter text) that do not trace to the profile. Empty = passes. */
export declare function truthGate(draft: ResumeDocument | string, profile: Profile, job: Job | null): TruthViolation[];
export declare function keywordGaps(job: Job, resume: ResumeDocument, profile: Profile, skills: SkillDictionary): KeywordGapReport;
/** Exactly one page. Throws ResumeError when the characters cannot be printed or nothing fits (never cuts text). */
export declare function renderPdf(doc: ResumeDocument): Promise<{
    bytes: Uint8Array;
    pages: number;
    leftOut: string[];
}>;
/** The Word file with the same content as renderPdf (the same items left out, in the same order). */
export declare function renderDocx(doc: ResumeDocument): Promise<Uint8Array>;
/** Grades the exact PDF bytes (same file, same report). Runs in a worker with a time limit. */
export declare function atsCheck(pdf: Uint8Array): Promise<AtsReport>;
export { ResumeService, profileIsEmpty, type ResumeServiceOptions, type ExportedFile } from './service.ts';
export { ResumeError, type ResumeErrorCode } from './errors.ts';
export { refusedFacts, workYears, headerFromProfile, checkDocument, checkLetter, buildProfileFacts } from './truth.ts';
export { builtinSkillDictionary, safeDictionary, jobTerms } from './gaps.ts';
export { draftTailoring, applyChanges, type TailorOp, type TailorDraft } from './tailor.ts';
export { draftLetter, editLetter, cleanJobField } from './letter.ts';
export { renderLetterPdf, renderLetterDocx } from './render/index.ts';
export { atsCheckPdf } from './ats.ts';
export { migrateResume, RESUME_SCHEMA_VERSION } from './db.ts';
export { documentText, dateRange } from './document.ts';
export { emptyProfileInput, asProfile } from './import/index.ts';
```
<!-- END GENERATED: sig:packages/resume -->

`ResumeService` (in `src/service.ts`; the server wires each route to one method). Every method throws `ResumeError`
(`code` = a local API error code of section 6.2, `message` = one plain sentence, `details` for the screen, `link` only
for `insufficient_balance`):

| Method | Route | Notes |
|---|---|---|
| `new ResumeService({ db, filesDir, profile, job, ai, skills, now? })` | — | Runs the `resume` migrations and sets `PRAGMA secure_delete = ON` on `db`. `ai()` may throw `AiError('no_provider')`: every step then uses jobleft's rules (no AI) |
| `list(): Resume[]` | `listResumes` | Bases (primary first), each followed by its versions. Base documents are brought in step with the profile on read (three-way: a field still equal to the old profile value takes the new one; a field edited on the resume stays) |
| `import(bytes, fileName, mimeType): Promise<{ resume, proposedProfile, outcome }>` | `importResume` | PDF, .docx or text, read in a worker (30 s, `JOBLEFT_IMPORT_TIMEOUT_MS`). A failed file throws (`payload_too_large`, `unsupported_media_type` or `bad_request`) with `details.report`; nothing is saved. Never writes the profile: the caller saves `proposedProfile` only when the person confirms |
| `create({ name, targetTitle? })` | `createResume` | `needs_profile` when the profile is empty |
| `get(id)`, `update(id, patch)` | `getResume`, `updateResume` | A `document` patch that holds a fact not in the profile is refused (`bad_request`, `details.violations`) |
| `delete(id, withVersions)` | `deleteResume` | `conflict` when the resume has tailored versions or cover letters and `withVersions` is false; returns every deleted id (resumes and letters) |
| `tailor(resumeId, jobId, { instruction?, useAi? }?)` | `tailorResume` | Nothing saved but the draft. `instruction` is the person's request (the assistant's "tailor" preset passes it); facts in it that are not in the profile come back in `refused` and `gaps` |
| `accept(resumeId, proposalId, acceptChangeIds)` | `acceptTailoring` | An empty list saves nothing (`conflict`, and the draft is marked rejected). A draft is accepted once. The saved version is checked by the truth gate again |
| `reject(proposalId)`, `proposal(id)` | — | For a UI "reject all" and for re-showing a draft |
| `fitCheck(id)`, `export(id, format)` | `fitCheck`, `exportResume` | `export` returns `{ fileName, mimeType, bytes, leftOut }`; the PDF is always one page; the Word file holds the same items |
| `atsCheck(id)` | `atsCheck` | Grades the exported PDF bytes |
| `keywordGaps(jobId, resumeId)` | `keywordGaps` | |
| `coverLetters(jobId)`, `getCoverLetter(id)`, `createCoverLetter(jobId, resumeId, { useAi? }?)`, `updateCoverLetter(id, { text?, instruction? }, { useAi? }?)`, `exportCoverLetter(id, format)` | cover-letter routes | A request with a fact not in the profile is refused (letter unchanged, `notice`, `gaps`). A hand edit is saved and marked `ready: false` while it holds violations; a letter that is not ready is not exported (`conflict`) |

Rules: the profile is the only source of facts; the job posting is data, never instructions or facts; no model call
during import, export or the ATS check; one model call per AI step and no retry; AI failures save nothing. The CLI
`jobleft-resume` (`node packages/resume/src/cli/main.ts`) runs every step on a data folder; until the server wires the
store, it keeps the profile in `files/resumes/profile.json`, added jobs in `files/resumes/jobs.json` and the AI choice in
`files/resumes/ai.json` (no key; keys come from an environment variable). Environment: `JOBLEFT_IMPORT_TIMEOUT_MS`
(import and ATS-check time limit, default 30000), `JOBLEFT_PDF_FONT` and `JOBLEFT_PDF_FONT_BOLD` (TrueType fonts to
embed when a PDF needs letters outside Helvetica; default: Arial, Liberation Sans or DejaVu Sans from the computer).
Contracts 1.1.0 additions used here: `Profile.extraSections`, `TailorProposal.costMicros|notice|refused`,
`CoverLetter.gaps|notice|provider|costMicros`, route `exportCoverLetter`.

### `@jobleft/match`

Status: **Built** (match lane, 2026-09-25). Purpose: the deterministic match score with reasons. Owns: route
`getMatch` (results may be cached by the store, keyed by job content hash, profile version and `ENGINE_VERSION`); the
data files `packages/match/data/{skills,credentials,occupations,industries}.tsv` (first-party, see
THIRD_PARTY_NOTICES.md); the CLI `node packages/match/src/cli.ts` (score, feed, claim, undo, explain, check, serve,
stats; packages/match/README.md); the probe `evals/match/ranking-pairs`.

<!-- BEGIN GENERATED: sig:packages/match -->
```ts
import type { Company, Job, MatchResult, MatchSummary, Place, PlaceQuery, Profile } from '@jobleft/contracts';
import type { SkillDictionary } from '@jobleft/static-data';
import type { MatchConfigInput } from './config.ts';
import { type FullMatchResult } from './score.ts';
import { matchSkillDictionary } from './taxonomy.ts';
/** Bump when the scoring rules change; cached results with another version are recomputed. */
export declare const ENGINE_VERSION = "match-1.0.0";
export interface MatchInput {
    profile: Profile;
    job: Job;
    company: Company | null;
    /**
     * Accepted for compatibility with the foundation interface and not read: the engine uses its own skill taxonomy
     * (packages/match/data), exported as `matchSkillDictionary` so other packages can use the same names.
     */
    skills?: SkillDictionary;
    /** ms since the epoch (for years of experience). Only the month is used. */
    now: number;
    /** Optional fit-model vectors (bge-small). Used only when `config.weights.semantic` is above 0 (default 0). */
    profileVector?: Float32Array | ArrayLike<number> | null;
    jobVector?: Float32Array | ArrayLike<number> | null;
    /** Optional weights and limits (see DEFAULT_CONFIG). Other weights give another engineVersion. */
    config?: MatchConfigInput | null;
    /** Optional distance in miles between a posting's place and a wanted place (a place dictionary). */
    distanceMiles?: (a: Place, b: PlaceQuery) => number | null;
}
/** The match of one job for the profile. Pure and deterministic. */
export declare function scoreMatch(input: MatchInput): FullMatchResult;
/** Hash of the profile facts the score reads (MatchResult.profileVersion). EEO answers are not part of it. */
export declare function profileVersion(profile: Profile): string;
/**
 * Years of experience from the work dates (overlaps counted once, a current role up to this month), or null with no
 * dates. A profile with education and no work entries counts as 0.
 */
export declare function yearsOfExperience(profile: Profile, now: number): number | null;
/** The text of the profile that fit indexing embeds (no contact details, no EEO answers). */
export declare function profileText(profile: Profile): string;
/** The text of a job that fit indexing embeds (title, company, skills and the first part of the description). */
export declare function jobText(job: Job): string;
/** The card view of a result: the percent, the band, two chips, and the first warning (never the detail only). */
export declare function summarize(result: MatchResult): MatchSummary;
export { DEFAULT_CONFIG, resolveConfig } from './config.ts';
export type { MatchConfig, MatchConfigInput } from './config.ts';
export type { FullMatchResult, MatchExtras, MustHave, DealBreakerCheck, SkillCheck, ExperienceDetail, JobFactView, Part } from './score.ts';
export { matchSkillDictionary };
export { taxonomyStats } from './taxonomy.ts';
export { bucketOf, bandCounts, rankTopMatched, type Bucket, type RankedItem } from './rank.ts';
export { cardText, detailText } from './views.ts';
export { narrativeBrief, checkNarrative, AI_TEXT_LABEL, type NarrativeBrief, type NarrativeIssue } from './narrative.ts';
export { setSkillClaim, undoSkillClaim, type SkillClaimChange } from './claims.ts';
export { looseJob, type LooseJob } from './loose.ts';
export { distanceFromPlaceIndex } from './geo.ts';
```
<!-- END GENERATED: sig:packages/match -->

Rules: pure and stable (same inputs, same numbers); free and offline; a part that cannot be judged has
`percent: null` with a reason, never a default; blockers name the posting's own words (for example "US citizenship
required") with evidence; protected traits and names are never inputs; posting text cannot inflate the score.

How it scores (details in packages/match/README.md, section 4): `overall = 36 + 0.24 x Experience + 0.29 x Skills +
0.08 x Industry` (weights in `DEFAULT_CONFIG`; a part with `null` adds 0, so an incomplete score is a floor), then
capped by unmet must-haves and broken deal-breakers (45 legal, 60 deal-breaker or level, 65 degree or years, 70 trade
licence, 84 for any "not in your profile" answer, so such a job is never Strong). `computedAt` is the first day of the
month the score was computed for: the score depends only on the month (a current role counts up to it).

Additive contract fields this lane added (contracts 1.1.0; all optional, readers that do not know them show nothing):

| Record | New field(s) | Meaning |
|---|---|---|
| `MatchResult` | `complete`, `unknownParts` | `false` / the parts with "not enough information". The UI shows "INCOMPLETE" and the band filter puts such a job in an "incomplete" bucket (`bucketOf`, `bandCounts`) |
| `MatchResult` | `mustHaves: MustHave[]` | Every must-have the posting states: `requirement`, `importance` (required, preferred, obtainable), `state` (met, unmet, not_in_profile, in_progress, info), the exact `quote`, a plain `message` |
| `MatchResult` | `dealBreakers: DealBreakerCheck[]` | Work model, location, minimum pay, job type against the person's preferences: ok, broken, not_stated |
| `MatchResult` | `jobFacts` | level, years, pay, sponsorship, industry, workModel, employmentType: `{ value, text, quote }`; `value: null` and `text: "not stated"` when the posting does not say |
| `MatchResult` | `experience: ExperienceDetail` | The years used, the roles counted (from, to, months) and not counted (why), the job's years and level |
| `MatchResult` | `skillDetail: SkillCheck[]`, `cap`, `notes` | Every skill or credential the posting names with its quote and whether the profile has it (met, related, implied, missing); the cap that lowered the percent; notes such as "not in English" |
| `Blocker` | kinds `licence`, `degree`, `work_model`, `pay`; fields `state` (unmet, not_in_profile), `requirement`, `dealBreaker` | |
| `WhyFitChip` | kind `post_says_no_sponsorship` | Only when the POSTING says it does not sponsor (never from missing data) |
| `MatchSummary` | `complete`, `blockerCount`, `warning` | `summarizeMatch()` fills them for results that carry `complete`, so a card shows the same first warning as the detail |
| `ProfileInput`, `Profile` | `declinedSkills: string[]` | "I don't have this": the score never counts these skills, even when a work bullet names them. The store must keep the field |

For other lanes:

- server: `getMatch` answers `scoreMatch({ profile, job, company, now: nowMs(), distanceMiles })`; `needs_profile` when
  there is no profile. Pass `distanceMiles: distanceFromPlaceIndex(placeIndex)` once @jobleft/static-data builds its
  place index (the CLI does this automatically when `loadPlaceIndex` stops throwing).
- store and UI: "Top Matched" orders by `percent` (then `complete`, then job id) with `rankTopMatched`; band filters
  and counts use `bucketOf` / `bandCounts`; cards use `summarizeMatch` (percent, band, two chips, first warning).
  "I have this" / "I don't have this" is `setSkillClaim(profileInput, skill, have)` (returns the new profile, the
  notice to show and a change for `undoSkillClaim`); it edits the profile, so every job follows.
- ai-engine: an AI summary gets only `narrativeBrief(result, job.contentHash)` (cache it under `cacheKey`) and is
  checked with `checkNarrative(text, result)` before it is shown, labelled with `AI_TEXT_LABEL`. It never changes a
  number.
- Anyone who needs skill names: `matchSkillDictionary` has the `SkillDictionary` shape (canonical, aliases, extract).

### `@jobleft/network`

Status: **Built** (52 tests; probe `evals/network/csv-fixtures`). Purpose: the Network tool on the person's own
`Connections.csv`. Owns: tables `network_contacts` and `network_meta`; routes `importNetwork`, `listContacts`,
`networkCoverage`, `rankContacts`, `updateContact`, `deleteContact`, `deleteNetwork`, `draftOutreach`, and (added by
the network lane, additive) `previewDraft`, `networkCompanies`, `explainCompanyMatch`, `networkPlan`,
`planTopContacts`. Commands and what a person sees: `packages/network/README.md`.

<!-- BEGIN GENERATED: sig:packages/network -->
```ts
import type { DatabaseSync } from 'node:sqlite';
import type { CompanyCoverage, ContactRank, Job, NetworkContact, NetworkImportSummary, OutreachDraft, OutreachStage } from '@jobleft/contracts';
import type { AiClient } from '@jobleft/ai-engine';
import { NetworkService as Service, type CompanyGroup, type MatchExplanation, type PlanEntry } from './service.ts';
export interface ParsedConnection {
    /** The file line (1-based) where the row starts. */
    line: number;
    firstName: string;
    lastName: string;
    profileUrl: string | null;
    email: string | null;
    company: string | null;
    position: string | null;
    /** YYYY-MM-DD, or null when blank or not readable without guessing. */
    connectedOn: string | null;
    /** The name may be garbled by the export. It is kept exactly as in the file. */
    maybeGarbled: boolean;
}
/**
 * Parses the export: skips the note lines above the header, handles a BOM, CRLF and quoted commas, and reports every
 * skipped row with a reason. A file that is not a connections export gives notAConnectionsFile: true and no rows.
 */
export declare function parseConnectionsCsv(text: string): {
    rows: ParsedConnection[];
    skipped: Array<{
        line: number;
        reason: string;
    }>;
    notAConnectionsFile: boolean;
    warnings: string[];
};
/** Ranks contacts at one company; each reason is true for the contact's row; same data, same order. */
export declare function rankContacts(contacts: NetworkContact[], ctx: {
    companyKey: string;
    job: Job | null;
    now: number;
}): ContactRank[];
/** Drafts one message from ONLY this contact's name, title and company, this job, and a short profile summary. */
export declare function draftOutreach(input: {
    contact: NetworkContact;
    job: Job | null;
    profileSummary: string;
    variant: 'short' | 'long';
    ai: AiClient;
}): Promise<OutreachDraft>;
export interface NetworkServiceOptions {
    db: DatabaseSync;
    /** @jobleft/static-data companyKey (the same key jobs use). */
    companyKey: (name: string) => string;
    now?: () => number;
    /** The person's time zone for "today" (default: the system zone, or JOBLEFT_TZ). */
    timeZone?: string;
}
/** Owns the tables `network_contacts` and `network_meta`. Deletes are real (rows, notes, dates; nothing left behind). */
export declare class NetworkService extends Service {
    constructor(opts: NetworkServiceOptions);
    /** Imports the file text. Keeps stages and notes of people already there; never drops a person silently. */
    import(csvText: string): NetworkImportSummary & {
        total: number;
        inFile: number;
    };
    list(q?: {
        companyKey?: string;
        noCompany?: boolean;
        stage?: OutreachStage;
        q?: string;
        due?: boolean;
        inPlan?: boolean;
        limit?: number;
        offset?: number;
    }): Array<NetworkContact & {
        inLatestFile: boolean;
        followUpDue: boolean;
    }>;
    /** How many connections work at a company (null when none, so cards show nothing). */
    countFor(companyKey: string): number | null;
    coverage(targetCompanies: Array<{
        companyKey: string;
        companyName: string;
        jobs?: Array<{
            id: string;
            title: string;
        }>;
    }>): CompanyCoverage[];
    rank(companyKey: string, job: Job | null): ContactRank[];
    update(id: string, patch: {
        stage?: OutreachStage;
        note?: string | null;
        followUpOn?: string | null;
        inPlan?: boolean;
    }): NetworkContact & {
        inLatestFile: boolean;
        followUpDue: boolean;
    };
    delete(id: string): boolean;
    deleteAll(): number;
    /** Contacts whose follow-up date is today or past (for reminders). */
    due(today?: string): Array<NetworkContact & {
        inLatestFile: boolean;
        followUpDue: boolean;
    }>;
    /** One contact, or null. */
    get(id: string): (NetworkContact & {
        inLatestFile: boolean;
        followUpDue: boolean;
    }) | null;
    /** countFor for a whole feed page from one cached map (no query per card). */
    countsFor(keys: Iterable<string>): Map<string, number | null>;
    /** Companies in the network with the names as written; blank ("unknown") and placeholder companies grouped apart. */
    companies(): CompanyGroup[];
    /** How a count was made: names counted and why; near names NOT counted and why. */
    explain(companyKey: string, companyName?: string | null): MatchExplanation;
    /** Puts the top `count` people at a company (ranked for the job, when given) into the coffee-chat plan. */
    addTopToPlan(companyKey: string, count: number, job: Job | null): Array<NetworkContact & {
        inLatestFile: boolean;
        followUpDue: boolean;
    }>;
    /** The coffee-chat plan by company, in rank order, with a next step for each person. */
    plan(): PlanEntry[];
    /** Due follow-ups not yet reminded for their date; marks them. The text holds a count, never a name. */
    takeReminders(today?: string): {
        count: number;
        contactIds: string[];
        text: {
            title: string;
            body: string;
        } | null;
    };
    /** Today's date (YYYY-MM-DD) in the person's time zone. */
    today(): string;
}
export { decodeCsvBytes, looksGarbled, parseConnectedOn, localDate, localTimeZone } from './text.ts';
export { urlIdentity } from './csv.ts';
export { resolveCompanyKey, interimCompanyKey, isPlaceholderCompany, keysForCompany, howMatched, whyNotCounted, type CompanyKeyFn, } from './company.ts';
export { readTitle, type Seniority, type Field, type TitleFacts } from './titles.ts';
export { scoreContact, RANK_POINTS } from './rank.ts';
export { profileSummary, draftFacts, draftMessages, checkDraft, redactContactDetails, cleanDraftText, templateDraft, draftFromTemplate, SHORT_CHAR_LIMIT, LONG_CHAR_LIMIT, type DraftFacts, type DraftVariant, } from './draft.ts';
export { NetworkError, followUpReminderText, type NetworkContactView, type CompanyGroup, type MatchExplanation, type PlanEntry, type ListQuery } from './service.ts';
export { migrateNetwork, openNetworkDatabase, NETWORK_SCHEMA_VERSION } from './db.ts';
export { handleNetworkRoute, NetworkApiError, NETWORK_ROUTES, aiErrorToApi, type NetworkRouteName, type NetworkRouteDeps, type NetworkRouteInput, type AiDestination, } from './routes.ts';
```
<!-- END GENERATED: sig:packages/network -->

Rules: no request to LinkedIn or any people-lookup service, ever; nothing is sent for the person; a draft request
carries only one contact's name, title and company, one job and a short profile summary; delete is real.

| Topic | Contract |
|---|---|
| Wiring (apps/server) | `new NetworkService({ db, companyKey })` on the store's connection, with `companyKey` from `@jobleft/static-data`. Each network route: `handleNetworkRoute(name, { params, query, body }, deps)` after the section 6.1 checks; `NetworkApiError.code` is an `ERROR_CODES` value (`details` and `link` go into the error body). `deps` (`NetworkRouteDeps`): `service`, `job(id)` (JobStore.get), `profileSummary()` (`profileSummary(profile)`), `ai()` (`AiEngine.client()`), `aiDestination()` (`{ provider, label, remote }`: `remote` is false only for a model on this computer), `targets()` (companies of liked, applied and tracked jobs), `offline` |
| Counts on job cards | `networkCount = service.countFor(job.companyKey)` (null = show nothing); a feed page uses `countsFor(keys)` (one cached map). The list behind a count is `listContacts?companyKey=<same key>`: always the same people |
| Matching | A contact counts at a company only when the keys are equal (`companyKey`: case, accents, punctuation, "&", a leading "The" and legal suffixes ignored; ordinary words never dropped). Also: a trailing short form in brackets ("Amazon Web Services (AWS)") matches with and without it. For the Network only (fix round JL-network-2): a web ending glued to a name of 3+ letters ("Gong.io") and a trailing "Global" or "Platforms" after the legal suffix ("Coinbase Global, Inc.") are left out, and names of one family in `@jobleft/static-data`'s reviewed alias table ("EY" and "Ernst & Young LLP", "Palantir" and "Palantir Technologies") share one key; every lookup (`countFor`, `listContacts?companyKey=`, coverage, rank, explain) puts the key in its family first, so a card, the Companies tab and the list behind them agree. Blank and placeholder companies ("Self-employed", "Stealth Startup", "N/A") have no key and match no job. `explain()` lists near names that are NOT counted, with the reason |
| Identity across imports | The profile link (lower case, no query, no trailing slash); rows with no link, or whose old link is gone from the new file, match by name and Connected On. Stages, notes, dates and plan survive a re-import; people missing from a newer file are kept, flagged `inLatestFile: false`, and counted in `missingFromFile` |
| Ranking points | `RANK_POINTS`: recruiter 30, same field as the job 20, manager-level in that field +10, seniority 1 to 8, connected within a year 10 (3 years 6, 7 years 3), email in the file 5, not in the latest file -5. Ties: last name, first name, id. Every reason quotes the title or the date from the file |
| Drafts | `draftOutreach` sends only `draftMessages(draftFacts(...))`; `checkDraft` flags a wrong greeting, shared-past, school, talk and referral claims, numbers, names, schools, companies or titles that are not in the inputs, placeholders, emails, links and length (short limit 300, long 1200). A draft with warnings has `ready: false`. A remote provider (`aiDestination().remote`) answers 409 `conflict` with `details.needsConfirmation` until the person confirms once per destination (`confirmRemote: true`). `template: true` builds a plain draft from the inputs with no AI. No draft is stored |
| Reminders | `takeReminders(today)` returns due follow-ups not yet reminded for their date and marks them; the server keeps ONE unread `Notification` (kind `follow_up`, no names: notification centres keep copies outside the data folder) that says how many follow-ups are due now (`followUpReminderText`): a newly due follow-up replaces it, a follow-up done, moved or deleted changes its number in place, and it goes when none is due. The People filter `stage=follow_up_due` also matches a follow-up date of today or earlier. "Today" is the person's own calendar date (`JOBLEFT_TZ`, else the system zone) through `nowMs()` |
| CLI | `node packages/network/src/cli.ts <command>` (`jobleft-network`): `import`, `status`, `list`, `show`, `companies`, `count`, `explain`, `rank`, `coverage`, `plan`, `stage`, `note`, `follow-up`, `due`, `remind`, `ai`, `preview`, `draft`, `delete`, `delete-all`, `jobs`, `profile`, `serve`, `mock-ai`, `fixture`, `bench` |
| Dev server | `serve` runs the network routes plus stand-in routes under `/api/v1/network-dev/` (jobs and likes, profile, AI address, status, reminder check) and the Network screens, with the section 6.1 rules, on 127.0.0.1:47841 to 47850. Its AI client is interim (`src/dev/ai-bridge.ts`, OpenAI-style, loopback addresses only) until apps/server passes `AiEngine.client()`. Until `@jobleft/static-data` is built in the same checkout, `resolveCompanyKey()` uses an interim key written to the rules above; the service rebuilds stored keys when the key function changes |

### `@jobleft/server` (apps/server)

Status: **Built** (server lane). Purpose: the local HTTP server that enforces section 6.1 and wires every package.
Owns: tables `pairings`, `srv_kv`, `srv_notifications` and the interim `srv_*` tables (section 3); routes `health`,
`getSettings`, `putSettings`, `backup`, `restore`, `exportAll`, `deleteAllData`, `listNotifications`,
`ackNotification`, `devClock`, `pairingCode`, `pair`, `listPairings`, `deletePairing`, `unpair`, `extensionStatus`,
`fill`, `review`; the scripts `pnpm app:up` and `pnpm app:down`. How to run it: `apps/server/README.md`.

| Export (`apps/server/src/index.ts`) | What |
|---|---|
| `resolveHome(env?, platform?)`, `homeLayout(home)`, `newLaunchToken()` | The data folder and its paths; a fresh 32-byte base64url token |
| `startServer(opts: ServerOptions): Promise<RunningServer>` | `ServerOptions { home, port?, launchToken, uiDir?, dev?, parentPid?, offline?, env?, secrets?, onStop? }`; `RunningServer { port, origin, uiUrl, close() }`. Throws `AlreadyRunningError` (another live server on the folder) or `DataFolderError` (`kind`: newer, read_only, full, not_jobleft, upgrade_failed; nothing was changed) |
| `SERVER_SCHEMA_VERSION`, `APP_VERSION`, `readRunFile(path)`, `memorySecrets()` | Schema version of the server's tables (2), the app version, the run file reader, a test secret store |

Entry point: `node apps/server/src/main.ts [--home <dir>] [--port <n>]` (reads section 4; `--home` and `--port` win over
`JOBLEFT_HOME` and `JOBLEFT_PORT`; `--help` and `--version` print and exit 0; any other argument prints the usage and
exits 1 before any folder is touched; exit codes 0 stopped, 1 could not start, 2 data folder refused and untouched,
3 already running). It prints the UI address and the token unless `JOBLEFT_QUIET=1`, and stops cleanly within 5 s on
SIGTERM, SIGINT or SIGHUP, and within 10 s after `JOBLEFT_PARENT_PID` is gone. A request with two `Host` lines answers
`400`; a request target that is not a plain path (`//x`, `*`, a full URL) answers `404`. Keys that a body's contract
does not declare are dropped before anything is stored (also keys such as `constructor` or `toString`).

CLI (`node apps/server/src/cli.ts`): `seed-jobs --home <dir> --count <n>` (synthetic jobs for speed tests),
`fixture --home <dir> --schema 1|future` (an older or a newer data folder with the test persona, for upgrade tests),
`counts --home <dir>` (count per kind, read-only); these three refuse to run while a server uses the folder.
`api-counts --home <dir>` needs the server RUNNING: it reads the count per kind through the API (token from
`run/server.json`) and the SHA-256 of each uploaded resume file as `exportResume` serves it; it changes nothing.
Test stand-ins: `node apps/server/scripts/mock-servers.ts --dir <dir>` (job boards from an editable JSON file, an
OpenAI-compatible AI server, a publik stand-in; every request logged).

Wiring in this build: the crawl tables through `new Store(homeLayout(home).db)` (@jobleft/crawler, Built), a second
connection in a worker thread for crawls (so a board's write transaction never delays an answer), `SOURCES` from
@jobleft/crawler. The routes of the store, resume, network, boards, sources-other and ai-engine lanes are answered by
INTERIM stand-ins in `apps/server/src/interim/` (tables `srv_*`); the routes whose lanes have no stand-in answer
`503 not_ready` with a plain sentence. Interim `exportResume`: an uploaded resume answers its own uploaded file, byte
for byte, when `format` matches the upload's type (`pdf` for a PDF, `docx` for a Word file); a rendered export is the
resume lane's and answers `503 not_ready` until it lands. Interim `addExternalJob` with pasted text reads only labelled
lines (`Company:`, `Location:`, `Workplace:`, `Employment type:`, `Department:`, `Posted:`); a date without a time
(pasted, or JSON-LD `datePosted`) is stored at 12:00 UTC of that day. The crawl uses the built-in `SOURCES` through
(removed: the app crawls through `@jobleft/sources-ats`, whose adapters keep a board's cents; `exact-sources.ts` was a dead stand-in) and
hides Greenhouse `updated_at` so a job without `first_published` keeps `postedAt: null`; it goes away when the crawler
lane's adapters land. A JSON body that is not UTF-8 or holds a lone UTF-16 surrogate answers `400 bad_request`.
At integration each lane's package replaces its stand-in
(`apps/server/README.md`, section 13).

Backup format (route `backup`): one zip. `manifest.json` (`format: "jobleft-backup"`, `formatVersion: 1`, app version,
schema versions, count per kind, and the size and SHA-256 of every other file), `data/jobleft.db` (a consistent copy
by SQLite's online backup, with `pairings` emptied and free pages wiped), and every file under `files/` except
`files/exports/`. The zip comment is `jobleft-backup v1 sha256=<hex>`: the SHA-256 of every byte before the comment.
Restore refuses a missing or wrong seal, unsafe names (`..`, absolute, backslash, control characters), links,
encryption, ZIP64, duplicates, a file not in the manifest, a size, CRC-32 or SHA-256 mismatch, a database that fails
`PRAGMA integrity_check`, and a newer schema; then it moves `data/` and `files/` aside, moves the backup in, opens it
(upgrading an older one), keeps this computer's pairings, and moves the old folders back on any failure.

The server's own page (`apps/server/ui-fallback/`, served at `/` when there is no built UI): data folder, count of
records, pairing with the 6-digit code and the list of paired extensions with Unpair, backup, restore, export, delete
everything. It keeps only the launch token, in `sessionStorage`.

`apps/server/jobsync/` is a fork of jobsync (MIT, 527333e) with the four spike S3 patches applied and its pages and
API routes removed. It is not run or served; it is the port source (`apps/server/jobsync/JOBLEFT-FORK.md`).

### `@jobleft/ui` (apps/ui)

Status: skeleton (`SCREENS`, `takeTokenFromFragment` Built). Purpose: the desktop UI, React and Ant Design 5, built by
Vite into `apps/ui/dist`, served by the server at `/`. It uses `createLocalApiClient` with the launch token from the URL
fragment (then removes it from the address bar; keeps it in memory or `sessionStorage`, never in a URL or a cookie).
It bundles every font and icon (nothing loads from the internet). Screens: `SCREENS` in `apps/ui/src/index.ts`. Parity
targets: `~/jobright-research/ui/UI-SPEC.md` and `UI-SPEC-LOGGED-IN.md` (layout and behaviour only: own brand, own
copy, own icons; no Jobright name, logo, copy or images; money is "balance" in dollars). Job text renders as text.

### `@jobleft/extension` (apps/extension)

Status: **Built** (extension lane). Purpose: the Chrome MV3 autofill extension (assisted apply) and the pure answer
engine the app uses to answer it. README: `apps/extension/README.md` (what it reads, how to run it, what you see).

| Part | What |
|---|---|
| Manifest | permissions `storage`, `activeTab`, `scripting`; host permissions `http://127.0.0.1:47821/*` to `http://127.0.0.1:47830/*` only (narrower than the foundation's `http://127.0.0.1/*`); extension-page CSP `connect-src http://127.0.0.1:*` (an app on another port, typed at pairing, is reached through the app's CORS answer for the extension Origin; the code talks to the paired port only, `src/appclient.ts`); no content scripts declared (the content script is injected only after the person clicks); no web-accessible resources |
| Node exports (`src/index.ts`) | `answerFill`, `openQuestions` (the app's `fill` and `drafts` logic), `classify`, `isSensitive`, `SENSITIVE_TOPICS`, `pickOption`, `pickMany`, `parseDegree`, `templateDraft`, `contactLeaks`, `pageKey`, `isNeverHost`, `supportFromUrl`, `supportFor`, `atsFromUrl`, `APP_PORTS`, `ATS_SUPPORT`, `NEVER_HOSTS`, `EXTENSION_PROTOCOL_VERSION`; types `AnswerContext`, `ResumeFile`, `Classification`, `Topic`, `SensitiveTopic`, `MatchKind`, `Opt`, `DraftJob`, `SupportInfo`, `SupportLevel` |
| Browser bundles | `src/background.ts` (service worker, the only network code), `src/popup.ts`, `src/content/main.ts`; built by `pnpm --filter @jobleft/extension build` into `apps/extension/dist` (not committed; esbuild, not minified; only the contracts the extension runs are bundled) |
| Test tools (not shipped) | `scripts/standin-app.ts` (a stand-in app with the extension routes and section 6.1 rules, no outbound request), `scripts/practice-server.ts` (practice pages with a submit/next/page-change log), `scripts/e2e.ts` (headless Chrome end-to-end checks), `scripts/record-fixture.ts` (polite saved copies of public application pages) |
| Commands | `test`, `typecheck`, `build`, `standin`, `practice`, `e2e`, `record` (all `pnpm --filter @jobleft/extension <name>`) |
| Data files | `fixtures/practice/*.html` (hand-made), `fixtures/recorded/*.html` and `fixtures/recorded/sources.json` (saved copies and their sources) |
| Environment | `JOBLEFT_HOME` (stand-in data folder; default `<repo>/.jobleft-dev/extension-standin`), `JOBLEFT_CHROME` (the Chrome binary for e2e) |

<!-- BEGIN GENERATED: sig:apps/extension -->
```ts
import { EXTENSION_PROTOCOL_VERSION } from '@jobleft/contracts';
import type { AtsId } from '@jobleft/contracts';
export { EXTENSION_PROTOCOL_VERSION };
/** The ports the app tries first. The extension does not scan them: it talks only to the port typed with the pairing code. */
export declare const APP_PORTS: readonly number[];
/**
 * Support level the popup shows before a fill (extension O13). Greenhouse, Lever, Ashby and Workable are supported.
 * Workday is partial (last). iCIMS is partial: no iCIMS form could be tested (no live iCIMS requests are allowed).
 */
export declare const ATS_SUPPORT: Readonly<Partial<Record<AtsId, 'supported' | 'partial'>>>;
/** Hosts where the extension never reads, fills or adds anything (every country domain and subdomain too). */
export declare const NEVER_HOSTS: RegExp;
export { answerFill, openQuestions } from './answer.ts';
export type { AnswerContext, ResumeFile } from './answer.ts';
export { classify, isSensitive, SENSITIVE_TOPICS } from './classify.ts';
export type { Classification, SensitiveTopic, Topic } from './classify.ts';
export { pickOption, pickMany, parseDegree } from './options.ts';
export type { MatchKind, Opt } from './options.ts';
export { templateDraft, contactLeaks } from './drafts.ts';
export type { DraftJob } from './drafts.ts';
export { pageKey } from './pagekey.ts';
export { isNeverHost, supportFromUrl, supportFor, atsFromUrl } from './support.ts';
export type { SupportInfo, SupportLevel } from './support.ts';
```
<!-- END GENERATED: sig:apps/extension -->

No Chrome Web Store submission (gate G-store).

### `@jobleft/shell` (apps/shell)

Status: Built (2026-09-25, gate 8): the Tauri v2 shell in `apps/shell/src-tauri` (Rust: sidecar start, ready wait,
one window, menu bar item, single instance, notifications through Notification Center, clean quit on menu/Cmd-Q/SIGTERM)
with the Node server as a sidecar: the official Node 24 binary beside the executable and the server tree (transpiled
to JavaScript by `apps/shell/scripts/pack.ts`) under `Resources/server`. `pnpm --filter @jobleft/shell app:build`
makes an unsigned debug `jobleft.app`; `apps/shell/README.md` has the layout and the test hooks. Section 5.2 is its
contract. The menu bar's "Pause checks" is the optional `crawl.paused` app setting (added 2026-09-25).
Builds use `CARGO_TARGET_DIR=<main checkout>/.cache/cargo-target`. No signing or notarizing in lanes
(gate G-release). If WKWebView rendering fails the visual check (plan section 6), the fallback is Electron with the
same server.

## 9. Outbound hosts (the complete list)

The app contacts only these hosts, and only for these reasons. Anything else is a bug.

| Host | Why | When |
|---|---|---|
| Approved public ATS APIs: `boards-api.greenhouse.io`, `api.lever.co`, `api.eu.lever.co`, `api.ashbyhq.com`, `apply.workable.com`, `<board>.recruitee.com`, `<board>.jobs.personio.de`, `<board>.jobs.personio.com`, `<board>.teamtailor.com`, `<board>.na.teamtailor.com`, `api.gem.com` | Job boards | Crawls; 1 request per second per host; robots.txt obeyed |
| Hosts of links the person pastes (careers pages, job pages) | Resolve a board or read an added job | On the person's action only; same polite client |
| Board pages of the providers (`jobs.lever.co`, `jobs.eu.lever.co`, `jobs.ashbyhq.com`) and the Greenhouse board endpoint (`boards-api.greenhouse.io/v1/boards/<token>`) | The employer name a board reports, when its job list has none | On a paste of a board that is not in the directory; same polite client |
| Approved non-ATS feed hosts (sources-other): `remoteok.com`, `www.themuse.com` (with the person's key), `hn.algolia.com`, `raw.githubusercontent.com` | Job feeds | Only when that source is on; never `remotive.com` or `data.usajobs.gov` (robots.txt) |
| The fit model host (`JOBLEFT_MODEL_BASE_URL`) | Download bge-small-en-v1.5 once | First fit indexing; never on every launch |
| The dataset release host (`JOBLEFT_DATASET_MANIFEST_URL`) | Newer H-1B, place or directory data | When the person updates, or a stated schedule |
| Free company-fact sources (Wikidata, SEC, GLEIF) | Company facts | When a company block is opened and its kept facts expired |
| The AI provider the person chose | AI answers | Only for AI steps |
| publik (`JOBLEFT_PUBLIK_BASE_URL`) | AI through publik, wallet, metered fetch and search | Only when the person chose publik, or turned metered fetch on |

No telemetry, no crash reporter, no analytics, no update check that sends an identifier.

## 10. Never-crawl hosts

Refused before any request, in code (`forbiddenHostOf` in `packages/crawler/src/hosts.ts`, applied by `HttpClient`),
also as redirect targets and in pasted links: LinkedIn (`linkedin.com`, `licdn.com`, `lnkd.in`), Indeed, Glassdoor,
SmartRecruiters (`smartrecruiters.com`, `smrtr.io`). Held back until the owner approves (refused by default; a family
is allowed only through `HttpOptions.allowHeldBack` in code): Workday (`myworkdayjobs.com`, `myworkdaysite.com`,
`workday.com`), iCIMS (`icims.com`), Oracle Recruiting (`oraclecloud.com`, `taleo.net`), UKG (`ultipro.com`,
`ukg.com`, `ukg.net`), Taleo (`taleo.net`). Recognising them from a URL for autofill sends no request. This computer
and the local network are refused too (by address, by name, and at connect time), except a loopback mock server named
by `JOBLEFT_HOST_MAP` or a board `origin`. Redirects are never followed automatically. The sources-ats lane refuses
the same hosts in `neverContactHost` (`@jobleft/sources-ats`), which its `politeFetch` wrapper and `classifyUrl` use. sources-other refuses the same hosts in `NEVER_CRAWL` (`packages/sources-other/src/http.ts`) and also refuses every host that is not on the source's own list.

## 11. Testing conventions

- Unit tests: `node --test "test/*.test.ts"` in each package (`pnpm test` runs all). No test makes a live request.
- Mock servers run on loopback and log every request (time, path, headers, body). Point the crawler at them with `JOBLEFT_HOST_MAP` or a board `origin` (the crawler's mock-board kit: `packages/crawler/testkit/mock-boards.ts`), publik with `JOBLEFT_PUBLIK_BASE_URL`, AI with a loopback custom provider URL, the model and datasets with their base URLs.
- Time-skip: `JOBLEFT_NOW` or `JOBLEFT_CLOCK_OFFSET` (every Node package reads time through `nowMs()`), or `--now` on the crawl CLI, or `POST /api/v1/dev/clock` with `JOBLEFT_DEV=1`.
- Data folder for a test: `JOBLEFT_HOME=/private/tmp/<something>`. Delete it at the end.
- Live requests (only when a lane's plan approves them): public ATS, job and open-data endpoints, at most 1 per second per host, robots.txt obeyed, at most 1,500 per agent, User-Agent `jobleft-build/0.1 (research build; no personal data)`.
- Browser tests: headless Chrome (`/Applications/Google Chrome.app`) with a scratch profile. Never the person's own Chrome.
- Probes and evaluation sets: `evals/` (see `evals/README.md`). Source research notes: `docs/sources/`.

## 12. Decisions made by the foundation (the owner can overturn them)

| # | Decision | Why |
|---|---|---|
| 1 | The server is a new plain Node server (`node:http`, no framework), not the running jobsync Next.js fork. jobsync code (MIT) is ported piece by piece, with notices | One small process, no Next build, no Prisma engines to sign, and the security rules of section 6.1 in one place. Spike S3's findings (sidecar, SQLite in the data folder) still hold |
| 2 | The UI is a Vite React SPA with Ant Design 5, served by the local server | Plan I9 names Ant Design 5; one origin for the window keeps the Origin rule simple |
| 3 | SQLite through `node:sqlite` for everything; no Prisma | Built into Node 24; spike S1 and S2 used it; no native module |
| 4 | Contracts are one builder that yields types, JSON Schemas and validators | One definition cannot drift from itself |
| 5 | The launch token rides in the URL fragment and a header; the port range is fixed (47821 to 47830) | The app comes back on the same port after a restart, so the paired extension (bound to that port) finds it; the fragment never reaches a server |
| 6 | Other feeds and added jobs live in the crawler's `jobs` table (`feed:<id>`, `external`) | One search index; one dedupe spine |
| 7 | TypeScript 7.0.2 (native) for type checks | Fast; no JS API is needed. If a lane needs the TypeScript JS API, pin 6.x in that package and say why |

Server lane note (2026-09-25): the lane plan said "fork jobsync into apps/server". Decision 1 above wins for what
runs: the server is plain `node:http`. The fork is kept, patched and tested, in `apps/server/jobsync/` as the port
source, and nothing in it is served.

Open items for the owner: the release location for dataset updates (`JOBLEFT_DATASET_MANIFEST_URL`); a project
contact address for the crawler identity (plan section 9); the publik app token (gate G-publik).
