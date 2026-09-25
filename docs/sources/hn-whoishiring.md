# Hacker News "Ask HN: Who is hiring?"

| Field | Value |
|---|---|
| Source id | `hn-whoishiring` |
| Kind | `community` |
| Decision | **Crawled through the public HN Search API by Algolia** (ships OFF). Flagged for the owner: YC's Terms of Use restrict data mining and commercial use of Site Content (see below) |
| Checked on | 2026-09-25, lane sources-other |

## Evidence

| What | Quote or fact | Where |
|---|---|---|
| YC Terms of Use, Site Content | "Except as expressly authorized by Y Combinator, you agree not to modify, copy, frame, scrape, rent, lease, loan, sell, distribute or create derivative works based on the Site or the Site Content ... In connection with your use of the Site you will not engage in or use any data mining, robots, scraping or similar data gathering or extraction methods." | https://www.ycombinator.com/legal/ (Terms of Use, read 2026-09-25). "Site" = the Y Combinator website "including all subdomains" |
| YC Terms of Use, commercial use | "Unless otherwise expressly authorized herein or in the Site, you agree not to display, distribute, license, perform, publish, reproduce, duplicate, copy, create derivative works from, modify, sell, resell, exploit, transfer or upload for any commercial purposes, any portion of the Site" | same |
| Official API (express authorization of programmatic access) | Hacker News publishes an official API (linked as "API" in the HN footer): "There is currently no rate limit." Repository licence: MIT (code) | https://github.com/HackerNews/API |
| HN Search API by Algolia | Rate limit: 10,000 requests an hour per IP. No separate terms page was found | https://hn.algolia.com/api (page renders by script; limit confirmed by search) |
| robots.txt | `hn.algolia.com/robots.txt` answers 404 (no rules published) | read 2026-09-25 |

## Reading of the terms

HN and YC offer programmatic access (the official API; the Algolia search is linked from every HN page), and the
hiring threads exist so that employers reach job seekers. jobleft reads one public thread a day for one person, keeps
it on that person's laptop, sells nothing and links every job back to its comment. Against that, the Terms of Use ban
"data mining ... or similar data gathering or extraction methods" except as expressly authorized, and bar commercial
use. This lane reads the API as the express authorization and the use as personal, so the source is built, but it
ships OFF and needs the owner's (and counsel's) review before any public release.

Never read: the "Ask HN: Who wants to be hired?" and "Freelancer? Seeking freelancer?" threads (job seekers' personal
data). The adapter accepts only a story by `whoishiring` whose title matches `Ask HN: Who is hiring? (<Month> <Year>)`.

## Endpoints

| Step | URL |
|---|---|
| Find the newest thread | `GET https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10` |
| Read it | `GET https://hn.algolia.com/api/v1/items/<story id>` (the whole comment tree in one answer, about 0.5 MB) |
| Link back | `https://news.ycombinator.com/item?id=<comment id>` (never fetched by jobleft) |

Whole feed proven: yes, when the items answer is the story with its `children` array. Jobs from an older month's
thread close when a newer thread is read (the source no longer lists them).

## Limits

| Limit | Value |
|---|---|
| Published | 10,000 requests an hour per IP |
| jobleft | At most 2 runs in any 24 hours, at least 6 hours apart, 2 requests per run, 1 request per second |

## Keys

None.

## Credit

Not required by any term. jobleft still shows the source name "Hacker News: Who is hiring?", credit
"Posted in <thread title> on Hacker News" linking to the thread, and each job's link to its own comment.

## Storage

Personal copy on the laptop only (`storable: true`); see "Reading of the terms".

## Field map

Only top-level comments are postings. The first line (before the first paragraph break) is split on `|`, the format
the thread asks for ("Company | Position | Location | ...").

| Part | jobleft `Job` | Rule |
|---|---|---|
| comment `id` | `externalId` | |
| first segment | `company` | Links and "(YC W24)"-style tags removed; a comment whose first line has no `|` is skipped (count shown) |
| a segment with a role word (engineer, developer, manager, designer, scientist, analyst, researcher, intern, "roles", "positions", ...) | `title` | When no segment names a role: "Open roles at <company>" (a label, not a fact) |
| segments with REMOTE / ONSITE / HYBRID / "in office" | `workModel` | Only remote words: `remote`. Only hybrid: `hybrid`. Only onsite: `onsite`. Remote and onsite together ("ONSITE or REMOTE"): unknown (`null`), remote scope still recorded |
| "REMOTE (US)", "Remote (Europe)", "REMOTE Worldwide" | `remoteScope` | The posting's words; regions parsed only when named |
| segments that look like places | `places` | Text as written |
| full-time / part-time / contract / intern | `employmentType` | |
| the first pay segment of the first line, else a range in the text | `pay` | A segment such as "$150 - 210K USD + equity" (a currency must be written; more than two amounts, as in several roles' pay, gives none); else `parsePayFromText`, which needs a currency and a range |
| `created_at` | `postedAt` | The comment time |
| an ATS posting link first, then a careers or jobs page | `applyUrl` | Otherwise none; the company home page is never called an apply page |

## Fixtures

| File | What it covers |
|---|---|
| `packages/sources-other/fixtures/hn/search.json` | Shape of the real search answer of 2026-09-25, including a "Who wants to be hired?" story that must be ignored |
| `packages/sources-other/fixtures/hn/item.json` | Shape of the real thread answer of 2026-09-25 with made-up companies, no usernames of real people, and made-up links |
| `packages/sources-other/fixtures/hn/shape.json` | Key and type signature of the real answers |
