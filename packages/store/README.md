# @jobleft/store: the local job store

The store keeps every job on the laptop in one SQLite file, finds jobs by words and by every filter of the
"All Filters" drawer, and ranks them by fit to a profile with a small embedding model that runs on the CPU.
Nothing about a search, a filter or the profile leaves the laptop. The only outbound request the store ever makes is
the one-time download of the fit model (below).

This README is the whole interface for testing: every command here works from a fresh checkout.

## 1. Set up (once)

Needs macOS on Apple silicon (built and measured on an M4 Pro with 24 GB), Node 24 or newer, and pnpm.

```sh
cd <repo root>
pnpm install                          # installs onnxruntime-node 1.30.0 (install scripts stay off)
export JOBLEFT_HOME=/private/tmp/jl-demo   # the data folder; default: ~/Library/Application Support/jobleft
alias jobleft-store='node packages/store/src/cli.ts'
jobleft-store init
```

You see the data folder and the database path. Every command below accepts `--home <dir>` instead of
`JOBLEFT_HOME`, and `--json` for JSON output. `jobleft-store help` lists every command.

## 2. Five-minute tour

```sh
jobleft-store seed --synthetic 5000                  # 5,000 synthetic jobs (plus their company facts)
jobleft-store search --q "C++ developer" --limit 5   # words
jobleft-store search --filter '{"workModels":["remote"],"minAnnualPayUsd":120000}' --sort most_recent
jobleft-store model download                         # 133.3 MB, once (see section 7)
echo '{"summary":"Invoices, vendor payments and month-end close.","skills":[{"name":"NetSuite","years":3,"source":"user"}]}' > /private/tmp/profile.json
jobleft-store profile set /private/tmp/profile.json
jobleft-store index                                  # fit indexing: about 100 to 250 jobs a second
jobleft-store search --sort top_matched --limit 5    # fit order, with a fit score per job
jobleft-store status                                 # indexed, waiting, last run, model
jobleft-store serve                                  # the HTTP endpoints (section 8); Ctrl-C to stop
```

Each search prints `<total> jobs (<ms> ms). Fit: <state>`, then one line per job: title, company, places, work
model, pay as stated, posted date, the fit score in Top Matched, and the job id. Facts the posting does not state show
as `not stated`.

## 3. Commands

| Command | What it does |
|---|---|
| `init` | Creates the data folder (mode 0700) and database (mode 0600); prints where they are |
| `import-jobs <file.ndjson>` | Imports jobs, one JSON object per line (section 4). `-` reads standard input. Prints how many were new, changed, unchanged, merged, reopened, closed and refused (with the line number and reason of the first refusal) |
| `import-jobs <file> --complete` | The file is the whole current listing of its board(s): listed jobs are saved, and open jobs of the same board that the file no longer lists are closed. This is the documented "refresh" (section 6) |
| `seed --synthetic <n> [--seed 42] [--prefix syn]` | Adds n synthetic jobs with realistic text lengths (median about 4,500 characters) and their company facts |
| `gen --synthetic <n> --out <file>` | Writes the same synthetic jobs as NDJSON without importing them (edit them, plant jobs, then `import-jobs`) |
| `search [--q words] [--sort recommended\|top_matched\|most_recent] [--filter '<JSON>'] [--limit 20] [--cursor c]` | One page of results. `--all` pages to the end and prints the total, the distinct jobs reached and any repeats |
| `get <jobId>` | One job with every stored fact, and its tracker entry |
| `close <jobId...>` | Closes jobs (they leave every result at once) |
| `sync-crawler` | Copies the crawler's `jobs` table (same database file) into the store: new and changed jobs, and jobs the crawler closed (section 6) |
| `profile show \| set <file.json> \| clear` | The profile used for fit order. `set` takes a `ProfileInput` JSON; missing parts are empty |
| `tracker like\|unlike\|hide\|unhide <jobId>` | Like a job, or mark it "not interested" (hidden) and undo |
| `tracker status <jobId> applied\|interviewing\|offer_received\|rejected\|archived\|none` | Tracker status |
| `tracker note <jobId> <text>` | Adds a note |
| `tracker list liked\|applied\|external\|hidden\|closed` | A tracker view with its counts |
| `filters save <name> --filter '<JSON>' --sort <sort> [--default]` / `filters list` / `filters delete <id>` | Saved filters. `--default` makes it the default filter of `GET /api/v1/jobs` and the first filter fit indexing works on |
| `model status \| download \| verify` | The fit model: state, size, source, checksum check |
| `index [--limit n] [--no-download]` | Runs fit indexing now (downloads the model first if it is missing, unless offline) |
| `status` | Fit indexing: state, indexed, waiting, and the last run (how many it indexed, start, finish) |
| `stats` | Data folder, database path, size on disk, bytes per job, open and kept jobs, vectors, model state |
| `vacuum [--full]` | Compacts the word index and gives freed pages back to the disk |
| `export-saved` | Saved jobs (liked, tracked or added) with their source credits, as NDJSON |
| `serve [--port 47850] [--token <t>] [--no-download]` | The loopback HTTP server (section 8) with background fit indexing |
| `bench [--queries 300]` | Times the section 9 query mix on the current store, in this process |
| `bench --synthetic <n>` | Builds an n-job store in memory (nothing on disk), with random unit vectors standing in for fit vectors, and times the query mix |

