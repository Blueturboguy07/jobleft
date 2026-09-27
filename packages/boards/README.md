# @jobleft/boards

How jobleft finds employer job boards, keeps the board list that ships with the app, and keeps the boards a person
adds. It holds:

- **the directory**: 3,581 public job boards (Greenhouse, Lever, Ashby) that ship with the app, with a stated source
  and licence (`data/board-directory.json`);
- **your boards and choices**: boards you add from a link, and follow, hide or disable on any board;
- **link to board**: paste a careers page, a job page, an embed link or a `gh_jid` link on an employer's own site,
  and see the provider, the employer name the board itself reports, and the number of open jobs, before anything is
  added;
- **board health**: every refresh records what each board answered; a board that fails twice in a row is marked
  unreachable with a stated next check date, and becomes live again by itself when it answers;
- **refresh**: crawls the boards through the crawler core (`@jobleft/crawler`), at most 1 request per second per host;
- **directory refresh**: re-checks directory rows against their providers and prunes dead board tokens;
- **Common Crawl discovery**: extracts more board tokens from Common Crawl URL-index answers. Its live mode obeys
  robots.txt, and Common Crawl's index hosts disallow all crawlers today, so it works offline on index answers
  (see section 6).

Everything below runs from the repository root with Node 24 and pnpm 12. Nothing needs an account or a key.

```sh
pnpm install
jb() { node packages/boards/src/cli.ts "$@"; }   # the jobleft-boards CLI (a shell function: works in bash and zsh)
jb help
```

Quote every link you paste in a shell (`'https://...?a=b'`), because `?` and `&` mean something to the shell.

## 1. Where the data lives

| What | Where |
|---|---|
| Your boards, choices, board checks, refresh reports | `$JOBLEFT_HOME/data/jobleft.db` (tables `board_prefs`, `board_checks`, `crawl_runs`, `crawl_board_reports`, `board_pending_links`, `host_pacing`, `robots_cache`; the crawler's `jobs` and `boards` tables are in the same file) |
| The directory that ships with the app | `packages/boards/data/board-directory.json` (header: sources, licences, notice; one row per board) |
| Boards removed from the directory, with both "not found" dates | `packages/boards/data/board-directory-pruned.json` |
| A newer directory you loaded | `$JOBLEFT_HOME/datasets/board-directory.json` |

`JOBLEFT_HOME` defaults to `~/Library/Application Support/jobleft` on macOS. For every test, set it to a folder under
`/private/tmp`:

```sh
export JOBLEFT_HOME=/private/tmp/jl-try
```

## 2. The shipped directory (outcomes O5, O6, O15)

```sh
jb directory info        # which directory is in use, its sources, licences and notice, and counts
jb directory check       # rows, providers, duplicates, blank names, bad board names, forbidden hosts
jb count                 # boards by origin, provider and state
jb export --out /private/tmp/boards.ndjson   # one JSON line per board (every field of the board, plus
                                             # source, boardUrl and apiUrl for a live spot check)
```

What you see: `directory check` prints the row count (over 3,000), the providers (`ashby, greenhouse, lever`), and
`duplicates 0, blank names 0, bad board names 0, forbidden hosts 0`. `directory info` names each source with its
licence and a public page (JobSync, MIT, `https://github.com/Gsync/jobsync` at a stated commit). On a fresh data
folder every board says `not checked yet` and has no job count: the directory's own `lastVerified` and `status`
fields describe the build's check of the row, and the app never shows them as a current state.

Each export line looks like this (the `apiUrl` is the exact public feed jobleft reads):

```json
{"id":"greenhouse:stripe","ats":"greenhouse","board":"stripe","region":null,"company":"Stripe","origin":"directory","followed":false,"hidden":false,"disabled":false,"state":"not_checked","lastCheckAt":null,"lastSuccessAt":null,"nextCheckAt":null,"openJobs":null,"lastError":null,"source":"jobsync","boardUrl":"https://job-boards.greenhouse.io/stripe","apiUrl":"https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true"}
```

## 3. Try everything against local mock hosts (no live request)

`scripts/mock-hosts.ts` starts loopback stand-ins for the Greenhouse, Lever and Ashby job APIs, their board pages,
a careers-page host (`careers.mock.example`) and a paid page fetch with a balance. Every request it receives is
logged (time, host, path, headers) to the `--log` file.

```sh
node packages/boards/scripts/mock-hosts.ts --config packages/boards/examples/mock-config.json \
  --log /private/tmp/jl-requests.ndjson > /private/tmp/jl-env.sh &
sleep 1; source /private/tmp/jl-env.sh     # sets JOBLEFT_HOST_MAP and JOBLEFT_PAID_FETCH_URL
export JOBLEFT_HOME=/private/tmp/jl-demo
export JOBLEFT_BOARD_DIRECTORY=$PWD/packages/boards/examples/demo-directory.json   # a 5-board directory
```

`JOBLEFT_HOST_MAP` sends a real provider host to a loopback server (only loopback targets are accepted).
`JOBLEFT_BOARD_DIRECTORY` swaps the 3,581-board directory for a small file (`none` = an empty directory), so a
refresh asks only the boards you care about. The mock config format is described at the top of
`scripts/mock-hosts.ts`; each board can follow a script of answers (`ok`, `404`, `500`, `403`, `timeout`, `empty`,
`broken`, `429:<seconds>`). Stop the mock hosts with `pkill -f mock-hosts.ts` when you are done.

### Paste a link (O1, O2, O3, O10)

```sh
jb resolve 'https://job-boards.greenhouse.io/Acme/jobs/1001?utm_source=x' \
  'https://careers.mock.example/embed.html' 'https://careers.mock.example/two-boards.html' \
  'https://careers.mock.example/listing?gh_jid=1001' 'https://careers.mock.example/jobs' \
  'https://www.linkedin.com/jobs/view/1' 'not a link' 'https://careers.mock.example/about.html'
```

What you see, for each link: either the board(s) with provider, board token, the employer name the board reports
and the open-job count (`Greenhouse board "acme": Acme Robotics, 6 open jobs. Confirm to add it.`), or
`Cannot use this link (<reason>). <one plain sentence>`. Reasons: `not_a_link`, `broken_link`,
`unsupported_provider`, `forbidden_host`, `no_board_found`, `blocked_by_robots`, `offline`. `resolve` never adds
anything. `--json` prints the `BoardResolveResponse` contract.

- Link shapes that work: board pages, single job pages, apply pages, embed links (`embed/job_board?for=`,
  `embed/job_app?for=&token=`, Ashby `/embed`), API links, Lever's EU host (`jobs.eu.lever.co`, read from
  `api.eu.lever.co`), upper-case letters, tracking parameters, trailing slashes. A Lever board that is not on the US
  host is looked up on the EU host. Greenhouse EU links are refused plainly (see Known limits).
