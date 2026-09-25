# Recruitee (Tellent Recruitee)

Decision: **crawled** (adapter `recruitee` in `packages/sources-ats/src/adapters/recruitee.ts`), with a known end date: Recruitee announced that the endpoint needs a token from 10 February 2027.

## Checked on

| Fact | Date | By |
|---|---|---|
| Careers Site API documentation (offers, authentication) | 2026-09-25 | sources-ats lane |
| robots.txt (bunq.recruitee.com, which redirects to careers.bunq.com/robots.txt) | 2026-09-25 | sources-ats lane |
| Terms (https://recruitee.com/terms) searched for a scraping ban | 2026-09-25 | sources-ats lane |
| One live payload captured (board `bunq`) | 2026-09-25 | sources-ats lane |

## Evidence

| Source | Quote |
|---|---|
| Recruitee docs, "/offers/": https://docs.recruitee.com/reference/offers | "Returns a collection of published company jobs. Offers can be filtered by department or tag." OpenAPI: server `https://{yourcompany}.recruitee.com/api`, `"security": [{}]` (no authentication). |
| Recruitee docs, "Intro to Careers Site API": https://docs.recruitee.com/reference/intro-to-careers-site-api | "The Recruitee Careers Site API allows to view company's jobs and add new candidates to jobs from candidate perspective." |
| Recruitee docs, "Authentication" (updated 2026-08-12): https://docs.recruitee.com/reference/authentication-1 | "Deadline for introducing the token to calls is **10 February 2027**. Calls without the authorization header will return the `401 Unauthorized` error." and "The XML offer feed and jobs widget are not covered by the Careers API token". |
| Tellent Recruitee Terms, section 2.9 "Careers Site": https://recruitee.com/terms | "This Careers Site is intended, among other things, to provide the public with a list of job opportunities, and therefore Subscriber's usage of the Careers Site is not intended to be private." No clause on scraping, crawling or robots was found. |
| robots.txt (bunq board, served from the custom domain) | `User-agent: *` / `Allow: /` |

Automated reading: allowed as far as the documentation shows, until 10 February 2027. After that date the API needs a token that only the employer can make; jobleft has none, so the board fails with the plain reason "Recruitee refused the request (HTTP 401). Recruitee announced that its Careers Site API needs a token from 10 February 2027, and jobleft has none, so this board cannot be read". The XML offer feed in the docs ("Feed documentation") is "generated per job board" for Recruitee's job-board partners; it is not a per-company public feed, so it is not a replacement.

## Endpoints

| What | URL |
|---|---|
| Board | `GET https://{company}.recruitee.com/api/offers/` |
| Paging | None. One answer is the whole board (`fullBoardListing: true`). |
| Host per board | Each board is its own sub-domain, so each board is its own host for the pacer and for robots.txt. |
| Custom domains | Some employers serve the careers site on their own domain (bunq: careers.bunq.com). The `{company}.recruitee.com` API still answered 200 directly (checked 2026-09-25), so jobleft always uses the recruitee.com host. |
| Whole board proven | An answer without an `offers` list fails the board. |

## Limits

No published rate limit. jobleft sends at most 1 request per second per host.

## Keys

None until 10 February 2027 (see above). jobleft sends no key.

## Credit

None required by anything found.

## Storage

Not addressed. jobleft keeps a local copy for the person's own search and never re-lists it.

## Field map

| Recruitee field | jobleft (`RawJob`) | Notes |
|---|---|---|
| `id` (number) | `externalId` | |
| `title` | `title` | |
| `company_name` | `company` | Else the board list's name |
| `locations[]` (`city` or `name`, `state_name` or `state`, `country`, `country_code`) | `location`, `countries` | "City, State, Country" with repeats removed ("İstanbul, İstanbul, Türkiye" becomes "İstanbul, Türkiye"); several joined with "; ". Falls back to the `location` string |
| `hybrid`, `remote`, `on_site` (booleans) | `workMode`, `remote` | hybrid wins; remote only when not also on-site; on-site only when not also remote; mixed or none says nothing. `remote` is Recruitee's "hiring remote applicants" |
| `published_at` ("2026-09-23 09:10:19 UTC") | `postedAt` | Converted to RFC 3339. `created_at` is not a posted date and is not used |
| `careers_url` | `url` | May be on the employer's custom domain |
| `careers_apply_url` | `applyUrl` | |
| `employment_type_code` (`fulltime_permanent`, `parttime_fixed_term`, `internship`, `freelance`, ...) | `employmentType` | intern/trainee/apprentice, then part, then full, then contract/freelance/temporary |
| `department` | `department` | |
| `description` + `requirements` (HTML) | `descriptionHtml` | Joined with a paragraph break |
| `salary` `{min, max, period, currency}` | `pay` | Strings in plain units ("4000"), never cents. Kept only with a 3-letter currency and a known period (hour, day, week, month, year). Every field null means no pay |

## Quirks

- `min` and `max` are strings.
- The live bunq answer has every salary field present but null.
- The docs example has `remote`, `on_site` and `hybrid` all true at once.

## Fixtures

| File | What |
|---|---|
| `packages/sources-ats/test/fixtures/live/recruitee-bunq.json` | Real answer from `bunq`, 2026-09-25, trimmed to 3 of 16 offers (multi-location, hybrid, null salary) |
| `packages/sources-ats/test/fixtures/standin/recruitee/zephyr-demo.json` | Hand-made: monthly pay in BRL, a remote job with no date and no place, a Japanese title with entity-encoded HTML |