Exit codes: 0 done; 1 a plain error (the message says what); 2 a wrong command or argument.

## 4. Import format (known job sets)

One JSON object per line. Required: `title`, `company`, and `url` (an absolute http or https link). Everything else
is optional, and a fact you leave out stays **unknown**: the store never fills a default (no "Onsite", no "$0",
no "United States", no crawl time as a posted date).

```json
{"id":"acme-101","title":"Senior C++ Engineer","company":"Acme Robotics, Inc.","url":"https://jobs.example.com/acme/101",
 "description":"Plain text of the posting.","places":["Austin, TX","Seattle, WA"],"workModel":"hybrid",
 "employmentType":"full_time","level":"senior","yearsRequired":{"min":5,"max":null},
 "pay":{"min":150000,"max":190000,"currency":"USD","period":"year"},"postedAt":"2026-09-20T15:00:00Z",
 "skills":["C++","Linux"],"statements":{"sponsorship":"no","clearanceRequired":null,"usCitizenOnly":null}}
{"title":"Barista","company":"Cafe Uno","url":"https://jobs.example.com/cafe/7","pay":{"min":18,"max":22,"currency":"USD","period":"hour"}}
{"type":"company","name":"Acme Robotics, Inc.","industries":["Robotics"],"stage":"growth","isStaffingAgency":false,"h1b":"likely"}
```

| Field | Values and meaning |
|---|---|
| `id` | Any string. Without it: `<ats>:<board>:<externalId>` when those are given, else `ext:` plus a hash of the canonical link |
| `places` | Strings (`"Austin, TX"`, `"London, GB"`, `"Remote - US"`) or objects `{text, city, region, country, placeId}`. `location: "A; B"` is read as two places. `[]` = not stated |
| `workModel` | `onsite`, `hybrid`, `remote`, or absent (unknown) |
| `remoteScope` | `{"regions":["US"],"text":"Remote (US only)"}` for remote jobs |
| `employmentType` | `full_time`, `part_time`, `contract`, `internship`, `temporary`, `other` |
| `level` / `levels` | Fine level (`intern` ... `exec`) and/or filter buckets (`intern_new_grad`, `entry`, `mid`, `senior`, `lead_staff`, `director_exec`). A level without buckets gives its bucket |
| `yearsRequired` | `{"min":3,"max":5}` |
| `pay` | `{min, max, currency, period}`; `period` is `hour`, `day`, `week`, `month` or `year`. Pay stays in its own period; the yearly figure (2,080 hours, 260 days, 52 weeks, 12 months) is kept beside it for the pay filter |
| `postedAt` | RFC 3339, or `YYYY-MM-DD` (kept as that calendar day at 00:00 UTC). Absent = not stated |
| `statements` | What the posting itself says: `sponsorship` `yes`/`no`, `clearanceRequired`, `usCitizenOnly` |
| `ats`, `board`, `externalId` | The ATS posting identity (used for dedupe and for `--complete` board refreshes) |
| `sources` | `[{sourceId, name, url, credit?}]`. Default: `ats:<ats>` for ATS jobs, else `import` (or `--source <id> --source-name <name>`) |
| `status` | `open` (default) or `closed` |
| `{"type":"company", ...}` lines | Company facts the filters read: `industries`, `stage` (`early`, `growth`, `late`, `public`), `isStaffingAgency`, `h1b` (`likely`, `some_history`, or null). Match by `key` or by `name` (the company key ignores case, accents, punctuation and legal suffixes, so "Stripe" and "Stripe, Inc." are one company) |

