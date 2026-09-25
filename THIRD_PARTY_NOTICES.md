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

### 1.3 Designs studied closely by the match lane (no code or data copied)

The match engine (`packages/match`) is written new. These MIT-licensed modules were read as references only; no file,
function, list or text was copied or ported.

| Source (read-only) | Licence | What was studied | Where the idea shows up in jobleft |
|---|---|---|---|
| freehire `internal/candidate/jobmatch/jobmatch.go` (commit `e58b1af6`, `vendor/freehire`) | MIT | Skill coverage with exact and "adjacent" matches, an adjacent match counting half | `packages/match/src/score.ts` (Skills part: a related skill counts half and still shows as missing) |
| freehire `internal/candidate/hardconstraint/hardconstraint.go`, `degrees.go` | MIT | Blockers per category with a score ceiling; judge a category only when both sides carry data | `packages/match/src/score.ts` (caps; "not in your profile" instead of a guessed answer) |
| freehire `internal/dict/skilladjacency`, `internal/dict/skilltag` (comments on ambiguous words) | MIT | A conservative list of substitutable skills; words such as "slack", "react", "epic", "assembly" that are also ordinary words | `packages/match/data/skills.tsv` (case and context rules; related skills) |
| career-ops `jd-skill-gap.mjs`, reactive-resume `jd/match.ts` (as summarised in `jobright-research/audit/03`) | MIT | Requirement-section detection by headings; weighting required over preferred terms; stuffing counted once | `packages/match/src/text.ts`, `src/job.ts` |

The starting weights of the overall percent (0.24 / 0.29 / 0.08 / +36) come from the project's own observation notes
(`jobright-research/ui/UI-SPEC-LOGGED-IN.md`, section MATCH SCORE), not from any code or dataset.

## 2. Data shipped with the app

### 2.1 Match dictionaries (first party)

- Files: `packages/match/data/skills.tsv` (about 550 skills with aliases, contexts and related skills),
  `credentials.tsv` (90 licences and certifications), `occupations.tsv` (46 kinds of work, about 1,500 job-title
  phrases, how close two kinds are), `industries.tsv` (30 industries with posting and employer-name phrases).
- Source: written new for jobleft by the match lane on 2026-09-25 from general knowledge of job titles, tools, trade
  skills and licences. No third-party list, taxonomy or dataset (O*NET, ESCO, Lightcast, freehire, or any other) was
  copied or transformed. Each file states this in its header.
- Licence: the jobleft project's own licence (not decided yet; see the root `package.json`).

### 2.2 Other data

None yet. The static-data lane adds entries here (board directory, H-1B sponsor table from US Department of Labor LCA disclosure files, city dictionary with its attribution, skill dictionary).

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
