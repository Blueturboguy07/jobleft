# jobleft build report (one-shot build, 2026-09-25)

Written for Mann by the single builder at the end of gate 10. Everything below is stated as measured. Evidence lives in
`evals/gate*/RESULT.md` (one table per gate, written by check scripts that read the outcome docs, not the code).

## 1. What exists

A local-first desktop job-search app on this Mac, named jobleft, with the Jobright consumer feature set as the parity
target. Nothing personal leaves the laptop unless the person chooses an AI provider.

| Part | Where | What it does |
|---|---|---|
| Server | `apps/server` (plain `node:http`, `node:sqlite`) | 97 local API routes (`docs/INTERFACES.md`), one SQLite file per data folder, launch token, Host/Origin gate, scheduler, notifications |
| Crawler and sources | `packages/crawler`, `sources-ats`, `sources-other`, `boards` | Greenhouse, Lever, Ashby, Workable, Recruitee, Personio, Teamtailor, Gem adapters; RemoteOK, The Muse, HN, GitHub feeds; a directory of 3,581 employer boards; 1 request a second a host; robots.txt; never-crawl list |
| Parsers, static data | `packages/parsers`, `static-data` | Pay, place, level, years, work model, H-1B table (DOL LCA, 3.6 MB shipped), places (3.1 MB), company facts cache |
| Store and match | `packages/store`, `match` | FTS5 search, facets, filters, saved filters, tracker; deterministic match percent + band + three sub-scores with reasons; optional bge-small fit model |
| Resume, letters | `packages/resume` | Import PDF/DOCX, profile proposal, truth-gated tailoring, PDF + DOCX export, ATS check, keyword gaps, cover letters |
| Network tool | `packages/network` | `Connections.csv` import, coverage per company, who to message first with reasons, drafts the person copies (never sent) |
| Assistant, AI engine | `packages/assistant`, `ai-engine` | Tool-using assistant over the person's own data; providers: publik, own key, local OpenAI-compatible, custom; proposals need confirmation |
| Extension | `apps/extension` (Chrome MV3) | Pairing code, fills Greenhouse, Lever, Ashby, Workable (supported), Workday, iCIMS (partial); never submits; never on LinkedIn, Indeed, Glassdoor |
| UI | `apps/ui` (Vite + React + Ant Design 5) | Feed, tabs, detail, resume workspace, profile, onboarding, tracker, dashboard, network, interview, assistant, settings |
| Shell | `apps/shell` (Tauri v2 + Node 24 sidecar) | Unsigned debug `jobleft.app`: starts the server, one window, menu bar item, single instance, notifications, clean quit |

Size: 2,303 tracked files; about 90,200 lines of TypeScript and Rust outside tests; 12,350 lines of tests; 17 test
suites, 692 tests pass, 2 skipped, 0 fail (`pnpm -r test`, 2026-09-25).

## 2. Gates

| # | Gate | Result | Evidence |
|---|---|---|---|
| 0 | Baseline | pass | commit `4f81782`; `pnpm check` green, `pnpm app:up` answers health |
| 1 | Open defects | pass | commit `285d0e1`; crawler same-link merge, parsers foreign-remote and third-party pay, resume title attach: failing tests first, then fixed |
| 2 | i-core | 19/19 | `evals/gate2-core/RESULT.md`: 41 real boards, 11,957 jobs, counts checked against the boards' own APIs |
| 3 | i-resume | 24/24 | `evals/gate3-resume/RESULT.md`: independent `pdftotext` and DOCX unzip; hostile model refused |
| 4 | i-network | 19/19 | `evals/gate4-network/RESULT.md` |
| 5 | i-ai | 23/23 | `evals/gate5-assistant/RESULT.md`: scripted model, injection refused, nothing changed without confirmation |
| 6 | i-ext | 21/21 | `evals/gate6-extension/RESULT.md`: real extension in headless Chrome against the real app; 0 submits, 0 Next presses |
| 7 | i-ui | 26/26 | `evals/gate7-ui/RESULT.md` + `shots/`: every screen against the real API; side by side with `~/jobright-research/ui/` |
| 8 | i-shell | 10/10 | `evals/gate8-shell/RESULT.md` + `shots/`: unsigned bundle, window in 1.8 s (fresh) / 0.5 s (11,957 jobs), quit in 0.3 s, WKWebView = Chromium |
| 9 | System | 33/33 | `evals/gate9-system/RESULT.md`: three personas end to end; cross-origin probes fail; egress only approved hosts; 100,000 jobs: search median 8 ms, p95 62 ms |
| 10 | Report | this file | |