- Employer-hosted pages: jobleft reads the page (with the same polite client) and finds a board behind a plain link,
  an iframe, a script embed, an inline embed config, an "Apply" button, a form, a meta refresh, a script redirect or
  an HTTP redirect (the target is checked before anything is sent to it). A partner's board in a footer, nav bar or
  aside never beats the employer's own board. A page with two boards lists both and asks you to choose. A page with
  no board gets one more look on the same site: a frame of the page, or else its own careers link.
- Forbidden hosts (LinkedIn, Indeed, Glassdoor, SmartRecruiters, Workday, iCIMS, Oracle, UKG, Taleo) get no request
  at all, also as a redirect target or an embed target. The answer says plainly that the site is not supported.
- A link that names a board the provider does not have answers `no_board_found`; jobleft never tries a company
  name as a board token.

### Add, follow, hide, disable (O4, O9, O14)

```sh
jb add 'https://boards.greenhouse.io/acme' --yes                 # resolve, show, add (asks y/N without --yes)
jb add 'https://job-boards.greenhouse.io/ACME/jobs/1002' --yes   # "Already added: nothing changed." (exit 3)
jb add 'https://careers.mock.example/two-boards.html' --pick 1 --yes
jb add --ats lever --board beta --yes                            # checks the board first, then adds it
jb search 'Stripe, Inc.'                                         # same first entry as "stripe" and "STRIPE"
jb follow greenhouse:stripe
jb hide greenhouse:quietco
jb disable greenhouse:flaky
jb list --view user          # views: all, followed, user, hidden, disabled, failing
```