A line that is not valid JSON or misses a required field is refused on its own (reported with its line number);
the other lines are imported. Contract `Job` records (the local API shape) are accepted as they are.

## 5. Search: words, filters and sorts

The same search runs in the CLI (`search`) and the endpoint `POST /api/v1/jobs/search` (section 8). Request body:
`{ "sort": "recommended"|"top_matched"|"most_recent", "q"?: "words", "filter"?: { ... }, "limit"?: 1-100, "cursor"?: "..." }`.

**Words.** A job matches when every word appears in its title, company, skills, department, places or description.
Words are matched by stem (`engineering` finds `engineer`) and without accents (`Societe Generale` finds
`Société Générale`). `C++`, `C#`, `F#`, `.NET`, `ASP.NET`, `Node.js` (also `nodejs`, `node js`), `401(k)`, `R&D`
are words of their own: `C++` finds neither `C` nor `C#` jobs. A one-letter prefix with an apostrophe is also one
word: `Loreal`, `L'Oréal` and `L Oreal` all find `L'Oréal` (`O'Reilly` the same; contractions such as `I'll` are left
alone). Quotes, `*`, brackets, hyphens, a lone `-`, and
`AND`, `OR`, `NOT`, `NEAR` are ordinary text, never syntax: such a query returns results or zero results, never an
error. Glue words (`and`, `or`, `the`, `in` ...) are dropped when other words remain. An empty query, or one with
nothing searchable (`-`, `""`), returns the normal list.

**Filters.** Every result meets every active filter. A job whose fact is unknown **fails** a filter on that fact
unless `includeUnknown` names it. Exclude filters always win over include filters. List filters match any of the
listed values.

| Filter | Passes when |
|---|---|
| `places: [{text, placeId, radiusMiles}]` | Any of the job's places is one of the listed places. `"Austin, TX"` = city and state (`"Austin, Texas"` works too); `"Texas"`/`"TX"` = the state; `"Austin"` = that city anywhere; a country name = that country. Every place of a multi-place job counts. `radiusMiles` needs the place data of the static-data lane; without it only the place itself matches. `includeUnknown: ["place"]` lets jobs with no stated place pass |
| `countries: ["US"]` | A place of the job is in the country (or the job is marked US) |
| `workModels` | The job's work model is listed |
| `remoteRegions: ["US"]` | The job is remote and its stated remote scope includes a listed region or `WORLDWIDE`. Onsite and hybrid jobs fail |
| `employmentTypes`, `levels` | The job's type / any of its level buckets is listed |
| `maxYearsRequired: n` | The job's minimum required years is at most n |
| `postedWithin: 24h\|3d\|7d\|30d` | Posted at most that long before now (an exact rolling window, no calendar-day or time-zone boundary). A job with no posted date never passes unless `includeUnknown: ["postedAt"]` |
| `minAnnualPayUsd: n` | The top of the stated range (the maximum, or the minimum when there is no maximum), converted to a year, is at least n US dollars. Unknown pay and pay in another currency fail unless `includeUnknown: ["pay"]` |
| `h1bSponsorship: true` | The posting says it sponsors, or the company's H-1B history is `likely` (company facts). A posting that says it does not sponsor always fails |
| `excludeClearanceRequired`, `excludeUsCitizenOnly` | Removes jobs whose posting states that requirement |
| `skills` / `excludedSkills` | Any listed skill is in the job's skills list (case and accents ignored; `C++`, `C#`, `C` and `.NET` are four different skills) / none is |
| `companies` / `excludedCompanies` | Company names or keys ("Stripe" matches "Stripe, Inc.") |
| `industries` / `excludedIndustries`, `companyStages`, `excludeStaffingAgencies` | Company facts. A company with no stated industry or stage fails an include filter; `excludeStaffingAgencies` removes only companies known to be agencies |
| `jobFunctions` | Every word of a listed function appears in the title or department |
| `excludedTitles` | Removes jobs whose title holds the phrase |
| `roleTypes: ["manager"\|"ic"]` | Manager = the level is manager or above, or the title says manager, director, head of, VP, chief, supervisor |
| `sources` | A listed source id is among the job's sources |
| `status: "closed"` | Only closed jobs (the default is open jobs only) |

