# One-shot goal (single builder, 2026-09-25)

I am the only builder from here. I build, then I test at every gate with checks I write from the outcome docs, not from my own code. I do not move past a gate until it passes or I have written down exactly why it did not.

## Done means

A person can open the app on this Mac and finish the whole job hunt without help:

1. Start it with `pnpm app:up` (dev) and see the feed within seconds.
2. Onboard: job function, job type, place, resume upload, profile check.
3. See real, current jobs from real employer boards, ranked for them, with pay, place, level and H-1B hints, and closed jobs gone.
4. Filter, sort, save a filter, like a job, open a detail with a stable match breakdown and why-fit chips.
5. Tailor a resume and cover letter for a job: only true facts, one page, PDF and DOCX.
6. Track applications through Applied, Interviewing, Offer, Rejected, Archived, with notes and reminders.
7. Import `Connections.csv` and see who they know at each company, who to message first and why, with a draft they send themselves.
8. Ask the assistant about their own jobs and fit, with a mock or local model, and get grounded answers.
9. Pair the Chrome extension and get an application form filled, never submitted.
10. Do all of it with no cloud unless they choose an AI provider. Nothing leaves the laptop otherwise.

Plus: the three open high defects (crawler same-title merge, parsers foreign-remote and pay estimates, resume truth-gate title attach) are fixed with regression tests.

## Not in this shot

Signed or notarized builds, Windows, the Chrome Web Store, live publik calls, live metered fetch, real vendor emails, the name check. These stay listed in `docs/BUILD-REPORT.md` for Mann.

## Gates (in order; each ends with a commit on main)

| # | Gate | Passes when |
|---|---|---|
| 0 | Baseline | `pnpm check` green on main; `pnpm app:up` starts and health answers |
| 1 | Open defects | The three high defects have failing tests first, then pass |
| 2 | i-core | 10 real boards crawl into the store; feed API returns ranked jobs; closed jobs vanish on a second crawl; counts checked against the boards' own APIs |
| 3 | i-resume | Upload a fake resume, get a profile, tailor for one job, PDF text contains only profile facts (checked by an independent text extract), DOCX opens |
| 4 | i-network | A CSV with traps ranks people correctly and drafts a message; delete-all leaves nothing |
| 5 | i-ai | Assistant answers from local data via a scripted mock model, refuses when data is missing, changes nothing without confirmation |
| 6 | i-ext | Pairing code flow works; a saved real application page is filled; Submit is never clicked |
| 7 | i-ui | Every screen in the reference set works against the real API; screenshots taken in headless Chrome and compared to `~/jobright-research/ui/` |
| 8 | i-shell | Tauri app builds unsigned, starts the sidecar, opens the UI, quits clean; WKWebView vs Chromium screenshots compared |
| 9 | System | Three personas run the full journey end to end; security probes from another origin fail; egress log shows only approved hosts; 100K-row search under 200 ms |
| 10 | Report | `docs/BUILD-REPORT.md` with parity status per plan ID and every gap stated plainly |

## Rules I keep

Nothing pushed, published, signed, emailed or bought. No live Workday, iCIMS, LinkedIn, Indeed, Glassdoor, SmartRecruiters. At most 1 request a second per host, robots.txt honoured, neutral User-Agent, no personal data in any request. The fake persona is Jordan Testwell. Copy rule: dollars and "balance", never "credits". No Jobright marks.
