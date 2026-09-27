# @jobleft/sources-other

Job sources that are not an employer's own ATS board: remote-job boards, community job lists, the HN hiring thread,
and (built but not crawled) USAJOBS and Remotive. The package also holds add-a-job by URL or text and the metered
fetch client. Everything here runs on the laptop. It can run with no network and no keys against local stand-in feeds.

Interface for other lanes: [docs/INTERFACES.md](../../docs/INTERFACES.md), section `@jobleft/sources-other`.
Terms, robots.txt and field maps of each source: [docs/sources/](../../docs/sources/).

## 1. The sources

Every crawled source ships OFF. The person turns it on.

| Source id | Name | Crawled | Key | Credit shown with each job | Limit (jobleft's, never above the source's) |
|---|---|---|---|---|---|
| `remoteok` | Remote OK | yes | no | "Found on Remote OK", link to remoteok.com, job link on Remote OK | 4 refreshes in any 24 h, 1 h apart |
| `themuse` | The Muse (remote jobs) | yes | **yes** (terms 2.2) | "Job listing from The Muse", job link on themuse.com | 2 refreshes in any 24 h, 6 h apart; 400 pages, 900 requests a day |
| `hn-whoishiring` | Hacker News: Who is hiring? | yes | no | "Posted in <thread> on Hacker News", link to the comment | 2 refreshes in any 24 h, 6 h apart |
| `gh-simplify-internships` | SimplifyJobs Summer 2027 internships (GitHub) | yes | no | "Listed in SimplifyJobs/Summer2027-Internships on GitHub" | 4 refreshes in any 24 h, 1 h apart |
| `gh-vanshb03-internships` | vanshb03 Summer 2027 internships (GitHub) | yes | no | same form, "(MIT licence)" | same |
| `gh-vanshb03-newgrad` | vanshb03 New Grad 2027 (GitHub) | yes | no | same form, "(MIT licence)" | same |
| `gh-speedyapply-swe` | speedyapply 2027 SWE college jobs (GitHub) | yes | no | same form | same |
| `gh-speedyapply-ai` | speedyapply 2027 AI/ML college jobs (GitHub) | yes | no | same form | same |
| `remotive` | Remotive | **no**: robots.txt disallows `/api/*` | no | (built) | cannot be turned on |
| `usajobs` | USAJOBS | **no**: robots.txt disallows `/`; needs the owner's decision | yes | (built) | cannot be turned on |
| `adzuna` | Adzuna | **no**: terms forbid storage; listed for information | yes | none | no adapter |

Every source also obeys 1 request a second per host (with a 100 ms margin), shared by all sources and all processes
that use the same data folder. The GitHub list names in the plan (Summer2026, 2026 lists) were renamed to their 2027
names; the table uses the current names.

## 2. Setup

Node 24 or newer. From the repository root:

```sh
pnpm install
alias jls='node packages/sources-other/src/cli.ts'      # bash or zsh
export JOBLEFT_HOME=/private/tmp/jls-check                # any empty folder; the database is $JOBLEFT_HOME/data/jobleft.db
```

Without `JOBLEFT_HOME` the CLI uses the app's normal data folder (macOS: `~/Library/Application Support/jobleft`).

## 3. Quick start with no network and no keys

Terminal 1 starts the stand-in feeds (loopback only):

```sh
jls standin --dir /private/tmp/jls-standin --port 4701
```

You see the folder, the request log path, and one line to copy:

```
export JOBLEFT_HOST_MAP='{"remoteok.com":"http://127.0.0.1:4701","www.themuse.com":"http://127.0.0.1:4702", ...}'
```

Terminal 2:

```sh
export JOBLEFT_HOME=/private/tmp/jls-check
export JOBLEFT_HOST_MAP="$(cat /private/tmp/jls-standin/hostmap.json)"
jls list                 # 11 sources; all off; The Muse "needs_key"; Remotive, USAJOBS and Adzuna "not crawled" with the reason
jls enable all           # turns on the 8 crawled sources (The Muse stays "needs_key")
jls refresh              # one line per source
jls jobs                 # every open job with its source, exact link and credit
```

