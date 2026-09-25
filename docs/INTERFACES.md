# jobleft interfaces

Version: contracts 1.0.0, local API v1, extension protocol v1. Written by the foundation commit, 2026-09-25.

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
| `backups/` | Backup files the person asks for | server |
| `logs/` | Logs with no personal data, no keys, no tokens, no resume or chat text | server |
| `tmp/` | Temporary files; emptied at start and after each step | every Node package |
| `run/server.json` | `{ pid, port, token, version, startedAt }`, mode 0600; removed on clean exit | server |
| `run/server.lock` | Single-instance lock (one server per data folder) | server |

Defaults: macOS `~/Library/Application Support/jobleft`, Windows `%APPDATA%\jobleft`, others
`~/.local/share/jobleft`. `pnpm app:up` uses `<repo>/.jobleft-dev` (ignored by git). Tests use a folder under
`/private/tmp`. The folder is created with mode 0700 and files with 0600. `homeLayout(home)` in apps/server
(Built) returns every path.

## 3. The database: one SQLite file, one owner per table

Engine: `node:sqlite` (built into Node; no native module). `openDatabase(path)` in `@jobleft/store` (Built) sets
`page_size = 16384` on a new file (spike S2), then WAL, `synchronous = NORMAL` and `foreign_keys = ON`.

Migrations: each owner creates and changes only its own tables, with forward-only numbered steps recorded in
`schema_migrations(owner TEXT, version INTEGER, applied_at TEXT, PRIMARY KEY (owner, version))`. Each step runs in one
transaction. The server runs the owners in this order at start: crawler, store, boards, static-data, sources-other,
resume, network, ai-engine, server. A database with a version newer than the build knows is refused with a plain
message and left untouched.

