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

### 1.3 pdf.js font metrics (Apache-2.0), resume lane

- Source: Mozilla pdf.js 6.1.200 (`src/core/metrics.js` and `src/core/encodings.js`), as bundled in the npm package `unpdf` 1.8.1 (`dist/pdfjs.mjs`). pdf.js is Apache-2.0; the widths are Adobe's Core 14 AFM metrics for Helvetica and Helvetica-Bold, which Adobe allows to be copied and distributed.
- What was taken: data only. The glyph widths of Helvetica and Helvetica-Bold and the WinAnsiEncoding glyph list, extracted by `packages/resume/scripts/extract-helvetica-metrics.ts` into a width table per WinAnsi byte.
- jobleft file: `packages/resume/src/render/helvetica-metrics.ts` (generated; its header names the source).
- Licence text: Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0 (pdf.js, Copyright Mozilla Foundation).

### 1.4 Designs studied for the resume lane (no code copied)

| Source | Licence | What was studied | jobleft files written new from the idea |
|---|---|---|---|
| srbhr/Resume-Matcher `apps/backend/app/services/resume_preservation.py` (commit a09ef5da) | Apache-2.0 | New-number check on rewritten bullets, grounding similarity warning | `packages/resume/src/truth.ts`, `src/tailor.ts` (`numbersKept`, `warnFor`) |
| career-ops-hq/career-ops `verify-cv-facts.mjs` (commit de7f7fe8) | MIT | Metric, employer and title claims checked against the source CV before any PDF | `packages/resume/src/facts.ts`, `src/truth.ts` |
| reactive-resume `packages/import/src/plain-text.ts`, `packages/resume/src/ats-pdf/` (commit 73ed3f9b) | MIT | Section alias table, entry grouping by dates, weighted readability categories with caps | `packages/resume/src/import/parse.ts`, `src/lexicon.ts`, `src/ats.ts` |

Resume-Matcher's job-description skill adder (`improver.py`) was deliberately not used.

## 2. Data shipped with the app

None yet. The static-data lane adds entries here (board directory, H-1B sponsor table from US Department of Labor LCA disclosure files, city dictionary with its attribution, skill dictionary).

## 3. Development tools (not shipped in the app)

| Package | Version | Licence | Use |
|---|---|---|---|
| typescript | 7.0.2 | Apache-2.0 | Type checking only (`tsc --noEmit`). Platform binaries come as optional dependencies; no install script |
| @types/node | 24.13.6 | MIT | Node 24 type definitions |

## 3a. Runtime dependencies (shipped with the app)

| Package | Version | Licence | Used by | Use |
|---|---|---|---|---|
| unpdf | 1.8.1 | MIT (bundles Mozilla pdf.js 6.1.200, Apache-2.0) | `@jobleft/resume` | Reads PDF files (text, positions, fonts, operators) for resume import and the readability check. No install script; its optional peer `@napi-rs/canvas` is not installed. Called with bytes only and no font, CMap or wasm URL, so it makes no network request |

Fonts: when a PDF needs letters outside the standard PDF fonts, `@jobleft/resume` embeds a TrueType font found on the person's own computer (Arial, Liberation Sans or DejaVu Sans, or the files named in `JOBLEFT_PDF_FONT`) into that person's own PDF. No font file ships with jobleft.

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
