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

Extension lane (apps/extension), from the freehire browser extension (`extension/lib/`, same commit and licence).
Ideas and approach only; the jobleft code is written new, so no freehire code ships in the extension:

| jobleft file | Ideas from (freehire path) | What |
|---|---|---|
| `apps/extension/src/content/combobox.ts` | `extension/lib/combobox.ts`, `extension/lib/form.ts` | Drive a custom dropdown the way a person does (open, read the options it shows, click one, read back what it shows); find its list through `aria-controls`/`aria-owns`; trust its `aria-expanded`; read the committed value only inside a wrapper that holds no other combobox. jobleft adds its strict matcher, no key events, and putting the widget back when nothing commits |
| `apps/extension/src/content/dom.ts`, `apps/extension/src/content/fill.ts` | `extension/lib/form.ts` | Questions as the unit (radio and checkbox groups by name within a labelled container), label order (labels, `aria-labelledby`, `aria-label`, placeholder, name), labels that must OPEN with the words, "an upload marks the application form" scoping, native value setter plus `input`/`change` events |

Local additions that are not in freehire (written new): the per-host pacer, the robots.txt parser and check, the never-crawl host list, the mass-close guard (`closeTooBroad`), the empty-streak rule, the level and pay parsers, the US-location heuristic and the SQLite store.

### 1.2 Internship Machine (first party)

- Source: the owner's own Python project (`~/Documents/internships`, `pipeline/normalize.py` and `pipeline/dedup.py`). First-party code, no third-party licence applies.
- jobleft file: `packages/crawler/src/normalize.ts` (URL canonicalisation, company and title normalisers, the two-layer dedupe spine). Two deliberate changes are documented in that file (`gh_jid` is kept; intern words are kept).

### 1.3 JobNavigator (MIT)

- Source: https://github.com/vesaias/JobNavigator, commit `972e796ee24691e4bd0b08b64924b76e496034c1` (2026-09-18). Read-only clone in the audit scratchpad (not committed).
- Licence: MIT. Copyright (c) 2026 JobNavigator Contributors. Full text in section 5.2.
- What was taken (extension lane): facts about page markup (selectors) and ideas, written new in TypeScript. No JobNavigator code ships in the extension. JobNavigator's own port of freehire's combobox code is not used.

| jobleft file | From (JobNavigator path) | What |
|---|---|---|
| `apps/extension/src/content/combobox.ts` | `extension/lib/ats_combobox.js` | The Workday option selector `div[data-automation-id="promptOption"]` and the Oracle JET option classes, in the option-node query |
| `apps/extension/src/content/dom.ts` | `extension/content_autofill_fill.js` | Workday `[data-automation-id^="formField-"]` container labels, Ashby `[data-field-path]` question containers, hidden radio and checkbox inputs driven through their visible `<label>` |
| `apps/extension/src/content/fill.ts` | `extension/content_autofill_fill.js` | The escalation for a tick box: click its label, then the box, then set the property; verify the state stuck |
| `apps/extension/src/options.ts`, `apps/extension/src/classify.ts` | `backend/autofill_schema.py`, `backend/seed.py` | Ideas for the EEO answer set (yes, no, decline) and self-identification wording. jobleft does NOT keep JobNavigator's defaults: it never answers "decline" by itself and never infers Hispanic/Latino from race |

## 2. Data shipped with the app

None yet. The static-data lane adds entries here (board directory, H-1B sponsor table from US Department of Labor LCA disclosure files, city dictionary with its attribution, skill dictionary).

## 3. Development tools (not shipped in the app)

| Package | Version | Licence | Use |
|---|---|---|---|
| typescript | 7.0.2 | Apache-2.0 | Type checking only (`tsc --noEmit`). Platform binaries come as optional dependencies; no install script |
| @types/node | 24.13.6 | MIT | Node 24 type definitions |
| esbuild | 0.28.2 | MIT | Bundles the extension's TypeScript into `apps/extension/dist` (not minified). The platform binary comes as an optional dependency (`@esbuild/darwin-arm64`); its `postinstall` script (`node install.js`, an optional binary check) does not run and is not needed |
| @types/chrome | 0.1.24 | MIT | Chrome extension API type definitions (with @types/filesystem 0.0.36 and @types/har-format 1.2.16, MIT) |

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

### 5.2 MIT licence (JobNavigator)

```
MIT License

Copyright (c) 2026 JobNavigator Contributors

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
