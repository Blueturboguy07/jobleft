# Workable

Decision: **crawled** (adapter `workable` in `packages/sources-ats/src/adapters/workable.ts`).

## Checked on

| Fact | Date | By |
|---|---|---|
| Public endpoint documented by Workable | 2026-09-25 | sources-ats lane |
| robots.txt of apply.workable.com and www.workable.com | 2026-09-25 | sources-ats lane |
| Terms (www.workable.com/terms, /candidate-terms) searched for a scraping ban | 2026-09-25 | sources-ats lane |
| One live payload captured (board `huggingface`) | 2026-09-25 | sources-ats lane |

## Evidence

| Source | Quote |
|---|---|
| Workable Help, "Using the Workable API to create a careers page": https://help.workable.com/hc/en-us/articles/115012771647-Using-the-Workable-API-to-create-a-careers-page | "Alternatively, to get the list of your published jobs only, you can try in your terminal the below public endpoints: curl -L GET 'https://www.workable.com/api/accounts/{subdomain}?details=true'" and "The part "?details=true" means you also want to fetch the job descriptions." |
| Workable API reference, "api/accounts/:subdomain": https://workable.readme.io/reference/jobs-1 | "Returns a collection of the public jobs for an account". The OpenAPI block is titled "public" and has `"security": [{}]` (no authentication). |
| robots.txt, https://apply.workable.com/robots.txt | `User-agent: *` / `Content-Signal: search=yes, ai-input=yes, ai-train=no` / `Disallow:` (nothing disallowed) |
| robots.txt, https://www.workable.com/robots.txt | `Content-Signal: search=yes, ai-input=yes, ai-train=no`; disallows only `/user_password_resets`, `/admin`, `/auth/google`, `/j/` |
| Terms, https://www.workable.com/terms and https://www.workable.com/candidate-terms | Searched for "scrape", "crawl", "spider", "robot", "automated means", "data mining", "harvest". No clause forbids reading the public job endpoint. The only "harvest" clause binds Workable's customers ("harvest Candidates for improper purposes"). |

Automated reading: allowed as far as the documentation shows. The endpoint is documented for programs (a careers page and a terminal command), it needs no key, and robots.txt allows it. The content signal `ai-train=no` means jobleft must never train a model on these postings (it does not).

## Endpoints

| What | URL |
|---|---|
| Documented | `GET https://www.workable.com/api/accounts/{subdomain}?details=true` |
| What jobleft calls | `GET https://apply.workable.com/api/v1/widget/accounts/{subdomain}?details=true` |
| Why the difference | The documented URL answered `302` with `location: https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true` (checked 2026-09-25, headers only). jobleft never follows redirects (a redirect would skip the pacer, robots.txt and the never-crawl list), so it asks the redirect target directly. Workable's own guide uses `curl -L`, which follows the same redirect. |
| Paging | None. One answer is the whole board (`fullBoardListing: true`). |
| Regional hosts | None found. |
| Whole board proven | One answer holds every published job. An answer without a `jobs` list fails the board ("the feed format may have changed"), so a renamed field never looks like an empty board. |

## Limits

No published rate limit. jobleft sends at most 1 request per second to `apply.workable.com` (every Workable board shares this one host, so boards run one after another).

## Keys

None. The authenticated SPI (`https://{subdomain}.workable.com/spi/v3/jobs`, bearer token) is not used.

## Credit

None required by anything found.

## Storage

Not addressed by the documentation or the terms. jobleft keeps a local copy for the person's own search and never re-lists it. No model training (content signal).

## Field map

| Workable field | jobleft (`RawJob`) | Notes |
|---|---|---|
| `shortcode` | `externalId` | A job without a shortcode is counted as unreadable, never dropped silently |
| `title` | `title` | Tags removed, entities decoded once |
| top-level `name` | `company` | The account name the board reports; else the board list's name |
| `locations[]` (`city`, `region`, `country`, `countryCode`, `hidden`) | `location`, `countries` | "City, Region, Country"; several joined with "; ". A location with `hidden: true` shows only its country (the employer chose not to publish the city). Without `locations`, the top-level `city`, `state`, `country` are used |
| `workplace_type` (`on_site`, `hybrid`, `remote`) | `workMode` | When absent, `telecommuting: true` means remote; `false` says nothing (no "on-site" default) |
| `telecommuting` | `remote` | |
| `published_on` (a date, no time) | `postedAt` | Stored as 12:00 UTC of that date, so the calendar day is the same from UTC-12 to UTC+11. `created_at` is not used as a posted date |
| `url` (else `shortlink`, else `https://apply.workable.com/{subdomain}/j/{shortcode}/`) | `url` | The docs call `url` the application form; the live payload shows it is the job page |
| `application_url` | `applyUrl` | Only absolute http(s) links; `javascript:` and relative links are refused |
| `employment_type` (or `type`) | `employmentType` | "Full-time", "Part-time", "Contract", "Temporary", "Internship" |
| `department` | `department` | |
| `description` (HTML, with `details=true`) | `descriptionHtml` | Converted to text by the crawler. `requirements` and `benefits`, when a board sends them separately, are added under their own headings |
| (none) | `pay` | The widget endpoint has no pay field. Pay written in the description is read by the crawler's text parser (`paySource: "text"`) |

## Quirks

- `url` and `application_url` are swapped relative to the documentation.
- `locations[].hidden` exists in live data; it is not in the documentation.
- Dates are plain dates (`2026-07-30`).

## Fixtures

| File | What |
|---|---|
| `packages/sources-ats/test/fixtures/live/workable-huggingface.json` | Real answer from `huggingface`, 2026-09-25, trimmed to 4 of 8 jobs (hidden and visible locations, an empty city) |
| `packages/sources-ats/test/fixtures/standin/workable/northwind-demo.json` | Hand-made: pay in text, no date and no place, hostile markup in title and text, entity codes, Zürich |
