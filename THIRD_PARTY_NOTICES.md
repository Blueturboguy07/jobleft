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

### 1.3 Store lane (`packages/store`): nothing copied

- The BERT WordPiece tokenizer (`packages/store/src/embed/tokenizer.ts`) is written from the published algorithm
  (BertNormalizer, BertPreTokenizer, greedy longest-match WordPiece, `[CLS] $A [SEP]`). No code was copied. It was
  checked (outputs only) against the Hugging Face tokenizer of the spike S2 copy of `@huggingface/transformers` 4.3.0
  (Apache-2.0), which was run read-only from `spikes/s2-snapshot` and is not a dependency.
- The float16 conversion, zstd record format, search, filters, dedupe and fit queue are written new.

## 2. Data shipped with the app

None yet. The static-data lane adds entries here (board directory, H-1B sponsor table from US Department of Labor LCA disclosure files, city dictionary with its attribution, skill dictionary).

### 2.1 Downloaded on first use (not shipped): the fit model

| Item | Source | Licence | Where it goes |
|---|---|---|---|
| BAAI/bge-small-en-v1.5, fp32 ONNX (`onnx/model.onnx`, `vocab.txt`, `tokenizer_config.json`, `config.json`) | https://huggingface.co/BAAI/bge-small-en-v1.5, revision `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`; sha256 of each file pinned in `packages/store/src/embed/model.ts` | MIT (model card) | `$JOBLEFT_HOME/models/bge-small-en-v1.5-5c38ec7/`, verified before use |

### 2.2 Runtime dependencies (installed by pnpm, shipped with the app)

| Package | Version | Licence | Use |
|---|---|---|---|
| onnxruntime-node | 1.30.0 | MIT | Runs the fit model on the CPU (`packages/store`). Its install script (downloads CUDA files on Linux only) does not run and is not needed on macOS: the macOS binary is in the package |
| onnxruntime-common | 1.30.0 | MIT | Tensor types for onnxruntime-node |
| adm-zip 0.6.1, global-agent 4.1.3 and their dependencies (define-data-property, define-properties, es-define-property, es-errors, escape-string-regexp, globalthis, gopd, has-property-descriptors, matcher, object-keys, semver, serialize-error, type-fest) | as locked | MIT, BSD-3-Clause (global-agent), ISC (semver), MIT or CC0-1.0 (type-fest) | Used only by onnxruntime-node's install script, which never runs; installed because they are declared dependencies |

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
