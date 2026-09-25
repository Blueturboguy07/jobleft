# @jobleft/crawler: `jobleft-crawl`

The crawler core of jobleft. It reads employers' public job boards (Greenhouse, Lever and Ashby), keeps every job in
one local SQLite file, keeps the jobs current, and closes a job only when the employer really removed it.

```
board list -> polite HTTP client (identity, never-crawl list, robots.txt, 1 request/s/host, Retry-After, back-off,
              conditional requests, size and time limits) -> adapters -> normalise (facts only, never invented)
           -> store (one transaction per board) -> reading of the board -> close what two readings agree is gone
scheduler: catch-up on launch, refresh on schedule, confirmation re-checks, resumable runs, crawl reports
```

Everything below runs on this computer. Nothing in this README contacts a real job board, except the one optional
"live check" section.

## 1. Before you start

| Need | Check |
|---|---|
| Node 24 or newer | `node --version` prints `v24.x` or later |
| The repository and its install | `pnpm install` at the repository root |
| A scratch folder | the commands use `/private/tmp/jl` (make it with `mkdir -p /private/tmp/jl`) |

Run every command from the **repository root**. The CLI is `node packages/crawler/src/cli.ts <command>`. (The
package also names it `jobleft-crawl` in its `bin` field. Below, `jobleft-crawl` means
`node packages/crawler/src/cli.ts`.) `node packages/crawler/src/cli.ts help` lists every command.

## 2. Five-minute tour with the bundled mock boards

1. Start the mock board server (one terminal; it stays open):

   ```sh
   cp packages/crawler/examples/mock-boards.json /private/tmp/jl/mock-boards.json
   node packages/crawler/testkit/mock-boards.ts --port 4010 --boards /private/tmp/jl/mock-boards.json --log /private/tmp/jl/requests.ndjson
   ```

   You see `mock boards on http://127.0.0.1:4010 ...`. It answers like Greenhouse, Lever and Ashby, reads the boards
   file again on every request (so you can edit it while it runs) and appends every request it gets (time, path,
   headers, status) to `requests.ndjson`.

2. Crawl (a second terminal):

   ```sh
   node packages/crawler/src/cli.ts run --boards packages/crawler/examples/boards.local.json --db /private/tmp/jl/jobleft.db
   ```

   You see about this (times differ):

   ```
   skipped   https://www.linkedin.com/jobs/view/4000000001
             www.linkedin.com is a LinkedIn site; jobleft never contacts LinkedIn; nothing was sent
   skipped   https://acme.wd5.myworkdayjobs.com/en-US/External
             acme.wd5.myworkdayjobs.com is a Workday site; Workday sources are off until the owner turns them on; nothing was sent
   jobleft-crawl run: 4 board(s), database /private/tmp/jl/jobleft.db, clock 2026-09-25T07:02:42Z, identity "jobleft-build/0.1 (research build; no personal data)"
   ok          greenhouse:acme-health            listed     3  new 3  updated 0  same 0  1 req  1.1s
   ok          lever:northwind-logistics         listed     2  new 2  updated 0  same 0  1 req  2.2s
   ok          ashby:brightline-energy           listed     2  new 2  updated 0  same 0  1 req  3.3s
   failed      greenhouse:offline-co             the board answered with a server error (HTTP 500); its jobs stay as they were
   run #1 done: 4/4 boards, 3 ok, 1 failed, 0 waiting; 7 new, 0 updated, 0 closed; 7 requests (robots.txt included); peak memory 128 MB
   jobs in the database: 7 open, 0 closed
   ```

   All four boards are on one mock host here, so their requests are about 1.1 seconds apart.