`jls refresh` prints (counts from the shipped fixtures):

```
OK      remoteok                   Remote OK: 10 jobs listed, 10 new, 0 closed
SKIPPED themuse                    The Muse needs a key. Register a free app at https://www.themuse.com/developers/api/v2/apps ...
OK      hn-whoishiring             Hacker News: Who is hiring?: 7 jobs listed, 7 new, 0 closed
OK      gh-simplify-internships    SimplifyJobs Summer 2027 internships (GitHub): 5 jobs listed, 5 new, 0 closed, 1 could not be read
OK      gh-vanshb03-internships    vanshb03 Summer 2027 internships (GitHub): 3 jobs listed, 2 new, 0 closed, 1 already known from another source
OK      gh-vanshb03-newgrad        vanshb03 New Grad 2027 (GitHub): 3 jobs listed, 3 new, 0 closed
OK      gh-speedyapply-swe         speedyapply 2027 SWE college jobs (GitHub): 9 jobs listed, 9 new, 0 closed
OK      gh-speedyapply-ai          speedyapply 2027 AI/ML college jobs (GitHub): 5 jobs listed, 5 new, 0 closed
SKIPPED remotive                   Remotive is not crawled: robots.txt on remotive.com disallows /api/* ...
SKIPPED usajobs                    USAJOBS is not crawled: robots.txt on data.usajobs.gov disallows every path ...
```

With `JOBLEFT_HOST_MAP` set, a host that has no stand-in is refused ("stand-in mode"), so nothing can reach a live
host by mistake. `JOBLEFT_OFFLINE=1` sends nothing at all.

## 4. The stand-in feeds

`jls standin --dir <d> [--port p]` copies the fixtures into `<d>` (only files that are missing) and serves them on
`127.0.0.1`, one port per real host, from `p` upward. It reads every file on every request, so you can edit a fixture
between two refreshes.

