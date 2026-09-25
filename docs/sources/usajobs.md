# USAJOBS

| Field | Value |
|---|---|
| Source id | `usajobs` |
| Kind | `government` |
| Decision | **Not crawled** until the owner decides: robots.txt on `data.usajobs.gov` disallows every path for every crawler. The adapter, the key handling and the fixtures are built; the source says "needs a key" and "not crawled" |
| Checked on | 2026-09-25, lane sources-other |

## Evidence

| What | Quote or fact | Where |
|---|---|---|
| robots.txt | `User-agent: *` / `Disallow: /` | https://data.usajobs.gov/robots.txt (read 2026-09-25) |
| Headers | "The user-agent parameter tells USAJOBS who is originating the request. This value should be the email address used when requesting the API Key." and "The authorization-key parameter ... should be the API Key you were provided when requesting access." | https://developer.usajobs.gov/guides/authentication |
| Terms | A generic federal-system notice: "This U. S. Federal Government system is to be used by authorized users only." and "While using this system your use may be monitored, recorded and subject to audit." Nothing on caching, credit or commercial use | https://developer.usajobs.gov/guides/terms-of-use |
| Limits | "Maximum of 10,000 rows per query", "Maximum of 500 rows per page". No request cap published | https://developer.usajobs.gov/guides/rate-limiting |
| Endpoint | `GET https://data.usajobs.gov/api/Search`, parameters `Page`, `ResultsPerPage` (max 500), `DatePosted` (0 to 60), `SortField` (`opendate`, ...), `SortDirection` | https://developer.usajobs.gov/api-reference/get-api-search |

## Why it is not crawled

jobleft obeys robots.txt on every host (plan section 6), and this robots.txt forbids everything. USAJOBS also issues
keys for automated use, so a registered key may count as permission. That is a legal and policy call for the owner,
not for this lane. Until then the source is listed with the reason, cannot be turned on, and sends nothing.

Slip, recorded on purpose: while checking this host on 2026-09-25, one request went to
`https://data.usajobs.gov/api/codelist/rateintervalcodes` in the same shell command that first read the
`Disallow: /` robots.txt. The answer body was empty. No other request went to `data.usajobs.gov`. The User-Agent was
`jobleft-build/0.1 (research build; no personal data)`.

To turn it on later: set `crawled: true` for `usajobs` in `packages/sources-other/src/catalog.ts` and add
`data.usajobs.gov` to `ROBOTS_EXCEPTIONS` in the same file (the only place robots.txt can be skipped, and only with
the owner's written approval).

## Keys and personal data

| Item | Rule |
|---|---|
| What the person enters | One secret: `<registered email> <API key>` (two words, in either order) |
| Where it goes | The key goes only in the `Authorization-Key` header, and the email only in the `User-Agent` header, and only to `data.usajobs.gov`. This is the one documented exception to the fixed jobleft User-Agent (sources-other O11) |
| Never | In a URL, a log, an error text, an export or a backup |

## Limits (for when it is allowed)

At most 4 runs in any 24 hours, at least 6 hours apart; at most 20 pages of 500 per run (the 10,000-row cap).

## Credit

None required. The posting link goes to `PositionURI` on usajobs.gov.

## Storage

The terms say nothing about storage; the data are federal job announcements (`storable: true`).

## Field map

| USAJOBS field | jobleft `Job` | Notes |
|---|---|---|
| `MatchedObjectId` or `PositionID` | `externalId` | |
| `PositionURI` | `url` | |
| `ApplyURI[0]` | `applyUrl` when it differs | |
| `PositionTitle` | `title` | |
| `OrganizationName` | `company` | `DepartmentName` goes to `department` |
| `PositionLocation[]` | `places` (city, state, country, coordinates as given) | `PositionLocationDisplay` is the text |
| `PositionRemuneration[0]` | `pay` | `RateIntervalCode` PA year, PH hour, PD day, PW week, PM month. Any other code (bi-weekly, fee basis, without pay) gives no `pay`; the text stays in the description |
| `JobGrade[0].Code` + `UserArea.Details.LowGrade`/`HighGrade` | description line "Pay grade: GS-05 to GS-07" | Never turned into a level |
| `PositionSchedule[0].Name` | `employmentType` | Full-time, Part-time, Intermittent (other) |
| `PublicationStartDate` | `postedAt` | |
| `ApplicationCloseDate` | closes the job after that date | Positive evidence of closing |
| `UserArea.Details.RemoteIndicator`, `TeleworkEligible` | `workModel` when present | Not in the published reference; used only when present |
| `QualificationSummary`, `UserArea.Details.JobSummary`, `MajorDuties` | `description` | |

## Fixtures

`packages/sources-other/fixtures/usajobs/search.json` is hand-made from the documented example answer (no key exists,
and robots.txt forbids the host). It covers a GS pay grade, a per-year range, a per-hour range, a bi-weekly code, a
remote position and a closing date in the past.