3. Read the jobs:

   ```sh
   node packages/crawler/src/cli.ts jobs --db /private/tmp/jl/jobleft.db --format lines
   ```

   ```
   open   greenhouse:acme-health:4101 | Registered Nurse - ICU (Nights) | Acme Health | Austin, TX; Dallas, TX; Houston, TX | USD 42-58 per hour | posted 2026-09-10 | last seen 2026-09-25T07:02:43.547Z
   open   greenhouse:acme-health:4103 | Director of Nursing | Acme Health | Dallas, TX | posted not stated | last seen ...
   ...
   ```

   Without `--format lines` the command prints JSON: `{ clock, total, open, closed, nextCursor, items }`, where each item
   is a full contract `Job` record (`packages/contracts/src/job.ts`): the record the app's job endpoints carry
   (`GET /api/v1/jobs`, `GET /api/v1/jobs/:jobId`, docs/INTERFACES.md section 6.4; those routes belong to the store and
   server lanes). `--id greenhouse:acme-health:4101` prints one job.

4. Check the boards:

   ```sh
   node packages/crawler/src/cli.ts status --db /private/tmp/jl/jobleft.db
   ```

   ```
   Crawl not running.
   Last run: finished 2026-09-25T07:02:49.031Z: 4 boards, 3 ok, 1 failed; 7 new, 0 updated, 0 closed; 7 requests
   Jobs: 7 open, 0 closed.

   BOARD                             STATE         OPEN  LAST CHECK           NEXT CHECK           PROBLEM OR NOTE
   greenhouse:acme-health            live             3  2026-09-25T07:02:43Z 2026-09-26T07:33:52Z -
   greenhouse:offline-co             failing          0  2026-09-25T07:02:49Z 2026-09-25T08:02:49Z the board answered with a server error (HTTP 500); its jobs stay as they were
   ...
   ```

   `status --json` prints the same as JSON: `progress` (contract `CrawlProgress`), `lastRun` (contract
   `{ run: CrawlRunSummary, boards: CrawlBoardReport[] }`), `boards` (one entry per board), `hostWaits` and `jobs`.

## 3. Point the crawler at your own mock servers

A mock must answer the real API paths with the real JSON shapes:

| ATS | Path the crawler requests | Reply the crawler expects |
|---|---|---|
| Greenhouse | `GET /v1/boards/<token>/jobs?content=true&pay_transparency=true` | `{"jobs":[{"id", "title", "absolute_url", "location":{"name"}, "content" (HTML, may be entity-encoded), "first_published", "updated_at", "offices":[], "departments":[], "metadata":[], "pay_input_ranges":[{"min_cents","max_cents","currency_type","title","blurb"}]}], "meta":{"total"}}` |
| Lever | `GET /v0/postings/<site>?mode=json` | `[{"id", "text", "hostedUrl", "applyUrl", "createdAt" (ms), "categories":{"location","allLocations":[],"commitment","department"}, "description", "lists":[{"text","content"}], "additional", "workplaceType", "salaryRange":{"min","max","currency","interval"}}]` |
| Ashby | `GET /posting-api/job-board/<name>?includeCompensation=true` | `{"jobs":[{"id", "title", "jobUrl", "applyUrl", "location", "secondaryLocations":[{"location"}], "publishedAt", "descriptionHtml", "workplaceType", "employmentType", "isListed", "compensation":{"compensationTiers":[{"components":[{"compensationType":"Salary","interval":"1 YEAR"|"1 HOUR"|"1 MONTH","currencyCode","minValue","maxValue"}]}]}}]}` |
| any | `GET /robots.txt` | optional; 404 means "no rules" |

Two ways to send boards to mocks. Only loopback targets (`127.0.0.1`, `localhost`, `[::1]`) are accepted.

- **One mock server per board (each board its own host):** give the board an `"origin"` in the board list:

  ```json
  [ { "ats": "greenhouse", "board": "acme", "company": "Acme", "origin": "http://127.0.0.1:4011" },
    { "ats": "lever", "board": "beta", "company": "Beta", "origin": "http://127.0.0.1:4012" } ]
  ```

