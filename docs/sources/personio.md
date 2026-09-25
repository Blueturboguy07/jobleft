# Personio

Decision: **crawled** (adapter `personio` in `packages/sources-ats/src/adapters/personio.ts`).

## Checked on

| Fact | Date | By |
|---|---|---|
| Developer Hub pages on the positions XML feed | 2026-09-25 | sources-ats lane |
| robots.txt of personio.jobs.personio.de | 2026-09-25 | sources-ats lane |
| One live payload captured (board `personio`) | 2026-09-25 | sources-ats lane |
| Personio terms | 2026-09-25: www.personio.com answered HTTP 429 to one request; not retried | sources-ats lane |

## Evidence

| Source | Quote |
|---|---|
| Personio Developer Hub, "Retrieving open positions": https://developer.personio.de/docs/retrieving-open-job-positions | "Description of the positions xml feed of the Personio Recruiting API" and "Current open job postings can be retrieved in XML format under myaccount.jobs.personio.de/xml." |
| Personio Developer Hub, "Integration via code": https://developer.personio.de/docs/integration-of-open-positions | A code sample for "your wordpress-based jobsite" that reads `simplexml_load_file('https://' . $hostname . '.jobs.personio.de/xml?language=' . $lang)` and links each job as `'https://' . $hostname . '.jobs.personio.de/job/' . $position->id`. No key appears. |
| robots.txt, https://personio.jobs.personio.de/robots.txt | HTTP 404 (no rules published, so everything is allowed under RFC 9309) |

Automated reading: the feed exists for other programs to read (the documented use is a website that pulls the feed), it needs no key, and no robots.txt rule forbids it. The employer must switch the feed on: the Personio help-centre article "Integrate jobs from Personio into your website via XML" (https://support.personio.de/hc/en-us/articles/207576365) says to enable the XML interface under Settings > Recruiting > Career page. That sentence was seen in a web-search summary on 2026-09-25; the page itself was not fetched. A board with the feed off fails with a plain reason.

## Endpoints

| What | URL |
|---|---|
| Board | `GET https://{company}.jobs.personio.de/xml` (the default language lists every open position) |
| Second request, only when needed | `GET https://{company}.jobs.personio.de/xml?language=en`, once, when some positions have empty description blocks in the default language. It only fills bodies; a failure changes nothing else |
| Job page (built, not fetched) | `https://{company}.jobs.personio.de/job/{id}` |
| Regional host | `.jobs.personio.com` also serves boards: `region: "com"`. The board id stays the same, so one employer on both domains is one board |
| Paging | None. `fullBoardListing: true` |
| Whole board proven | The root must be `<workzag-jobs>` (or hold `<position>` elements); anything else fails the board. Cut-off XML, an HTML page or an empty body fail the board. |

## Limits

None published. At most 1 request per second per host.

## Keys

None.

## Credit

None required by anything found.

## Storage

Not addressed. Local copy for the person's own search only.

## Field map

| Personio element | jobleft (`RawJob`) | Notes |
|---|---|---|
| `id` | `externalId` | |
| `name` | `title` | XML entities decoded once (`&#039;` becomes an apostrophe) |
| `subcompany` | `company` | The employing entity when the account has several; else the board list's name |
| `office` + `additionalOffices/office` | `location` | Joined with "; ". Office names only; the feed has no country |
| (none) | `workMode`, `remote` | The feed has no remote field. The crawler still marks a job remote when the office text says "Remote" |
| `createdAt` | `postedAt` | The feed's only date. Personio names it createdAt (when the position was created) |
| (built) | `url` | `https://{company}.jobs.personio.de/job/{id}` |
| `employmentType` + `schedule` | `employmentType` | intern/trainee = internship, freelance = contract, then schedule full-time / part-time |
| `department` | `department` | |
| `jobDescriptions/jobDescription` (`name`, CDATA `value`) | `descriptionHtml` | Each block under its own heading (the block's `name`), so sections stay apart |
| (none) | `pay` | No pay element. Pay written in the text is read by the crawler's text parser |

Not used: `recruitingCategory`, `seniority`, `yearsOfExperience`, `keywords`, `occupation`, `occupationCategory`.

## Quirks

- The root element is `<workzag-jobs>` (an old product name).
- Descriptions are HTML inside CDATA; the heading names are XML-escaped text.
- A position published only in a non-default language can have empty blocks in the default feed (seen by freehire, MIT; idea reused, see THIRD_PARTY_NOTICES.md).

## Fixtures

| File | What |
|---|---|
| `packages/sources-ats/test/fixtures/live/personio-personio.xml` | Real answer from `personio`, 2026-09-25 (1 position, untrimmed) |
| `packages/sources-ats/test/fixtures/standin/personio/acme-demo.xml` | Hand-made: Zürich and München offices, a script inside CDATA, no date, no office, an escaped-HTML block, an intern role |
