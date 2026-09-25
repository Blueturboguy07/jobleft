# Gem

Decision: **crawled** (adapter `gem` in `packages/sources-ats/src/adapters/gem.ts`).

## Checked on

| Fact | Date | By |
|---|---|---|
| Job Board API reference (OpenAPI) and the help article | 2026-09-25 | sources-ats lane |
| robots.txt of api.gem.com and jobs.gem.com | 2026-09-25 | sources-ats lane |
| Terms (https://www.gem.com/terms) searched for a scraping ban | 2026-09-25 | sources-ats lane |
| One live payload captured (board `gem`) | 2026-09-25 | sources-ats lane |

## Evidence

| Source | Quote |
|---|---|
| Gem Job Board API reference: https://api.gem.com/job_board/v0/reference (the page loads https://api.gem.com/job_board/v0/openapi.json) | "Most endpoints in the Job Board API are **public** and do not require authentication — job board information can be read by anyone using your job board's vanity URL path." / "The Job Board API does not use pagination. Endpoints return complete lists of all matching resources in a single response." |
| Gem Help Center, "The Job Board API": https://help.gem.com/databases/gem-help-center/the-job-board-api | "This API allows you to generate a list of all live job posts to embed on a suitable web page" and "The endpoint to call is: GET https://api.gem.com/job_board/v0/{vanity_url_path}/job_posts/" |
| robots.txt, https://api.gem.com/robots.txt | HTTP 403 with `{"message":"Forbidden"}`: no rules published (a 4xx answer means no rules under RFC 9309) |
| robots.txt, https://jobs.gem.com/robots.txt | HTTP 404 |
| Terms, https://www.gem.com/terms (served as /compliance/terms) | Searched for "scrape", "crawl", "spider", "robot", "automated means", "data mining", "harvest": no clause found. |

Automated reading: allowed as far as the documentation shows ("can be read by anyone").

## Endpoints

| What | URL |
|---|---|
| Board | `GET https://api.gem.com/job_board/v0/{vanity_url_path}/job_posts/` |
| Paging | None (documented). `fullBoardListing: true` |
| Host | Every Gem board shares `api.gem.com`, so boards run one after another at 1 request per second. |
| Whole board proven | An answer that is not a JSON list fails the board. |

## Limits

Gem: "each API key is subject to a rate limit of 20 requests per second, with a burst capacity of 500 requests". jobleft uses no key and sends at most 1 request per second.

## Keys

None. Only the application endpoint (`POST .../applications`) needs `X-API-Key`; jobleft never calls it.

## Credit

None required by anything found.

## Storage

Not addressed. Local copy only.

## Field map

| Gem field | jobleft (`RawJob`) | Notes |
|---|---|---|
| `id` | `externalId` | |
| `title` | `title` | |
| (none) | `company` | The board list's name (the feed names no employer) |
| `location.name`, else `offices[].location.name` / `offices[].name` | `location` | Several offices joined with "; " |
| `location_type` (`in_office`, `hybrid`, `remote`) | `workMode`, `remote` | |
| `first_published_at` | `postedAt` | `created_at` and `updated_at` are not posted dates and are not used |
| `absolute_url` | `url` | The job page on jobs.gem.com (it holds the form) |
| `employment_type` (`full_time`, `part_time`, `intern`, `contract`, `temporary`) | `employmentType` | intern = internship, temporary = contract |
| `departments[0].name` | `department` | |
| `content` (HTML), else `content_plain` | `descriptionHtml` | Plain text is escaped first, so "<3" stays text |
| (none) | `pay` | Pay in the text is read by the crawler's text parser |

## Quirks

- `content` includes the employer's intro and outro blocks when they are switched on.
- Ids look numeric but are strings.

## Fixtures

| File | What |
|---|---|
| `packages/sources-ats/test/fixtures/live/gem-gem.json` | Real answer from `gem`, 2026-09-25 (4 posts, untrimmed) |
| `packages/sources-ats/test/fixtures/standin/gem/acme-demo.json` | Hand-made: remote, in-office and hybrid posts, hourly pay in text, a missing date, office-only place, plain-text-only body with "<3" |