| Table(s) | Owner | Notes |
|---|---|---|
| `jobs`, `jobs_fts`, `boards` | crawler | Built (from spike S1). `jobs` holds every stored posting: ATS boards, other feeds (`ats = 'feed:<sourceId>'`) and added jobs (`ats = 'external'`, `board = 'url'` or `'text'`). The crawler lane adds the columns the `Job` contract needs (places, levels, years, remote scope, statements, evidence, source attribution). `boards` is board health |
| `job_sources` | crawler | Planned. Every source that listed a posting (the same posting from two places keeps both credits) |
| `schema_migrations`, `job_vectors`, `job_skills`, `tracker`, `tracker_notes`, `tracker_reminders`, `saved_filters`, `profile`, `chats`, `notifications`, `settings` | store | Planned. `job_vectors`: float16 BLOB per (job id, content hash, model). `settings` is key-value JSON (other packages' small settings go here through `SettingsStore`) |
| `board_prefs`, `crawl_runs`, `crawl_board_reports` | boards | Planned. User boards and choices (follow, hide, disable); crawl run history for the report |
| `company_facts` | static-data | Planned. Facts per company key with source and date |
| `source_state`, `source_runs`, `source_requests`, `source_host_slots`, `feed_postings` | sources-other | Built (migrations 1 and 2). `source_state`: on or off, last run, last problem, 429 wait, ETag, run lease. `source_runs` and `source_requests`: the rolling 24-hour counts (limits survive restarts and hold across processes). `source_host_slots`: the pacer shared by every process. `feed_postings`: each posting as each feed lists it (see "Reading feed jobs" under `@jobleft/sources-other`) |
| `resumes`, `tailor_proposals`, `cover_letters` | resume | Planned |
| `network_contacts` | network | Planned |
| `practice_sessions`, `practice_items` | ai-engine | Planned |
| `pairings` | server | Planned. Extension id, hash of the pairing token, browser, times |

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
| `JOBLEFT_OFFLINE` | server | off | `1` = no outbound request at all (crawl and AI answer `offline`) |
| `JOBLEFT_NOW` | every Node package through `nowMs()` | real time | Freeze the clock (RFC 3339). Time-skip for tests |
| `JOBLEFT_CLOCK_OFFSET` | same | `0` | Run the clock ahead or behind: `72h`, `-30m`, `3d`, `90s`, `1500ms` |
| `JOBLEFT_HOST_MAP` | crawler `hostMapFromEnv()` (Built) | none | JSON map from a real ATS host to a LOOPBACK mock origin, for example `{"boards-api.greenhouse.io":"http://127.0.0.1:4010"}` |
| `JOBLEFT_PUBLIK_BASE_URL` | ai-engine, sources-other | `https://publikhq.com/api/v1` | Lanes and tests MUST point this at a local stand-in. No lane calls publikhq.com |
| `JOBLEFT_SOURCE_KEY_<ID>` | sources-other CLI only | none | A source key for the `jobleft-sources` CLI (for example `JOBLEFT_SOURCE_KEY_THEMUSE`). Read, never saved or printed. The app uses the OS secret store (`SECRET_NAMES.sourceKey(id)`) |
| `JOBLEFT_SOURCE_TIMEOUT_MS` | sources-other CLI | `15000` | Per-request timeout of other-source requests |
| `JOBLEFT_PUBLIK_APP_TOKEN` | ai-engine | none | The publik app token. None exists yet (gate G-publik); without it, connect answers a plain error |
| `JOBLEFT_MODEL_BASE_URL` | ai-engine | the Hugging Face `BAAI/bge-small-en-v1.5` files | Where the fit model is downloaded from, once (tests use a local stand-in) |
| `JOBLEFT_DATASET_MANIFEST_URL` | static-data | none until the owner names the release location | Where newer dataset releases are listed (tests use a local stand-in) |
| `JOBLEFT_LOG_LEVEL` | server | `info` | `error`, `warn`, `info`, `debug`. No level logs personal text, keys or tokens |
| `CARGO_TARGET_DIR` | shell builds | `<main checkout>/.cache/cargo-target` | The one shared Cargo target dir (every worktree uses the main checkout's) |

The User-Agent of every crawl request is fixed in code (`USER_AGENT` in `@jobleft/crawler`):
`jobleft-build/0.1 (research build; no personal data)`. It is never read from the environment, a profile or git.

## 5. Start the whole app

### 5.1 `pnpm app:up` and `pnpm app:down` (development)

Status: placeholders in `scripts/app-up.ts` and `scripts/app-down.ts` (app:up exits 1 with a plain message). The
server lane replaces them. When built, they must do exactly this:

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
| `devClock` | POST | `/api/v1/dev/clock` | launch | server | — | `{ offset?, now? }` | `{ now }` | Time-skip for tests (JOBLEFT_DEV=1 only) |
| `listJobs` | GET | `/api/v1/jobs` | launch | store | `{ q?, sort?, cursor?, limit?, status? }` | — | `JobSearchResponse` | Simple search with the saved default filter |
| `searchJobs` | POST | `/api/v1/jobs/search` | launch | store | — | `JobSearchRequest` | `JobSearchResponse` | Search with the full filter set |
| `getJob` | GET | `/api/v1/jobs/:jobId` | launch | store | — | — | `JobDetail` | One job with company, match, tracker and network count |
| `addExternalJob` | POST | `/api/v1/jobs/external` | launch | sources-other | — | `ExternalJobRequest` | `{ job, tracker }` | Add a job from a URL or pasted text (External tab) |
| `keywordGaps` | GET | `/api/v1/jobs/:jobId/keyword-gaps` | launch | resume | `{ resumeId }` | — | `KeywordGapReport` | Keyword gaps of a resume for a job |
| `listTracker` | GET | `/api/v1/tracker` | launch | store | `{ view, status? }` | — | `TrackerList` | Liked, Applied, External, hidden and closed views |
| `updateTracker` | PATCH | `/api/v1/tracker/:jobId` | launch | store | — | `TrackerPatch` | `TrackerEntry` | Like, hide, set status, notes, reminders |
| `listFilters` | GET | `/api/v1/filters` | launch | store | — | — | `SavedFilter[]` | Saved filters |
| `createFilter` | POST | `/api/v1/filters` | launch | store | — | `{ name, filter, sort, alert? }` | `SavedFilter` | Save a filter |
| `updateFilter` | PUT | `/api/v1/filters/:filterId` | launch | store | — | `{ name, filter, sort, alert? }` | `SavedFilter` | Change a saved filter |
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
| `listContacts` | GET | `/api/v1/network/contacts` | launch | network | `{ companyKey?, stage?, q?, due?, inPlan? }` | — | `NetworkContact[]` | Contacts, filtered |
| `networkCoverage` | GET | `/api/v1/network/coverage` | launch | network | — | — | `CompanyCoverage[]` | Target companies with and without connections |
| `rankContacts` | GET | `/api/v1/network/rank` | launch | network | `{ companyKey, jobId? }` | — | `ContactRank[]` | Who to message first at a company, with reasons |
| `updateContact` | PATCH | `/api/v1/network/contacts/:contactId` | launch | network | — | `{ stage?, note?, followUpOn?, inPlan? }` | `NetworkContact` | Stage, note, follow-up date, plan |
| `deleteContact` | DELETE | `/api/v1/network/contacts/:contactId` | launch | network | — | — | `Ok` | Delete one contact and everything about it |
| `deleteNetwork` | DELETE | `/api/v1/network` | launch | network | — | — | `{ ok, deleted }` | Delete all network data (the user's own file is untouched) |
| `draftOutreach` | POST | `/api/v1/network/contacts/:contactId/draft` | launch | network | — | `{ variant, jobId? }` | `OutreachDraft` | Draft a short message (sends only this contact, this job and a short summary) |
| `getAiSettings` | GET | `/api/v1/ai/settings` | launch | ai-engine | — | — | `AiSettings` | Provider settings (never the key) |
| `putAiSettings` | PUT | `/api/v1/ai/settings` | launch | ai-engine | — | `AiSettingsUpdate` | `{ settings, check }` | Choose a provider; runs the setup check |
| `setAiKey` | PUT | `/api/v1/ai/key` | launch | ai-engine | — | `{ key }` | `AiSettings` | Save the key of the current provider (secret store; only the last 4 characters come back) |
| `deleteAiKey` | DELETE | `/api/v1/ai/key` | launch | ai-engine | — | — | `AiSettings` | Forget the key |
| `checkAi` | POST | `/api/v1/ai/check` | launch | ai-engine | — | — | `ProviderCheck` | Test the provider now |
| `listModels` | GET | `/api/v1/ai/models` | launch | ai-engine | — | — | `{ models }` | Models the provider says it has |
| `chat` | POST | `/api/v1/ai/chat` | launch | ai-engine | — | `ChatRequest` | SSE `ChatStreamEvent` | Chat (streams ChatStreamEvent) |
| `listChats` | GET | `/api/v1/ai/chats` | launch | ai-engine | — | — | `{ id, title, jobId, updatedAt }[]` | Saved conversations (on the laptop) |
| `getChat` | GET | `/api/v1/ai/chats/:chatId` | launch | ai-engine | — | — | `ChatThread` | One conversation |
| `deleteChat` | DELETE | `/api/v1/ai/chats/:chatId` | launch | ai-engine | — | — | `Ok` | Delete a conversation for real |
| `decideProposal` | POST | `/api/v1/ai/proposals/:proposalId` | launch | ai-engine | — | `{ approveActionIds }` | `{ applied, declined }` | Approve some actions of an assistant proposal; the rest are declined |
| `startPractice` | POST | `/api/v1/practice/sessions` | launch | ai-engine | — | `{ jobId }` | `PracticeSession` | Interview practice made for one job |
| `practiceFeedback` | POST | `/api/v1/practice/feedback` | launch | ai-engine | — | `{ sessionId, questionId, answer }` | `{ feedback, sampleAnswer, placeholders }` | Feedback on an answer (no invented achievements; placeholders marked) |
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
<!-- END GENERATED: routes -->

## 7. Extension protocol

Code: `packages/contracts/src/extension.ts` (protocol version 1). Transport: HTTP from the extension's service worker
to the local API. Content scripts never call the app directly.

| Step | Who | What |
|---|---|---|
| Discover | extension | `GET /api/v1/health` on ports 47821 to 47830 until one answers `app: "jobleft"`. Re-discover when a call fails (the port can change between launches) |
| Start pairing | person, in the app | The person clicks "Pair a browser extension". The UI calls `POST /api/v1/extension/pairing-code` and shows a 6-digit code (valid 5 minutes). This click is the approval |
| Pair | extension | The person types the code in the extension popup. `POST /api/v1/extension/pair` with `PairRequest`. The Origin must be `chrome-extension://<extensionId>`. Five wrong codes void the code. The answer `PairResponse` holds the pairing token (the app keeps only its hash) |
| Keep | extension | The token lives only in `chrome.storage.local`. Every later call sends `x-jobleft-pairing` from the same Origin |
| List and unpair | person, in the app | `GET /api/v1/extension/pairings`, `DELETE /api/v1/extension/pairings/:extensionId`. The token stops working at once. The extension can unpair itself with `DELETE /api/v1/extension/pairing` |
| Status | extension | `GET /api/v1/extension/status`: paired, app version, profile completeness |
| Fill | extension | Only when the person starts a fill. The extension lists the visible fields of the application form (never hidden or off-screen fields, never other forms) as `FillRequest`. The app answers `FillResponse`: values from the profile, the resume file to attach, drafts for open questions, and the fields it has no answer for |
| Review | person, then extension | The extension fills, marks each changed field, shows the report (filled, kept, needs you) and offers undo. Drafts go in only when the person accepts each one. The extension never submits and never solves a CAPTCHA |
| Record | extension | `POST /api/v1/extension/review` with `ReviewResult`. `submittedByUser` is true only when the person confirmed they submitted. Then the app marks the job Applied |

What the extension never gets: network contacts, AI keys, the publik key, backups, provider settings. Sensitive
questions (EEO, work authorization, sponsorship, pay expectation, date of birth) stay empty unless the person saved
an answer for them. The extension never reads, fills or adds anything on LinkedIn, Indeed or Glassdoor.
Support levels: Greenhouse, Lever, Ashby, Workable and iCIMS supported; Workday partial (built last); everything
else "not supported" (`ATS_SUPPORT` in apps/extension).

## 8. Packages and apps

### `@jobleft/contracts`

Status: **Built** (18 tests). Purpose: every record that crosses a package boundary, the local API and the extension
protocol. One builder gives each contract its JSON Schema, its TypeScript type and run-time validation.

| Export | What |
|---|---|
| Builder | `str`, `num`, `int`, `bool`, `enm`, `lit`, `arr`, `obj(required, optional)`, `rec`, `nullable`, `union`, `anyValue`, `named`; types `Schema<T>`, `Infer<S>`, `JsonSchema` |
| Validation | `validate(schema, value) -> { ok, value } or { ok: false, issues[] }`, `isValid`, `parse` (throws `ContractError`) |
| Records | `Job`, `JobSummary`, `Pay`, `Place`, `RemoteScope`, `SourceAttribution`, `Company`, `H1bSummary`, `Profile`, `ProfileInput`, `Resume`, `ResumeDocument`, `ImportReport`, `AtsReport`, `KeywordGapReport`, `TailorProposal`, `TruthViolation`, `CoverLetter`, `MatchResult`, `MatchSummary`, `TrackerEntry`, `TrackerPatch`, `NetworkContact`, `NetworkImportSummary`, `ContactRank`, `CompanyCoverage`, `OutreachDraft`, `PublikWallet`, `PublikConnection`, `AiSettings`, `ProviderCheck`, `ChatRequest`, `ChatStreamEvent`, `ActionProposal`, `ChatThread`, `PracticeSession`, `PracticeItem`, `JobFilter`, `JobSearchRequest`, `JobSearchResponse`, `JobListItem`, `SavedFilter`, `BoardEntry`, `BoardResolveResponse`, `SourceInfo`, `CrawlProgress`, `CrawlBoardReport`, `FitIndexStatus`, `DatasetInfo`, `H1bLookup`, `PlaceLookup`, `StorageInfo`, `Notification`, extension messages. Each has a `<Name>Schema` |
| Helpers | `bandFor(percent)` (STRONG 85+, GOOD 70 to 84, FAIR below 70), `summarizeMatch`, `experienceLevelOf(level)`, `formatDollars(micros)` (floors; "<$0.01" for a positive balance under a cent), `nowMs()` and `nowIso()` (time-skip), `parseDuration` |
| Local API | `LOCAL_API`, `RouteName`, `RouteBody<K>`, `RouteQuery<K>`, `RouteResponse<K>`, `matchRoute(method, path)`, `buildPath(path, params)`, `createLocalApiClient(opts)`, `LocalApiError`, headers (`LAUNCH_TOKEN_HEADER` = `x-jobleft-token`, `PAIRING_TOKEN_HEADER` = `x-jobleft-pairing`, `FILE_NAME_HEADER`), `DEFAULT_PORT` = 47821, `PORT_SPAN` = 10, `ERROR_CODES`, `ERROR_STATUS`, `ApiErrorSchema` |
| Interfaces | `Embedder` (`model`, `dims`, `embed(texts)`), `SecretStore` (`get`, `set`, `delete`), `SECRET_NAMES` |
| Registry | `SCHEMAS`, `schemaDocument(name)`, `CONTRACTS_VERSION` |

Data files: `packages/contracts/schemas/<Name>.schema.json` (68 files, generated; `pnpm --filter @jobleft/contracts run gen`).
Details and change rules: `packages/contracts/README.md`.

### `@jobleft/parsers`

Status: **Built** (ported from spike S1, 12 tests). Pure functions only: no network, no clock, no files.

| Export | Signature | Notes |
|---|---|---|
| `htmlToText` | `(html: string) => string` | Blocks become lines, `li` becomes "- ", entities decode, scripts and styles vanish |
| `unescapeEncodedHtml`, `decodeEntities` | `(s: string) => string` | One entity layer, only when encoded tags outnumber live tags |
| `levelFromTitle` | `(title: string) => Level \| null` | Most senior marker wins; non-tech titles work |
| `levelFromDescription` | `(text: string) => Level \| null` | Weak fallback from "N+ years ... experience" |
| `parsePayFromText` | `(text: string) => ParsedPay \| null` | `{ min, max, currency, period }`; conservative |
| `annualize` | `(v: number \| null, period: PayPeriod) => number \| null` | 2,080 hours, 260 days, 52 weeks, 12 months |
| `isUsLocation` | `(location: string, countries?: string[]) => boolean \| null` | Country codes from the API win |
| `isRemoteText` | `(location: string) => boolean` | |

Planned by the parsers lane (names fixed here): `parsePlaces(text): Place[]` (every place, never a default country),
`parseWorkModel(text, fields): { workModel, remoteScope, evidence }`, `parseYearsRequired(text): { min, max, evidence } | null`,
`parseStatements(text): PostingStatements & { evidence }` (sponsorship yes or no, clearance, US citizen only; negations
near and far), `levelsOf(level, years): ExperienceLevel[]`, and evidence for each fact. The crawler lane calls them in
`normalizeJob`.

### `@jobleft/crawler`

Status: **Built** (ported from spike S1: 64 of the 76 tests, plus 5 foundation tests). Purpose: fetch public job
boards politely, normalise, dedupe, store, and close vanished postings only when coverage is proven.

| Export | Signature |
|---|---|
| Types | `Ats` (= contract `CrawlAtsId`), `BoardRef { ats, board, company, region? }`, `RawJob`, `RawPay`, `Job` (alias `CrawledJob`: the normalised crawl row), `BoardStats`, `HttpGetter { getJson(url) }`, `Source`, `SourceRegistry = Partial<Record<Ats, Source>>` |
| `Source` | `{ ats; fullBoardListing: boolean; fetchBoard(board: BoardRef, http: HttpGetter): Promise<RawJob[]>; host?(board): string }` |
| `HttpClient` | `new HttpClient({ fetchImpl?, pacer?, timeoutMs?, maxBodyBytes?, maxRequests?, retries?, retryDelayMs?, respectRobots?, hostMap? })`; `getJson(url)`, `getText(url, accept?)`, `snapshot(host?)`, `isTripped(host)`, `totalRequests`, `stats` |
| Errors | `HttpError`, `BlockedError` (403, 429), `NotFoundError`, `RobotsError`, `DeniedHostError`, `BudgetError`, `HostTrippedError`, `HostMapError` |
| `Pacer` | `new Pacer(intervalMs = 1000, now?, sleep?)`; `wait(host, extraIntervalMs?)` |
| robots | `parseRobots(body, productToken): RobotsRules { allows(pathWithQuery), crawlDelayMs }`, `ALLOW_ALL`, `DISALLOW_ALL` |
| Identity | `USER_AGENT` = `jobleft-build/0.1 (research build; no personal data)`, `PRODUCT_TOKEN` = `jobleft-build` |
| Host map | `checkHostMap(map)`, `hostMapFromEnv(env?)` (loopback targets only; never-crawl hosts refused) |
| Normalise | `normalizeJob(board, raw): Job \| null`, `canonicalizeUrl(url, { stripGhJid? })` (keeps `gh_jid`), `normalizeCompany`, `normalizeTitle`, `dedupHash`, `dedupeBatch`, `partitionNew`, `contentHash`, `cleanText` |
| Lifecycle | `boardQualifies`, `sweepableBoards`, `shouldSweep`, `closeTooBroad`, `emptyFeedShouldClose`, `cooldownFor`, `emptyStats`, constants (`DEFAULT_SWEEP_GRACE_MS` 48 h, `MAX_CLOSE_SHARE` 0.5, `EMPTY_FEED_MIN_STREAK` 3, cooldown 6 h doubling to 24 h) |
| `Store` | `new Store(path, { fts? })`; `upsertJob(job, nowIso)`, `closeUnseenForBoard`, `countUnseenForBoard`, `closeBoardEmpty`, `ensureBoard`, `getBoard`, `isCooledDown`, `recordSuccess`, `recordFailure`, `count`, `search`, `transaction`, `db` |
| `crawl` | `crawl(boards: BoardRef[], { store, http, sources?, now?, graceMs?, emptyFeedMs?, onBoard? }): Promise<RunReport>`. A board whose ATS has no adapter fails with a reason and sends nothing |
| Adapters | `SOURCES` (greenhouse, lever, ashby), `greenhouse`, `lever`, `ashby`, `mapGreenhouse`, `mapLever`, `mapAshby`, `hostFor(ats, region?)`, `PAY_QUERY`, helpers in `sources/util.ts` |

CLI `jobleft-crawl` (`packages/crawler/src/cli.ts`): `crawl --boards <file> --db <file> --out <file> [--grace-hours 48]
[--max-requests 3000] [--now <RFC 3339>]`, `verify --in <file> --out <file>`, `report --db <file> [--out <file>]`,
`search --db <file> --q <words>`, `probe --url <url> [--key <field>]`. From the root: `pnpm --filter @jobleft/crawler run <command> ...`
(always `run`: `pnpm search` is a pnpm command). Environment: `JOBLEFT_HOST_MAP`.

Planned by the crawler lane: store every `Job` contract fact (section 3), `job_sources`, the retry-after wait on 429
and 503 (instead of stopping at once), conditional requests (ETag, If-Modified-Since), resume of an interrupted run,
per-host concurrency from the scheduler, `feed:<id>` and `external` families, a mock-board kit for tests.

### `@jobleft/sources-ats`

Status: **Stub**. Purpose: Workable, Recruitee and Personio adapters (then more), the ATS source list (crawled or not,
why, checked when), and ATS detection from a URL. Owns: routes marked `sources-ats` (none yet; `listSources` merges its list).

<!-- BEGIN GENERATED: sig:packages/sources-ats -->
```ts
import type { AtsId, CrawlAtsId, SourceInfo } from '@jobleft/contracts';
import type { SourceRegistry } from '@jobleft/crawler';
/** The lane's adapters (workable, recruitee, personio, ...). Merge with @jobleft/crawler SOURCES: { ...SOURCES, ...ATS_SOURCES }. */
export declare const ATS_SOURCES: SourceRegistry;
/** What a URL says about the ATS behind it. Pure string work: it sends no request. */
export interface AtsDetection {
    ats: AtsId;
    /** The board token, when the URL names one. */
    board: string | null;
    region: string | null;
    /** The posting id, when the URL is a single job page (for example a Greenhouse gh_jid). */
    jobId: string | null;
    /** true only for CrawlAtsId families; false for workday, icims, smartrecruiters and the rest. */
    crawlable: boolean;
}
/** Recognises board and job URLs of known ATS families (case, tracking parameters and trailing slashes ignored). */
export declare function detectAts(url: string): AtsDetection | null;
/** The public API host of an ATS board (regional hosts included). */
export declare function atsHost(ats: CrawlAtsId, region: string | null): string;
/**
 * The ATS source list: every family jobleft crawls (with evidence that the feed is public) and every family it does
 * not (with a reason and the date the reason was checked). Status fields are filled by the server at run time.
 */
export declare const ATS_SOURCE_LIST: ReadonlyArray<Omit<SourceInfo, 'enabled' | 'keySet' | 'status'>>;
```
<!-- END GENERATED: sig:packages/sources-ats -->

Rules: every adapter uses only the `HttpGetter` it is given; `fullBoardListing` is true only when one answer is the
whole board (a paged adapter reads every page, and a page failure fails the board); descriptions go through
`htmlToText`; never a request to SmartRecruiters, Workday, iCIMS, Oracle, UKG or Taleo. The server merges
`{ ...SOURCES, ...ATS_SOURCES }`.

### `@jobleft/sources-other`

Status: **Built** (48 tests, no live request). Purpose: non-ATS feeds (each OFF until the person turns it on),
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

Status: **Stub** (`boardId` Built). Purpose: the board directory (at least 3,000 clean rows with a stated licence),
the person's boards and choices, link-to-board resolution, crawl planning and the scheduler. Owns: tables
`board_prefs`, `crawl_runs`, `crawl_board_reports`; routes `crawlStatus`, `crawlRun`, `crawlReport`, `listBoards`,
`resolveBoard`, `addBoard`, `updateBoard`, `exportBoards`.

<!-- BEGIN GENERATED: sig:packages/boards -->
```ts
import type { DatabaseSync } from 'node:sqlite';
import type { BoardEntry, BoardResolveResponse, CrawlAtsId, CrawlBoardReport, CrawlProgress, CrawlRunSummary } from '@jobleft/contracts';
import type { BoardRef, HttpClient, SourceRegistry, Store } from '@jobleft/crawler';
import type { DirectoryRow } from '@jobleft/static-data';
/** "<ats>:<board>" or "<ats>:<region>:<board>", lower case (BoardEntry.id). */
export declare function boardId(ats: CrawlAtsId, board: string, region?: string | null): string;
export declare class BoardDirectory {
    constructor(rows: DirectoryRow[]);
    get size(): number;
    /** Case-, accent- and suffix-insensitive company search; the same entry comes first for "stripe" and "Stripe, Inc.". */
    search(q: string, limit?: number): DirectoryRow[];
    get(id: string): DirectoryRow | undefined;
}
export interface BoardServiceOptions {
    db: DatabaseSync;
    directory: BoardDirectory;
    /** The polite client: every paste and every refresh shares its pacer (1 request per second per host). */
    http: HttpClient;
    sources: SourceRegistry;
    now?: () => number;
}
export declare class BoardService {
    constructor(opts: BoardServiceOptions);
    list(q: {
        q?: string;
        view?: 'all' | 'followed' | 'user' | 'hidden' | 'disabled' | 'failing';
        cursor?: string;
        limit?: number;
    }): {
        items: BoardEntry[];
        total: number;
        nextCursor: string | null;
    };
    /** What board is behind a link. Adds nothing. Never contacts a never-crawl host. */
    resolve(url: string, opts?: {
        acceptPaidLookup?: boolean;
    }): Promise<BoardResolveResponse>;
    /** Adds a confirmed board. Throws a conflict when it is already in the list. */
    add(input: {
        ats: CrawlAtsId;
        board: string;
        region?: string | null;
    }): BoardEntry;
    update(id: string, patch: {
        followed?: boolean;
        hidden?: boolean;
        disabled?: boolean;
    }): BoardEntry;
    /** NDJSON lines of the directory and the user boards (GET /api/v1/boards/export). */
    export(): Iterable<string>;
    /** The boards due for a crawl now (not hidden, not disabled, not in back-off), spread so they do not all start at once. */
    due(now: number, opts: {
        intervalHours: number;
        catchUp: boolean;
    }): BoardRef[];
}
export interface SchedulerOptions {
    boards: BoardService;
    crawlStore: Store;
    http: HttpClient;
    sources: SourceRegistry;
    intervalHours: () => number;
    now?: () => number;
    /** Called after each board and at the end, so new jobs are findable at once. */
    onProgress?: (p: CrawlProgress) => void;
}
/** Runs crawls: a catch-up on launch, then every intervalHours while the app or the tray runs. */
export declare class CrawlScheduler {
    constructor(opts: SchedulerOptions);
    start(opts: {
        catchUp: boolean;
    }): void;
    stop(): Promise<void>;
    runNow(boardIds?: string[]): {
        started: boolean;
        message: string;
        nextAllowedAt: string | null;
    };
    progress(): CrawlProgress;
    lastReport(): {
        run: CrawlRunSummary | null;
        boards: CrawlBoardReport[];
    };
}
```
<!-- END GENERATED: sig:packages/boards -->

Rules: every resolve request goes through the shared `HttpClient` (one pacer for pastes and refreshes); an employer
name comes from the board or the directory, never a guess; a failing board is backed off and re-checked on a stated
date; a directory update never removes or renames a person's boards. CLI (planned): `jobleft-boards list|export|resolve <url>`.

### `@jobleft/store`

Status: **Stub** (`openDatabase`, `makeJobId` Built). Purpose: the one database, job search and fit indexing, and the
person's records. Owns: the tables in section 3; routes `storage`, `exportJobs`, `listJobs`, `searchJobs`, `getJob`,
`listTracker`, `updateTracker`, `listFilters`, `createFilter`, `updateFilter`, `deleteFilter`, `getProfile`,
`putProfile`, `fitIndexStatus`.

<!-- BEGIN GENERATED: sig:packages/store -->
```ts
import { DatabaseSync } from 'node:sqlite';
import type { AppSettings, ChatThread, Embedder, FitIndexStatus, Job, JobSearchRequest, JobSearchResponse, Notification, Profile, ProfileInput, SavedFilter, StorageInfo, TrackerEntry, TrackerList, TrackerPatch, TrackerStatus, TrackerView } from '@jobleft/contracts';
import type { H1bIndex, PlaceIndex } from '@jobleft/static-data';
/**
 * Opens (or creates) the database. A new file gets `page_size = 16384` before any table (spike S2), then WAL,
 * `synchronous = NORMAL` and `foreign_keys = ON`. Migrations are the store lane's (see migrate()).
 */
export declare function openDatabase(path: string): DatabaseSync;
/**
 * Runs the store's migrations (forward only, one transaction each, recorded in `schema_migrations`).
 * A newer file than this build knows is refused with a plain error and left untouched (server O12).
 */
export declare function migrate(db: DatabaseSync): {
    from: number;
    to: number;
};
/** The contract job id of a crawled posting: "<ats>:<board>:<externalId>", lower-case ATS and board. */
export declare function makeJobId(ats: string, board: string, externalId: string): string;
export interface SearchContext {
    /** The profile vector for Top Matched; null = no profile (the answer says fit needs a profile). */
    profileVector: Float32Array | null;
    h1b: H1bIndex;
    places: PlaceIndex;
    now: number;
}
/** Reads jobs (crawler tables + the store's side tables) as contract Jobs. */
export declare class JobStore {
    constructor(db: DatabaseSync);
    get(id: string): Job | null;
    /** Search with words, filters and a sort. Closed, hidden and duplicate jobs never appear or count. */
    search(req: JobSearchRequest, ctx: SearchContext): JobSearchResponse;
    /** Saves a job added by URL or text (External tab). Returns the stored job. */
    saveExternal(job: Job): Job;
    /** NDJSON lines of saved jobs with their source credits (GET /api/v1/export/jobs). */
    exportSaved(): Iterable<string>;
    storage(dbPath: string, dataDir: string): StorageInfo;
}
export declare class TrackerStore {
    constructor(db: DatabaseSync);
    get(jobId: string): TrackerEntry | null;
    list(view: TrackerView, status?: TrackerStatus): TrackerList;
    /** Applies a patch in one transaction (status and its history entry together). */
    patch(jobId: string, patch: TrackerPatch, now: number): TrackerEntry;
}
export declare class FilterStore {
    constructor(db: DatabaseSync);
    list(): SavedFilter[];
    create(input: Pick<SavedFilter, 'name' | 'filter' | 'sort'> & {
        alert?: boolean;
    }, now: number): SavedFilter;
    update(id: string, input: Pick<SavedFilter, 'name' | 'filter' | 'sort'> & {
        alert?: boolean;
    }, now: number): SavedFilter;
    delete(id: string): boolean;
}
export declare class ProfileStore {
    constructor(db: DatabaseSync);
    /** The one profile (an empty one on a fresh install). */
    get(): Profile;
    /** Replaces the editable part; the store sets version and updatedAt. */
    put(input: ProfileInput, version: string, now: number): Profile;
}
export declare class ChatStore {
    constructor(db: DatabaseSync);
    list(): Array<Pick<ChatThread, 'id' | 'title' | 'jobId' | 'updatedAt'>>;
    get(id: string): ChatThread | null;
    append(id: string | null, message: ChatThread['messages'][number], meta: {
        jobId: string | null;
        now: number;
    }): ChatThread;
    delete(id: string): boolean;
}
export declare class NotificationStore {
    constructor(db: DatabaseSync);
    add(n: Omit<Notification, 'id' | 'createdAt'>, now: number): Notification;
    pending(): Notification[];
    ack(id: string): boolean;
}
export declare class SettingsStore {
    constructor(db: DatabaseSync);
    get(): AppSettings;
    put(s: AppSettings): AppSettings;
    /** Key-value rows for other packages' small settings (for example the key-free AI settings). */
    getJson<T>(key: string): T | null;
    setJson(key: string, value: unknown): void;
}
/** Fit indexing: vectors per (job content hash, model). Never repeats work on an unchanged job (store O10). */
export declare class FitIndex {
    constructor(db: DatabaseSync, embedder: Embedder | null);
    status(): FitIndexStatus;
    /** Embeds up to `limit` waiting jobs (newest first, those that pass the user's hard filters first). */
    runOnce(limit?: number, signal?: AbortSignal): Promise<{
        indexed: number;
    }>;
    /** Embeds the profile text for Top Matched. */
    profileVector(text: string): Promise<Float32Array>;
}
```
<!-- END GENERATED: sig:packages/store -->

Search method (spike S2): filter columns in typed arrays in RAM, filter first, brute-force cosine over float32 vectors
expanded from float16 BLOBs, FTS5 with `FROM jobs_fts CROSS JOIN jobs` for words, top 50 fetched by id. Words keep
`C++`, `C#`, `.NET`, `401(k)`; operator words and quotes are treated as words, never as syntax errors. Most Recent sorts
by the posted date (unknown dates last), never by first seen. Ties break by job id, so the order is stable.
CLI (planned): `jobleft-store import-jobs <file.ndjson>` (the documented import path for known job sets),
`jobleft-store seed --synthetic <n>`, `jobleft-store stats`, `jobleft-store vacuum`.

### `@jobleft/static-data`

Status: **Stub**. Purpose: the shipped datasets and lookups, `companyKey`, and company facts. Owns: table
`company_facts`; routes `h1bLookup`, `placeLookup`, `getCompany`, `refreshCompany`, `listDatasets`, `updateDatasets`;
data files in `packages/static-data/data/` (each with a header naming source, date and licence, and an entry in
`THIRD_PARTY_NOTICES.md`).

<!-- BEGIN GENERATED: sig:packages/static-data -->
```ts
import type { DatabaseSync } from 'node:sqlite';
import type { Company, CrawlAtsId, DatasetInfo, H1bLookup, Place, PlaceLookup } from '@jobleft/contracts';
/** Where datasets live. Shipped copies sit in `bundledDir`; updated releases are written to `dataDir`. */
export interface StaticDataOptions {
    /** $JOBLEFT_HOME/datasets (updated releases, verified before use). */
    dataDir: string;
    /** Defaults to this package's data/ folder (the copies that ship with the app). */
    bundledDir?: string;
}
/**
 * The company match key. Lower case; accents removed; "&" and "+" become "and"; a leading "the" and legal suffixes
 * (inc, llc, l.l.c., corp, corporation, co, ltd, llp, plc, pbc, gmbh) are removed; punctuation and spaces are removed.
 * It NEVER removes ordinary words such as "technologies", "group", "services" or "holdings" (static-data O5).
 * Examples: "Stripe, Inc." -> "stripe"; "The Home Depot" -> "homedepot"; "Ramp Business Corporation" -> "rampbusiness".
 */
export declare function companyKey(name: string): string;
/** Brand to legal filer names that are known to be the same company (a reviewed alias table, never a guess). */
export interface CompanyAliases {
    /** The keys of every name known for this company, including the input's own key. */
    keysFor(name: string): string[];
}
export interface H1bIndex {
    /** found with a summary, or unknown. Never a "no" (static-data O2). */
    lookup(companyName: string): H1bLookup;
    dataset(): DatasetInfo;
}
export interface PlaceIndex {
    /** Resolves "Austin, TX", "SF", "Remote - US", "New York, NY; Austin, TX". Unresolved text stays as written. */
    resolve(text: string): PlaceLookup;
    /** Great-circle distance in miles, or null when either place has no coordinates. */
    distanceMiles(a: Place, b: Place): number | null;
    /** Place ids within the radius of a place id (for the "within 25 miles" filter). */
    within(placeId: string, radiusMiles: number): Set<string>;
    dataset(): DatasetInfo;
}
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
export declare function loadAliases(opts: StaticDataOptions): CompanyAliases;
export declare function loadH1bIndex(opts: StaticDataOptions): H1bIndex;
export declare function loadPlaceIndex(opts: StaticDataOptions): PlaceIndex;
export declare function loadSkills(opts: StaticDataOptions): SkillDictionary;
export declare function loadDirectoryRows(opts: StaticDataOptions): DirectoryRow[];
/** Every dataset with its date, licence and attribution (GET /api/v1/data-sources). */
export declare function listDatasets(opts: StaticDataOptions): DatasetInfo[];
/** Downloads, verifies (size and sha256 from the release manifest) and swaps in newer releases. A bad release changes nothing. */
export declare function updateDatasets(opts: StaticDataOptions & {
    releaseManifestUrl: string;
    fetchImpl?: typeof fetch;
}): Promise<DatasetInfo[]>;
/** A paid lookup the facts service may use only when the person allowed it (see @jobleft/sources-other). */
export interface PaidSearch {
    priceMicros(kind: 'search' | 'page'): number;
    search(query: string, opts: {
        maxPriceMicros: number;
        signal?: AbortSignal;
    }): Promise<Array<{
        title: string;
        url: string;
        snippet: string;
    }>>;
}
export interface CompanyFactsOptions {
    db: DatabaseSync;
    h1b: H1bIndex;
    aliases: CompanyAliases;
    /** Free public sources (Wikidata, SEC, GLEIF) through the polite HTTP client. */
    fetchText: (url: string) => Promise<string>;
    /** null = paid lookups are off. */
    paid: PaidSearch | null;
    now?: () => number;
    /** Kept facts expire after this long (default 30 days). */
    freshForMs?: number;
}
/** Company facts, kept per company key in the `company_facts` table (owned by this package). */
export declare class CompanyFacts {
    constructor(opts: CompanyFactsOptions);
    /** The kept company, or a company with no facts (never invented ones). */
    get(key: string): Company;
    /** Reads facts again. A failed refresh keeps the old facts. Paid lookups only with allowPaid and within the cap. */
    refresh(key: string, opts: {
        allowPaid: boolean;
        maxPriceMicros?: number;
    }): Promise<Company>;
    /** Marks every kept fact expired (the documented option to expire kept facts). */
    expireAll(): number;
}
```
<!-- END GENERATED: sig:packages/static-data -->

Rules: H-1B counts are certified H-1B rows only, per filer entity, with the date window and the data date; a missing
company is `unknown`, never "no"; brand-to-filer aliases come from a reviewed table, never from a similarity score;
place and sponsor lookups work offline; company-fact requests carry only what names the company. CLI (planned):
`jobleft-data h1b <company>`, `jobleft-data place <text>`, `jobleft-data build-h1b --lca <files>`.

### `@jobleft/ai-engine`

Status: **Stub** (`AiError`, `memorySecretStore`, constants Built). Purpose: every AI call, the publik connection and
wallet, secrets, embeddings, the assistant and interview practice. Owns: tables `practice_sessions`, `practice_items`;
routes `getAiSettings`, `putAiSettings`, `setAiKey`, `deleteAiKey`, `checkAi`, `listModels`, `chat`, `cancelAi`,
`listChats`, `getChat`, `deleteChat`, `decideProposal`, `startPractice`, `practiceFeedback`, `listPracticeItems`,
`savePracticeItem`, `updatePracticeItem`, `deletePracticeItem`, `getPublik`, `connectPublik`, `disconnectPublik`,
`refreshPublik`.

<!-- BEGIN GENERATED: sig:packages/ai-engine -->
```ts
import type { AiProviderKind, AiSettings, AiSettingsUpdate, ChatMessage, Embedder, JsonSchema, Infer, ProviderCheck, PublikConnection, SecretStore } from '@jobleft/contracts';
/** Version of the two-sentence disclosure shown before the app connects to publik. */
export declare const PUBLIK_DISCLOSURE_VERSION = 1;
/** The compiled default. Tests and development point JOBLEFT_PUBLIK_BASE_URL at a local stand-in. */
export declare const PUBLIK_DEFAULT_BASE_URL = "https://publikhq.com/api/v1";
export type AiErrorCode = 'no_provider' | 'unreachable' | 'timeout' | 'key_refused' | 'model_not_found' | 'not_ai_server' | 'insufficient_balance' | 'provider_error' | 'bad_answer' | 'cancelled';
/** Every provider failure, in plain words. `topUpUrl` is set only for insufficient_balance. */
export declare class AiError extends Error {
    readonly code: AiErrorCode;
    readonly topUpUrl: string | null;
    constructor(code: AiErrorCode, message: string, topUpUrl?: string | null);
}
export type AiChunk = {
    type: 'delta';
    text: string;
} | {
    type: 'done';
    incomplete: boolean;
    costMicros: number | null;
};
export interface AiCompletion {
    text: string;
    incomplete: boolean;
    costMicros: number | null;
    model: string;
}
export interface AiRequest {
    messages: ChatMessage[];
    /** Used to cancel; cancelling stops the upstream request too. */
    requestId?: string;
    maxTokens?: number;
    signal?: AbortSignal;
}
/** One provider, ready to use. Every call ends: a dead provider fails within 10 s, a silent stream after 120 s. */
export interface AiClient {
    readonly provider: AiProviderKind;
    readonly model: string;
    chat(req: AiRequest): AsyncIterable<AiChunk>;
    complete(req: AiRequest): Promise<AiCompletion>;
    /**
     * A structured answer checked against a contract schema. Small models: `lineFallback` parses a plain-text
     * answer. An answer that fits neither throws AiError('bad_answer'); nothing is invented to fill the gap.
     */
    json<S extends JsonSchema>(req: AiRequest & {
        schema: S;
        lineFallback?: (text: string) => Infer<S> | null;
    }): Promise<Infer<S>>;
    listModels(): Promise<string[]>;
}
/** Where AiEngine keeps the (key-free) settings. The server backs it with the store. */
export interface AiSettingsStore {
    load(): AiSettings;
    save(s: AiSettings): void;
}
export interface AiEngineOptions {
    settings: AiSettingsStore;
    secrets: SecretStore;
    /** JOBLEFT_PUBLIK_BASE_URL, else PUBLIK_DEFAULT_BASE_URL. */
    publikBaseUrl: string;
    /** The publik app token (G-publik). null until the owner approves one: connect then answers a plain error. */
    publikAppToken: string | null;
    fetchImpl?: typeof fetch;
    connectTimeoutMs?: number;
    idleTimeoutMs?: number;
}
/** The publik connection: provisioning, wallet, top-up link. The key never leaves the secret store. */
export declare class PublikClient {
    constructor(opts: {
        baseUrl: string;
        appToken: string | null;
        secrets: SecretStore;
        fetchImpl?: typeof fetch;
    });
    status(): Promise<PublikConnection>;
    /** POST /installs after the person accepted the disclosure. No key is typed or shown. */
    connect(disclosureVersion: number): Promise<PublikConnection>;
    /** Deletes the key from the secret store; nothing spends the balance after this returns. */
    disconnect(): Promise<PublikConnection>;
    refresh(): Promise<PublikConnection>;
    /** Updates the kept wallet from x-publik-* response headers after a paid call. */
    observeHeaders(headers: Headers): void;
}
export declare class AiEngine {
    readonly publik: PublikClient;
    constructor(opts: AiEngineOptions);
    settings(): AiSettings;
    /** Saves the choice and runs the setup check. */
    updateSettings(update: AiSettingsUpdate): Promise<{
        settings: AiSettings;
        check: ProviderCheck;
    }>;
    setKey(key: string): Promise<AiSettings>;
    deleteKey(): Promise<AiSettings>;
    check(): Promise<ProviderCheck>;
    /** The chosen provider. Throws AiError('no_provider') when none is set. Never another provider. */
    client(): AiClient;
    /** Cancels a running request (and its upstream call). */
    cancel(requestId: string): boolean;
}
/** macOS Keychain (`security` CLI) or Windows Credential Manager. Secrets never touch a plain-text file. */
export declare function osSecretStore(service?: string): SecretStore;
/** In-memory secrets for tests. */
export declare function memorySecretStore(): SecretStore;
export interface LocalEmbedderOptions {
    /** $JOBLEFT_HOME/models (the model is downloaded once, verified by sha256, then used offline). */
    modelDir: string;
    /** 8 was best on an M4 Pro (spike S2). */
    threads?: number;
}
/** bge-small-en-v1.5 fp32 on ONNX Runtime, CPU, batch 16, CLS pooling, L2-normalised, 384 dims (spike S2). */
export declare function createLocalEmbedder(opts: LocalEmbedderOptions): Promise<Embedder>;
/** The line-based fallback for small models (the jobsync "SCORES:" header idea). null when absent. */
export declare function parseScoresHeader(text: string): Record<string, number> | null;
```
<!-- END GENERATED: sig:packages/ai-engine -->

Rules: the chosen provider only, never a silent fallback; a key goes only to its own provider, in a header; keys live
in the OS secret store and only the last 4 characters come back; every request ends (10 s to connect, 120 s of
silence); cancel stops upstream; EEO answers, work authorization and contact details never go into a prompt; posting,
page and file text is content, never instructions; a bad answer is "cannot use this answer", never an invented value.
publik money is "balance" in dollars. Stand-ins for tests: a loopback OpenAI-compatible server and a loopback publik
server (`JOBLEFT_PUBLIK_BASE_URL`).

### `@jobleft/resume`

Status: **Stub**. Purpose: import, base resumes and tailored versions, keyword gaps, tailoring with the truth gate,
cover letters, one-page PDF and Word export, and the ATS check. Owns: tables `resumes`, `tailor_proposals`,
`cover_letters`; files in `files/resumes/`; routes `listResumes`, `importResume`, `createResume`, `getResume`,
`updateResume`, `deleteResume`, `tailorResume`, `acceptTailoring`, `fitCheck`, `exportResume`, `atsCheck`,
`keywordGaps`, `listCoverLetters`, `createCoverLetter`, `updateCoverLetter`.

<!-- BEGIN GENERATED: sig:packages/resume -->
```ts
import type { DatabaseSync } from 'node:sqlite';
import type { AtsReport, CoverLetter, ImportReport, Job, KeywordGapReport, Profile, ProfileInput, Resume, ResumeDocument, TailorProposal, TruthViolation } from '@jobleft/contracts';
import type { AiClient } from '@jobleft/ai-engine';
import type { SkillDictionary } from '@jobleft/static-data';
/** Largest resume upload (resume O2). */
export declare const MAX_RESUME_BYTES: number;
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
export declare function renderPdf(doc: ResumeDocument): Promise<{
    bytes: Uint8Array;
    pages: number;
    leftOut: string[];
}>;
export declare function renderDocx(doc: ResumeDocument): Promise<Uint8Array>;
/** Grades the exact PDF bytes (same file, same report). */
export declare function atsCheck(pdf: Uint8Array): Promise<AtsReport>;
export interface ResumeServiceOptions {
    db: DatabaseSync;
    /** $JOBLEFT_HOME/files/resumes (uploaded files and exports, inside the data folder only). */
    filesDir: string;
    profile: () => Profile;
    job: (id: string) => Job | null;
    /** The chosen AI provider; throws AiError('no_provider') when none is set. */
    ai: () => AiClient;
    skills: SkillDictionary;
    now?: () => number;
}
/** Owns the tables `resumes`, `resume_versions`, `tailor_proposals` and `cover_letters`. */
export declare class ResumeService {
    constructor(opts: ResumeServiceOptions);
    list(): Resume[];
    import(bytes: Uint8Array, fileName: string, mimeType: string): Promise<{
        resume: Resume;
        proposedProfile: ProfileInput;
    }>;
    create(input: {
        name: string;
        targetTitle?: string;
    }): Resume;
    get(id: string): Resume | null;
    update(id: string, patch: {
        name?: string;
        targetTitle?: string | null;
        isPrimary?: boolean;
        document?: ResumeDocument;
    }): Resume;
    /** Refuses (conflict) to delete a base with versions unless withVersions is true. */
    delete(id: string, withVersions: boolean): string[];
    tailor(resumeId: string, jobId: string): Promise<TailorProposal>;
    accept(resumeId: string, proposalId: string, acceptChangeIds: string[]): Resume;
    fitCheck(resumeId: string): Promise<{
        fitsOnePage: boolean;
        leftOut: string[];
    }>;
    export(resumeId: string, format: 'pdf' | 'docx'): Promise<{
        fileName: string;
        mimeType: string;
        bytes: Uint8Array;
    }>;
    atsCheck(resumeId: string): Promise<AtsReport>;
    keywordGaps(jobId: string, resumeId: string): KeywordGapReport;
    coverLetters(jobId: string): CoverLetter[];
    createCoverLetter(jobId: string, resumeId: string): Promise<CoverLetter>;
    updateCoverLetter(id: string, patch: {
        text?: string;
        instruction?: string;
    }): Promise<CoverLetter>;
}
```
<!-- END GENERATED: sig:packages/resume -->

### `@jobleft/match`

Status: **Stub**. Purpose: the deterministic match score with reasons. Owns: route `getMatch` (results may be cached
by the store, keyed by job content hash, profile version and `ENGINE_VERSION`).

<!-- BEGIN GENERATED: sig:packages/match -->
```ts
import type { Company, Job, MatchResult, Profile } from '@jobleft/contracts';
import type { SkillDictionary } from '@jobleft/static-data';
/** Bump when the scoring rules change; cached results with another version are recomputed. */
export declare const ENGINE_VERSION = "match-0.0.0";
export interface MatchInput {
    profile: Profile;
    job: Job;
    company: Company | null;
    skills: SkillDictionary;
    /** ms since the epoch (for years of experience). */
    now: number;
}
/** The match of one job for the profile. Pure and deterministic. */
export declare function scoreMatch(input: MatchInput): MatchResult;
/** Hash of the profile facts the score reads (MatchResult.profileVersion). EEO answers are not part of it. */
export declare function profileVersion(profile: Profile): string;
/** Years of experience from the work dates (overlaps counted once), or null with no dates. */
export declare function yearsOfExperience(profile: Profile, now: number): number | null;
/** The text of the profile that fit indexing embeds (no contact details, no EEO answers). */
export declare function profileText(profile: Profile): string;
/** The text of a job that fit indexing embeds (title, company, skills and the first part of the description). */
export declare function jobText(job: Job): string;
```
<!-- END GENERATED: sig:packages/match -->

Rules: pure and stable (same inputs, same numbers); free and offline; a part that cannot be judged has
`percent: null` with a reason, never a default; blockers name the posting's own words (for example "US citizenship
required") with evidence; protected traits and names are never inputs; posting text cannot inflate the score.

### `@jobleft/network`

Status: **Stub**. Purpose: the Network tool on the person's own `Connections.csv`. Owns: table `network_contacts`;
routes `importNetwork`, `listContacts`, `networkCoverage`, `rankContacts`, `updateContact`, `deleteContact`,
`deleteNetwork`, `draftOutreach`.

<!-- BEGIN GENERATED: sig:packages/network -->
```ts
import type { DatabaseSync } from 'node:sqlite';
import type { CompanyCoverage, ContactRank, Job, NetworkContact, NetworkImportSummary, OutreachDraft, OutreachStage } from '@jobleft/contracts';
import type { AiClient } from '@jobleft/ai-engine';
export interface ParsedConnection {
    line: number;
    firstName: string;
    lastName: string;
    profileUrl: string | null;
    email: string | null;
    company: string | null;
    position: string | null;
    connectedOn: string | null;
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
}
/** Owns the table `network_contacts`. Deletes are real (rows, drafts, notes; nothing left behind). */
export declare class NetworkService {
    constructor(opts: NetworkServiceOptions);
    /** Imports the file text. Keeps stages and notes of people already there; never drops a person silently. */
    import(csvText: string): NetworkImportSummary;
    list(q: {
        companyKey?: string;
        stage?: OutreachStage;
        q?: string;
        due?: boolean;
        inPlan?: boolean;
    }): NetworkContact[];
    /** How many connections work at a company (null when none, so cards show nothing). */
    countFor(companyKey: string): number | null;
    coverage(targetCompanies: Array<{
        companyKey: string;
        companyName: string;
    }>): CompanyCoverage[];
    rank(companyKey: string, job: Job | null): ContactRank[];
    update(id: string, patch: {
        stage?: OutreachStage;
        note?: string | null;
        followUpOn?: string | null;
        inPlan?: boolean;
    }): NetworkContact;
    delete(id: string): boolean;
    deleteAll(): number;
    /** Contacts whose follow-up date is today or past (for reminders). */
    due(today: string): NetworkContact[];
}
```
<!-- END GENERATED: sig:packages/network -->

Rules: no request to LinkedIn or any people-lookup service, ever; nothing is sent for the person; a draft request
carries only one contact's name, title and company, one job and a short profile summary; delete is real.

### `@jobleft/server` (apps/server)

Status: **Stub** (`resolveHome`, `homeLayout`, `newLaunchToken` Built). Purpose: the local HTTP server that enforces
section 6.1 and wires every package. Owns: table `pairings`; routes `health`, `getSettings`, `putSettings`, `backup`,
`restore`, `exportAll`, `deleteAllData`, `listNotifications`, `ackNotification`, `devClock`, `pairingCode`, `pair`,
`listPairings`, `deletePairing`, `unpair`, `extensionStatus`, `fill`, `review`; the scripts `pnpm app:up` and
`pnpm app:down`.

Exports: `resolveHome(env?, platform?)`, `homeLayout(home)`, `newLaunchToken()`, `startServer(opts: ServerOptions): Promise<RunningServer>`
(`ServerOptions { home, port?, launchToken, uiDir?, dev?, parentPid?, offline?, env? }`,
`RunningServer { port, origin, uiUrl, close() }`). Entry point (planned): `apps/server/src/main.ts`, which reads section 4.
Wiring: `new Store(homeLayout(home).db)` for the crawl tables on the same file as `openDatabase()`; `{ ...SOURCES, ...ATS_SOURCES }`
for adapters; one shared `HttpClient` for every outbound board request; the AI engine's client for resume, network
and assistant work. Backups are zip files of the data folder without secrets; restore refuses damaged or foreign
files and `..` paths.

### `@jobleft/ui` (apps/ui)

Status: skeleton (`SCREENS`, `takeTokenFromFragment` Built). Purpose: the desktop UI, React and Ant Design 5, built by
Vite into `apps/ui/dist`, served by the server at `/`. It uses `createLocalApiClient` with the launch token from the URL
fragment (then removes it from the address bar; keeps it in memory or `sessionStorage`, never in a URL or a cookie).
It bundles every font and icon (nothing loads from the internet). Screens: `SCREENS` in `apps/ui/src/index.ts`. Parity
targets: `~/jobright-research/ui/UI-SPEC.md` and `UI-SPEC-LOGGED-IN.md` (layout and behaviour only: own brand, own
copy, own icons; no Jobright name, logo, copy or images; money is "balance" in dollars). Job text renders as text.

### `@jobleft/extension` (apps/extension)

Status: skeleton (`APP_PORTS`, `ATS_SUPPORT`, `NEVER_HOSTS`, `manifest.json` Built). Purpose: the Chrome MV3 autofill
extension. Manifest: permissions `storage`, `activeTab`, `scripting`; host permission `http://127.0.0.1/*` only;
content scripts are injected on the person's request (`activeTab`), not declared for every site. Protocol: section 7.
Build output: `apps/extension/dist` (not committed). No Chrome Web Store submission (gate G-store).

### `@jobleft/shell` (apps/shell)

Status: skeleton (`sidecarEnv`, `READY_TIMEOUT_MS`, `NOTIFICATION_POLL_MS` Built). Purpose: the Tauri v2 shell
(`apps/shell/src-tauri`, created by the shell lane) with the Node server as a sidecar. Section 5.2 is its contract.
Builds use `CARGO_TARGET_DIR=<main checkout>/.cache/cargo-target`. No signing or notarizing in lanes
(gate G-release). If WKWebView rendering fails the visual check (plan section 6), the fallback is Electron with the
same server.

## 9. Outbound hosts (the complete list)

The app contacts only these hosts, and only for these reasons. Anything else is a bug.

| Host | Why | When |
|---|---|---|
| Approved public ATS APIs: `boards-api.greenhouse.io`, `api.lever.co`, `api.eu.lever.co`, `api.ashbyhq.com`, and the Workable, Recruitee and Personio feed hosts once their adapters land | Job boards | Crawls; 1 request per second per host; robots.txt obeyed |
| Hosts of links the person pastes (careers pages, job pages) | Resolve a board or read an added job | On the person's action only; same polite client |
| Approved non-ATS feed hosts (sources-other): `remoteok.com`, `www.themuse.com` (with the person's key), `hn.algolia.com`, `raw.githubusercontent.com` | Job feeds | Only when that source is on; never `remotive.com` or `data.usajobs.gov` (robots.txt) |
| The fit model host (`JOBLEFT_MODEL_BASE_URL`) | Download bge-small-en-v1.5 once | First fit indexing; never on every launch |
| The dataset release host (`JOBLEFT_DATASET_MANIFEST_URL`) | Newer H-1B, place or directory data | When the person updates, or a stated schedule |
| Free company-fact sources (Wikidata, SEC, GLEIF) | Company facts | When a company block is opened and its kept facts expired |
| The AI provider the person chose | AI answers | Only for AI steps |
| publik (`JOBLEFT_PUBLIK_BASE_URL`) | AI through publik, wallet, metered fetch and search | Only when the person chose publik, or turned metered fetch on |

No telemetry, no crash reporter, no analytics, no update check that sends an identifier.

## 10. Never-crawl hosts

Refused before any request, in code (`DENY_HOST` in `packages/crawler/src/http.ts`), also as redirect targets and in
pasted links: LinkedIn (`linkedin.com`, `licdn.com`), Indeed, Glassdoor, SmartRecruiters, Workday
(`myworkdayjobs.com`, `myworkdaysite.com`, `workday.com`). Held back until the owner approves: iCIMS, Oracle, UKG,
Taleo (the lanes add their hosts to the refused list; recognising them from a URL for autofill sends no request).
Redirects are never followed automatically. sources-other refuses all of these, iCIMS (`icims.com`), Oracle
(`oraclecloud.com`), Taleo (`taleo.net`) and UKG (`ultipro.com`, `ukg.com`, `ukg.net`) included, in `NEVER_CRAWL`
(`packages/sources-other/src/http.ts`), and also refuses every host that is not on the source's own list.

## 11. Testing conventions

- Unit tests: `node --test "test/*.test.ts"` in each package (`pnpm test` runs all). No test makes a live request.
- Mock servers run on loopback and log every request (time, path, headers, body). Point the crawler at them with `JOBLEFT_HOST_MAP`, publik with `JOBLEFT_PUBLIK_BASE_URL`, AI with a loopback custom provider URL, the model and datasets with their base URLs.
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
| 5 | The launch token rides in the URL fragment and a header; the port range is fixed (47821 to 47830) | The extension can find the app after a restart; the fragment never reaches a server |
| 6 | Other feeds and added jobs live in the crawler's `jobs` table (`feed:<id>`, `external`) | One search index; one dedupe spine |
| 7 | TypeScript 7.0.2 (native) for type checks | Fast; no JS API is needed. If a lane needs the TypeScript JS API, pin 6.x in that package and say why |

Open items for the owner: the release location for dataset updates (`JOBLEFT_DATASET_MANIFEST_URL`); a project
contact address for the crawler identity (plan section 9); the publik app token (gate G-publik).