**Sorts.** `recommended`: with words, jobs with the exact words in the title first, then stemmed title words, the
words in order, the share of the title they cover, company-name words; then the newest posting day. Without words:
the newest posting day, then postings that state more facts. `most_recent`: the employer's posted time, newest first;
jobs with no posted date come last (never the time the store first saw them). `top_matched`: the fit score, highest
first. Fit score = cosine(profile, job) minus 0.5 x cosine(average job, job), where the average is over every current
job vector in the store. The second part takes off the pull of text that every posting shares (communication
skills, benefits, equal-opportunity lines), so a job whose duties match ranks above a generic one. Jobs that wait
for fit indexing follow, marked `fitScore: null` ("not scored yet"). Ties always break by the job's row number, so
the same query on the same data gives the same order every time, also after a restart (the session scores with the
profile vector rounded to float16, the same copy that is kept on disk and read back after a restart).

## 6. Closed, hidden and duplicate jobs

- A closed job never appears in any result list or count, in any sort. A job the person liked, applied to, noted or
  hid keeps its row when it closes and moves to the Closed view (`tracker list closed`) with its likes, notes and
  status. A closed job that nobody tracks is removed.
- "Not interested" (`tracker hide`) removes the job from every result and count until `tracker unhide`; a refresh
  that lists the job again does not bring it back. `tracker list hidden` shows them.
- **Refreshing a board** (the documented way to close jobs): `import-jobs <listing.ndjson> --complete`. The file is
  that board's full current listing (jobs share one board: the same `ats` and `board`, or the same source). Listed
  jobs are saved; open jobs of that board that are missing are closed. Guards: an empty listing closes nothing, and a
  listing that would close more than half of a board with 10 or more open jobs closes nothing and says so ("Held").
  A board that fails to answer produces no file, so nothing changes.