Defects found by the gates and fixed on the way (each with a test or a check): same-link jobs merged across boards;
foreign remote + US office read as US; third-party pay read as pay; wrong job's title accepted into a resume;
"Title at Company" pasted jobs; job-title words flagged as an organisation; intern outranking a same-role engineer;
assistant emitting a literal "undefined"; the mock crashing on a paid proposal; UI counts not refreshing after a change
made outside the UI (extension, refresh); the word "credit" in a dataset attribution line; the search index cold on
first search (0.5 s at 100,000 jobs); a symbol-only search scanning every row; the home feed's ranked order evicted by
a burst of searches (0.2 s re-rank).

## 3. Parity status per plan ID (docs/PLAN.md section 3)

Status words: **built** (in the app and checked by a gate), **partial** (in the app, part missing, said where),
**excluded** (by decision), **not started**.

| ID | Feature | Status | Notes and evidence |
|---|---|---|---|
| I1 | Job cards: pay, work model, level, years, post time, badges | built | gate 7 O2 (card = detail = API); applicant counts and "Early applicant" excluded on purpose |
| I2 | Filters, sort (Recommended, Top Matched, Most Recent), saved filters | built | gate 2 O5, gate 7 O7; Top Matched needs the fit model (see M2) |
| I3 | Job detail: match breakdown, company, funding, leaders, news, tools rail | partial | breakdown, company block, tools rail built (gate 7); funding, leaders and news come only from paid publik lookups, never run live (G-publik) |
| I4 | Tabs, like, external job by URL or paste | built | gate 7 O6, gate 9 task 6 (URL through a mapped employer page) |
| I5 | Onboarding and profile | built | gate 7 fresh install, gate 9 task 1 (resume-proposed profile, non-tech personas) |
| I6 | Resume workspace: many resumes, report card, keyword gaps, per-job version | built | gate 3; ATS check and keyword gaps routes; report drawer in the UI |
| I7 | Tracker with reminders | built | gate 7 O5/O6, gate 9 task 5; reminders fire through the shell's Notification Center path (see gap S3) |
| I8 | Dashboard and alerts | built | gate 7; alerts queue on the server, shown by the shell every minute |
| I9 | Design system | built | Ant Design 5, own brand, own copy; layout audit in gate 7 O14 (0 overflow, 0 unnamed controls) |
| D1 | Job volume, all levels, US | built | 3,581-board directory; 41 boards crawled in 49 s in gate 2; 100,000 jobs crawled from 50 stand-in boards in 61 s in gate 9 |
| D2 | Full text, years, skills, pay | built | gate 1 fixes, parsers 63 tests, gate 2 O2 |
| D3 | Company: size, funding, investors, leaders, news | partial | free-source basics (Wikidata, SEC, GLEIF) cached locally; investors, stage, leaders, news need the metered publik route, never run live |
| D4 | "H-1B sponsor likely" tag and filter | built | shipped LCA table; hedged wording checked in gate 7 O3 and gate 9 (persona C) |
| D5 | Fresh jobs, no ghost jobs | built | gate 2 O5/O6: a dropped posting closes, a failing board closes nothing |
| M1 | Match % with three parts, bands, why-fit | built | gate 7 O4 (same everywhere, stable across reload), match 57 tests |
| M2 | Semantic matching (bge-small) | partial | in the store (fit index, float16 vectors, 23 tests); needs a one-time 133 MB model download from Hugging Face; not exercised end to end in the gates |
| M3 | Copilot | built (as "Assistant") | gate 5; presets: chat, browse, tailor, interview rehearsal; no Orion name or copy |
| M4 | ATS score and keyword gaps | built | routes `ats-check`, `keyword-gaps`; gate 3 |
| M5 | Insider connections → Network tool | built | gate 4, gate 9 task 7; CSV only, nothing sent by the app |
| M6 | Interview prep | partial by design | rehearsal from the posting and a personal question bank; no curated question bank (that content is Jobright's) |
| T1 | Truthful tailoring | built | gate 3 (hostile model refused, PDF text holds only profile facts), gate 9 (three personas) |
| A1 | Autofill extension | partial | Greenhouse, Lever, Ashby, Workable supported on saved real pages and hand-made forms; Workday one visible step, no Next; iCIMS untested (no forms available) |
| A2 | Agent (auto-apply) | excluded → assisted apply | fills, the person reviews and submits; tracker changes only on the person's confirmation (gate 6 O13) |
| P1 | Accounts | built | one local user, no login |
| P2 | Free credit, paid plan → balance | built | dollars and "balance" everywhere; stand-in wallet checked in gate 7 O10 and gate 5; live publik never called |
| P3 | Mobile apps, instant alerts | excluded / built | mobile excluded; alerts as macOS notifications through the shell |

## 4. Gaps, stated plainly

Product gaps seen in the gates (not failures of a MUST):

- **Feed diversity.** With the software persona the top of Recommended is one employer (Palantir, six near-identical
  postings). A diversity tiebreak (one employer, one slot, then the rest) is wanted. Gate 7 note.
- **Default filter chips.** The UI derives the first filter chips from the profile and keeps them in the webview's own
  storage; the shell's WKWebView storage is per app, not per data folder, so a folder swap keeps old chips. Gate 8 note.
- **Cached data with the server down.** Screens that hold cached data keep showing it; only the feed's refresh line says
  the app cannot be reached. A failed change is never shown as saved (gate 7 O9).
- **Store size.** 11,957 real jobs with full text and their indexes take 155 MB (about 1.3 GB per 100,000 at that
  density); 100,000 short synthetic jobs take 217 MB. The plan's 141 MB figure assumed summaries.
- **Search tail.** First search after launch on 100,000 jobs was 0.5 s cold; a warm-up now runs at start (64 ms cold in
  the last run). Re-ranking the whole store costs about 0.2 s and is now cached and pinned for the home feed.

Shell gaps (i-shell outcomes not covered by the gate; the shell is a debug build):

- S1 "Open at login" switch: not built (no Login Items entry is ever made, which is the safe half).
- S2 Notifications go through `osascript`; a click on one does not open the job (no click target). A native
  notification plugin would fix it.
- S3 Reminders firing while the window is closed, the wake-from-sleep catch-up, and 24-hour idle CPU/memory were not
  measured. The scheduler and reminder code run inside the server (tested there); the shell keeps the server alive.
- S4 Second launch was proven with the executable; `open -n -a jobleft` and Spotlight were not tried.
- S5 The bundle is ad-hoc signed only; "Replace the app with a newer build and keep the data" was not tried.
- S6 The Tauri CLI link under `pnpm exec` is dropped by this workspace's install policy; the build script calls the CLI
  by its file in the pnpm store (`apps/shell/README.md`).

Outside this build (need Mann):

| Item | What it is |
|---|---|
| G-publik | New `/fetch` and `/search` metered routes, a jobleft app row and token on the live publik repo. Nothing was pushed. Company facts beyond the free sources, metered fetch and publik AI all wait on it |
| G-resale | Written confirmation from Parallel and Tavily that resale inside publik apps is allowed; the OpenRouter-style resale flag for metered routes |
| G-store | Chrome Web Store submission of the extension |
| G-release | Name check, counsel review, signed and notarized builds, first public release; Windows port not started |
| Crawler identity | A project contact address for the crawler User-Agent (today `jobleft-build/0.1 (research build; no personal data)`) |
| Dataset updates | The release location for dataset updates (`JOBLEFT_DATASET_MANIFEST_URL`) |
| Fit model host | The 133 MB bge-small model downloads from Hugging Face on first use of Top Matched; a mirror under publik would keep the host list short |
| Lane leftovers | Untracked folders from the multi-agent phase are still in the worktree, uncommitted: `evals/{crawler,parsers,sources-*,boards,store,...}` (about 310 MB of ground-truth captures) and `spikes/` (929 MB). Keep, prune or commit is Mann's call |
| Duplicate port source | `apps/server/jobsync/` (885 files, 12 MB) is the kept, patched jobsync fork used as the port source; nothing in it runs |

## 5. Spend and outside contact during the build

No money spent. No email sent. Nothing pushed, published or signed. Downloads: the official Node 24.18.0 arm64
binary (verified against nodejs.org's SHASUMS256.txt), Rust crates for the shell, the `@tauri-apps/cli` npm package.
Live requests: only the gate 2 crawl of 41 public employer boards (44 requests to `boards-api.greenhouse.io`,
`api.lever.co`, `api.ashbyhq.com`; 1 a second a host; robots.txt read first), and the boards' own public APIs read by
the checker. No LinkedIn, Indeed, Glassdoor, SmartRecruiters, Workday or iCIMS host was contacted.

## 6. How to run it

| Want | Command |
|---|---|
| Dev app in a browser | `pnpm app:up` (prints `http://127.0.0.1:<port>/#token=...`; data in `<repo>/.jobleft-dev`); `pnpm app:down` |
| The desktop bundle | `pnpm --filter @jobleft/ui build && pnpm --filter @jobleft/shell app:build` → `.cache/cargo-target/debug/bundle/macos/jobleft.app` (needs the Node binary at `apps/shell/src-tauri/binaries/`, see `apps/shell/README.md`) |
| The extension | `pnpm --filter @jobleft/extension build`, then load `apps/extension/dist` unpacked in Chrome and pair from Settings → Browser extension |
| All tests | `pnpm -r test` |
| A gate again | `node evals/gate<N>-*/run.mjs` (gate 2 reuses its crawl with `GATE2_REUSE=1`; gates 7–9 copy the gate 2 data folder from `/private/tmp/jl-gate2`) |
