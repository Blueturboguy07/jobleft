# Plan v2: jobleft, a local desktop job-search app at full consumer parity with Jobright

Status: v2, 2026-09-24. Approved as v1 by you. Revised the same day at your direction (local-first jobs).
Name: **jobleft**. It is a wordplay on "Jobright", so it carries trademark risk (section 6). The product uses no Jobright name, logo, copy or images.
Workspace: `~/jobleft/`. Inputs: `GAPS.md`, `jobright-features.md`, `oss-repos.md`, `audit/01..05`, `ui/UI-SPEC.md`.

## What changed from v1

| v1 | v2 (your decision) |
|---|---|
| A hosted publik jobs service: Railway crawler, Supabase, R2 snapshots, $47 to $150 a month | No hosted jobs. Every laptop crawls its own jobs into local SQLite, like the Internship Machine. No Supabase, Railway or R2 for jobs. Fixed cost: $0 |
| Legal review needed before serving postings to other users | The redistribution problem mostly disappears, because nobody serves postings. Other legal items remain (section 6) |
| Freehire as the server-side crawler | Freehire is a source of adapter logic and pure modules to port to TypeScript. It does not run |
| "More scraping" means a bigger hosted index | "More scraping" is a pay-as-you-go metered publik route (like the OpenRouter chat tiers). Research is running (spike S4) |

## 1. Decisions

| # | Decision |
|---|---|
| 1 | Full parity with Jobright's consumer side. The UI and the experience carry most of the weight |
| 2 | A local desktop app. Mac first. Windows later by CI, as with `publikclip` |
| 3 | The publik API serves what cannot run on the laptop: AI calls (exists), and metered fetch and search (new, pay-as-you-go) |
| 4 | Local models work too (Ollama, llama.cpp, MLX, any OpenAI-compatible URL) |
| 5 | Drop community features (section 8) |
| 6 | The Network tool imports your own LinkedIn `Connections.csv`. No Chrome, no scraping, no automation |
| 7 | Local-first jobs: the laptop crawls public ATS job APIs and keeps every job in local SQLite |
| 8 | Your Python "Internship Machine" is a reference. I port its duplicate-link guard and one-page PDF loop |
| 9 | Name: jobleft |

## 2. Architecture

```
YOUR LAPTOP (everything you own lives here)                       PUBLIK API (already exists; nothing new to host)
-------------------------------------------------------           ---------------------------------------------
Tauri v2 shell (provisional; Electron is the fallback)                                  https://publikhq.com/api/v1
  |                                                                 - chat, embeddings, audio: metered, exists
  +-- local Node server (jobsync fork, MIT)                         - NEW, later: /fetch and /search, metered,
  |     SQLite: profile, resumes, tracker, notes, contacts,             pay-as-you-go, upstream bought per use,
  |             network, chat, AND all crawled jobs                    sold at publik's own price (margin,
  |                                                                     builder share), NO fixed cost
  +-- crawler core (TypeScript)                                     Wallet and keys: publik's existing service
  |     adapters -> pacer (1 req/s/host) -> dedupe -> store
  |     close vanished jobs, tray poller, catch-up on launch
  |
  +-- job search: SQLite FTS5 + local vectors (bge-small, 384-d)
  +-- match engine, resume pipeline, tracker, Network tool, chat
  +-- AI engine: publik API | Ollama | custom URL | own key
  +-- fetch/search client: free plain HTTP first;
  |     publik metered route (or your own provider key) for "more"
  +-- static data shipped with the app (no server): board directory,
        H-1B sponsor table, skill and city dictionaries

Chrome MV3 extension  <-- localhost + token -->  the app     (autofill; your own Chrome keeps your logins)
```

What leaves the laptop:

| Data | Leaves? | Where |
|---|---|---|
| Resume, profile, tracker, notes, network CSV, crawled jobs | No | Local SQLite |
| Requests to employers' public job APIs | Yes | Direct from your laptop, one request a second per host |
| AI prompts | Only if you pick the publik API or your own key | With a local model, nothing leaves |
| Metered fetch or search requests | Only when you use them | Through the publik API, paid from your balance |

Why this shape:

1. It is the design you already proved with the Internship Machine: crawl, dedupe, classify and rank on your own machine.
2. There is no server to run, no fixed bill, and no shared copy of other companies' postings.
3. Privacy is total. The profile, the tracker and the crawled jobs never leave the laptop.
4. `jobsync` already has a local discovery pipeline: 3,622 bundled boards (602 Greenhouse, 1,160 Lever, 1,860 Ashby). We extend it.