- **Refreshing through the crawler**: run the crawler on the same database file, then `jobleft-store sync-crawler`:
  `pnpm --filter @jobleft/crawler run crawl --boards <boards.json> --db $JOBLEFT_HOME/data/jobleft.db --out /private/tmp/report.json`
  (point `JOBLEFT_HOME`'s crawl at a loopback mock board with `JOBLEFT_HOST_MAP`, see docs/INTERFACES.md). The
  crawler closes a vanished job only after 48 hours unseen and never on a failed or empty answer; the sync copies its
  decisions. `--now <RFC 3339>` on both commands moves the clock.
- **Duplicates**: one posting reached through several links is stored once: the same id, the same link after removing
  tracking parameters (`utm_*`, `gclid`, `fbclid`, `ref` and similar; job-id parameters such as `gh_jid` are kept),
  or the same Greenhouse, Lever or Ashby posting id (also inside a company careers link such as `?gh_jid=123`). The
  same company, title, places and text seen on another site is also one posting ("Stripe" and "Stripe, Inc." are one
  company). Two postings stay two when their posting ids differ or when their links are different pages of one site,
  also with the same title at the same company. Refreshing never adds a copy.

## 7. Fit order and fit indexing

- **Model**: BAAI/bge-small-en-v1.5 (MIT licence), fp32 ONNX, 384 dimensions, pinned to Hugging Face revision
  `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`. Download: 4 files, **133.3 MB** in total, from
  `https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/5c38ec7c.../` (`JOBLEFT_MODEL_BASE_URL` overrides it: another
  http(s) base, a `file://` URL or a folder path). It lands in `$JOBLEFT_HOME/models/bge-small-en-v1.5-5c38ec7/`.
- **When it downloads**: on `model download` or `index`, and in `serve` when the store holds jobs. Never on a search,
  never "to check for updates". A cut download resumes from where it stopped (HTTP Range) on the next try. Each file
  must match its size and sha256 before it is used; a file that does not is deleted. Once the files are in place the
  model is used offline: no network request, ever. `JOBLEFT_OFFLINE=1` forbids every request.
- **Before the model exists**: word search and filters work. Top Matched answers "Top Matched is not ready yet: the
  fit model has not been downloaded." (HTTP 503 `not_ready`), and `status` says `model_missing`.
- **Without a profile**: Top Matched answers "Top Matched needs a profile..." (HTTP 409 `needs_profile`) and shows no
  list. `profile clear` deletes the profile. A profile change changes fit order at the next search.
- **What is embedded**: for a job, its title, department, skills and about 450 characters of the part of the
  description about the role; for the profile, target titles, job functions, summary, skills, recent work and degrees
  (never contact details or equal-employment answers).
- **Queue**: jobs that pass the person's hard filters (the default saved filter, else the profile's levels, work models,
  countries and places) are embedded first, newest first; then jobs a Top Matched search found without a vector; then
  the rest. `serve` runs it in the background; `index` runs it now.
- **Never repeated**: each vector carries the hash of the text it was made from. A refresh with no text change, or a
  restart, embeds nothing; a pay, date or tracking-field change embeds nothing; a description change embeds that job
  again, and until then the job is shown as "not scored yet" (never with its old score). Vectors of another model are
  never mixed into a ranking.
- **Status** (`status`, `GET /api/v1/index/status`): `state` (`ready`, `indexing`, `model_missing`, `downloading`,
  `failed`), `indexed`, `waiting`, `modelBytes`, `modelSource`, and `lastRun {indexed, startedAt, finishedAt}`. A run
  starts at every `serve` launch (it records 0 when nothing waits) and after every data change; `finishedAt: null`
  means that run was cut (for example by a force quit).

## 8. The HTTP endpoints (`serve`)

`jobleft-store serve` starts a loopback server (127.0.0.1, port 47850 or `--port`) for the store's routes of the
local API in docs/INTERFACES.md section 6, with the same paths, bodies, answers and error shapes. It prints
`{"port":…,"token":…}` on standard output and writes `$JOBLEFT_HOME/run/store-serve.json` (mode 0600). Every route
but health needs the header `x-jobleft-token`.

```sh
jobleft-store serve --port 47850 --token local-test-token &
curl -s -H 'x-jobleft-token: local-test-token' -H 'content-type: application/json' \
  -d '{"sort":"recommended","q":"nurse","filter":{"workModels":["remote"]},"limit":20}' \
  http://127.0.0.1:47850/api/v1/jobs/search
```

| Route | Path |
|---|---|
| searchJobs | `POST /api/v1/jobs/search` (body above) |
| listJobs | `GET /api/v1/jobs?q=&sort=&cursor=&limit=&status=` (uses the default saved filter) |
| getJob | `GET /api/v1/jobs/<jobId>` (URL-encode the id) |
| listTracker / updateTracker | `GET /api/v1/tracker?view=liked\|applied\|external\|hidden\|closed` / `PATCH /api/v1/tracker/<jobId>` with `{liked?, hidden?, status?, notes?, reminders?}` |
| listFilters / createFilter / updateFilter / deleteFilter | `/api/v1/filters`, `/api/v1/filters/<id>` |
| getProfile / putProfile | `GET` / `PUT /api/v1/profile` (a full `ProfileInput`) |
| fitIndexStatus | `GET /api/v1/index/status` |
| storage | `GET /api/v1/storage` (data folder, database path, size in bytes, job counts) |
| exportJobs | `GET /api/v1/export/jobs` (NDJSON) |
| health | `GET /api/v1/health` (no token; no data) |

