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

### 1.3 ai-engine: references only, no code copied (ai-engine lane, 2026-09-25)

`packages/ai-engine` is written new. No third-party code was copied or ported into it. These sources were read for
ideas only:

| Source | Licence | What was studied | Where the idea shows |
|---|---|---|---|
| NitroAI `server/publik.mjs`, `server/publikProxy.mjs`, `server/ollama.mjs`, `src/lib/engine/*` (the owner's own project, `~/NitroAI`) | AGPL-3.0 (the repository licence), so reference only | The publik provisioning order (mint only after the disclosure; a 200 replay without a key mints once more with a new install id; the key never reaches a web page), Ollama `/api/tags` detection | `src/publik.ts`, `src/providers/ollama.ts`. NitroAI's retry-with-backoff wrapper was deliberately NOT followed: jobleft never retries a failed AI request by itself |
| publik API build contract, sections 1, 3.2 and 12, and memo R21 sections 2.1 to 2.6 (`~/publik-api-research`, first-party documents) | First party | The `POST /installs`, `GET /wallet`, `POST /installs/revoke` shapes, the `x-publik-*` headers, the 402 body with one `top_up_url` | `src/publik.ts`, `src/mock/publik-server.ts` |
| jobsync "SCORES:" header idea (named in docs/PLAN.md section 6) | MIT | Only the idea of a one-line score header for small models; no code | `parseScoresHeader` in `src/structured.ts` |
| BERT WordPiece tokenization rules (Devlin et al. 2018; the rules as documented for `BertTokenizer`) | Rules only, no code | Basic tokenization (clean, CJK split, lower case, accent strip, punctuation split) and greedy longest-match WordPiece | `WordPieceTokenizer` in `src/embedder.ts` |

### 1.4 jobsync (MIT)

- Source: https://github.com/Gsync/jobsync, commit `527333e` (release 1.1.20). Read-only clone at `vendor/jobsync` (not committed).
- Licence: MIT. Copyright (c) 2024 gsync. Full text in section 5.2 and in `apps/server/jobsync/LICENSE`.
- Added by the server lane (2026-09-25).

| jobleft file | From jobsync | What |
|---|---|---|
| `apps/server/jobsync/` (whole folder) | The source tree at `527333e` | A fork copy with the four spike S3 patches applied (`spikes/s3-shell/patches/01` to `04`), and its pages, API routes, end-to-end tests and deploy files removed. It is not run or served; it is the port source. Details: `apps/server/jobsync/JOBLEFT-FORK.md` |
| `apps/server/src/interim/ai.ts` | `src/lib/ai/custom-endpoint.ts`, `src/lib/ai/provider-registry.server.ts`, `src/lib/ai/ollama-capabilities.ts` (as changed by spike patches 03 and 04) | Logic re-written in plain TypeScript: an OpenAI-compatible provider is a base URL plus an optional key over Chat Completions; its check asks `GET <base>/models` and treats 404 as usable; Ollama gets `think: true` only for models whose `/api/show` lists "thinking" |

### 1.5 Designs studied closely by the match lane (no code or data copied)

The match engine (`packages/match`) is written new. These MIT-licensed modules were read as references only; no file,
function, list or text was copied or ported.

| Source (read-only) | Licence | What was studied | Where the idea shows up in jobleft |
|---|---|---|---|
| freehire `internal/candidate/jobmatch/jobmatch.go` (commit `e58b1af6`, `vendor/freehire`) | MIT | Skill coverage with exact and "adjacent" matches, an adjacent match counting half | `packages/match/src/score.ts` (Skills part: a related skill counts half and still shows as missing) |
| freehire `internal/candidate/hardconstraint/hardconstraint.go`, `degrees.go` | MIT | Blockers per category with a score ceiling; judge a category only when both sides carry data | `packages/match/src/score.ts` (caps; "not in your profile" instead of a guessed answer) |
| freehire `internal/dict/skilladjacency`, `internal/dict/skilltag` (comments on ambiguous words) | MIT | A conservative list of substitutable skills; words such as "slack", "react", "epic", "assembly" that are also ordinary words | `packages/match/data/skills.tsv` (case and context rules; related skills) |
| career-ops `jd-skill-gap.mjs`, reactive-resume `jd/match.ts` (as summarised in the project's research audit 03) | MIT | Requirement-section detection by headings; weighting required over preferred terms; stuffing counted once | `packages/match/src/text.ts`, `src/job.ts` |

The starting weights of the overall percent (0.24 / 0.29 / 0.08 / +36) come from the project's own observation notes
(the logged-in UI spec, section MATCH SCORE), not from any code or dataset.

### 1.6 Network lane (`packages/network`): no third-party code

- No third-party code or data was copied. The package adds no dependency.
- One public-domain algorithm was re-typed from its published description: mulberry32, a 32-bit pseudo-random
  generator (Tommy Ettinger, released to the public domain). File: `packages/network/src/dev/fixture.ts`
  (`prng`). Use: made-up test fixtures only; it is not part of the Network tool's logic.
- The connections-file layout (3 note lines, then `First Name, Last Name, URL, Email Address, Company, Position,
  Connected On`) is a file format, recorded from plan section 7. The fixtures hold made-up people only.

## 2. Data shipped with the app

Entries 2.1 to 2.5 are from the static-data lane, 2.6 from the ai-engine lane and 2.7 from the match lane (2026-09-25). The board directory and the skill dictionary are not built yet.

### 2.1 H-1B sponsor table (US Department of Labor)

- Source: US Department of Labor, Employment and Training Administration, Office of Foreign Labor Certification, LCA Programs (H-1B, H-1B1, E-3) disclosure data, https://www.dol.gov/agencies/eta/foreign-labor/performance. Files (size and sha256 in `packages/static-data/src/h1b/lca-files.ts`): `LCA_Disclosure_Data_FY2025_Q1.xlsx` to `_Q4.xlsx` and `LCA_Disclosure_Data_FY2026_Q3.xlsx`.
- Licence: US government work, public domain in the United States (17 U.S.C. 105). The source states no licence terms.
- Attribution (shown in the data-sources list): "Source: US Department of Labor, Employment and Training Administration, Office of Foreign Labor Certification, LCA Programs (H-1B, H-1B1, E-3) disclosure data. jobleft counts certified H-1B rows only; DOL does not endorse jobleft."
- jobleft files: `packages/static-data/dist/h1b-lca.json.gz` (derived counts per filer: name, FEIN, city, state, NAICS code, counts per file and quarter, SOC major groups; a job-title table), built by `jobleft-data build-h1b`. No personal data from the files (points of contact, attorneys, preparers) is kept.

### 2.2 Place table (USGS GNIS and Natural Earth)

- USGS Geographic Names Information System (GNIS), "Populated Places" and "Federal Codes" national text files, dated 2026-09-02, https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/. Licence: US government work, public domain.
- Natural Earth 1:10m Populated Places (simple), version 5.1.2, https://www.naturalearthdata.com/. Licence: public domain ("All versions of Natural Earth raster + vector map data found on this website are in the public domain").
- Attribution given as a courtesy: "US places: USGS Geographic Names Information System (GNIS). World cities: Made with Natural Earth (naturalearthdata.com)."
- jobleft file: `packages/static-data/dist/places.json.gz`, built by `jobleft-data build-places`.
- GeoNames (CC BY 4.0) is NOT shipped: its download hosts forbid automated clients in robots.txt. When a person supplies GeoNames files (`build-places --geonames <dir>`), the table replaces Natural Earth outside the US and carries this attribution: "World cities: GeoNames (https://www.geonames.org/), licensed under CC BY 4.0."

### 2.3 Reviewed name tables (jobleft's own data)

- `packages/static-data/data/company-aliases.json` (222 brand-to-filer entries), `company-identifiers.json` (38 Wikidata item ids), `place-aliases.json` (29 short names). Written by the static-data lane; each alias states its basis. Company and place names are facts.
- How the alias candidates were found (reference only, nothing copied): the company names in jobsync's MIT-licensed board lists (`vendor/jobsync/src/lib/scraper/{greenhouse,lever,ashby}/companies.json`, read-only clone) were compared with DOL filer names to list candidates for review. No list, file or code from jobsync is in the package.

### 2.4 Classification and region names typed into code

- 2018 Standard Occupational Classification major group titles (US Bureau of Labor Statistics, public domain): `packages/static-data/src/h1b/role-family.ts`.
- NAICS 2-digit sector titles (US Census Bureau, public domain): `packages/static-data/src/facts/company-facts.ts`.
- US state and territory codes (USPS), Canadian province codes, ISO 3166-1 country codes and names: `packages/static-data/src/places/regions.ts`.

### 2.5 Test fixtures (not shipped in the app)

- `packages/static-data/test/fixtures/facts/`: trimmed answers recorded on 2026-09-25 from Wikidata (CC0 1.0), SEC EDGAR data.sec.gov (US government, public domain) and GLEIF (CC0 1.0) for NVIDIA, Stripe and Notion Labs.
- `packages/static-data/test/fixtures/release-test-key.pem`: an Ed25519 TEST key made for this repository; jobleft trusts it only for release manifests served from 127.0.0.1 or localhost.
- Company facts read at run time (Wikidata CC0, SEC public domain, GLEIF CC0) name their source and link on every fact.

### 2.6 The fit model (downloaded at first use, not in the repository)

- Model: `BAAI/bge-small-en-v1.5`, files `onnx/model.onnx` (133,093,490 bytes, sha256 `828e1496...0cf35`) and
  `vocab.txt` (231,508 bytes, sha256 `07eced37...38a3`), from `https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main`
  (or `JOBLEFT_MODEL_BASE_URL`). Licence: MIT (model card). The hashes are pinned in `packages/ai-engine/src/embedder.ts`
  and were measured on the copies spike S2 downloaded on 2026-09-24. Nothing of the model is committed.
- Runtime: `onnxruntime-node` (MIT) is loaded at run time when it is installed. It is not a dependency of any package
  yet (287 MB); the app build decides. Its install script only fetches CUDA files on Linux (spike S2), so it is not needed.

### 2.7 Match dictionaries (first party)

- Files: `packages/match/data/skills.tsv` (about 550 skills with aliases, contexts and related skills),
  `credentials.tsv` (90 licences and certifications), `occupations.tsv` (46 kinds of work, about 1,500 job-title
  phrases, how close two kinds are), `industries.tsv` (30 industries with posting and employer-name phrases).
- Source: written new for jobleft by the match lane on 2026-09-25 from general knowledge of job titles, tools, trade
  skills and licences. No third-party list, taxonomy or dataset (O*NET, ESCO, Lightcast, freehire, or any other) was
  copied or transformed. Each file states this in its header.
- Licence: the jobleft project's own licence (not decided yet; see the root `package.json`).

Note (parsers lane, 2026-09-25): `packages/parsers/src/geo-us.ts`, `geo-world.ts` and `currency.ts` hold small lookup lists (US state codes, about 2,500 US city names, 116 country names, common regions, about 1,500 world city names, currency markers). They were written for jobleft from general knowledge. No dataset (GeoNames, Census or other) was copied, so no third-party licence applies.

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

### 5.2 MIT licence (jobsync)

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
