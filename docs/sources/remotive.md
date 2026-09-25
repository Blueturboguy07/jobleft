# Remotive

| Field | Value |
|---|---|
| Source id | `remotive` |
| Kind | `job_board` |
| Decision | **Not crawled**: robots.txt on `remotive.com` disallows the API path for every crawler |
| Checked on | 2026-09-25, lane sources-other |

## Evidence

| What | Quote or fact | Where |
|---|---|---|
| robots.txt | Group `User-agent: *` contains `Disallow: /api/*` (line 18 of the file as served). The API lives at `/api/remote-jobs` | https://remotive.com/robots.txt (read 2026-09-25) |
| API terms: credit | "Please link back to the URL found on Remotive AND mention Remotive as a source in order to Remotive to get traffic from your listing" | https://github.com/remotive-com/remote-jobs-api (README, read 2026-09-25) |
| API terms: other boards | "Please do not submit Remotive jobs to third Party websites, including but not limited to: Jooble, Neuvoo, Google Jobs, LinkedIn Jobs." | same README |
| API terms: delay | "Jobs displayed are delayed by 24 hours, the goal being that jobs are attributed to Remotive on various platforms." | same README |
| API terms: rate | "we advise max. 4 times a day" and "excessive requests (more than 2x per minute) will be blocked" | same README |

## Why it is not crawled

jobleft obeys robots.txt on every host (plan section 6). The README invites API use, but the site's robots.txt
forbids `/api/*` to every user agent. The two disagree, so jobleft sends nothing to `remotive.com`. No live request
was made to the API while building this adapter.

What would change the decision: a robots.txt that allows `/api/remote-jobs`, or written permission from Remotive
that the owner accepts. Then flip `crawled` in `packages/sources-other/src/catalog.ts` (the adapter is built and tested).

## Endpoints (for when it is allowed)

| Item | Value |
|---|---|
| URL | `GET https://remotive.com/api/remote-jobs` (optional `category`, `company_name`, `search`, `limit`) |
| Pagination | None; the answer is the whole feed |

## Limits (for when it is allowed)

At most 4 runs in any 24 hours, at least 6 hours apart (Remotive's "max. 4 times a day"), never 2 requests in one minute.

## Keys

None.

## Credit (for when it is allowed)

Source name "Remotive", credit "Found on Remotive" linking to `https://remotive.com/`, posting link to the job's `url` on Remotive.

## Storage

The README asks not to re-submit jobs to other job boards. jobleft keeps jobs on the person's laptop only and never
submits them anywhere, so `storable: true` would hold if the robots.txt problem were solved.

## Field map

| Remotive field | jobleft `Job` | Notes |
|---|---|---|
| `id` | `externalId` | |
| `url` | `url` | The page on Remotive (link back) |
| `title`, `company_name` | `title`, `company` | |
| `description` | `description` | HTML to text |
| `publication_date` | `postedAt` | The employer's date; the feed arrives 24 hours later, so the fetch time is never used |
| `candidate_required_location` | `remoteScope` | "USA Only", "Europe Only", "Worldwide", and so on |
| `salary` | `pay` | Free text; parsed only when a currency and an amount are written ("$30/hour"); otherwise unknown |
| `job_type` | `employmentType` | `full_time`, `contract`, `part_time`, `freelance`, `internship` |
| all postings | `workModel: remote` | Remotive lists remote jobs only |

## Fixtures

`packages/sources-other/fixtures/remotive/remote-jobs.json` is hand-made from the documented field list (no live
request was allowed). Its top-level keys other than `jobs` are UNVERIFIED.