The response of a search: `{items, total, nextCursor, fit: {state, waiting, model}, tookMs}`; each item has the job
(every fact, plus a snippet), `liked`, `hidden`, `trackerStatus`, `h1bTag` (`likely_by_history`, `post_says_yes`,
`post_says_no`, or null = no tag) and `fitScore` (Top Matched only; null = not scored yet). `match` and
`networkCount` are null here (other lanes fill them in the app). Refused: any Host other than
`127.0.0.1:<port>`/`localhost:<port>` (403), any `Origin` header (403), a missing or wrong token (401), a token in the
address (401), a body that is not `application/json` (415), a body over 1 MiB (413), an invalid body (400). Errors are
`{"error":{"code","message"}}` with one plain sentence. The server's log (standard error) holds the time, method,
route name, status and milliseconds; never search words, profile text or job text. `serve` also watches the database:
jobs imported by another process are searchable at the next request.

## 9. Speed

Method (spike S2): filter columns in typed arrays in memory (a few milliseconds over 500,000 jobs), words from SQLite
FTS5 as row lists, fit order as a dot product over the candidates' vectors (float16 on disk, float32 in memory,
brute force, no approximate index), the first page picked without sorting the rest, and later pages sliced from the
kept order. Unlike the spike, fit order ranks every candidate, not only the best 1,000, so the total and paging stay
true to the end.

