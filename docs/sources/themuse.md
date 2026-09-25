# The Muse

| Field | Value |
|---|---|
| Source id | `themuse` |
| Kind | `job_board` |
| Decision | **Crawled with the person's own key** (ships OFF; "needs a key" until one is saved) |
| Checked on | 2026-09-25, lane sources-other |

## Evidence

| What | Quote | Where |
|---|---|---|
| Purpose (1.1) | "We have developed an API ... that will allow you to develop your own websites and applications (the "Apps") that utilize or interact with The Muse API to allow you to provide our listings of jobs, companies, coaches and posts as well as other content" | https://www.themuse.com/developers/api/v2/terms (Last Modified 7/25/2015, read 2026-09-25) |
| Registration (2.2) | "In order to access The Muse API, you are required to register your App at https://www.themuse.com/developers/api/v2/apps using your Muse account." | same |
| Licence (3.1) | "... (b) obtaining, using, distributing and transmitting Muse Content to the extent needed to format and display Muse Content through the Apps in accordance with these Terms" | same |
| Restrictions (3.3) | "(a) replicate products or services offered by The Muse; ... (g) clone Muse Content provided through the API." | same |
| Link back (3.4) | "You agree that any Muse Content provided through the Apps by utilizing the Muse API will link back to The Muse Website (located at www.themuse.com)" | same |
| Rate limits (4.2) | "You agree to comply with the technical limitations of the API in developing the Apps and will not violate any rate limits on calling the API." | same |
| No scraping (4.3 d) | "not to use web scraping, web harvesting, or web data extraction methods to extract data from The Muse" | same |
| Keys | "Registration is required for any use beyond testing." With a key: 3,600 requests an hour (`api_key` query parameter). Without: 500 an hour. Headers `X-RateLimit-Remaining`, `X-RateLimit-Limit`, `X-RateLimit-Reset` | https://www.themuse.com/developers/api/v2 |
| robots.txt | `User-agent: *` disallows `/clients/`, `/dashboard/`, `/job/redirect/*`, `/api/users*` and others; `/api/public/jobs` is allowed | https://www.themuse.com/robots.txt (read 2026-09-25) |

## Reading of the terms

The terms were written for exactly this kind of app (1.1, 3.1). Two points need the owner's eye before a public
release: 3.3(a) "replicate products or services offered by The Muse" and 3.3(g) "clone Muse Content". jobleft keeps a
personal copy of one slice (remote jobs), links every job back to themuse.com and never republishes. Because 2.2
requires each app to register, the source runs only with a key the person registers and saves; it sends nothing
without one.

## Endpoints

| Item | Value |
|---|---|
| URL | `GET https://www.themuse.com/api/public/jobs?page=<n>&location=Flexible%20%2F%20Remote&api_key=<key>` |
| Slice | Remote jobs only (`location=Flexible / Remote`): 307 pages, 6,128 jobs on 2026-09-25. All 414,334 jobs would be 20,717 pages, which no personal app should pull |
| Pagination | 20 per page, `page` from 0 to `page_count - 1`. The answer states `page_count` and `total` |
| Whole feed proven | Only when every page from 0 to `page_count - 1` was read in one run with no failure (`complete: true`). A failed page stores what was read and closes nothing |
| Hosts | `www.themuse.com` only |

## Limits

| Limit | Value |
|---|---|
| Published | 3,600 requests an hour with a key |
| jobleft | At most 2 runs in any 24 hours, at least 6 hours apart; at most 400 pages per run and 900 requests in any 24 hours; 1 request per second |

## Keys

The Muse takes the key only as the `api_key` URL parameter (no header is documented). jobleft sends that URL only to
`www.themuse.com`, and every URL that jobleft writes into a log, an error or a status line has the value replaced by
`[redacted]`.

## Credit

Every job links back to its page on themuse.com (`refs.landing_page`), and shows the source name "The Muse" with
credit "Job listing from The Muse" linking to `https://www.themuse.com/`. No logo.

## Storage

Kept on the person's laptop only (`storable: true`), with the link back (3.4).

## Field map

| The Muse field | jobleft `Job` | Notes |
|---|---|---|
| `id` | `externalId` | Number |
| `refs.landing_page` | `url` (link back) | |
| `name` | `title` | |
| `company.name` | `company` | |
| `contents` | `description` | HTML to text |
| `publication_date` | `postedAt` | |
| `locations[].name` | `places` | "Flexible / Remote" is not a place: it sets `workModel: remote` with no region (`remoteScope.regions: []`, "region not stated") |
| `levels[].name` | `level` (`board_field`) | Internship -> intern, Entry Level -> entry, Mid Level -> mid, Senior Level -> senior, management -> manager |
| `type` | not used | Always "external" in the answer read |
| `categories`, `tags` | not used | |

No pay field exists; pay is parsed from the text only when stated.

## Fixtures

| File | What it covers |
|---|---|
| `packages/sources-other/fixtures/themuse/jobs.json` | The `results` of the real remote-slice page 0 of 2026-09-25 (one request, no key), with made-up employers, titles and text; the stand-in pages it 20 at a time |
| `packages/sources-other/fixtures/themuse/shape.json` | Key and type signature of the real answer |