| File in `<d>` | Source | Format (the real answer's structure) |
|---|---|---|
| `remoteok.json` | `remoteok` | JSON array. First element `{ "legal": ... }`; then postings with `id`, `position`, `company`, `url`, `apply_url`, `location`, `date`, `salary_min`, `salary_max` (0 = not stated; annual USD), `description` (HTML) |
| `themuse.json` | `themuse` | `{ "results": [ ... ] }`, each with `id`, `name`, `company.name`, `refs.landing_page`, `locations[].name`, `levels[].name`, `publication_date`, `contents`. The stand-in pages it 20 at a time |
| `hn-search.json`, `hn-item.json` | `hn-whoishiring` | The search answer (`hits`) and the thread (`id`, `title`, `children[]` with `id`, `text` HTML, `created_at`). Only top-level comments whose first line uses `|` are postings |
| `gh-simplify-internships.json`, `gh-vanshb03-internships.json`, `gh-vanshb03-newgrad.json` | the JSON lists | JSON array of rows with `id`, `company_name`, `title`, `url`, `locations[]`, `date_posted` (Unix seconds), `active`, `is_visible`, `sponsorship` |
| `gh-speedyapply-swe/*.md`, `gh-speedyapply-ai/*.md` | the speedyapply lists | Four markdown files each; tables between `<!-- TABLE..._START -->` and `<!-- TABLE..._END -->` with header `Company | Position | Location | [Salary] | Posting | Age` |
| `remotive.json`, `usajobs.json` | not crawled | Served for completeness; jobleft never asks for them |
| `scenarios.json` | all | `{ "<sourceId>": "<scenario>" }`, read on every request |
| `robots/<host>.txt` | any host | Optional robots.txt for that host. No file = 404 = no rules |
| `requests.ndjson` | log | One line per request: `t`, real `host`, `path`, `query`, `headers`, `source`, `scenario`, `status`. Keys (`api_key`, `Authorization-Key`) are shown only as `[redacted: N characters, sha256 xxxxxxxx]` |
| `hostmap.json` | | The `JOBLEFT_HOST_MAP` value |

Switch a source to a scenario (takes effect on the next request):

```sh
jls standin-set remoteok http500 --dir /private/tmp/jls-standin
```

| Scenario | The stand-in answers | jobleft shows |
|---|---|---|
| `ok` | the fixture | the jobs |
| `empty` | a valid answer with no postings | "0 jobs listed"; nothing closes |
| `http500`, `http503` | server error (jobleft retries once) | "had a server error (HTTP 500)" |
| `http429` | 429 with Retry-After 3600 | state `rate_limited`; nothing before the wait (at least 1 hour) |
| `http403`, `http401`, `http404` | that status | "refused the request (HTTP 403)", "refused the key (HTTP 401)", "was not found (HTTP 404)" |
| `hang` | never answers | "did not answer within 15 seconds" (set `JOBLEFT_SOURCE_TIMEOUT_MS=3000` to wait less) |
| `slow` | answers after 5 s | the jobs |
| `html` | a web page | "answered with a web page instead of job data" |
| `notjson` | text that is not JSON | "answered with data that is not valid JSON" |
| `renamed` | every field renamed (markdown: the header) | "the data format changed: ..." |
| `truncated` | 60% of the body, as if complete | "the answer ... was cut off before it ended" |
| `cutoff` | announces the full length, sends 60%, closes the connection | same |
| `redirect` | 302 to linkedin.com | "answered with a redirect to www.linkedin.com; jobleft does not follow redirects" |
| `page2fail` | The Muse: page 2 and later fail | the jobs of page 1 are kept; nothing closes; state `failing` |

## 5. Commands

All commands: `jls <command>` (that is, `node packages/sources-other/src/cli.ts <command>`).

| Command | What it does |
|---|---|
| `list [--json]` | Every source: crawled, on/off, state (`never_run`, `ok`, `failing`, `needs_key`, `off`, `rate_limited`), open jobs, last success, next allowed refresh, last problem with its time, credit. `--json` prints the same `SourceInfo[]` body as `GET /api/v1/sources` |
| `enable <id...>` / `enable all` / `disable <id...>` | Turn sources on or off. Off = no request at all. A not-crawled source cannot be turned on (the reason is printed) |
| `refresh [id...] [--reason manual\|schedule\|launch] [--json]` | Refresh now. Each source obeys its limits; a source that is too soon prints when its next refresh is allowed and sends nothing |
| `due` | Run only the sources the scheduler would run now (on, due, not backing off) |
| `simulate [--hours 24] [--step 15m] [--press-every n]` | Step the app clock through the hours as a running app would, run the scheduler at each step (and a manual refresh every n steps), then print the most runs and requests of each source in any 24-hour window |
| `jobs [--source id] [--status open\|closed\|all] [--remote] [--open-to-us] [--include-unknown-region] [--include-off] [--limit n] [--json]` | Jobs from these sources as contract `Job` records. `--json` prints the records (each checked against the `Job` schema). Jobs that only sources turned off list are hidden unless `--include-off` |
| `export [--out file] [--source id] [--status ...]` | NDJSON, one `Job` per line with every source's link and credit, plus `creditLine`. Default file: `$JOBLEFT_HOME/files/exports/` |
| `runs [--source id] [--limit n] [--json]` | Run history: time, reason, outcome, counts, requests, problem |
| `discover [--json]` | ATS boards behind the links of open postings (Greenhouse, Lever, Ashby, Workable, Recruitee, Personio). Links to Workday, iCIMS, SmartRecruiters and Oracle are counted, never contacted. Sends nothing |
| `standin [--dir d] [--port p]` | Start the stand-in feeds (section 4) |
| `standin-set <id> <scenario> [--dir d]` | Switch a stand-in source to a scenario |
| `standin-reset [--dir d]` | Restore the shipped fixtures and set every scenario to `ok` (the log is kept) |

Environment:

| Variable | Meaning |
|---|---|
| `JOBLEFT_HOME` | Data folder. Database `data/jobleft.db`, log `logs/sources.log`, exports `files/exports/` |
| `JOBLEFT_HOST_MAP` | Real host to loopback stand-in (JSON). When set, unmapped hosts are refused |
| `JOBLEFT_OFFLINE=1` | Send nothing |
| `JOBLEFT_NOW`, `JOBLEFT_CLOCK_OFFSET` | The app clock (for example `JOBLEFT_CLOCK_OFFSET=25h`). Limits, dates and closes use it; pacing uses real time |
| `JOBLEFT_SOURCE_KEY_THEMUSE` | The Muse key. The CLI reads keys only from the environment and never saves or prints them. The app keeps them in the OS secret store |
| `JOBLEFT_SOURCE_KEY_USAJOBS` | `"<registered email> <key>"` (USAJOBS is not crawled) |
| `JOBLEFT_SOURCE_TIMEOUT_MS` | Per-request timeout (default 15000) |

## 6. How to check each outcome

Keep the stand-in of section 3 running. Start every row from a clean state with this reset (a new data folder, the
shipped fixtures, every scenario "ok", then one refresh):

```sh
S=/private/tmp/jls-standin
reset() { rm -rf "$JOBLEFT_HOME"; jls standin-reset --dir $S >/dev/null; jls enable all >/dev/null; jls refresh >/dev/null; }
```

Each source keeps its limits (Remote OK: 4 refreshes in any 24 hours, 1 hour apart), so the rows move the app clock
forward with `JOBLEFT_CLOCK_OFFSET` between refreshes.

| Outcome | Steps (after `reset`) | What you see |
|---|---|---|
| O1 names and links | `jls jobs --source remoteok --json` | 10 jobs; each `sources[]` entry names the source; `url` equals the fixture's `url` character for character (tracking parameters stay in the link; they are removed only in `canonicalUrl`) |
| O2 credit | `jls export --out /private/tmp/jls.ndjson; grep -c "Found on Remote OK" /private/tmp/jls.ndjson` | 10: every Remote OK line has the credit and its link; a merged job keeps every credit |
| O3 limits | `for i in 1 2 3 4 5 6 7 8 9 10; do jls refresh remoteok; done` | Every press: `SKIPPED ... The next refresh is allowed at <time>`, and `$S/requests.ndjson` gets no new line. Each `jls` call is a new process, so this is also 10 relaunches. `JOBLEFT_CLOCK_OFFSET=2h jls refresh remoteok` runs. `jls simulate --hours 26 --step 30m --press-every 2` runs the scheduler (plus manual presses) through 26 hours of app time and prints the most runs and requests of each source in any 24 hours; none is above its limit |
| O4 keys | `jls list` (The Muse: `needs_key` and the steps); `grep -c www.themuse.com $S/requests.ndjson` (0). Then `JOBLEFT_SOURCE_KEY_THEMUSE=TESTKEY-0000-jordan jls refresh themuse`; `grep -r TESTKEY-0000-jordan $JOBLEFT_HOME $S` | The Muse runs with the key (5 jobs). `grep` finds nothing: not in logs, the database, exports or the stand-in log. `jls standin-set themuse http401 --dir $S; JOBLEFT_CLOCK_OFFSET=7h JOBLEFT_SOURCE_KEY_THEMUSE=TESTKEY-0000-jordan jls refresh themuse` says "refused the key (HTTP 401)", not "0 jobs" |
| O5 failures | `jls standin-set remoteok http500 --dir $S; jls standin-set gh-vanshb03-internships renamed --dir $S; jls standin-set gh-vanshb03-newgrad hang --dir $S`, then `JOBLEFT_CLOCK_OFFSET=2h JOBLEFT_SOURCE_TIMEOUT_MS=3000 jls refresh` and `JOBLEFT_CLOCK_OFFSET=2h jls list` | Three different sentences, each with a UTC time: "server error (HTTP 500)", "the data format changed: ...", "did not answer within 3 seconds". `gh-speedyapply-swe` and the others still arrive. No blank rows |
| O6 no silent loss | `for p in "http500 7h" "empty 14h" "truncated 21h" "cutoff 28h"; do set -- ${=p}; jls standin-set remoteok $1 --dir $S; JOBLEFT_CLOCK_OFFSET=$2 jls refresh remoteok; done; jls jobs --source remoteok \| tail -1` (in bash use `set -- $p`) | Each refresh fails with a plain reason ("the answer listed no jobs, although this source listed 10 before" for the empty one); `10 job(s)` stay open; `jls list` shows the problem; nothing is deleted |
| O7 closes | Edit `$S/remoteok.json`: delete one posting object and add a copy of another with a new `id` and `url`. `JOBLEFT_CLOCK_OFFSET=2h jls refresh remoteok` | "1 new, 1 closed". The removed job shows only with `jls jobs --status closed` (`closedReason: source_removed`). Put it back and refresh 1 hour later: "1 reopened". Remove more than half of the jobs: "nothing was closed; they close if an answer at least 12 hours later still leaves them out" |
| O8 facts | `jls jobs --json` | Remote OK pay in USD per year (its form asks for annual USD); speedyapply `$60/hr` per hour; HN `€60k–€85k` in EUR; unknown pay, level and date stay `null`; `postedAt` is the source's own date |
| O9 remote regions | `jls jobs --remote --open-to-us` | "USA only", "Worldwide" and "Americas" jobs; never "Europe only" or "Germany"; "Data Annotator" (no region stated) only with `--include-unknown-region`. Words that leave the US out ("Worldwide (excluding US)", "Anywhere except USA", "Remote (Not US)", "Non-US", "outside the US", "US excluded") never show, not even with `--include-unknown-region`: the job keeps its words and `isUs: false`, and its regions list no US, WORLDWIDE or NA |
| O10 same posting | `jls jobs` | "Software Engineering Intern" at Acme Robotics is one job with two sources (the SimplifyJobs link with `?utm_source=Simplify`, the vanshb03 link without) and both credits |
| O11 hosts and identity | Read `$S/requests.ndjson` | Only the stand-in hosts of the sources you turned on; `user-agent` is always `jobleft/0.1.0 (+https://github.com/Blueturboguy07/jobleft; no personal data)`; no persona data; the gap between two requests to one host is never under 1 second, and never under a longer `Crawl-delay` from the host's robots.txt (put `User-agent: *` and `Crawl-delay: 4` in `$S/robots/raw.githubusercontent.com.txt`: every gap to that host, the one after `/robots.txt` included, is at least 4 seconds) |
| O12 safe text | `jls jobs --source remoteok --json`, job "Security Test Posting" | The description is plain text: the script, the image with `onerror`, the frame and the 1-pixel image are gone |
| O13 no storage | No approved source forbids storage | The runner never stores a feed marked `storable: false` (see the tests) |
| O14 control | `jls disable remoteok; JOBLEFT_CLOCK_OFFSET=3h jls refresh; JOBLEFT_CLOCK_OFFSET=3h jls list` | `SKIPPED remoteok ... is off`; no new remoteok.com line in the log. Its jobs are hidden from `jls jobs` (never deleted: `jls jobs --include-off` shows them) and its OPEN count is 0. For every source, OPEN in `jls list` equals the count from `jls jobs --source <id> \| tail -1`. `jls enable remoteok` brings them back |
| O15 offline | Disconnect the network; run section 3 | Every source produces the fixture jobs or its scenario's status |

Timing of closes (O7): a job that a complete, healthy answer no longer lists is closed at that refresh, that is at
the source's next allowed refresh (1 hour later for Remote OK and the GitHub lists, 6 hours for HN and The Muse). A
drop of more than half of 10 or more open jobs closes only when a second answer at least 12 hours later confirms it.

A job that two sources list (one link, tracking parameters removed) stays open while either source lists it. It closes
at the refresh where the LAST source drops it, whichever source created the job row and in whichever order the
sources drop it. Then it is gone from `jls jobs` and shows in `jls jobs --status closed` with `closedReason:
source_removed`. To see it: put a copy of the same posting (same job link) in both `$S/gh-simplify-internships.json`
and `$S/gh-vanshb03-internships.json`, refresh both, delete it from one file and refresh that source 2 hours later (the
job is still open), then delete it from the other file and refresh that source (the job closes at that refresh).

## 7. Rules the code keeps

| Rule | Where |
|---|---|
| Nothing is sent to a host outside the source's own list, a never-crawl host (LinkedIn, Indeed, Glassdoor, SmartRecruiters, Workday, iCIMS, Oracle, UKG, Taleo), or any host in stand-in or offline mode | `src/http.ts` `FeedClient` |
| robots.txt is obeyed on every host; `ROBOTS_EXCEPTIONS` is empty and only the owner may add to it | `src/http.ts`, `src/catalog.ts` |
| Redirects are never followed | `src/http.ts` |
| One request a second per host across sources and processes (SQLite slots). A robots.txt `Crawl-delay` above that is the gap between all requests to the host: it also holds the first request after `/robots.txt` (`HostPacer.hold`), and a jitter margin of 100 ms is added like for the 1 second floor | `DbPacer`, `FeedClient` in `src/http.ts` |
| Runs and requests are counted in SQLite over a rolling 24 hours, reserved atomically, with a run lease | `src/limits.ts` |
| Keys go only to their source's host; The Muse takes its key only as the `api_key` URL parameter, so every URL jobleft writes is redacted; error texts hold host and path only | `src/http.ts`, `src/runner.ts` |
| Facts are the source's; unknown is `null`; a zone-less time is read as UTC; the fetch time is never a posted date | `src/feeds/*.ts`, `src/text.ts` |
| Descriptions are stored as plain text (HTML to text) | the crawler's `normalizeJob` |
| An error, an empty answer, a cut-off or partial answer, or an unreadable posting closes nothing and deletes nothing | `src/runner.ts` |
| Two sources with the same posting (same link after tracking parameters are removed) share one job and keep both credits; the same title at the same company with another link stays a separate job. The shared job closes when its last source drops it (`settleBoard`) | `src/runner.ts`, `src/view.ts` |
| A remote region the words leave out ("excluding US", "except USA", "Not US", "Non-US") is never a stated region, and it takes back a wider region that would hold it (WORLDWIDE, NA) | `src/text.ts` `parseRemoteScope`, `scopeOpenToUs` |

## 8. For other lanes (library)

```ts
import { Store } from '@jobleft/crawler';
import { SourceService } from '@jobleft/sources-other';

const svc = new SourceService({ store: new Store(dbPath), secrets: osSecretStore() });
await svc.list();                              // GET    /api/v1/sources
await svc.update('remoteok', { enabled: true }); // PATCH  /api/v1/sources/:sourceId
await svc.setKey('themuse', key);              // PUT    /api/v1/sources/:sourceId/key
await svc.deleteKey('themuse');                // DELETE /api/v1/sources/:sourceId/key
await svc.refresh({ reason: 'manual' });       // with too_early results that carry nextAllowedAt
await svc.runDue('launch');                    // launch catch-up; call runDue('schedule') on the tray timer
```

`SourceServiceError.code` maps to the API error codes: `not_found` 404, `conflict` 409 (turning on a not-crawled
source), `bad_request` 400 (a key in the wrong form). Feed jobs live in the crawler's `jobs` table (`ats =
"feed:<id>"`); this lane's `feed_postings` table holds each source's link, credit and stated facts (see
docs/INTERFACES.md section 3). `feedJobs()` and `exportFeedJobs()` show how they map to the `Job` contract;
`creditLine(job.sources)` gives the credit text for notifications and alerts.

## 9. Tests

```sh
pnpm --filter @jobleft/sources-other test        # 49 tests, about 16 s, no live request
pnpm --filter @jobleft/sources-other typecheck
```

The fixtures are made-up employers and text in the exact structure of each source's real answer. Each real answer was
read once on 2026-09-25; only its structure (paths and types, no data) is kept in `fixtures/*/shape.json`, and the
tests check that no fixture has a path the real answer lacks. `pnpm --filter @jobleft/sources-other run fixtures` rewrites the fixtures (add `-- --captures <dir>` with fresh real answers to rewrite the shape signatures too).

## 10. Known limits

- USAJOBS and Remotive are built and tested but not crawled (robots.txt). The owner decides.
- The Muse and HN terms have open questions for a public release (docs/sources/themuse.md, hn-whoishiring.md).
- A feed job that another source also lists under a different link (for example Remote OK's own page and the
  employer's Greenhouse page) shows as two jobs. Merging by title alone would merge different jobs.
- The job cards, detail view, tracker and alerts are other lanes. This lane gives them the data, the credits and
  `creditLine()`.