Different links to one board always give one board id (`<provider>:<token>`, or `<provider>:eu:<token>`), so the
list grows by exactly one board. Your boards and choices live in your own database table; loading a newer directory
(`jb directory load <file>`, `jb directory unload`) never removes, renames or re-enables them, and a board you
added keeps the name it had when you added it.

### Refresh, dead boards and warnings (O7, O8, O11, O15)

```sh
jb refresh                     # one refresh now: every board not hidden, disabled or waiting for its next check
                               # (--followed: only your followed and added boards; --boards <id,id>: only those)
jb list                        # state per board: live with its open-job count, warning, unreachable, blocked
jb show greenhouse:deadco      # warning: The board answered "not found" (HTTP 404). (one failure: asked again)
jb refresh
jb show greenhouse:deadco      # unreachable ... (last check <time>, next check <time + 1 day>)
jb refresh                     # deadco gets no request now (the mock log shows it)
jb report --failed             # the last refresh, board by board, with a plain reason
jb status
jb jobs greenhouse:acme --all  # the jobs a board's refreshes stored; closed ones show when and why
```

- One failed check (not found, server error, timeout, broken reply) shows a warning and the board is asked again at
  the next refresh. Two failures in a row make it `unreachable` with a next check date (1 day, then 2, 4, ... up to
  30 days); it gets no request before that date. When it answers again it is `live` again, with no action from you.
- A `429` makes the board `blocked` until at least its `Retry-After` (never less than 15 minutes); a `403` for 6
  hours, doubling up to 7 days; a robots.txt that forbids the board's feed for 1 day.
- Network trouble is not held against a board: when a host cannot be reached at all (its robots.txt does not load),
  its boards are not counted as checked; when every board of one host fails in the same refresh, they show a warning
  but are never marked unreachable for it.
- A board that was not asked is not a failed board. When a host refuses jobleft twice in a row (`403` or `429`) the
  rest of its boards are skipped for that run. The report shows them as `host_skipped` with a plain reason, and their
  health, failure count and next check date do not change, so they cannot slide to `unreachable`.
- A failed, "not found", empty or broken answer never closes the board's jobs (the crawler closes a job only after a
  refresh that read the whole board has not listed it for 24 hours). An empty answer from a board that had jobs shows
  a warning, not "live, 0 jobs".
- Every request carries `User-Agent: jobleft/0.1.0 (+https://github.com/Blueturboguy07/jobleft; no personal data)` and nothing else about
  you. Requests to one host are at least 1.1 seconds apart, across pastes, refreshes and even several jobleft
  processes (the schedule lives in the database, table `host_pacing`). robots.txt is obeyed (an answer is reused
  for 10 minutes; a robots.txt that cannot be read counts as "disallow everything"). A `429` or `503` with
  `Retry-After` pushes that host's next request back by at least the stated time.
- Time-skip: `JOBLEFT_CLOCK_OFFSET=2d jb refresh` (or `JOBLEFT_NOW=2026-10-01T00:00:00Z`) runs as if the clock were
  later, so a board's next check date can be reached without waiting.
- A refresh that would ask more than 25 boards on live (unmapped) hosts stops and asks for `--live`; this protects
  you from starting a 3,581-board live crawl by accident.

### Offline and pending links (O2)

```sh
JOBLEFT_OFFLINE=1 jb resolve 'https://boards.greenhouse.io/acme'   # "jobleft is offline ..." (reason offline)
jb pending                                                          # the link is kept
jb pending --retry                                                  # try the kept links again
```

