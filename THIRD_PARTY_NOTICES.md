# Third-party notices

This file records every piece of third-party code, data or model that jobleft copies, ports or ships.
Rules (from the build rules):

- Copy or port code only from MIT, Apache-2.0 or BSD sources. Add an entry here in the same commit.
- AGPL and GPL code is reference only. Never copy it. Record a reference only when a design was studied closely.
- Data files need their own entry (source, licence, date, attribution text), even when the code that uses them is ours.
- Never ship data under a non-commercial licence (for example CC BY-NC). Keep share-alike data out of the shipped app, or isolate it and say so here.
- An entry names: the source (URL and commit), the licence, the files in this repository that hold the copied or ported work, and what was taken.

## 1. Code ported or copied into jobleft

### 1.1 freehire (MIT)

- Source: https://github.com/strelov1/freehire, commit `e58b1af64414b2dca7d1566d5d0db17f44a82ac2` (2026-09-24). Read-only clone at `vendor/freehire` (not committed).
- Licence: MIT. Copyright (c) 2026 freehire contributors. Full text in section 5.1.
- What was taken: logic only, re-written from Go to TypeScript by the S1 spike (2026-09-24) and moved into this repository by the foundation commit. No Go file, data list, brand mark, image or certificate was copied.

| jobleft file | Ported from (freehire path) | What |
|---|---|---|
| `packages/crawler/src/sources/greenhouse.ts` | `internal/ingest/sources/greenhouse.go` | Greenhouse board API mapping |
| `packages/crawler/src/sources/lever.ts` | `internal/ingest/sources/lever.go` | Lever postings API mapping |
| `packages/crawler/src/sources/ashby.ts` | `internal/ingest/sources/ashby.go` | Ashby job-board API mapping |
| `packages/crawler/src/sources/util.ts` | `internal/ingest/sources/*.go` helpers | `isRemote`, `workplaceTypeMode`, `roundSalaryPart`, `countryFromCode`, the "not in the future" date rule |
| `packages/crawler/src/lifecycle.ts` | `internal/ingest/pipeline/board_scope.go`, `cooldown.go`, `cmd/ingest/main.go` | Close-vanished guards (board coverage proof, sweepable providers, sweep grace, cooldown backoff, empty-feed net) |
| `packages/crawler/src/types.ts` | `internal/ingest/sources` `Source` interface | Adapter contract shape (`fullBoardListing` marker) |
| `packages/parsers/src/html.ts` | `unescapeEncodedHTML` rule | Decode one entity layer only when encoded tags outnumber live tags |

Local additions that are not in freehire (written new): the per-host pacer, the robots.txt parser and check, the never-crawl host list, the mass-close guard (`closeTooBroad`), the empty-streak rule, the level and pay parsers, the US-location heuristic and the SQLite store.

### 1.2 Internship Machine (first party)

- Source: the owner's own Python project (`~/Documents/internships`, `pipeline/normalize.py` and `pipeline/dedup.py`). First-party code, no third-party licence applies.
- jobleft file: `packages/crawler/src/normalize.ts` (URL canonicalisation, company and title normalisers, the two-layer dedupe spine). Two deliberate changes are documented in that file (`gh_jid` is kept; intern words are kept).

## 2. Data shipped with the app

The static-data lane adds its entries here (H-1B sponsor table from US Department of Labor LCA disclosure files, city dictionary with its attribution, skill dictionary).

### 2.1 Board directory (added by the boards lane)

- File: `packages/boards/data/board-directory.json` (the header names every source, its licence, a public page and a notice; it ships with the app). Removed rows, with both "not found" dates: `packages/boards/data/board-directory-pruned.json`.
- Source: JobSync bundled company board lists, https://github.com/Gsync/jobsync, commit `527333e60d4913f3af217c2153a8ee7bc68cf857` (2026-09-14). Read-only clone at `vendor/jobsync` (not committed). Files: `src/lib/scraper/greenhouse/companies.json` (602 rows), `src/lib/scraper/lever/companies.json` (1,160 rows, 81 on Lever's EU host), `src/lib/scraper/ashby/companies.json` (1,860 rows).
- Licence: MIT. Copyright (c) 2024 gsync. Full text in section 5.2. The upstream repository does not say how the lists were made (open question for the owner; see below).
- What was taken: each row's board token and employer name. No JobSync code was copied (`packages/boards/scripts/build-directory.ts` reads the files and is written new).
- What jobleft changed: rows normalised to `{ ats, slug, name, region, source, lastVerified, status }`; every Greenhouse row, every EU Lever row and a random sample of the other Lever and Ashby rows were checked against the providers' public APIs on 2026-09-25 (1 request per second per host, robots.txt obeyed, User-Agent `jobleft-build/0.1 (research build; no personal data)`); where a Greenhouse board reports a different name in its own API (`GET boards-api.greenhouse.io/v1/boards/{token}`), the row now carries the board's own name (4 rows); rows that answered "not found" are marked `suspect` and are removed only after a second "not found" at a later time: 41 rows (31 Greenhouse, 9 Lever, 1 Ashby) were removed this way on 2026-09-25, so the file ships 3,581 rows (571 Greenhouse, 1,151 Lever, 1,859 Ashby).
- Not used, on purpose: the `data/` board lists of Feashliaa/job-board-aggregator and of colophon-group/jobseek (both CC BY-NC 4.0, non-commercial). No directory row comes from them.
- Not used yet: the Common Crawl URL index. `packages/boards/scripts/cc-discover.ts` can extract board tokens from it, but on 2026-09-25 the robots.txt of index.commoncrawl.org and data.commoncrawl.org disallows all crawlers, so jobleft sent no index request and the directory holds no Common Crawl row. If the owner later obtains index answers another way, rows added from them are named `commoncrawl-<crawl id>` in the directory header, with the Common Crawl Terms of Use (https://commoncrawl.org/terms-of-use, last updated 2024-03-07: a limited licence; commercial use is not excluded; legal advice is recommended); their employer names come from each board's own API, never from crawled text.
- Open question for the owner: JobSync's lists carry JobSync's MIT licence, but their own upstream origin is not documented. Before a public release, confirm with the JobSync maintainer that the lists were not copied from a non-commercial list.

## 3. Development tools (not shipped in the app)

| Package | Version | Licence | Use |
|---|---|---|---|
| typescript | 7.0.2 | Apache-2.0 | Type checking only (`tsc --noEmit`). Platform binaries come as optional dependencies; no install script |
| @types/node | 24.13.6 | MIT | Node 24 type definitions |

## 4. Install scripts that run

None. `pnpm-workspace.yaml` sets `ignoreScripts: true` and an empty `allowBuilds`. A lane that needs a dependency's install script reads it first and records it here: package, version, script, why it is needed.

## 5. Licence texts

### 5.1 MIT licence (freehire)

```
MIT License

Copyright (c) 2026 freehire contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 5.2 MIT licence (JobSync)

```
MIT License

Copyright (c) 2024 gsync

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
