# @jobleft/crawler

The crawler core. It fetches employers' public job boards, turns each posting into one normalised row,
dedupes, stores the rows in SQLite, and closes postings that vanish, with guards that stop a failed
crawl from closing anything.

Status: ported from the S1 spike (`spikes/s1-ingest/crawler`, report `spikes/s1-ingest/REPORT.md`).
64 of the 76 ported S1 tests live here (the other 12 are in `@jobleft/parsers`). The full interface is in
[docs/INTERFACES.md](../../docs/INTERFACES.md), section `@jobleft/crawler`.

```
adapters (Source) -> HttpClient (never-crawl list, robots.txt, pacer, budget) -> normalizeJob -> dedupeBatch
  -> Store.upsertJob -> board health (cooldown) -> sweep (close unseen, only where coverage was proven)
```

## What it guarantees

| Rule | Where |
|---|---|
| One honest User-Agent on every request: `jobleft-build/0.1 (research build; no personal data)` | `src/http.ts` `USER_AGENT` |
| Never LinkedIn, Indeed, Glassdoor, SmartRecruiters or Workday (refused before any request, also as a redirect target) | `src/http.ts` `DENY_HOST` |
| robots.txt per host (RFC 9309). A 5xx or network failure on robots.txt means "disallow all" for the run | `src/robots.ts`, `HttpClient.robotsFor` |
| At most 1 request per second per host, more when Crawl-delay asks | `Pacer` |
| 403 or 429 stops the board with no retry; two in a row trip the host for the run | `HttpClient.getText` |
| Redirects are never followed | `redirect: 'manual'` |
| A total request budget per client | `maxRequests` (default 3,000) |
| A posting closes by absence only when this run proved it read the whole board; never more than half a big board at once | `src/lifecycle.ts`, `src/crawl.ts` |
| `gh_jid` is kept in canonical URLs (it is the job id on company-hosted Greenhouse pages) | `src/normalize.ts` |
| No IT-only gate: nurses, cashiers and drivers are kept like engineers | `src/job.ts` |

## CLI

The package has one CLI, `jobleft-crawl` (`src/cli.ts`). From the repository root (always use `run`: `pnpm search`
is a built-in pnpm command, so `pnpm --filter ... search` would not reach the script):

| Command | What it does |
|---|---|
| `pnpm --filter @jobleft/crawler run crawl --boards <boards.json> --db <run.db> --out <run.json>` | Crawl every board in the list into the SQLite file and write the run report |
| `... crawl ... --grace-hours 48 --max-requests 3000` | Sweep grace window and request budget |
| `... crawl ... --now 2026-09-28T00:00:00Z` | Time-skip: store and sweep as if the clock said this (the pacer still uses real time) |
| `pnpm --filter @jobleft/crawler run verify --in <boards.json> --out <verify.json>` | One request per board, to see which boards are live |
| `pnpm --filter @jobleft/crawler run report --db <run.db>` | Coverage report of a crawl database (pay, level, dates, US share, sizes) |
| `pnpm --filter @jobleft/crawler run search --db <run.db> --q "registered nurse"` | Full-text search of open, non-duplicate rows |

A board list is a JSON array of `{ "ats": "greenhouse" | "lever" | "ashby", "board": "<token>", "company": "<name>", "region"?: "eu" }`.

Paths given to `--db` and `--out` are relative to `packages/crawler` when you use `pnpm --filter`. Use absolute paths
or a folder under `/private/tmp` for throwaway runs.

### Crawl against local mock servers

`JOBLEFT_HOST_MAP` sends a real ATS host to a mock server on this computer. Only loopback targets
(`127.0.0.1`, `localhost`, `[::1]`) are accepted, and the never-crawl list is checked on the real host first.
Each mock server counts as its own host for the pacer and for robots.txt.

```sh
JOBLEFT_HOST_MAP='{"boards-api.greenhouse.io":"http://127.0.0.1:4010","api.lever.co":"http://127.0.0.1:4011"}' \
  pnpm --filter @jobleft/crawler run crawl --boards /private/tmp/boards.json --db /private/tmp/run.db --out /private/tmp/run.json
```

The mock must answer the same paths as the real API (for example `/v1/boards/<token>/jobs?content=true`
for Greenhouse) and may serve `/robots.txt`.

## Library

```ts
import { HttpClient, Store, crawl, SOURCES } from '@jobleft/crawler';

const store = new Store('/path/to/jobleft.db');
const http = new HttpClient({ maxRequests: 500 });
const report = await crawl([{ ats: 'lever', board: 'acme', company: 'Acme' }], { store, http, sources: SOURCES });
```

A new adapter implements `Source` (`src/types.ts`): `ats`, `fullBoardListing` (true only when one request returns the
whole board) and `fetchBoard(board, http)`. It may only use the `HttpGetter` it is given.

## Tables this package owns

`jobs`, `jobs_fts` (FTS5, external content) and `boards`, created by `Store` (`src/store.ts`). Other packages read them
through the columns listed in docs/INTERFACES.md and never write them. Schema changes are additive.

## Not ported from the spike

The spike's one-off analysis scripts (`scripts/analyze.ts`, `gates.ts`, `export-jobs.ts`, `inject-canaries.ts`,
`sample-boards.ts`) and its board lists stay in `spikes/s1-ingest/crawler`. They measured the spike; they are not part
of the crawler.

## Commands

| Command | What it does |
|---|---|
| `pnpm --filter @jobleft/crawler test` | Run the tests (`node --test "test/*.test.ts"`) |
| `pnpm --filter @jobleft/crawler typecheck` | Type-check (`tsc -p tsconfig.json`) |