To measure end to end: start `serve` on a store of the size you want (`seed --synthetic 100000`, then `index`), and
send your queries to `POST /api/v1/jobs/search` (`tookMs` in each answer is the store's own time). The `bench`
command runs this mix in-process, 300 queries: words only, rare words, filters only, words and filters, fit order
with filters, broad filters (every US job), narrow filters (under 10 jobs), and page 20 of a long list.

Measured on this Mac (M4 Pro, 24 GB) while ten other build jobs shared the CPU:

| Case | p50 | p95 | max |
|---|---|---|---|
| 100,000 jobs, `bench --synthetic 100000` (in memory) | 2.8 ms | 9.2 ms | 45 ms (the first fit query scores every job) |
| 500,000 jobs, `bench --synthetic 500000` (in memory) | 11.3 ms | 52.2 ms | 152.5 ms (the first fit query over every job) |
| 500,000 jobs on disk through HTTP (`serve`), 3,000 mixed searches (a third Top Matched) | 20 ms | 32 ms | 82 ms |
| 50,000 jobs through HTTP while fit indexing worked through a 30,000-job backlog | 6.7 ms | 19.9 ms | 65.7 ms |

First search after a launch (500,000 jobs on disk, all fit-indexed): `serve` answers after 0.46 s (the filter
arrays load first); the first word search then takes 53 ms and the first Top Matched search 0.98 s (it waits for the
vectors, which load in about 0.6 s, and scores every job once). The profile vector is kept on disk, so Top Matched
needs no model after a restart. A new job is searchable at the next request after its import commits (0.4 s
in the test above), long before it is fit-indexed.

Writing: about 4,000 jobs a second with realistic descriptions (100,000 jobs in about 25 s; FTS5 word indexing of
4,500-character descriptions is most of it). Fit indexing: 100 to 280 jobs a second on the CPU, in a worker thread,
so searches stay fast meanwhile.

## 10. Crash safety

Every write is a SQLite transaction (WAL mode). A bulk import commits in chunks of 2,000 jobs, fit indexing in
batches of 64. A force quit (`kill -9`) or a crash loses at most the chunk that was being written: the store opens
with no repair step, every job, like, note, hidden job and saved filter written before is there, and running the same
import again finishes it without copies. Fit vectors already written stay; the next run continues with the jobs that
still wait. Two processes may use the store at once (for example `serve` and an `import-jobs`): SQLite serializes the
writers and readers are never blocked.

## 11. Privacy and files

- The data folder is created with mode 0700 and the database with 0600 (`-wal` and `-shm` take the same mode). The
  model files are 0600. Nothing is written outside `$JOBLEFT_HOME` except what you redirect yourself.
- Search, filters, fit indexing and the profile never cause a network request. The only outbound request is the
  model download of section 7, with the User-Agent `jobleft/0.1.0 (+https://github.com/Blueturboguy07/jobleft; no personal data)` and
  nothing about you in it. There is no telemetry, analytics or crash reporter.
- No log holds search words, profile text, resume text or job text.

## 12. Size on disk and memory

`stats` (and `GET /api/v1/storage`) shows where the store is and how big it is. Measured with realistic synthetic
descriptions (median about 4,500 characters): about 4.1 KB per job without fit vectors (2.7 KB of it is the job
record, compressed with zstd; 0.6 KB the word index) plus 0.8 KB per fit vector. That is about 490 MB per 100,000
fit-indexed jobs and about 2.4 GB per 500,000: above the 200 MB and 1 GB the store outcome O15 asks for. Closed jobs
that nobody tracks are removed, so a board whose jobs come and go does not grow the store; `vacuum` gives the freed
pages back to the disk. Memory at 500,000 fit-indexed jobs (`serve`, measured): 1.1 GB after launch, 1.6 GB after
1,000 mixed searches, then flat (+0.8% over the next 1,000). The vectors are 768 MB of it; kept result orders are
capped at 64 MB; the fit model (about 300 MB) is loaded only while it works and freed after a minute idle.

## 13. Known limits

- O15 sizes (section 12) are above target: full descriptions are kept per job and compress about 2.2 times one by one.
- `radiusMiles`, place ids and H-1B history from the shipped data wait for the static-data lane; until then company
  H-1B history comes from company fact lines, and places match by text.
- `match` (percent and band) and `networkCount` in results are filled by other lanes in the app, null here.
- Measured on one Mac under load; the 16 GB base Mac was not available.
- Fit quality, measured with 30 hand-written profile and target pairs hidden among 10,000 synthetic jobs
  (`JOBLEFT_TEST_MODEL_DIR=<model folder> JOBLEFT_TEST_FIT_SIZE=10000 pnpm --filter @jobleft/store test`): 27 of 30
  targets in the first 10 (plain cosine gave 24); a profile paired with the wrong target puts it in the first 10 for
  2 of 30. Misses: Material Handler, Customer Care Associate, UI Engineer, fields where many synthetic jobs repeat the
  profile's own words ("forklift", "Zendesk", "React"). With 3,000 synthetic jobs: 30 of 30.
- A new fit vector moves the average job, so the fit scores of a search change a little while indexing runs; with
  the same data the scores are the same in every session and after a restart.
- Skill tags and search words are made when a job is saved. A data file made before this build keeps the old skill
  tags (`C++`, `C#` and `C` as one skill) and the old apostrophe words until its jobs are imported again.
- Bulk writes are about 4,000 jobs a second with realistic descriptions, not the 70,000 a second the spike measured
  with 400-character summaries: indexing every word of a 4,500-character description is most of the cost.

## 14. Development

| Command | What it does |
|---|---|
| `pnpm --filter @jobleft/store test` | Unit and integration tests (24; the real-model fit check runs only with `JOBLEFT_TEST_MODEL_DIR=<model folder>`) |
| `pnpm --filter @jobleft/store typecheck` | Type check (`tsc`, no output files) |

Code: `src/db.ts` (schema, migrations), `src/record.ts` (import shape, keys, hashes, facets), `src/writer.ts`
(upsert, dedupe, close, refresh), `src/memindex.ts` (filter arrays), `src/search.ts` (words, filters, sorts, paging),
`src/vectors.ts` and `src/fit.ts` (fit vectors and indexing), `src/embed/` (tokenizer, ONNX model, download, worker),
`src/userdata.ts` (tracker, filters, profile, chats, notifications, settings), `src/service.ts`, `src/serve.ts`,
`src/cli.ts`.
