# Job source notes

One file per job source: an ATS family (for example `workable.md`) or another feed (for example `usajobs.md`).
A source gets a file before its adapter lands, and the file is updated when anything about the source changes.
The source list that the app shows (`SourceInfo`, `GET /api/v1/sources`) must agree with these files.

The sources-ats lane filled the ATS notes below (2026-09-25). The sources-other lane adds non-ATS feeds.

## ATS source list (sources-ats)

The same list is in code (`ATS_SOURCE_LIST` in `@jobleft/sources-ats`) and on the command line
(`node packages/sources-ats/src/cli.ts sources`). A test checks that the code and these files agree.

| Family | Crawled | Why not, or the evidence | Checked on | Note |
|---|---|---|---|---|
| Greenhouse | yes | Documented public Job Board API | 2026-09-25 | [greenhouse.md](greenhouse.md) |
| Lever | yes | Documented public postings API; robots.txt Crawl-delay 1 | 2026-09-25 | [lever.md](lever.md) |
| Ashby | yes | Documented public Job Postings API | 2026-09-25 | [ashby.md](ashby.md) |
| Workable | yes | Documented public account endpoint; robots.txt `ai-train=no` | 2026-09-25 | [workable.md](workable.md) |
| Recruitee | yes | Documented public Careers Site API; a token is announced from 10 February 2027 | 2026-09-25 | [recruitee.md](recruitee.md) |
| Personio | yes | Documented positions XML feed (.de and .com hosts) | 2026-09-25 | [personio.md](personio.md) |
| Teamtailor | yes | Documented career-site RSS feed (paged); robots.txt `ai-train=no` | 2026-09-25 | [teamtailor.md](teamtailor.md) |
| Gem | yes | Documented public Job Board API | 2026-09-25 | [gem.md](gem.md) |
| BambooHR | no | No documented public feed | 2026-09-25 | [bamboohr.md](bamboohr.md) |
| Breezy HR | no | No documented public feed | 2026-09-25 | [breezy.md](breezy.md) |
| JazzHR | no | No documented public feed | 2026-09-25 | [jazzhr.md](jazzhr.md) |
| Rippling | no | Terms not readable without its web app; owner approval needed | 2026-09-25 | [rippling.md](rippling.md) |
| Jobvite | no | Not reviewed; owner approval needed | 2026-09-25 | [not-crawled.md](not-crawled.md) |
| SmartRecruiters | no, never | robots.txt disallows all crawlers | 2026-09-24 | [smartrecruiters.md](smartrecruiters.md) |
| Workday | no | Owner has not approved; not a documented API | 2026-09-24 | [workday.md](workday.md) |
| iCIMS | no | No documented public feed; owner has not approved | 2026-09-24 | [icims.md](icims.md) |
| Oracle Recruiting | no | Owner has not approved; no feed verified | 2026-09-24 | [oracle.md](oracle.md) |
| UKG | no | Owner has not approved; no feed verified | 2026-09-24 | [ukg.md](ukg.md) |
| Taleo | no | Owner has not approved; no feed verified | 2026-09-24 | [taleo.md](taleo.md) |
| LinkedIn, Indeed, Glassdoor | no, never | Terms or the plan forbid it | 2026-09-24 | [never-crawled-sites.md](never-crawled-sites.md) |

## What each file holds

| Section | Content |
|---|---|
| Decision | Crawled, or not crawled. For "not crawled": the reason (no documented public feed, robots.txt disallows the feed, terms forbid automated access, a login is needed, or the owner has not approved it) |
| Checked on | The date each fact below was checked, and by which lane |
| Evidence | Links to the official feed documentation, the robots.txt as read (quote the lines that matter), and the terms section that allows or forbids use |
| Endpoints | URL patterns, regional hosts, pagination, how "the whole board" is proven (`fullBoardListing`) |
| Limits | Published rate limits, crawl delay, daily caps. jobleft never exceeds 1 request per second per host |
| Keys | Whether a key or a registration is needed, and what the key may be sent with (a header only; never a URL) |
| Credit | Credit text and link the terms require, and where it must appear (card, detail, alerts, exports) |
| Storage | Whether the terms allow storing and re-listing the jobs (`storable`) |
| Field map | Each field of the source mapped to the `Job` contract, with units (cents or dollars, hour or year) and what is missing |
| Quirks | Entity-encoded HTML, CDATA, time zones, reposts, id reuse, anything that broke a parser |
| Fixtures | Where the recorded or hand-made stand-in replies live, and what each one covers (normal, errors, changed shape) |

## Rules

- No live request to write these notes beyond reading official documentation pages and robots.txt, at most 1 request per second per host, with the User-Agent `jobleft-build/0.1 (research build; no personal data)`.
- Never LinkedIn, Indeed, Glassdoor or SmartRecruiters. No live Workday, iCIMS, Oracle, UKG or Taleo request.
- No personal data in the notes or the fixtures. Fixtures use made-up employers and the persona "Jordan Testwell" only.
  Exception (sources-ats lane spec): one real answer per built ATS family, captured once from a public board, is kept in
  `packages/sources-ats/test/fixtures/live/` so the field maps are tested on real data. They are employers' public
  postings; a scan found no personal e-mail address or phone number (see that folder's README).
- Quote only what is needed; name the source and the date for each quote.
