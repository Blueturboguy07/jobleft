# @jobleft/ui

The jobleft desktop UI: a Vite + React 18 + TypeScript single-page app with Ant Design 5. It talks only to the
local jobleft API (`docs/INTERFACES.md`, section 6) with the launch token from the address fragment. Fonts (Inter,
Titillium Web) and icons are bundled, so the page loads nothing from the internet.

This lane also ships a **mock of the local API** (`apps/ui/mock`) so the UI can be run, looked at and tested on its own,
with made-up jobs, a made-up publik service (dollar balance and charge log) and a made-up AI model. Everything below
runs offline on loopback (127.0.0.1) and uses only made-up data (the persona is "Jordan Testwell").

Minimum window size: **1024 x 640**. Below that width a screen may scroll sideways. It is tuned for 1024 x 640 up to
a large display (2560 x 1440), and stays usable at 150% zoom.

## Requirements

- macOS with Node 24 or newer (`node --version`) and pnpm (`pnpm --version`).
- To take screenshots or run the browser checks: Google Chrome at `/Applications/Google Chrome.app` (the checks start
  it headless with a throw-away profile under `/private/tmp`; they never touch your own Chrome).

## Run it (3 commands)

Run these in the repository root.

```sh
pnpm install                                   # once. Install scripts are off by policy (pnpm-workspace.yaml)
pnpm --filter @jobleft/ui build                # builds apps/ui/dist (about 5 seconds)
pnpm --filter @jobleft/ui demo -- --persona --balance 4.37
```

The last command starts four small local servers and prints one line like this:

```
[api] Open: http://127.0.0.1:47830/#token=WPFbJelheS9IZ3L12UkzZWp7YmzJbz8Z
```

Open that address in Chrome or Safari. The token in the address is removed from the address bar at once and kept only in
memory and `sessionStorage`. Press Ctrl+C in the terminal to stop everything.

What you will see, in order:

1. **With `--persona`**: the feed opens on **Jobs > Recommended** for Jordan Testwell (Software Engineering, US, entry to
   senior). The header says "AI: not set up" until you pick a provider in Settings.
2. **A refresh starts at once** (first run only). The feed shows a crawl-progress banner ("Reading job boards: 12 of 40")
   and the list fills with jobs as each board finishes. The first refresh takes about a minute.
3. **Without `--persona`** the first launch opens the **onboarding** (job function, job type, where, resume upload, about
   you, AI choice). Type the persona's details, or use the fixture resume (see "Test files").

Other start-up options (put them after `--`; they go to the servers):

| Option | Meaning |
|---|---|
| `--home DIR` | Data folder of the demo. Default `apps/ui/.mock-home`. Keep the same folder to keep your data across restarts |
| `--persona` | Load the made-up profile Jordan Testwell on first start |
| `--balance 4.37` | Starting dollar balance of the made-up publik service (default 5.00) |
| `--price 0.01` | Dollars one AI call charges at the made-up publik service (default 0.01) |
| `--jobs 50000` | Create about that many postings and load them at once (no first refresh). Use this for the speed checks. Creating 50,000 takes about a minute |
| `--boards N`, `--per-board N` | Size of the first refresh instead (default 40 boards of about 30 postings) |
| `--crawl-delay-ms N` | Wait between boards during a refresh (default 1500 on the first run, 150 later) |
| `--no-crawl` | Do not refresh when the app starts |
| `--port N`, `--token T` | Fix the address (default: first free port of 47821-47830 and a random token). Use these to restart at the same address |
| `--reset` | Delete the demo's data and boards first (only for folders this mock made) |
| `--build` | Rebuild the UI before starting |
| `--legacy-wording` | Make the made-up publik service answer with the word "credits" in its errors, to prove the app never shows it |

**Restart with the same data** (a normal quit, or `kill -9` of the API to imitate a force-quit):

```sh
pnpm --filter @jobleft/ui demo -- --home /private/tmp/jl-demo --persona --port 47821 --token demo-token
# Open http://127.0.0.1:47821/#token=demo-token   (stop it with Ctrl+C, run the same command again: your data is back)
```

## The made-up services and how to control them

