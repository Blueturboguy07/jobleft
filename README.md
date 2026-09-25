# jobleft

Working name. A local macOS desktop job-search app at full consumer parity with Jobright.ai,
plus a hosted "publik jobs" service that publishes nightly job snapshots.

- Plan (approved 2026-09-24): docs/PLAN.md
- Research, audits and UI spec: ~/jobright-research/
- Phase 0 spikes: spikes/s1-ingest, spikes/s2-snapshot, spikes/s3-shell
- vendor/ holds read-only clones of the MIT repos we borrow from (freehire, jobsync).
  Do not push from vendor/. Keep each licence notice.

Rules: no Jobright name, logo, copy or images. No personal data in any request.
No LinkedIn, Indeed or Glassdoor access. No Claude-subscription login path.

Note (plan v2): the hosted "publik jobs" snapshot service in the first paragraph was dropped.
Every laptop crawls its own jobs into local SQLite (docs/PLAN.md, "What changed from v1").

## Workspace

A pnpm workspace of ESM TypeScript packages. Node 24 runs the `.ts` files directly (type stripping),
so there is no build step for the Node packages. `tsc` only type-checks.

| Folder | What lives there |
|---|---|
| `packages/contracts` | Shared types, JSON Schemas and small runtime validators. Every other package depends on it |
| `packages/parsers` | Level, pay, place and HTML-to-text parsers |
| `packages/crawler` | Crawler core: adapter contract, polite HTTP client, pacer, robots.txt, dedupe, close-vanished, crawl store |
| `packages/sources-ats` | More ATS adapters (Workable, Recruitee, Personio, ...) and ATS detection from a URL |
| `packages/sources-other` | Non-ATS job sources, add-a-job by URL or text, the metered fetch client |
| `packages/boards` | Board directory, board discovery from a link, crawl planning |
| `packages/store` | The local SQLite database for everything the user owns, plus job search |
| `packages/static-data` | Data shipped with the app: board directory, H-1B sponsor table, places, skills |
| `packages/ai-engine` | AI providers (publik API, local model, custom URL, own key), the publik wallet, embeddings |
| `packages/resume` | Resume import, truth-gated tailoring, keyword gaps, ATS check, PDF and Word export |
| `packages/match` | The match score (Experience Level, Skills, Industry Experience) and fit ranking |
| `packages/network` | The Network tool (the user's own `Connections.csv`) |
| `apps/server` | The local HTTP server (loopback only, launch token) |
| `apps/ui` | The desktop UI (React and Ant Design 5), served by the local server |
| `apps/extension` | The Chrome MV3 autofill extension (assisted apply) |
| `apps/shell` | The desktop shell (Tauri v2; Electron is the fallback) |

The precise contract between all of these (exports, CLI names, data files, environment variables,
the local API and the extension protocol) is `docs/INTERFACES.md`. Lanes build in parallel from it.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install the workspace. Dependency install scripts never run (`ignoreScripts: true`) |
| `pnpm typecheck` | `tsc --noEmit` in every package and app |
| `pnpm test` | `node --test` in every package and app |
| `pnpm app:up` | Start the whole app (placeholder until the server lane builds it) |
| `pnpm app:down` | Stop it (placeholder) |
| `pnpm --filter @jobleft/crawler run crawl --boards <file> --db <file> --out <file>` | Run the crawler CLI on a board list |

Requirements: Node 24 or newer, pnpm 12 (the version is pinned in `package.json`).

## Build rules for every lane

1. Work only inside this repository, your own worktree, and temporary folders.
2. No push, no publish, no email, no account, no log-in, no publik app token, no live call to publikhq.com (use local mock servers), no spending, no signing.
3. Never LinkedIn, Indeed, Glassdoor or SmartRecruiters. No live Workday, iCIMS, Oracle, UKG or Taleo request. Live requests only to approved public ATS, job and open-data endpoints, at most 1 per second per host, obeying robots.txt, with the User-Agent `jobleft-build/0.1 (research build; no personal data)`.
4. No personal data in any request, file or command. Tests use the fake persona "Jordan Testwell" (jordan.testwell@example.com).
5. Third-party code is untrusted: read it before you run it; install with scripts off. Copy only MIT, Apache-2.0 or BSD code and record it in `THIRD_PARTY_NOTICES.md`. AGPL and GPL code is reference only.
6. No Jobright name, logo, copy, images or trademarks in the product. Money in UI copy is the publik "balance" in dollars, never "credits".
7. Contracts change by addition only (`packages/contracts/README.md`).