`JOBLEFT_OFFLINE=1` sends no request at all. A link that failed because the network or the site did not answer is
also kept in the pending list. This holds for a provider board link (Greenhouse, Lever, Ashby and the others) as
well as for a careers page: when the provider host cannot be reached at all (network down, name lookup failed,
connection refused, time-out), `jb resolve` says reason `offline` with the plain cause (for example "The site
refused the connection."), offers no board, adds nothing and keeps the link. It never says `blocked_by_robots` for
that: only a robots.txt that was read and says no gives that reason. The next paste of the link after the network
is back works at once, and the kept link is removed.

### Paid lookup: never without your consent (O13)

When plain requests find no board on a page, and a paid page fetch is configured, the answer offers it with the
price in dollars from your publik balance (`paidLookup.priceMicros`, and the message says e.g. `$0.004`). Nothing is
sent to the paid service unless you accept:

```sh
jb resolve 'https://careers.mock.example/script-only.html'                 # offer only; 0 paid requests
jb resolve 'https://careers.mock.example/script-only.html' --accept-paid   # exactly 1 paid request
curl -s "$JOBLEFT_PAID_FETCH_URL/balance"                                  # the mock balance fell by the price
```

`JOBLEFT_PAID_FETCH_URL` must be a loopback stand-in in this build (POST `<url>/fetch` with
`{ url, js, maxPriceMicros }`, answer `{ url, html, costMicros }`); `JOBLEFT_PAID_FETCH_PRICE_MICROS` sets the shown
price. Without `JOBLEFT_PAID_FETCH_URL` no paid lookup is ever offered. The real metered client is
`@jobleft/sources-other`'s `createMeteredFetchClient`, which the app server passes in as `paid`.

## 4. The board routes over HTTP (development server)

`jb serve` serves the board routes of the local API (`docs/INTERFACES.md` section 6.4) on 127.0.0.1 with the same
security rules as the app (Host check, Origin refused, token in the `x-jobleft-token` header only, JSON bodies only,
1 MiB limit, every body checked against its contract). Use it for tests that paste many links while a refresh runs.

```sh
jb serve --port 47901 --token demo-token &      # add --live to allow a refresh of more than 25 live boards,
                                                # --schedule to start the launch catch-up and the 6-hour refresh
H='x-jobleft-token: demo-token'; J='content-type: application/json'
curl -s -H "$H" 'http://127.0.0.1:47901/api/v1/boards?view=all&limit=5'
curl -s -H "$H" -H "$J" -d '{"url":"https://jobs.lever.co/beta"}' http://127.0.0.1:47901/api/v1/boards/resolve
curl -s -H "$H" -H "$J" -d '{"ats":"greenhouse","board":"acme"}' http://127.0.0.1:47901/api/v1/boards   # 409 when added
curl -s -X PATCH -H "$H" -H "$J" -d '{"followed":true}' http://127.0.0.1:47901/api/v1/boards/greenhouse:stripe
curl -s -H "$H" -H "$J" -d '{}' http://127.0.0.1:47901/api/v1/crawl/run
curl -s -H "$H" http://127.0.0.1:47901/api/v1/crawl/status
curl -s -H "$H" http://127.0.0.1:47901/api/v1/crawl/report
curl -s -H "$H" http://127.0.0.1:47901/api/v1/boards/export
```

Errors use the local API error body: `{"error":{"code":"conflict","message":"This board is already in your list (Acme Robotics)."}}`.

## 5. Live use

Without `JOBLEFT_HOST_MAP` the same commands talk to the real providers, politely. For example
`jb resolve 'https://boards.greenhouse.io/airbnb'` sends two requests (robots.txt and the board's public job list).
A refresh of the whole shipped directory is about 3,600 requests (one per board, plus robots.txt), roughly 35 minutes with three hosts in parallel, and
needs `jb refresh --live`.

## 6. Directory maintenance

```sh
# Rebuild the starting directory from a JobSync checkout (MIT): no network.
node packages/boards/scripts/build-directory.ts --jobsync ~/jobleft/vendor/jobsync

# Check rows against their providers (1 request per second per host, robots.txt, a request budget), rename
# Greenhouse rows to the name the board reports, mark "not found" rows suspect, and remove a suspect row when a
# second check at least --recheck-after-hours later is "not found" again (both dates go to the pruned file).
jb directory refresh --sample 50 --max-requests 60                       # writes $JOBLEFT_HOME/datasets/...
jb directory refresh --all --ats greenhouse --max-requests 700 \
  --in packages/boards/data/board-directory.json --out packages/boards/data/board-directory.json

# Common Crawl discovery. The live mode asks index.commoncrawl.org, but it obeys robots.txt, and on 2026-09-25 both
# index.commoncrawl.org and data.commoncrawl.org answer "User-agent: * / Disallow: /". So today the live mode stops
# with a plain message after reading robots.txt (exit code 3) and sends nothing else:
node packages/boards/scripts/cc-discover.ts --crawl CC-MAIN-2026-39 --host job-boards.greenhouse.io --max-requests 5

# Offline, on index answers in the CDX API format (one JSON object per line), from saved files:
node packages/boards/scripts/cc-discover.ts --crawl CC-MAIN-2026-39 --host job-boards.greenhouse.io \
  --host jobs.ashbyhq.com --pages 0-1 --replay packages/boards/test/fixtures/cc --out /private/tmp/discovered.json
node packages/boards/scripts/cc-discover.ts --crawl CC-MAIN-2026-39 --from-file <answer.ndjson> --out /private/tmp/discovered.json

# Add discovered tokens that answer as live boards AND report their own employer name (never a name from the index):
jb directory refresh --discovered /private/tmp/discovered.json --max-requests 300 --in <directory file> --out <file>
```

What you see from the replay: `6 board tokens from job-boards.greenhouse.io, jobs.ashbyhq.com (0 requests,
replayed)`. The fixtures in `test/fixtures/cc` are hand-written in the CDX format (see the README there), because
recording real answers would have broken robots.txt. `cc-discover` keeps only board tokens (never page content),
reads only the URL index (never crawled pages), sends at most `--max-requests` requests (default 20), 1 per 1.1
seconds, with the project User-Agent, robots.txt and Retry-After honoured. `--record <dir>` saves answers for replay.

The shipped directory today: 3,581 rows (571 Greenhouse, 1,151 Lever of which 78 on Lever's EU host, 1,859 Ashby),
all from JobSync. On 2026-09-25 every Greenhouse row, every EU Lever row and 400 random Lever and Ashby rows were
checked live: 1,029 answered as live boards (status `live`), 41 answered "not found" and answered "not found" again
about 40 minutes later, so they were removed (`data/board-directory-pruned.json` lists them with both times); the
other 2,552 rows are `unverified`. An earlier random sample of 150 rows (50 per provider) found 143 live.

## 7. Using the package from code

```ts
import { BoardDirectory, BoardService, CrawlScheduler, SqlitePacer, createBoardHttp, boardSources, loadActiveDirectory } from '@jobleft/boards';
```

- `new BoardService({ db, directory, http, sources, now?, newHttp?, paid?, offline? })`: `list`, `get`, `resolve`,
  `add`, `update`, `export`, `due`, `recordCheck`, `hiddenBoards`, `counts`, `listPending`.
- `new CrawlScheduler({ boards, crawlStore, http, sources, intervalHours, now?, onProgress?, newHttp?, offline? })`:
  `start`, `stop`, `runNow`, `runOnce`, `progress`, `lastReport`.
- `detectBoardFromUrl(url)` (pure), `detectBoard(url, { http })` (reads pages), `scanPage(html, url)` (pure).
- `createBoardHttp({ pacer, hostMap, ... })`: the polite client; share one `SqlitePacer` per database.
- Errors: `BoardError` with `code` `conflict`, `not_found`, `bad_request`, `unsupported_source`.

Details: `docs/INTERFACES.md`, section `@jobleft/boards`.

## 8. Tests

```sh
pnpm --filter @jobleft/boards test        # node --test, loopback mock hosts only, about 5 seconds
pnpm --filter @jobleft/boards typecheck
```

## 9. Known limits

- Boards are read only from providers that have a crawl adapter: Greenhouse, Lever and Ashby today. Workable,
  Recruitee and Personio links are recognised; they become usable when `@jobleft/sources-ats` adds their adapters.
- A page that builds its board only in the browser (no board address anywhere in its HTML) needs the paid page
  fetch. A Workable embed that names only a numeric account id cannot be resolved.
- Greenhouse boards on its EU hosts (`job-boards.eu.greenhouse.io/<token>`) are recognised but refused with a plain
  message: Greenhouse documents a public job feed only for its US host (`boards-api.eu.greenhouse.io` does not exist
  and `api.eu.greenhouse.io` needs a key, checked 2026-09-25). jobleft never sends them to the US host.
- Lever and Ashby rows keep the JobSync name (their APIs report no name); boards added from a link take the name
  from the board's own page title.

## Rules

- ESM TypeScript that Node 24 runs directly: erasable syntax only, relative imports end in `.ts`.
- Types that cross a package boundary live in `@jobleft/contracts`. Contracts change by addition only.
- Third-party code and data: see `THIRD_PARTY_NOTICES.md` (the directory's sources are listed there and in the
  directory file's own header).
- No personal data in any request, file or test. Tests use the fake persona "Jordan Testwell" (jordan.testwell@example.com).