| Service | Address | What it is |
|---|---|---|
| Local API (the mock) + the built UI | `http://127.0.0.1:47821-47830` | Serves the UI at `/` and the API at `/api/v1`. It follows `packages/contracts` exactly and validates every request |
| Employer boards | `http://127.0.0.1:47920` | Made-up job boards and one made-up posting page per job (the "original posting" and "Apply" links open these) |
| publik | `http://127.0.0.1:47910/api/v1` | One dollar balance, a fixed price per AI call, and a charge log. **Never** `publikhq.com` |
| AI model on this computer | `http://127.0.0.1:47911/v1` | An OpenAI-compatible stand-in (models `standin-7b`, `standin-14b`) for the "model on this computer" and "custom address" choices |

Control a running demo in a second terminal (add `--home DIR` when you used another data folder):

```sh
CTL="pnpm --filter @jobleft/ui ctl --"
$CTL status                        # which of the four servers are running
$CTL balance 4.37                  # set the made-up publik balance in dollars
$CTL ledger                        # print the charge log: one JSON line per charge (time, kind, micros, balance after)
$CTL publik stop                   # the publik service goes away ("$CTL publik start" brings it back)
$CTL ai stop                       # the AI model goes away ("$CTL ai start" brings it back)
$CTL boards stop                   # every employer site is down ("$CTL boards start")
$CTL board-down ashby:acmelogistics   # one employer board answers "service unavailable" (board-up undoes it)
$CTL remove-posting ashby:acmelogistics:39000   # take one posting off its board (use a job id from the app or the API)
$CTL restore-posting ashby:acmelogistics:39000  # put it back
$CTL offline on                    # the API acts as if the computer had no network (offline off ends it)
```