- **One mock server per ATS host:** `JOBLEFT_HOST_MAP` maps a real API host to a mock origin:

  ```sh
  export JOBLEFT_HOST_MAP='{"boards-api.greenhouse.io":"http://127.0.0.1:4010","api.lever.co":"http://127.0.0.1:4010","api.ashbyhq.com":"http://127.0.0.1:4010"}'
  ```

Each mock origin (address and port) is its own host for pacing, robots.txt and waits.

The bundled mock (`packages/crawler/testkit/mock-boards.ts`) can also misbehave per board. In the boards file, set
`"mode"` to one of: `error500`, `error503`, `timeout` (never answers), `slow` (one byte a second), `cutoff` (reply cut
half-way), `html` (a sign-in web page), `broken` (broken JSON), `empty` (0 jobs), `notfound`, `forbidden403`,
`ratelimit429` (with `"retryAfter": <seconds>`), `redirect` (to `"redirectTo"`), `redirectLoop`, `huge` (`"hugeMB"`,
default 500), `junk` (`"junkCount"`, default 50,000). A mock job has `id`, `title`, `location` (a string or a list),
`description` (HTML), `postedAt`, `pay` (`{ "min", "max", "period": "hour"|"year"|"month" }`), `url`, `applyUrl`,
`workplaceType` (`Remote`, `Hybrid`, `OnSite`), `commitment`, or `raw` (served exactly as given). ETag and
If-None-Match (304) work for boards in the normal mode.

## 4. Board list format

A JSON array (or `{ "boards": [...] }`). Each entry is one of:

| Entry | Meaning |
|---|---|
| `{ "ats": "greenhouse" \| "lever" \| "ashby", "board": "<token>", "company": "<name>", "region": "eu"?, "origin": "<loopback mock>"? }` | A board. Without `company`, Greenhouse's own `company_name` is used, else the board token |
| `{ "url": "<link>" }` | A board link: `boards.greenhouse.io/<token>`, `job-boards.greenhouse.io/<token>`, `jobs.lever.co/<site>`, `jobs.eu.lever.co/<site>`, `jobs.ashbyhq.com/<name>` (job links on those hosts work too). Recognised from the text; nothing is fetched to find out |

Entries jobleft will not crawl are listed at the top of the run with a reason, and nothing is sent for them:
LinkedIn, Indeed, Glassdoor and SmartRecruiters (never); Workday, iCIMS, Oracle, UKG and Taleo (off until the owner
turns them on); short links and other sites; a board name with characters a board name cannot have; an `origin` that is
not on this computer. The same board listed twice is crawled once.

## 5. Commands

| Command | What it does |
|---|---|
| `run --boards <file> --db <file>` | Crawl the listed boards now. If a run was cut short (quit, crash, power loss), it finishes that run first, with only its unfinished boards, and says so; run again for a new full crawl. A board that failed before is asked once, without retries. A board whose host refused access (403 or 429) waits out its back-off unless `--force`. `--due` crawls only the boards whose time has come. `--fresh` drops a cut-short run. `--out <file>` writes the run report as JSON |
| `status --db <file> [--json] [--boards <file>]` | Progress (boards done of boards total while a run goes), the last run, and one line per board: state (`not_checked`, `live`, `failing`, `unreachable`, `cooldown`, `blocked`, `waiting`), open jobs, last check, next check, and the problem in words. Also hosts that asked jobleft to wait |
| `jobs --db <file> [--status open\|closed\|all] [--q <words>] [--board <ats:board>] [--id <job id>] [--format lines] [--include-duplicates]` | Stored jobs as contract `Job` records. Default: all statuses; repeats of a job from another board are hidden unless `--include-duplicates`. `--q` finds jobs that hold all the words |
| `daemon --boards <file> --db <file> [--refresh 24h] [--confirm 2h]` | Keeps jobs current until Ctrl+C: a catch-up now, then each board when due. Prints one line per board. Ctrl+C or SIGTERM stops cleanly |
| `simulate --for <duration> --boards <file> --db <file>` | Time-skip: runs the schedule as if the app had been open that long (see section 6) |
| `verify --db <file>` | Checks the database: SQLite integrity, the full-text index, every job has a title and a web link, every job is a valid contract `Job`, and whether a run waits to resume. Exit 0 when all pass |
| `verify --in <boards.json> --out <file>` | One request per board, to see which boards are live |
| `clock --db <file> [--reset]` | Shows the crawler clock of a database (moved by `simulate`); `--reset` puts it back |
| `report --db <file> [--run <id\|last>]` | Coverage numbers of the database, or the report of one run |
| `search --db <file> --q <words>` | Open jobs that hold all the words |

