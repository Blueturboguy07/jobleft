# @jobleft/sources-ats

jobleft crawls employers' public job boards into a local SQLite file. This package adds five ATS families to the
crawler's built-in three (Greenhouse, Lever, Ashby), keeps the list of which ATS families are crawled and why, and
recognises ATS links that a person pastes.

| Family | Crawled | Feed jobleft reads |
|---|---|---|
| Greenhouse, Lever, Ashby | yes (adapters in `@jobleft/crawler`, run through this package's repairs, see section 4) | their documented public board APIs (Greenhouse `"region": "eu"`: `boards-api.eu.greenhouse.io`) |
| Workable | yes | `apply.workable.com/api/v1/widget/accounts/<board>?details=true` |
| Recruitee | yes | `<board>.recruitee.com/api/offers/` |
| Personio | yes | `<board>.jobs.personio.de/xml` (or `.jobs.personio.com`) |
| Teamtailor | yes | `<board>.teamtailor.com/jobs.rss` (or `.na.teamtailor.com`), every page |
| Gem | yes | `api.gem.com/job_board/v0/<board>/job_posts/` |
| BambooHR, Breezy HR, JazzHR | no: no documented public feed | none |
| Rippling | no: its API terms could not be read; the owner must approve | none |
| SmartRecruiters, Workday, iCIMS, Oracle, UKG, Taleo, Jobvite, LinkedIn, Indeed, Glassdoor | no (never, or held back by the plan) | none; no request is ever sent |

Each decision has a note with dated quotes from the vendor's own documentation, robots.txt and terms in
[`docs/sources/`](../../docs/sources/README.md).

## Before you start

Run every command from the repository root. You need Node 24 or newer and pnpm.

```sh
pnpm install
```

Nothing below needs the internet. Every crawl in this README goes to stand-in boards on `127.0.0.1`.

## 1. Read the source list

```sh
node packages/sources-ats/src/cli.ts sources
```

You see two groups. "Crawled" lists Greenhouse, Lever, Ashby, Workable, Recruitee, Personio, Teamtailor and Gem, each
with the date it was checked, a link to the vendor's public-feed documentation, and its limits (for example
Workable's robots.txt `ai-train=no`, Lever's `Crawl-delay: 1`, Recruitee's token deadline of 10 February 2027). "Not
crawled" lists BambooHR, Breezy HR, JazzHR, Rippling, Jobvite, SmartRecruiters, Workday, iCIMS, Oracle Recruiting, UKG,
Taleo, LinkedIn, Indeed and Glassdoor, each with a reason and the date the reason was checked.

- `--json` prints the same list with the quote and the note file of each entry.
- The same list is in code: `ATS_SOURCE_LIST` (the app's `GET /api/v1/sources` merges it; see `docs/INTERFACES.md`).
- The same list, with links to each note, is the table in `docs/sources/README.md`.

## 2. Check a pasted link

```sh
node packages/sources-ats/src/cli.ts detect "https://apply.workable.com/northwind-demo/j/NWD0000001/?utm_source=x" \
  "https://www.linkedin.com/jobs/view/123" "https://acme.bamboohr.com/careers" "https://apply.workable.com/j/AB12" \
  "https://example.com/careers" "not a link"
```

You see one verdict and one plain sentence per link. This command sends no request.

```
crawlable              Workable board "northwind-demo", job NWD0000001.
never                  jobleft does not support LinkedIn links: its terms forbid automated access. Nothing was sent to www.linkedin.com.
not_crawled            This is a BambooHR link. jobleft does not crawl BambooHR: no documented public feed: ... Nothing was sent.
job_link_without_board This is a Workable job link, but it does not name the employer's board. Paste the board link instead.
unknown                jobleft does not recognise the job system behind this link, so it cannot add a board from it.
invalid                This is not a web link (http or https), so jobleft cannot use it.
```

Board and job links of every family are recognised, including regional hosts (`jobs.eu.lever.co`,
`job-boards.eu.greenhouse.io`, `<board>.jobs.personio.com`, `<board>.na.teamtailor.com`) and company pages that
carry `gh_jid` or `ashby_jid`. Case, tracking parameters, fragments and a trailing slash do not change the board.
Add `--json` for the full detection (`ats`, `board`, `region`, `jobId`, `crawlable`); it takes no value, so it may stand before or after any number of links, and every link gets its own answer.

## 3. Crawl stand-in boards

The package ships stand-in boards with made-up employers in `packages/sources-ats/test/fixtures/standin/`: 3 jobs on
each of Workable, Recruitee, Personio, Teamtailor and Gem. They include pay in a board field and in the text, jobs with
no date, no place or no pay, accented places (Zürich, São Paulo, Göteborg, Montréal), Japanese text, entity codes,
CDATA, and hostile markup (a script, an image with an error handler, a `javascript:` link and an iframe, all aimed at
`127.0.0.1:9`).

Terminal 1 starts the stand-ins and keeps running (Ctrl+C stops it):

```sh
mkdir -p /private/tmp/jl
node packages/sources-ats/src/cli.ts standin --dir packages/sources-ats/test/fixtures/standin --port 4600 \
  --log /private/tmp/jl/standin.ndjson --boards-out /private/tmp/jl/boards.json --map-out /private/tmp/jl/hostmap.json
```

It prints one line per board (for example `recruitee:zephyr-demo  zephyr-demo.recruitee.com -> http://127.0.0.1:4601`),
writes the board list to `boards.json`, and writes the host map to `hostmap.json`.

Terminal 2 crawls them:

```sh
JOBLEFT_HOST_MAP="$(cat /private/tmp/jl/hostmap.json)" node packages/sources-ats/src/cli.ts crawl \
  --boards /private/tmp/jl/boards.json --db /private/tmp/jl/jobs.db \
  --out /private/tmp/jl/report.json --log /private/tmp/jl/requests.ndjson
```

You see one line per board, a per-ATS summary, and a total:

```
ok           workable:northwind-demo                  listed=3 new=3 updated=0 same=0 unreadable=0 requests=1
...
per ATS: boards ok/failed, jobs listed, read, new, closed, open after the run
  gem         boards 1/0  listed 3  read 3  new 3  closed 0  open 3
  ...
crawl done: 5 of 5 boards ok, 15 jobs read (15 new), 0 closed, 10 requests (robots.txt included), report in /private/tmp/jl/report.json
```

A second run of the same command adds no copies (`new=0 same=3` on each board).

Crawl flags: `--grace-hours <h>` (default 48, see section 6), `--max-requests <n>` (default 3000), `--now <RFC 3339>`
(run as if the clock said this time), `--log <file>` (one JSON line per request: time, URL, host, status).
`JOBLEFT_OFFLINE=1` makes `crawl` send nothing and change nothing.

## 4. Read the stored jobs

```sh
node packages/sources-ats/src/cli.ts jobs --db /private/tmp/jl/jobs.db
node packages/sources-ats/src/cli.ts jobs --db /private/tmp/jl/jobs.db --json --full
```

The first prints each job: open or closed, its id (`<ats>:<board>:<job id>`), title, company, place, work model,
pay (with its source: `api` for a board field, `text` for the description), posted date and link. A fact the board did
not give prints as "not stated". `--json` prints every field; `--full` includes the whole description. Filters:
`--ats <id>`, `--board <token>`, `--status open|closed|all`.

The jobs live in the `jobs` table of the `--db` file (the crawler's table; `docs/INTERFACES.md` section 3). In the app,
the same rows are in `$JOBLEFT_HOME/data/jobleft.db` and come out of `GET /api/v1/jobs` and `GET /api/v1/jobs/:jobId`.

Every ATS gives the same fields with the same meaning:

| Field | Meaning | Missing means |
|---|---|---|
| title, company | The posting's title; the employer name the board reports (else the name in the board list) | never missing |
| location | Every place the posting lists, "City, Region, Country", several joined with "; " (Lever: every place in `categories.allLocations`) | not stated (never "Remote", never a default country) |
| remote, workMode | What the board states (Workable `workplace_type`/`telecommuting`, Recruitee `remote`/`hybrid`/`on_site`, Teamtailor `remoteStatus`, Gem `location_type`); the crawler also reads "Remote" in the place text | not stated (never "On-site" by default) |
| pay | min, max, currency, period exactly as stated: decimals are kept (Recruitee "22.50" is 22.5), and a period the board does not state stays "not stated" (the amounts are still kept). Recruitee states plain amounts, never cents. Ashby: the board's overall range (`summaryComponents`), not the first of several tiers | not stated. Pay in the text is read by the crawler's text parser and marked `text`; pay written in European number style (`€45.000 – €55.000 brutto jährlich`, `CHF 85'000 - 95'000 pro Jahr`, `€14,50 - €16,00 pro Stunde`) is read by this package (`parseEuropeanPay`), because the crawler's parser would take "45.000" for 45. Such a pay shows source `api` (the crawler's label for "a pay the adapter gave"), and it is never given a period the text does not support |
| postedAt | The board's posting date in UTC (Greenhouse: `first_published` only; `updated_at` is the last edit, not the posting). A date without a time (Workable) is stored at 12:00 UTC so the day is the same in every time zone from UTC-12 to UTC+11 | not stated (never the crawl time) |
| url, applyUrl | The job's own page on the ATS (its id is in the link), and the apply page when the board gives one | only absolute http(s) links are kept; a `javascript:` link is dropped |
| description | Plain text: tags, scripts, CDATA and entity codes removed (all 252 HTML 4 names such as `&atilde;` `&szlig;` `&euro;`, and numeric codes; also when a board escaped the HTML twice or mixed live and escaped HTML); terminal control characters (ESC, BEL, NUL) removed, in titles, places and descriptions too; lists kept as "- " lines; sections kept under their own headings | empty |

Per-family details (field by field): `docs/sources/<family>.md`.

## 5. Read the crawl report

- `--out <file>` of `crawl` writes the run report. `health.boards[]` has, per board: status, a plain `reason`, a
  `flag`, last checked, last success, jobs listed, read, new, updated, unchanged, unreadable, closed, open after the
  run. `health.byAts[]` and `health.totals` add up the boards. `run` is the crawler's raw report.
- `node packages/sources-ats/src/cli.ts report --db /private/tmp/jl/jobs.db` (or `--json`) prints, per board: state
  (`ok`, `failing`, `cooldown`, `not_checked`), open and closed jobs, last checked, the last problem in plain words,
  and a flag; then totals per ATS.
- In the app, the report is `GET /api/v1/crawl/report` (boards lane).

A board that answered with jobs that could not be read, or with 0 jobs while earlier jobs are still open, is flagged,
not shown as healthy. Counts are jobs, never requests.

## 6. When a job closes

A job closes only when a crawl read the WHOLE board, the job was missing, and the job was last seen more than the
grace period ago (`--grace-hours`, default 48). A failed, empty, cut-off, renamed or unreadable answer never closes
anything. A board that answers "0 jobs" closes its jobs only after 3 such answers in a row over at least 7 days. No
crawl closes more than half of a board of 10 or more open jobs at once. A job that comes back is open again.

To see a close at once with stand-in boards: remove one job from the stand-in file and run the crawl with
`--grace-hours 0`. Only the missing job closes; `jobs --status closed` shows it with `closedAt` and
`closedReason: unseen`. (Each crawl runs on one fixed clock, so `--grace-hours 0` never touches jobs this run saw.)

## 7. Point a crawl at your own stand-in boards

A stand-in board is any HTTP server on `127.0.0.1` (or `localhost`, `[::1]`) that answers the same path as the real
feed. `JOBLEFT_HOST_MAP` is a JSON object from the real host to the stand-in origin; only loopback targets are
accepted, and never-crawl hosts are refused. Each real host needs its own entry. Recruitee, Personio and Teamtailor
boards each live on their own sub-domain, so each such board needs its own stand-in port.

| ATS | Real host (board `acme`) | Path the stand-in must answer | Answer |
|---|---|---|---|
| Workable | `apply.workable.com` | `/api/v1/widget/accounts/acme?details=true` | JSON `{ "name", "jobs": [...] }` |
| Recruitee | `acme.recruitee.com` | `/api/offers/` | JSON `{ "offers": [...] }` |
| Personio | `acme.jobs.personio.de` (`"region": "com"`: `acme.jobs.personio.com`) | `/xml` (and `/xml?language=en` only when some descriptions are empty) | XML `<workzag-jobs><position>...` |
| Teamtailor | `acme.teamtailor.com` (`"region": "na"`: `acme.na.teamtailor.com`) | `/jobs.rss?offset=0&per_page=100`, then `offset=100`, ... until a page has fewer than 100 items | RSS 2.0 with `tt:` location elements |
| Gem | `api.gem.com` | `/job_board/v0/acme/job_posts/` | JSON list |
| Greenhouse, Lever, Ashby | see `packages/crawler/README.md` | | |

Every host is also asked for `/robots.txt` first (404 means no rules). The board list is a JSON array of
`{ "ats", "board", "company", "region"? }`.

The `standin` command serves such boards from a folder: `<ats>/<board>.json|.xml|.rss`, `<board>@<region>` for a
regional host, `boards.json` for employer names, `<ats>/robots.txt` or `<ats>/<board>.robots.txt`, and
`<board>.meta.json` to make a board misbehave: `{"status": 500}`, `{"status": 429, "headers": {"retry-after": "10"}}`,
`{"body": "garbage"}`, `{"delayMs": 30000}`, `{"bytesPerSecond": 1}`. It serves Teamtailor feeds page by page, logs
every request (time, host, path, headers) to `--log`, and reads the files again on every request, so you can edit a
file between crawls.

## 8. What every crawl request obeys

| Rule | Where |
|---|---|
| User-Agent `jobleft/0.1.1 (+https://github.com/Blueturboguy07/jobleft; no personal data)`, no other identifying header, no cookie, no profile data in any URL or body | crawler `HttpClient` |
| At most 1 request per second per host, counted from what the host last saw (with a 100 ms margin), also right after a `Retry-After` wait; a path robots.txt disallows is never requested; a longer `Crawl-delay` is kept between every two requests to that host, the first request after robots.txt included. A `Crawl-delay` over 60 s fails the board at once with that reason; a shorter one is waited, and the wait does not use up the request's 20 s timeout | crawler `HttpClient`, `Pacer`; `politeFetch` (this package) |
| After a 429 or 503 with `Retry-After`, no request reaches that host until the time has passed, and the queued requests then leave 1.1 s apart (waits over 60 s fail the board at once instead of holding the crawl) | `politeFetch` (this package, used by `crawl`) |
| An answer body is read with a 64 MiB limit while it streams (an endless answer stops at the limit; memory never holds more); a Latin-1 feed is turned into UTF-8 | `politeFetch` |
| A robots.txt that could not be read (no connection, HTTP 5xx) is reported as that ("could not connect ...", "robots.txt could not be read (HTTP 500)"), not as "robots.txt disallows this feed" | `politeFetch`, `plainReason` |
| Never a request to LinkedIn, Indeed, Glassdoor, SmartRecruiters, Workday, iCIMS, Oracle, UKG or Taleo, also not by redirect; redirects are never followed | crawler `DENY_HOST`, `politeFetch`, `neverContactHost` |
| A board token is checked before any request (a sub-domain must be a plain DNS label), so `evil.com/x?` as a board sends nothing | adapters |
| A bad board (404, 429, 500, timeout, empty, invalid JSON, HTML, cut-off XML, a renamed list field, a 30 MB body, a redirect, a feed whose pages never end) fails with one plain reason and never stops the other boards | adapters, crawler, `plainReason` |

## Tests and checks

```sh
pnpm --filter @jobleft/sources-ats test        # 62 tests, no live request, about 40 s
pnpm --filter @jobleft/sources-ats typecheck
```

`test/fixtures/live/` holds one real answer per built family, captured once on 2026-09-25 (see its README).

## Live smoke (makes real requests; not needed for anything above)

`smoke/live-boards.json` lists 14 real public boards (at most 3 per built family). On 2026-09-25:

```sh
node packages/sources-ats/src/cli.ts crawl --boards packages/sources-ats/smoke/live-boards.json \
  --db /private/tmp/jl-live/jobs.db --out /private/tmp/jl-live/report.json --max-requests 100
```

gave 13 of 14 boards ok and 146 jobs in 26 requests. `recruitee:projectivegroup` answered 404 (the employer's board
is gone from that host). `gem:mission` and `teamtailor:nanlabs` answered with 0 jobs. The run found that Workable lists
a job once per city under one shortcode; the adapter now merges those rows into one job with every place.

## Known limits

- Recruitee boards will fail from 10 February 2027 unless Recruitee changes its plan (reason shown in the report).
- The crawler's close rule tolerates up to 5% unreadable postings on a board; a job that stays unreadable for 48 hours
  on a large board can close.
- The crawler flags a second job with the same company and title as a role duplicate (`duplicate_of`) even when its id
  and place differ; whether such rows are hidden is the store lane's choice.
- Greenhouse boards with `"region": "eu"` are read from `boards-api.eu.greenhouse.io` by this package's wrapper. The crawler's own Greenhouse adapter still knows no EU host, so code that runs `SOURCES` from `@jobleft/crawler` directly (not `allSources()`) reads the US host.
- Pay in the text that this package reads (European number style) shows source `api`, because the crawler labels every pay an adapter hands over that way. Only the amounts and period are checked against the text.
- A `Retry-After` and `Crawl-delay` are waited only when they are 60 s or less; a longer one fails the board for this run (its reason names the seconds).
- `politeFetch` is what makes the pace, the body limit and the robots.txt reasons true. Code that uses the crawler's `HttpClient` without `politeFetch` does not have them (crawler lane).
- The crawler's own never-crawl list does not yet include iCIMS, Oracle, UKG and Taleo; this package's `crawl`
  command refuses them through `politeFetch`.
- The crawler's `Pacer` applies a robots.txt `Crawl-delay` only from the second request after robots.txt, and stops a
  board at once on 429 without waiting for `Retry-After`; this package's `crawl` command closes both gaps through
  `politeFetch`. Code that uses the crawler's `HttpClient` without `politeFetch` still has them (crawler lane).
