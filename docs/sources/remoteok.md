# Remote OK

| Field | Value |
|---|---|
| Source id | `remoteok` |
| Kind | `job_board` |
| Decision | **Crawled** (ships OFF; the person turns it on) |
| Checked on | 2026-09-25, lane sources-other |

## Evidence

| What | Quote or fact | Where |
|---|---|---|
| Terms (the first element of every API answer, field `legal`) | "API Terms of Service: Please link back (with follow, and without nofollow!) to the URL on Remote OK and mention Remote OK as a source, so we get traffic back from your site. If you do not we'll have to suspend API access." | https://remoteok.com/api (answer of 2026-09-25) |
| Trademark | "Please don't use the Remote OK logo without written permission as it's a registered trademark, please DO use our name Remote OK though." | same field |
| robots.txt | `User-agent: *` / `Crawl-delay: 1` / `Allow: /`. `/api` is not disallowed. Disallowed: `/*?action=get_jobs`, `/*?url=`, `/track-ad`, `/?tags`, `/l/`, profile pages | https://remoteok.com/robots.txt (read 2026-09-25) |
| Salary fields | The posting form labels both salary fields "Annual Salary or Compensation in USD (Gross, Annualized, Full-Time-Equivalent (FTE) in USD equivalent)" | https://remoteok.com/hire-remotely (read 2026-09-25) |
| Location field | The posting form asks "Job is restricted to locations?" with help text "If not restricted, please leave it as 'Worldwide'" | same page |

## Endpoints

| Item | Value |
|---|---|
| URL | `GET https://remoteok.com/api` (one request, no parameters) |
| Pagination | None. One answer holds the whole feed (about 100 postings on 2026-09-25) |
| Whole feed proven | Yes (`complete: true`) when the answer is a JSON array whose first element is the legal notice and at least one posting maps |
| Hosts | `remoteok.com` only |

## Limits

| Limit | Value |
|---|---|
| Published by Remote OK | No request cap published. robots.txt asks for a 1-second crawl delay |
| jobleft | At most 4 runs in any 24 hours, at least 1 hour apart, 1 request per run (2 with one retry), 1 request per second per host |

## Keys

None.

## Credit

| Where | What jobleft shows |
|---|---|
| Every card, detail view, alert and export line | Source name "Remote OK", credit text "Found on Remote OK" linking to `https://remoteok.com/`, and the posting link to the job's own page on Remote OK (the `url` field). No Remote OK logo |

## Storage

Allowed as far as the terms say: they ask for credit and a link back, and name no storage limit (`storable: true`).

## Field map

| Remote OK field | jobleft `Job` | Notes |
|---|---|---|
| `id` | `externalId` | String digits |
| `url` | `url` (link back) and the source link | The page on Remote OK. `apply_url` is the same page in every posting read on 2026-09-25 |
| `apply_url` | `applyUrl` only when it differs from `url` and is http(s) | |
| `position` | `title` | Mojibake fixed (see Quirks) |
| `company` | `company` | Trailing spaces trimmed |
| `description` | `description` | HTML to plain text |
| `location` | `remoteScope.text`, `places` | This is the restriction on where applicants may live ("Job is restricted to locations?"). Empty = not stated |
| `date` | `postedAt` | ISO 8601 with offset |
| `salary_min`, `salary_max` | `pay` (USD, per year, `board_field`) | `0` means not stated. The form says annual USD or USD equivalent |
| `tags` | not used | |
| all postings | `workModel: remote` | Remote OK lists remote jobs only (evidence: board field) |

Missing from the source: level, employment type, years, sponsorship.

## Quirks

- Text is double-encoded UTF-8 ("MecÃ¡nico" for "Mecánico", Arabic place names as Latin-1 soup). The adapter repairs a string only when re-decoding its Latin-1 bytes gives valid UTF-8.
- Every description ends with an anti-spam line that embeds the requester's IP address in base64 (for example `#R<base64 of the IP>`). It reaches only the person's own laptop. Recorded fixtures replace it with a documentation address (192.0.2.1).
- The first array element is the legal notice, not a job.

## Fixtures

| File | What it covers |
|---|---|
| `packages/sources-other/fixtures/remoteok/api.json` | Shape of the real answer of 2026-09-25 (one request), with made-up employers, titles, text and ids. Covers salary 0 (not stated), a USD range, mojibake, empty location, "Remote - US", "Worldwide", a country restriction, a script tag and a tracking pixel in a description |
| `packages/sources-other/fixtures/remoteok/shape.json` | Key and type signature of the real answer (no data), checked by the tests |