Common flags: `--config <file.json>` (section 8), `--refresh 24h`, `--confirm 2h`,
`--max-requests <n>`, `--timeout 60s`, `--now <RFC 3339>`, `--clock-offset <duration>`. Durations: `90s`, `30m`,
`48h`, `3d`. Exit codes: 0 done, 1 error, 2 wrong usage, 3 offline (`JOBLEFT_OFFLINE=1`), 4 another crawler holds the
database, 130 stopped by Ctrl+C.

Environment: `JOBLEFT_HOME` (the default database is `$JOBLEFT_HOME/data/jobleft.db`; default folder on macOS
`~/Library/Application Support/jobleft`), `JOBLEFT_HOST_MAP`, `JOBLEFT_NOW` and `JOBLEFT_CLOCK_OFFSET` (time-skip),
`JOBLEFT_OFFLINE=1` (send nothing).

## 6. Time-skip recipes

The crawler reads the time through one clock: real time, moved by `JOBLEFT_NOW` / `JOBLEFT_CLOCK_OFFSET`, by
`--now` / `--clock-offset`, and by the offset `simulate` leaves in the database. Pacing, timeouts and a host's
Retry-After always use real time.

**A removed job closes (and comes back).** With the tour above:

```sh
# remove "Director of Nursing" (id 4103) from /private/tmp/jl/mock-boards.json, then:
node packages/crawler/src/cli.ts simulate --for 48h --boards packages/crawler/examples/boards.local.json --db /private/tmp/jl/jobleft.db
node packages/crawler/src/cli.ts jobs --db /private/tmp/jl/jobleft.db --status closed --format lines
```

`simulate` prints each scheduled event. The refresh a day later finds the job missing; the confirmation 2 hours after
that closes it:

```
simulated time 2026-09-26T07:33:52.485Z: 1 board(s) due
ok          greenhouse:acme-health            listed     2  new 0  updated 0  same 2  missing 1  1 req  1.1s
simulated time 2026-09-26T09:33:52.485Z: 1 board(s) due
ok          greenhouse:acme-health            unchanged (304)  open 2  closed 1  missing 1  1 req  1.1s
...
closed greenhouse:acme-health:4103 | Director of Nursing | Acme Health | Dallas, TX | posted not stated | last seen 2026-09-25T07:02:43.547Z (not confirmed for 2d) | closed 2026-09-26T09:33:52.485Z
```

The database keeps the moved clock, so later commands on it continue from there (`clock --reset` undoes it). Put the
job back in the mock file and `run` again: the job is open again, with the same id and all its details.

The same with a single command: `run ... --clock-offset 49h` (or `export JOBLEFT_CLOCK_OFFSET=49h` for the whole
session). That run reads the board, finds the job missing, reads it a second time about 20 seconds later, and closes
it, because it was last seen more than 48 hours ago. Keep the same offset for later commands on that database.

**A board that fails for 3 days.** Set the board's `"mode": "error500"`, then
`simulate --for 3d ...` and `jobs --format lines`: the jobs stay open, `last seen` stays at the last good reading, and
the line says `(not confirmed for 3d)`. The failing board is asked after 1 h, 4 h, 12 h, 1 day, then 2 days.

