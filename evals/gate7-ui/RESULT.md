# Gate 7 (i-ui) result, 2026-09-25T15:41:20.983Z

The real built UI served by the real app on a copy of the gate 2 store (11,957 jobs from real employer boards), driven in headless Chrome at 1440×900 (and 1024×640 for the layout audit). Screenshots in `shots/`; the lane's own audit in `shots/audit/`.

| Check | Result | Evidence |
|---|---|---|
| setup.ui | PASS | the app serves the built UI at http://127.0.0.1:47821 (status 200) |
| setup.data | PASS | profile Jordan Testwell; 11957 jobs in the store (copied from gate 2) |
| O11.token-off-the-address-bar | PASS | address fragment after load: "#/jobs" |
| O1.O12.O10.no-banned-text | PASS | 22 screens read; no lorem/sample/TODO/undefined/null/NaN/[object Object]/Jobright/Orion/Turbo/applicants/coach/credits/reference copy |
| O9.no-console-errors | PASS | 0 console errors or uncaught exceptions across 22 screens |
| O12.app-name | PASS | window title: "Jobs · jobleft" |
| O11.no-foreign-requests | PASS | 89 requests from the page; not to the app: 0 |
| O11.fonts-bundled | PASS | @font-face sources pointing off this computer: 0 |
| O2.card-facts-and-links | PASS | 11/11 cards agree with the API on title, company, percent and band; 11/11 detail pages link to the employer's own apply URL |
| O4.score-same-everywhere | PASS | 11/11 detail pages show the API's percent; 11/11 bands follow the number (STRONG ≥85, GOOD 70–84, FAIR <70)<br>lever:palantir:a2e9ab0f-4dd1-4744-92b9-e: card 67% FAIR / api 67% fair / detail 67% / link employer<br>lever:palantir:289ad049-7b4e-41e3-8a39-1: card 67% FAIR / api 67% fair / detail 67% / link employer<br>lever:palantir:34b3a697-6e22-4751-befd-0: card 59% FAIR / api 59% fair / detail 59% / link employer<br>lever:palantir:e7100322-be11-40c8-9dba-7: card 58% FAIR / api 58% fair / detail 58% / link employer<br>lever:palantir:be4ab5cb-9caa-4c2a-97b9-c: card 58% FAIR / api 58% fair / detail 58% / link employer<br>lever:palantir:d83fac1c-353e-4b77-a586-3: card 55% FAIR / api 55% fair / detail 55% / link employer |
| O4.stable-across-reload | PASS | 11/11 cards keep the same score after a full reload |
| O4.sorted-by-number | PASS | the Recommended order goes down by percent: 67, 67, 59, 58, 58, 55, 55, 55, 55, 55, 55 |
| O2.hourly-pay-shown-hourly | PASS | no hourly job among the 100 most recent; skipped |
| O3.no-invented-facts | PASS | job greenhouse:robinhood:8123225 (no pay, no years): no "$0", "0+ years", "No H1B", "Unknown Stage" or "1-10 employees" |
| O3.h1b-hedged | PASS | H-1B wording seen: "H-1B sponsor likely" |
| O6.counts-match | PASS | api / rows on screen / nav badge — liked: 3/3/3, applied: 1/1/1, external: 1/1/1, hidden: 1/1/; nav text: "Recommended Liked 3 Applied 1 External 1" |
| O7.hidden-stays-hidden | PASS | the hidden job lever:palantir:e7100322-be11-40c8-9dba-7 is not in the Recommended list |
| O7.search-by-company | PASS | search "Palantir Technologies": 11 cards on the first page, all that company: true; API finds 323 |
| O10.balance-in-dollars | PASS | settings/balance shows $4.37 (the stand-in wallet): true; the word "credit": false |
| O13.nothing-paid-in-background | PASS | 3 calls to the stand-in publik while browsing every screen; paid ones: 0 |
| O5.survives-force-quit | PASS | after SIGKILL + relaunch: liked 3, note kept true; profile screen shows the new city: true; the note is visible on screen: true |
| O9.error-when-server-down | PASS | with the app's server killed (port closed: true): clicked "lever:palantir:be4ab5cb-9caa-4c2a-97b9-c73805fca4fc"; message seen after 257 ms, still on screen at 5998 ms: "jobleft cannot read the refresh status right now."; the like shown as saved: false; the tracker screen then says: "(nothing)" |
| O1.fresh-install-honest | PASS | first run opens onboarding: true; 13 empty screens read; banned words: 0; console errors: 0; screens with an empty-state message: 9 |
| O14.layout-audit | PASS | 46 screen×size audits (script ok); sideways overflow: 0; off-screen controls: 0; errors: 0; banned: 0 |
| O14.contrast-and-names | PASS | low-contrast text findings: 0; controls without an accessible name: 0 |
| O15.fast-with-full-store | PASS | 11957 jobs; median/slowest ms — feed 11/18, search 11/381, filter 11/13, detail 3/6 (19 of 20 under 1 s each) |

Verdict: PASS
## Side-by-side with the reference screenshots (judged by eye)

| Screen | Mine | Reference (`~/jobright-research/ui/logged-in`) | Parity |
|---|---|---|---|
| Jobs feed | `shots/jobs.png` | `L01a-feed-top-loaded.png` | Same structure: title row with Recommended/Liked/Applied/External counts, search box, filter chips row, cards with logo tile, title, company / team, place, type, pay, work model, hide/like/Ask/Apply row, dark match tile with percent + band + reasons; right column with profile, saved filters, board refresh and a setup checklist. Absent on purpose: applicant counts, "Early applicant", Turbo upsell, Orion, coaching offer. |
| Job detail | `shots/audit/DETAIL@1440x900.png` | `L03b-detail-apple-top-match-breakdown.png` | Same: header actions (hide, like, mark applied, apply on employer site), Overview/Company tabs, score panel with three parts, "Why this score", tools column (tailor, cover letter, keyword gaps, interview, assistant). Insider connections replaced by the CSV network panel. |
| Resume | `shots/resume.png` (empty on this store) | `L04a-resume-workspace-table.png` | Same page shape; no "slots" limit and no Turbo banner. |
| Profile | `shots/profile.png` | `L05a-profile-personal-top.png` | Same sections and edit affordances; privacy line says the data stays on this Mac; no "Complete profile" pressure card. |
| Balance | `shots/settings_balance-connected.png` | `L10i-credit-balance-popover-rocket-icon.png` | Dollars and cents, "balance" wording; no "credits". |

Observations (not failures): the default feed filters (United States, software, Full-time) narrow 11,957 stored jobs to 89 and the top of the list is one employer (Palantir) — a diversity tiebreak is still wanted (noted for the build report). With the app's server stopped, screens with cached data show the old data and only the feed's refresh line says the app cannot be reached; a failed change is never shown as saved.
