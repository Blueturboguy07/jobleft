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

Entries 2.1 to 2.5 are from the static-data lane (2026-09-25). The board directory and the skill dictionary are not built yet.

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
