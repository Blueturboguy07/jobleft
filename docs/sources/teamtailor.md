# Teamtailor

Decision: **crawled** (adapter `teamtailor` in `packages/sources-ats/src/adapters/teamtailor.ts`).

## Checked on

| Fact | Date | By |
|---|---|---|
| Support Center article on the RSS feed | 2026-09-25 (article dated 2026-08-24) | sources-ats lane |
| robots.txt of career.teamtailor.com | 2026-09-25 | sources-ats lane |
| Terms (https://www.teamtailor.com/en/terms-and-conditions/) searched for a scraping ban | 2026-09-25 | sources-ats lane |
| One live payload captured (board `career`, Teamtailor's own) | 2026-09-25 | sources-ats lane |
| North America host `*.na.teamtailor.com` exists | 2026-09-25 (web search results for several employers) | sources-ats lane |

## Evidence

| Source | Quote |
|---|---|
| Teamtailor Support Center, "RSS feed: how-to guide": https://support.teamtailor.com/en/articles/11171756-rss-feed-how-to-guide | "How to create an RSS feed from your Teamtailor careers site, which you can then use to send data to other systems." / "Go to the main jobs page of your careers site and add ".rss". For example, https://career.teamtailor.com/jobs.rss" / "Note that all of the data is publicly available" / "By default, the RSS feed will show the first 100 jobs. However, you can edit the URL in order to show more by using "offset" and/or "per_page"" |
| robots.txt, https://career.teamtailor.com/robots.txt | `User-Agent: *` disallows `/app/`, `/messages/`, `/messenger/`, `/facebook/tab/`, `/jobs/internal/`; `Content-Signal: search=yes, ai-train=no, ai-input=yes`. `/jobs.rss` is allowed. |
| Terms, https://www.teamtailor.com/en/terms-and-conditions/ | Searched for "scrape", "crawl", "spider", "robot", "automated means", "data mining", "harvest": no clause found. The terms bind Teamtailor's customers. |

Automated reading: allowed as far as the documentation shows. The feed is documented as a way "to send data to other systems", and its data "is publicly available". The content signal `ai-train=no` means no model training on these postings.

## Endpoints

| What | URL |
|---|---|
| Page | `GET https://{company}.teamtailor.com/jobs.rss?offset={n}&per_page=100` |
| North America | `GET https://{company}.na.teamtailor.com/jobs.rss?...` (`region: "na"`) |
| Paging | `offset` and `per_page` (documented). jobleft asks for 100 per page (the documented default size) and reads the next page until a page has fewer than 100 items or none. |
| Whole board proven | Every page is read; any failed page fails the whole board (so nothing on it can close). A page that only repeats jobs already read fails the board ("the feed does not advance"). More than 100 pages (10,000 jobs) fails the board ("stopped, and the board was not read in full"). So a list the adapter returns is the whole board: `fullBoardListing: true`. |
| Host per board | Each board is its own sub-domain, so each board is its own host for the pacer and robots.txt. Custom domains are not used; the teamtailor.com sub-domain is. |

## Limits

None published. At most 1 request per second per host.

## Keys

None. (Teamtailor's own API needs a key; it is not used.)

## Credit

None required by anything found.

## Storage

Not addressed. Local copy only. No model training (content signal).

## Field map

| RSS element | jobleft (`RawJob`) | Notes |
|---|---|---|
| number in `link` (`/jobs/8021334-...`), else `guid` | `externalId` | The same id a pasted job link gives |
| `title` | `title` | |
| channel `title` | `company` | The career site's name; else the board list's name |
| `tt:locations/tt:location` (`tt:city` or `tt:name`, `tt:country`) | `location`, `countries` | "City, Country"; several joined with "; ". Street and post code are not kept |
| `remoteStatus` (`none`, `hybrid`, `fully`, `temporary`) | `workMode`, `remote` | none = on-site (the board says not remote), hybrid, fully = remote; temporary and unknown values say nothing |
| `pubDate` (RFC 822 with offset) | `postedAt` | Converted to UTC |
| `link` | `url` | |
| (none) | `applyUrl` | The job page holds the form |
| `tt:department` | `department` | `tt:role` and `tt:division` are not used |
| `description` (HTML, entity-encoded inside XML) | `descriptionHtml` | Decoded once by the XML reader, then turned into text by the crawler (which decodes one more layer only when encoded tags outnumber live ones) |
| (none) | `pay`, `employmentType` | Not in the feed. Pay in the text is read by the crawler's text parser |

## Quirks

- The description is HTML escaped as XML text, not CDATA.
- Some items have an empty `<tt:division/>` and no `<tt:role>`.

## Fixtures

| File | What |
|---|---|
| `packages/sources-ats/test/fixtures/live/teamtailor-career.rss` | Real feed from `career`, 2026-09-25, trimmed to 3 of 15 items |
| `packages/sources-ats/test/fixtures/standin/teamtailor/acme-demo.rss` | Hand-made: on-site, fully remote and hybrid jobs, a script and an iframe in the text, a missing date, Göteborg |
| built in `test/faults.test.ts` | 250 jobs over 3 pages; a feed that repeats its page; a feed that never ends; page 2 failing |