Honest trade-offs:

| Trade-off | Effect | Answer |
|---|---|---|
| Volume per laptop | About 25K to 60K US postings from about 2,000 companies (audit 05). Jobright claims far more | Enough for a personal search. More through a longer crawl and the metered route |
| Repeated work | Every user crawls the same employer boards | One request a second per host, conditional requests, and each user has their own IP. Keep it polite |
| First run | The first crawl takes time | Ship a board directory. Crawl in the background. Show jobs as they arrive |
| Freshness | Jobs refresh only when the app runs | Tray poller plus a catch-up crawl on launch |
| No cross-user signals | No "many people applied" data | Excluded anyway (section 8) |

## 3. Parity matrix

Source key: FH = freehire (MIT), JS = jobsync (MIT), RM = Resume-Matcher (Apache-2.0), RR = reactive-resume (MIT), CO = career-ops (MIT), JN = JobNavigator (MIT, ideas and small modules), NA = your NitroAI, PC = your publikclip, BASE = your Internship Machine, NEW = written new.

### Interface (I)

| ID | Jobright feature | Built from | Phase |
|---|---|---|---|
| I1 | Job cards: salary, work model, level, years, post time, badges | NEW UI on local job rows. Layout from `UI-SPEC` section 08. Applicant counts and "Early applicant": excluded | 4 |
| I2 | Filters, sort (Recommended, Top Matched, Most Recent), saved filters | NEW on SQLite FTS5 and facets. Taxonomy from the "All Filters" drawer in `UI-SPEC` | 2 |
| I3 | Job detail: match breakdown, company, funding, leaders, news, tools rail | JS `JobDetails` tabs, FH `JobView` and `JobMatch` as spec, NEW company panel | 4 |
| I4 | Tabs Recommended / Liked / Applied / External, like button | NEW. External job by URL: BASE `jobdesc.py` plus JS add-job-from-paste | 2 |
| I5 | Onboarding and profile: job function, type, location, salary, work authorization, resume upload | JS profile editor and resume import, NEW preferences and target title per resume. Step order from `UI-SPEC-LOGGED-IN` | 3 |
| I6 | Resume workspace: many resumes, report card, keyword gaps, per-job version | JS editor, RR ATS report, RM diffs | 3 |
| I7 | Tracker: Applied, Interviewing, Offer, Rejected, Archived, reminders | JS model (a superset of Jobright's), NEW likes and reminders as macOS notifications | 2 |
| I8 | Dashboard and alerts | JS charts, NEW tray poller with macOS notifications | 4 |
| I9 | Design system | Ant Design 5 with the measured Jobright tokens (own brand, own copy, own icons). Public landing, SEO pages, mobile web: excluded | 4 |

### Data (D)

| ID | Jobright feature | Built from | Phase |
|---|---|---|---|
| D1 | Job volume, all levels, US | Local crawler core: adapters ported from FH and JS to TypeScript, board directory, pacer. Ceiling per laptop about 25K to 60K US postings. Metered fetch for pages plain HTTP cannot reach | 1 |
| D2 | Full text, years, skills, pay | Parse locally: FH `reqextract` and `skilltag` ideas, NEW pay parser. Keep posted date and pay (jobsync drops both today). Remove IT-only gates | 1 |
| D3 | Company: size, funding, investors, leaders, news | Local cache. Wikidata, SEC, GLEIF for basics. Investors and stage: LLM with web search through the metered route, cached, about $0.03 a company. Partial by design | 5 |
| D4 | "H-1B sponsor likely" tag and filter | DOL LCA files turned into a static table of about 8 MB (83,972 employers), shipped with the app and refreshed from a release file. Exact name plus alias table. Hedged wording. Never "No H-1B" from a missing match | 1 |
| D5 | Fresh jobs, no ghost jobs | Per-laptop: mark a job closed when it vanishes from its board, with a mass-close guard (FH `board_scope`), plus age rules. Cross-user ghost signals are dropped. Your data: 68.7% of 3-month-old postings had vanished | 1 |

### Matching and AI (M, T)

| ID | Jobright feature | Built from | Phase |
|---|---|---|---|
| M1 | Match % with Experience, Skill and Industry parts, bands, "why you fit" | NEW engine. Ideas: FH `jobmatch`, `hardconstraint`; JN five-part rubric and requirement map; RR `jd/match.ts`; CO `jd-skill-gap.mjs`. Every score shows reasons. Deterministic first, LLM text second. Target format (`UI-SPEC-LOGGED-IN`, section MATCH SCORE): a percent, a band (STRONG 85+, GOOD 70 to 84, FAIR below 70), three sub-scores (Experience Level, Skills, Industry Experience), and "why you fit" chips. Jobright's own score moves 1 to 3 points, and up to 12 on Industry, between page loads. Ours will be stable | 3 |
| M2 | Semantic matching | bge-small-en-v1.5 (MIT, 384-d) on the laptop. Store float16 in SQLite, load as float32 in RAM, filter first, then brute-force cosine (no ANN index, no sqlite-vec). Embed new and changed rows that pass the user's filters at crawl time, and the rest lazily (spike S2) | 3 |
| M3 | Orion copilot | JS agent shell, plus tools from FH (about 35) and presets (chat, browse, profile, tailor, interview, debrief) | 5 |
| M4 | ATS score and keyword gaps | RR `ats-pdf` (77 rules, reads the real PDF) | 3 |
| M5 | Insider connections | NEW Network tool (`Connections.csv`). See section 7 | 5 |
| M6 | Interview prep | FH rehearsal preset, JS personal question bank. No curated 6,656-question bank: that content is Jobright's. Partial by design | 5 |
| T1 | Truthful tailoring (new gap, found by audit 03) | RM `resume_preservation.py` and CO `verify-cv-facts.mjs`. Remove RM's job-description skill adder (`improver.py:842`). Do not use JadeAI prompts | 3 |

### Actions (A) and platform (P)

| ID | Jobright feature | Built from | Phase |
|---|---|---|---|
| A1 | Autofill extension: Workday, Greenhouse, Lever, iCIMS, Ashby, Workable | FH `extension/` engine, JN Workday selectors and EEO schema, NEW localhost link to the app. No audited repo has real Workday support | 6 |
| A2 | Agent (auto-apply) | Assisted apply only: it fills, you review, you submit. This matches Jobright's own beta, which is "review before submit". No CAPTCHA bypass. No LinkedIn or Indeed | 6 |
| P1 | Accounts | One local user. No login. The publik key comes from the `PC` provisioning pattern | 2 |
| P2 | Free credits, paid plan | The publik balance card from publik `CONTRACT` section 12. UI copy says dollars and "balance", never "credits" | 2 |
| P3 | Mobile apps, instant alerts | Mobile: excluded (desktop scope). Alerts: macOS notifications | 4 |

## 4. Phases and gates

Sizes: S = days, M = 1 to 2 weeks, L = 2 or more weeks. These are estimates. The spikes replace guesses with numbers.

| Phase | Work | Size | Starts when |
|---|---|---|---|
| 0 | Spikes S1 to S4 (section 5). No spend. No deploy. Running now | S | Now |
| 1 | Crawler core and local job store: adapters (Greenhouse, Lever, Ashby, then Workable, Recruitee, Personio), pacer, dedupe, close-vanished, board directory, H-1B table, tray poller | M | S1 and S2 pass |
| 2 | Client core: Tauri shell, local Node server, SQLite, filters, tabs, tracker, publik provisioning and balance card | M | S3 passes |
| 3 | Profile, resume parse, match engine, embeddings, tailoring with truth gate, ATS report, PDF and DOCX | L | Phase 2 core |
| 4 | UI parity pass: Ant Design theme, every screen checked against `UI-SPEC` and `UI-SPEC-LOGGED-IN` with screenshots | L | Phase 2 |
| 5 | Copilot, interview rehearsal, Network tool, company facts, metered fetch and search through publik | M | Phase 3, and G-resale for the metered route |
| 6 | Chrome extension and assisted apply, Workday last | L | Phase 2 |
| 7 | Sign and notarize, auto-update, Windows CI, publik listing | M | G-release |

Phases 2 to 6 run in parallel lanes once S3 passes.

Gates:

| Gate | What must happen first |
|---|---|
| G-resale | Parallel (primary) and Tavily (failover) allow resale only inside publik's own apps, with their terms flowed down (spike S4). Email both for written confirmation, run a 30-URL live proof, get the counsel read, and set the prices. If they refuse, the metered route becomes "bring your own provider key" |
| G-publik | You approve each change to the live publik repo (new `/fetch` and `/search` routes, a jobleft app row and token). I work on a branch and never push to main without your word |
| G-store | You approve the Chrome Web Store submission |
| G-release | Name check and counsel review (section 6), then you approve the first public release |

## 5. Spikes (Phase 0)

| Spike | Question | Pass when | State |
|---|---|---|---|
| S1 (changed) | Does a local TypeScript crawler core, ported from freehire and jobsync, crawl 30 boards into SQLite with dedupe and close-vanished logic, and keep non-IT jobs? | At least 90% of 30 boards produce rows, non-IT jobs are kept, 10 unit tests are green, and the 2,000-company estimate is measured | **PASSED**: 30 of 30 boards, 4,907 jobs (25 boards mostly non-IT), 76 tests green, about 55K postings and a 17-minute refresh for 2,000 companies. freehire's own gates would drop 32.5% of non-IT jobs and hide 55% more, so we do not run its pipeline. Report: `~/jobleft/spikes/s1-ingest/REPORT.md` |
| S2 (changed) | How big and fast is a local store of 100K to 500K jobs with embeddings and search? | Full search under 200 ms at 100K rows. Sizes and embed times measured | **PASSED** (synthetic data, so size and speed only): bge-small embeds about 200 to 250 jobs a second on CPU (about 4 s per 1,000). Search over 100K rows takes at most 55 ms, and over 500K rows at most 93 ms with an in-memory filter. 100K rows insert in 1.4 s. The local SQLite file is 141 MB per 100K rows (707 MB at 500K with int8). CoreML was 7 to 10 times slower. The int8 model was rejected. Report: `~/jobleft/spikes/s2-snapshot/REPORT.md` |
| S3 | Does the jobsync fork run inside Tauri as a sidecar, and should the shell be Tauri or Electron? | Starts from an app bundle, SQLite in the app-support folder, Prisma works on Apple silicon, the boot-time `npx prisma migrate deploy` is replaced, a custom-URL provider answers a chat | **PASSED, with caveats**: bundle 223 MB (Node sidecar 115 MB), first page about 1 s, idle memory about 550 MB, `tauri build` 77 s, 39 migrations run offline in 80 ms, custom-URL provider streams and calls a tool. Ollama failed as shipped (`think:true` hard-coded) and passes after a patch. Open: no login on the local API, manual signing of the Node binary, no visual WKWebView check. Report: `~/jobleft/spikes/s3-shell/REPORT.md` |
| S4 (new) | Which pay-as-you-go scraping and search upstream can publik resell, at what price, with what float? | A provider with no monthly minimum whose terms allow resale, or a clear "no" and the bring-your-own-key fallback | **DONE**: Parallel (primary) and Tavily (failover) allow resale only inside publik's own apps with their terms flowed down. Exa and Bright Data need written approval. Brave, Zyte, Firecrawl, ScrapingBee and Vercel AI Gateway forbid it. No aggregator exists. Parallel costs $1 per 1,000 searches or pages and handles JS pages. Proposed publik prices: search $5, plain page $2, JS page $4 per 1,000. Report: `~/jobleft/docs/research/06-metered-scrape.md` |

Spike rules for every agent I start: no personal data in any request, 1 request a second per host, robots.txt respected, no LinkedIn, Indeed, Glassdoor or SmartRecruiters, no live Workday request without your approval, no secrets in the environment, repos read-only except where a spike says otherwise.

If S1 fails, the fallback is to lean on the jobsync discovery pipeline as it is (3 ATS types, 3,622 boards).
If S3 fails, the shell becomes Electron. Iris for Windows already uses it.

## 6. Cost, legal and risk

**Cost.** Fixed cost: **$0**. There is no server, no database plan and no storage bill for jobs.

| Item | Cost |
|---|---|
| Crawling employers' public job APIs from the laptop | $0 |
| AI through the publik API | Metered, paid from the user's balance. Free with a local model |
| Metered fetch and search (later) | Metered, paid from the user's balance. publik buys the upstream per use and sells at its own price. Starting float: $20 at Parallel. Tavily needs no prepay. No plan tier to buy. Build it after the crawler, unless onboarding needs company discovery |
| Static data (H-1B table, board directory) | Free file hosting (GitHub Releases) |
| Chrome Web Store developer fee | Small and one-time. Amount not verified |
| Apple Developer signing | Already have (`R5R3ZS54LV`) |

**Legal.** I am not a lawyer. In this design, jobleft and publik never store or serve other companies' postings. Each laptop fetches and keeps its own copy for personal use. I read that as much lower risk than a shared index. It is not zero risk.

| Risk | What I know | Mitigation |
|---|---|---|
| Employers' terms and robots.txt | hiQ v. LinkedIn: public pages are unlikely to break the computer-fraud law, but a terms-of-use ban on scraping was enforced ($500,000, injunction, data destroyed) | Employer-published feeds only. Honor robots.txt. One request a second per host. Link every job back to the employer's apply page |
| Hosts that say no | SmartRecruiters `robots.txt` disallows `*`. Workable sets `ai-train=no`. Lever wants a 1-second crawl delay. Workday CXS is undocumented and gray | Leave SmartRecruiters out. Ask you before any Workday crawl. No model training on postings. Drop every spoofed-browser adapter |
| Never | LinkedIn, Indeed, Glassdoor scraping or automation | Never |
| Crawler identity | A polite crawler names itself with a contact address | Use `jobleft/<version>` plus a project contact address. Never a personal email. Needs a domain after the name is cleared |
| Metered resale | Upstream scraping providers may forbid resale | G-resale. Fallback: bring your own provider key |
| The name | "jobleft" flips "Jobright". A web search found no product called jobleft. That is not clearance | Run a [USPTO search](https://www.uspto.gov/trademarks/search). Ask counsel. Consider another name before any public release |
| Data licences | GeoNames needs attribution (CC BY 4.0). Wikipedia text is CC BY-SA. The unicorn list is share-alike. DOL and USCIS data are public | Keep attribution. Avoid share-alike data in the shipped app, or isolate it |
| Extension and autofill | Users fill their own applications. Chrome Web Store has a user-data policy. ATS terms may limit automation | Assisted apply only. No CAPTCHA bypass. Say plainly what the extension reads |
| Code provenance | freehire is 3.5 months old and AI-written. I port pure logic only | Review each module. Keep the MIT notice. Rename everything. Drop its brand marks, data lists, photo and root certificate |
| Match quality unknown | No repo has Jobright's three-part score. `cvmatch` fails on decorated titles | Build a small labeled eval set before Phase 3 ships |
| Local model quality | Small models break strict JSON output | Keep a line-based fallback (the jobsync `SCORES:` header). Test with a 7B to 14B model |
| Local API has no login | S3 tested it: any web page you visit can call the local server | A random launch token, Host and Origin checks, loopback only, no permissive CORS. The extension pairs with the app once. Build this in Phase 2 |
| Shell choice not proven visually | S3 checked WKWebView by load events only. NitroAI ships Electron, not Tauri | Before Phase 2 commits, render the Ant Design feed in WKWebView and in Chromium and compare. If they differ, switch to Electron. The Node server is the same in both shells |
| Workday autofill | Multi-page flow with account login. No repo handles it | Chrome extension keeps your own login. Build it last. Say plainly that it is partial until proven |
| Claude subscription login | Two audited repos ship one (`claude_code`, `claude_cli`). Your rule forbids it | Not shipped. Providers: publik API, own key, Codex sign-in, Ollama, custom URL |

## 7. The Network tool (replaces Insider Connections)

| Step | What happens |
|---|---|
| Import | You pick `Connections.csv`. The parser skips the 3 note lines, then reads `First Name, Last Name, URL, Email Address, Company, Position, Connected On`. Nothing uploads |
| Match | Company names are normalized (BASE `normalize_company` idea) and matched to jobs. Cards show "You know 3 people at Stripe" |
| Rank | Score: target company, role fit (recruiter, hiring manager, engineer on the team), seniority, how long ago you connected, email present. Each score lists its reasons |
| Plan | Top people per target company go into a coffee-chat list |
| Draft | The AI writes a short message (publik API or local model). You copy it and send it yourself |
| Track | To contact, Messaged, Replied, Met, Follow-up due, with reminders |
| Map | Target companies where you know nobody |

How to get the file (shown on the import screen; steps 1 to 4 confirmed on LinkedIn's help page): Me, Settings & Privacy, Data privacy, Get a copy of your data, choose the larger archive, Request archive, click the emailed link, unzip, import `Connections.csv`. LinkedIn exports first-degree connections only. Many emails are blank. Chinese, Japanese and Hebrew names come out garbled.

Optional later, off by default: `messages.csv` from the same archive, to show who you talk to often.

## 8. Excluded features

| Feature | Reason |
|---|---|
| TNT talent network | Needs a member network |
| Member-to-member referrals | Needs a member network |
| Public GitHub job lists | Community output |
| Applicant counts, "Top Applicants", "Early applicant" | Need Jobright's own user base |
| Live human coaching | A human service |
| Reviews and social proof | Not a feature |
| Employer side | Out of scope |
| Public landing, SEO job pages, mobile web | A desktop app has no public site. The free tools (resume check, tailor, cover letter) exist as in-app features |
| Curated 6,656-question interview bank | Jobright's content. I build rehearsal and a personal bank instead |
| Hosted job index | Replaced by local-first crawling (your decision) |

## 9. What I still need from you

| # | Item | Why |
|---|---|---|
| 1 | Decide on the metered route after spike S4 reports | G-resale |
| 2 | Legal review and name check before any public release | G-release. Not needed for private use |
| 3 | A project contact address for the crawler's User-Agent (not your personal email) | Polite crawling |
| 4 | Approve each change to the live publik repo | G-publik |

Done: plan approval, the product name, the Jobright onboarding with a made-up persona (the logged-in capture is running).

## 10. Method notes and slips (for the record)

- Audits read repos and ran nothing, with one exception. The autofill agent ran Python `exec` on the first 94 lines of JobNavigator `backend/autofill_schema.py`. I checked those lines: literal data only, no imports, no file, process or network calls.
- The data-supply agent put your email in the `User-Agent` header of its early probes (about 15:38 to 16:05 local time). Hosts: the ATS boards it tested, Common Crawl, DOL and USCIS. It cannot be recalled. Later requests used a neutral agent.
- Corrections to earlier files: the base's truthfulness guard is a prompt rule, not a checked gate (audit 03). freehire does import USCIS H-1B data at company level, and it has 6 chat presets, not 5 (audit 01). Jobright's public job list shows its join wall after 50 jobs, not after 18 to 20 (`UI-SPEC` section 08).
- Side finding from spike S4, outside jobleft: OpenRouter Terms section 7 bars "reselling API access to Models". Your R26 memo (Sep 18) said "Never front OpenRouter". The chat tiers moved to OpenRouter on Sep 22. I did not act on this. It needs your decision: ask OpenRouter for written approval, or keep the OpenAI-platform fallback ready.
- My error: I said NitroAI uses a Tauri shell with a local Node server. It ships Electron (`electron/main.mjs`, `electron-builder`). Its `src-tauri` has no sidecar. Its local Node server (`server/publik.mjs`, `publikProxy.mjs`, `ollama.mjs`) is still the right thing to reuse. My memory note was out of date.
- Spike S1 ran `go env` with an unscrubbed environment, which started a Go toolchain download into your Go cache. The agent killed it and removed its two partial files. I checked: no toolchain files remain and `go version` still works. S1 also found that your Internship Machine dedupe strips the `gh_jid` query parameter, which merges different jobs on company-hosted Greenhouse pages. The new crawler keeps `gh_jid`.
- The first browser form-fill on Jobright was blocked by the permission check. I stopped, and I filled the onboarding only after you said "you're allowed".
- UI capture: the public spec came from a separate clean headless Chrome, so every public screen is a true logged-out view.
- Verified from the logged-in Upgrade sheet (2026-09-24): Turbo weekly $17.99, monthly $39.99 (list $49.99), quarterly $89.99 (list $149.97). All three match the third-party posts. Interview passes: $19.99 for 7 days (one company), $39.99 for 30 days. Free limits: 2 resume, 4 autofill, 2 cover letter and 2 email-finder credits a day, 1 saved filter, 1 alert a day. A 6-month plan, an annual plan, a free trial and a countdown timer were not shown.
- Not seen: the Agent screen (`/agent` stays on a loader, in hidden and visible windows, on the Free Plan with an incomplete profile), the profile wizard steps 2 to 5, every paid-plan screen, the extension, and the phone apps. Nothing was spent, applied, sent or saved.
- Not verified: Reddit quotes (blocked) and dependency licences of freehire (Meilisearch, `typst`, `pdftotext`).
