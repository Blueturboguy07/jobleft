# Job source notes

One file per job source: an ATS family (for example `workable.md`) or another feed (for example `usajobs.md`).
A source gets a file before its adapter lands, and the file is updated when anything about the source changes.
The source list that the app shows (`SourceInfo`, `GET /api/v1/sources`) must agree with these files.

This folder is empty on purpose. The sources-ats and sources-other lanes fill it.

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
- Quote only what is needed; name the source and the date for each quote.