To see the closing of a posting: like a job, run `remove-posting <its job id>`, then press **Refresh now** (Jobs page side panel or
Settings > Job sources). The job moves to **Liked > Closed** (or the tracker's closed list) with its notes kept.
A job's id is in its address: `#/jobs/<jobId>`.

## Test files (made up)

The demo writes these to `<home>/fixtures` (for the default home: `apps/ui/.mock-home/fixtures`):

| File | Use |
|---|---|
| `Jordan_Testwell_Resume.pdf` | A one-page resume of the persona. Resume > Add resume > Upload, or onboarding step 4 |
| `not-a-resume.pdf` | A PDF with no text. The upload must say in plain words that it found no resume text |
| `Connections.csv` | A made-up connections export (the three LinkedIn note lines, then the header) for Network > Import |

Paste these into **Jobs > External** to see the three outcomes: a good posting (any `http://127.0.0.1:47920/<board>/jobs/<id>`
address, for example the "original posting" link of any job that is not tracked yet), a dead link
(`http://127.0.0.1:47920/nope/jobs/1`) and a page that is not a job (`http://127.0.0.1:47920/about`). Pasting the same link twice
says "Already in your list" and adds no second row.

## Screens

Navigation stays on screen: the rail on the left (Jobs, Tracker, Dashboard, Resume, Profile, Network, Interview,
Assistant, Alerts, Settings), the tabs at the top of Jobs, and the sub-navigation of Settings and Network. The assistant
chat is also one click away on every screen (the round sparkle button at the bottom right). Every screen is at most two
clicks from any other.

| Screen | Address | Content |
|---|---|---|
| Feed | `#/jobs` | Recommended, Liked, Applied, External tabs with count pills; filter chips and popovers (location, job function, level, job type, work model, date posted, industry, years of experience, pay, H-1B sponsor likely, hidden jobs); the All Filters drawer; saved filters (with alert switch); sort (Recommended, Top matched, Most recent); job cards with the match tile |
| Job detail | `#/jobs/<jobId>` | Opens over the list. Overview (facts, match panel with three part-scores, "why this score" reasons, description) and Company (company block, H-1B block with its source, network panel); tools rail (tailor resume, cover letter, keyword gaps, practice, ask); Apply on employer site; Esc or the close button returns to the same list, filters and scroll position |
| Tracker | `#/tracker` | Board and table by stage (Applied, Interviewing, Offer Received, Rejected, Archived), notes, reminders, closed postings |
| Dashboard | `#/dashboard` | Counts, applications per week, next reminders, refresh summary, alerts |
| Resume | `#/resume`, `#/resume/<id>` | List with slots, editor, report card (ATS and keyword gaps), tailoring review with a truth check, Add resume (upload, from profile, blank) |
| Profile | `#/profile` | Personal, Job preferences, Education, Work experience, Skills, Work authorization, Equal employment (each in its own drawer; unsaved text asks before it is thrown away) |
| Network | `#/network`, `#/network/people` | Import Connections.csv, companies where you know people, who to contact, coffee-chat plan, contact tracking, draft a message |
| Interview | `#/interview` | Practice questions for a job, feedback on an answer, a personal question bank |
| Assistant | `#/assistant`, panel on every screen | Chat with saved conversations. Proposals (for example a change to preferences) apply only when you click Accept |
| Settings | `#/settings/ai`, `balance`, `alerts`, `sources`, `data`, `extension`, `about` | AI provider (publik API, a model on this computer, a custom address, your own key), the dollar balance card, alerts, job sources and the refresh report, data and backup, browser extension pairing, about and privacy |
| Notifications | `#/notifications` | New jobs, saved-filter alerts, reminders, follow-ups |
| Onboarding | `#/onboarding` | First run. It can be skipped for good |

## AI, money and privacy in the demo

- Settings > AI provider: pick **publik API** to use the made-up publik service (balance shown as "Balance: $4.37"), or **A model
  on this computer** (nothing leaves the Mac; no balance prompt), then press **Save and test**.
- The UI never spends balance, sends a message or changes preferences by itself. Each paid action (tailor, cover letter, message draft,
  chat turn, practice) shows a note before the click: "This uses your balance. Expected cost about $0.01" and runs only after you click
  the button that names it. The charge log (`$CTL ledger`) then shows exactly one line per confirmed action.
- The page makes requests only to its own origin (the local API). The local API calls employer boards, and the AI service you chose. No
  analytics, no crash reporter, no remote font, logo or icon.
- Text from another service that says "credits" is shown as "balance".

## Checks you can run

All browser checks start their own demo in `/private/tmp` and stop it at the end.

```sh
pnpm --filter @jobleft/ui test          # unit tests (node --test)
pnpm --filter @jobleft/ui typecheck     # tsc
# The lane's own outcome probes (hostile checks written from docs/outcomes/ui.md; each prints PASS or FAIL with the evidence):
node apps/ui/scripts/probe/run.ts --only nav,facts,filters
# Screenshots and an accessibility, contrast and banned-word audit of every screen at two sizes (needs a running demo):
node apps/ui/scripts/shots.ts --url "http://127.0.0.1:47830/#token=..." --out /private/tmp/jlui-shots --sizes 1024x640,1920x1080
```

## Layout of the lane

```
apps/ui/
  src/app        shell, hash router, API door (api.ts), shared cache (data.ts), layers (Esc, dirty editors), theme tokens
  src/components job card, match tile, virtual list, states (loading, empty, error), chat panel, icons and drawn art
  src/screens    one folder or file per screen
  src/lib        pure helpers (formatting, filter model)
  mock/          the local API mock, stand-in boards, publik and AI servers, launcher (run.ts) and control (ctl.ts)
  scripts/       headless Chrome driver, screenshot audit, outcome probes
  test/          unit tests
```

Design tokens (`src/app/theme.ts`) come from the measured values in `jobright-research/ui/UI-SPEC*.md`: Inter and Titillium Web,
accent #00F0A0, black primary buttons, 16 px card radius, 28 px pill buttons, backgrounds #F5F6F7 and #FFFFFF. The brand
is jobleft, with its own logo, icons, illustrations and copy.

## Rules of this package

- ESM TypeScript. Node 24 runs `mock/`, `scripts/` and `test/` directly (erasable syntax only, relative imports end in `.ts`).
- Types that cross a package boundary live in `@jobleft/contracts`. This lane made one additive change to it (contracts 1.1.0:
  optional `AiSettings.costEstimates`), described in `docs/INTERFACES.md`.
- No personal data anywhere. Tests use "Jordan Testwell" (jordan.testwell@example.com).