**Catch-up after a break.** `status --clock-offset 3d` shows every board due now; `daemon --clock-offset 3d` (or `run`)
crawls them all at once, at the polite pace. A board that did not change answers `304` (a small reply, no job list),
seen in `requests.ndjson` as `"status":304` and an `if-none-match` header.

**Watch the schedule in real time.** `daemon --refresh 2m` refreshes every 2 minutes. A refresh period under 1 hour is
accepted only when every board is a mock server on this computer; real boards refresh at most once an hour
(default: once a day).

## 7. What the crawler guarantees

| Rule | Detail |
|---|---|
| One honest identity | Every request carries `user-agent: jobleft-build/0.1 (research build; no personal data)` (fixed in code; a config value or `--user-agent` flag that names another identity is refused) and only these headers: `host`, `connection`, `user-agent`, `accept`, `accept-encoding`, and `if-none-match` / `if-modified-since` on a conditional request. No cookie, no referrer, no install id. The identity must start with `jobleft/<version>`; a browser word (Mozilla, Chrome, Safari, ...) or a personal e-mail address is refused. It is never read from a profile, git or the environment |
| Nothing personal leaves | A crawl request holds no name, e-mail, resume, profile, search words or filters. The crawler contacts only the boards and their `robots.txt`. It sends the job store and the board list nowhere |
| Never-crawl hosts | LinkedIn, Indeed, Glassdoor, SmartRecruiters: refused before any request, also as redirect targets. Workday, iCIMS, Oracle, UKG, Taleo: refused unless the owner turns the family on in code (`allowHeldBack`); off by default |
| No local network | A host that is this computer or the local network (by address or by name, checked when the connection is made) is refused, except a loopback mock named by a board `origin` or `JOBLEFT_HOST_MAP` |
| Redirects | Never followed. The report names the target (and says when it is a never-crawl host, a local address or a loop) |
| 1 request per second per host | Requests to one host start at least 1.1 s apart (1 s plus a margin), across concurrent boards, retries, robots.txt, and across runs (the last request time is kept in the database). A longer `Crawl-delay` in robots.txt wins, for every request to that host: counted from the robots.txt request itself, and across runs |
| robots.txt | Read once per host and kept 24 hours. A disallowed path gets no request. A robots.txt that answers a server error, a redirect, 429 or nothing means "do not crawl this host now" (tried again after 30 minutes), never "all allowed". A 404 means no rules |
| "Too many requests" | 429 or 503 with `Retry-After`: the host gets no request until then (up to 120 s inside a run; longer, and its boards wait for a later run). 429 without a time: 60 s. Two refusals (403/429) in a row: the host is left alone for 30 minutes |
| Failing boards | A board that failed before is asked once, without retries. The scheduler asks it again after 1 h, 4 h, 12 h, 1 day, 2 days, 4 days, then weekly (scaled to the refresh period), until it answers well. Server errors on a host lower the retries for its other boards; 6 in a row stop that host for the run |
| Bounded work | A reply over 64 MB is not read (read as a stream, so memory stays bounded). A request has 60 s in total (headers and body). A board has 300 s. A board that lists more than 10,000 postings is refused as a whole. A run sends at most 5,000 requests; boards left over wait for the next run. At most 3 boards of one host and 8 boards overall are in flight; one hung board holds one slot only |
| Facts, never inventions | Title, company, every place the board lists, pay (a board field first, else a wage line of the posting text, a range or a single figure such as "Pay: $45 per hour"; a bonus, 401(k), HRA or stipend figure is never pay), the figures exactly as the board states them (cents kept: $18.50 stays 18.5), the unit only as stated (hour, month, year; a board range that states no unit is not shown as board pay), the posted date (Greenhouse `first_published`, Lever `createdAt`, Ashby `publishedAt`; never the crawl time, never the board's "updated" stamp), work model, employment type, level. Anything not stated is `null` or `[]`. Each shown fact names its evidence |
| Text stays text | The description is plain text (lists become `- ` lines, headings their own lines); scripts, images, frames and links are removed as markup. A `url` or `applyUrl` that is not `http(s)` is dropped; a posting with no web link at all is not stored (the report says so) |
| Identity of a job | `(ats, board, board's job id)`. The same posting read again is updated in place (an edited title or text never makes a second job). Two ids on one board are always two jobs, even with the same title, place or page link. The same page link with the same company, title and text (or the same places) on another board is the same posting: it is credited to both, stored once; the same link with a different city and text is a second opening (a generic link shared by different postings never merges them; a route fragment such as `#/jobs/123` is part of the link). The same company, title, places, description and pay on another board is a repeat: kept, flagged `duplicateOf`, hidden from the job list until the first copy closes. A different description or pay is a different opening and always shows. Ids above 2^53 keep their exact digits |
| Closing | A job closes only when its board answered with its whole list, cleanly (no failure, at least one posting, at most 5% unreadable), and a second reading confirms that it is gone: 2 hours later (the scheduler re-checks the board then), or in the same run when the job was last seen more than 48 hours ago. A reappearing job reopens. A closed job keeps every detail |
| A failed crawl closes nothing | A server error, a timeout, a cut-off or broken reply, a web page, a reply that is not a job list, a Greenhouse reply shorter than its own `meta.total`, "not found", a refusal or a redirect: the board's jobs stay as they were, and the board status names the reason |
| Mass-close guard | A reading that would close more than half of a board with 10 or more open jobs is held ("held for review") and closes nothing. The same drop, read 3 times over 24 hours, is accepted |
| Empty and gone boards | A clean empty answer closes nothing. A board that lists nothing on 3 checks over 7 days is closed as empty. A board that answers "not found" on 3 checks over 14 days is closed as gone |
| Conditional requests | Greenhouse, Lever and Ashby boards send `If-None-Match` / `If-Modified-Since` after a proven reading. A `304` confirms the board's jobs as seen with a tiny reply |
| Crash safety | Each board is written in one SQLite transaction (WAL): its jobs, the reading, the board's health and the run's progress. A quit, crash or power loss loses at most the boards in flight, never half a board, and the store opens with no repair step |
| Resume | The next `run`, `daemon` or `simulate` finishes a cut-short run first, with only the boards it had not finished |
| One crawler per database | A lease in the database: a second crawler on the same file is refused (exit 4) while the first runs |

## 8. Configuration

`--config <file.json>` sets any of these keys (unknown keys are refused). `packages/crawler/examples/crawler.config.example.json`
is an example.

| Key | Default | Meaning |
|---|---|---|
| `userAgent` | `jobleft-build/0.1 (research build; no personal data)` | The identity. Fixed in code: any other value is refused |
| `refreshHours` | 24 | A healthy board is read again after this long |
| `confirmHours` | 2 | A missing job is confirmed (and closed) by a reading this long after the first miss (at most half the refresh) |
| `graceHours` | 48 | A job last seen this long ago closes on a confirmed miss inside one run |
| `confirmDelaySeconds` | 20 | Wait before the in-run second reading |
| `requestTimeoutSeconds` | 60 | Whole-request deadline |
| `robotsTimeoutSeconds` | 15 | Deadline for robots.txt |
| `maxBodyMB` | 64 | Largest reply read |
| `maxJobsPerBoard` | 10000 | Larger boards are refused as a whole |
| `maxRequestsPerRun` | 5000 | Request budget of one run |
| `perHostConcurrency` | 3 | Boards of one host in flight |
| `globalConcurrency` | 8 | Boards in flight overall |
| `minHostIntervalSeconds` | 1 | Seconds between requests to one host (never below 1) |
| `maxRetryAfterSeconds` | 120 | Longest Retry-After waited for inside a run |
| `boardDeadlineSeconds` | 300 | Longest time for one board |
| `retries` | 2 | Retries after a server error or a dropped connection (never after 4xx or a timeout) |
| `greenhousePayTransparency` | true | Ask Greenhouse for `pay_input_ranges` |

## 9. Failure reasons

The `status` line and the run report use these codes (`reasonCode`) with a sentence:

| Code | Meaning | Jobs closed? |
|---|---|---|
| `ok`, `not_modified` | Read well (304 = unchanged) | Only confirmed removals |
| `empty` | The board listed 0 jobs | No (see "Empty and gone boards") |
| `server_error`, `timeout`, `cut_off`, `broken_reply`, `not_job_data`, `network`, `deadline`, `too_large`, `too_many_jobs`, `redirect`, `http_error` | The board could not be read | No |
| `not_found` | 404 or 410 | No (3 checks over 14 days: closed as gone) |
| `blocked`, `rate_limited` | 403, or 429 after waiting | No; back-off |
| `robots`, `robots_unreadable` | robots.txt forbids the path, or cannot be read | No; no request |
| `forbidden_host`, `held_back_host`, `private_address`, `bad_origin` | A host jobleft does not contact | No; no request |
| `host_wait`, `host_skipped`, `budget`, `stopped` | The board waits for a later run | No |
| `cooldown` | In back-off; the last failure is quoted | No |
| `no_adapter` | No reader for this ATS in this package | No; no request |

## 10. Optional live check (real public boards)

Only for people allowed to send live requests. It sends about one request per board plus one robots.txt per host,
at most one request a second per host:

```sh
node packages/crawler/src/cli.ts run --boards packages/crawler/examples/boards.live.json --db /private/tmp/jl/live.db
node packages/crawler/src/cli.ts jobs --db /private/tmp/jl/live.db --format lines | head -20
```

Each job's `url` is the posting's own page from the board (`absolute_url`, `hostedUrl` or `jobUrl`).

## 11. Library use (other lanes)

```ts
import { Store, runOnce, Scheduler, makeConfig, crawlerClock, queryJobs, SOURCES } from '@jobleft/crawler';

const store = new Store('/path/jobleft.db');          // or new Store(db) with the app's one DatabaseSync
const config = makeConfig();
const clock = crawlerClock(store);
await runOnce({ store, config, clock, sources: { ...SOURCES /*, ...ATS_SOURCES */ } }, { reason: 'manual', boards, retryFailing: true });
const page = queryJobs(store.db, { status: 'open', q: 'registered nurse' });   // contract Job records

const scheduler = new Scheduler({ store, config, clock, boards: () => currentBoards });
await scheduler.start({ catchUp: true });  scheduler.progress();  scheduler.lastReport();  await scheduler.stop();
```

A new adapter implements `Source` (`src/types.ts`): `ats`, `fullBoardListing` (true only when one answer is the
whole board), optional `conditional` (true only when the board is ONE request), optional `host(board)`, and
`fetchBoard(board, http)`. It may use only the `HttpGetter` it is given. The full interface is in
[docs/INTERFACES.md](../../docs/INTERFACES.md), section `@jobleft/crawler`.

## 12. Tables this package owns

`jobs`, `jobs_fts` (FTS5), `boards`, `job_sources`, `crawler_runs`, `crawler_run_boards`, `crawler_hosts`,
`crawler_robots`, `crawler_meta`. Migrations are forward only and recorded in `schema_migrations` (owner `crawler`).
A database written by a newer build is refused with a plain message and left untouched.

## 13. Tests

| Command | What it does |
|---|---|
| `pnpm --filter @jobleft/crawler test` | 105 tests, about 15 s: the 64 ported S1 tests (2 dedupe tests rewritten for outcome O5, see `test/store.test.ts`), unit tests, and end-to-end tests on loopback mock boards (facts, closing, failures, dedupe, real-pace politeness, hostile boards, kill-and-resume through the CLI, scheduler and time-skip) |
| `pnpm --filter @jobleft/crawler typecheck` | Type-check |

No test sends a request off this computer.
