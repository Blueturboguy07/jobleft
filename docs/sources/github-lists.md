# Community job lists on GitHub

| Field | Value |
|---|---|
| Source ids | `gh-simplify-internships`, `gh-vanshb03-internships`, `gh-vanshb03-newgrad`, `gh-speedyapply-swe`, `gh-speedyapply-ai` |
| Kind | `community` |
| Decision | **Crawled** (each ships OFF). jobleft keeps only facts (company, title, places, dates, links, season, the list's sponsorship note), never the lists' prose |
| Checked on | 2026-09-25, lane sources-other |

## The lists

The repositories named in the plan were renamed for the 2027 season. GitHub's API answers the old names with
"Moved Permanently"; jobleft uses the new names (it never follows redirects).

| Source id | Repository (as of 2026-09-25) | Old name | Licence | File(s) read |
|---|---|---|---|---|
| `gh-simplify-internships` | `SimplifyJobs/Summer2027-Internships`, branch `dev` | `SimplifyJobs/Summer2026-Internships` | none (no licence file; GitHub API `license: null`) | `.github/scripts/listings.json` (12.9 MB, 17,201 rows, 4,639 active) |
| `gh-vanshb03-internships` | `vanshb03/Summer2027-Internships`, branch `dev` | `vanshb03/Summer2026-Internships` | MIT | `.github/scripts/listings.json` (0.3 MB, 471 rows) |
| `gh-vanshb03-newgrad` | `vanshb03/New-Grad-2027`, branch `dev` | `vanshb03/New-Grad-2026` | MIT | `.github/scripts/listings.json` (0.6 MB, 1,142 rows) |
| `gh-speedyapply-swe` | `speedyapply/2027-SWE-College-Jobs`, branch `main` | `speedyapply/2026-SWE-College-Jobs` | none | `README.md`, `NEW_GRAD_USA.md`, `INTERN_INTL.md`, `NEW_GRAD_INTL.md` (markdown tables) |
| `gh-speedyapply-ai` | `speedyapply/2027-AI-College-Jobs`, branch `main` | `speedyapply/2026-AI-College-Jobs` | none | same four files |

Host: `raw.githubusercontent.com` only. Its robots.txt answers 404 (no rules).

## Evidence and reading of the terms

| What | Quote or fact | Where |
|---|---|---|
| GitHub Acceptable Use Policies, section 7 | "You may not use information from the Service (whether scraped, collected through our API, or obtained otherwise) for spamming purposes, including for the purposes of sending unsolicited emails to users or selling personal information, such as to recruiters, headhunters, and job boards." | https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies |
| Same section | "Scraping refers to extracting information from our Service via an automated process, such as a bot or webcrawler. Scraping does not refer to the collection of information through our API." | same |
| vanshb03 lists | MIT licence (GitHub API `license.spdx_id: MIT`) | `api.github.com/repositories/794545597`, `/834615440` |
| Simplify, speedyapply | No licence file. The Simplify README says roles "come from community submissions and Simplify's automated internship monitoring" | README of each repository |

Reading: jobleft downloads a public file from a public repository (the same bytes `git clone` gets), reads the
facts in it for one person, and keeps them on that person's laptop. It sends no email, sells nothing, and keeps no
personal data from the lists (the `source` field of Simplify rows holds contributor user names; jobleft ignores it).
Facts such as a company, a title and a link are not protected by copyright; the lists without a licence are used for
facts only and credited. The MIT lists are credited with their licence. No term found forbids this use.

## Endpoints

| Source | URL pattern |
|---|---|
| JSON lists | `GET https://raw.githubusercontent.com/<owner>/<repo>/dev/.github/scripts/listings.json` with `If-None-Match` when an ETag is kept (a 304 answer costs almost nothing) |
| speedyapply | `GET https://raw.githubusercontent.com/speedyapply/<repo>/main/<file>.md` for each of the four files |

Whole feed proven: a JSON list is complete when the file parses as an array. A speedyapply source is complete only
when all four files were read and every table has its `<!-- TABLE..._END -->` marker (a cut file is not complete).
Only rows with `active: true` and `is_visible` not `false` count as listed; a row turned inactive closes the job.

## Limits

| Limit | Value |
|---|---|
| Published | None for raw files |
| jobleft | At most 4 runs in any 24 hours, at least 1 hour apart, 1 request per second per host (all lists share `raw.githubusercontent.com`) |

## Keys

None.

## Credit

Source name (for example "SimplifyJobs Summer 2027 internships (GitHub)"), credit "Listed in <owner>/<repo> on
GitHub" linking to the repository, and the job link to the employer's own posting from the list. MIT lists add
"(MIT licence)".

## Field map (JSON lists)

| Field | jobleft `Job` | Notes |
|---|---|---|
| `id` | `externalId` | UUID |
| `url` | `url` and `applyUrl` | The employer's own posting (tracking parameters removed in `canonicalUrl` only) |
| `company_name`, `title` | `company`, `title` | |
| `locations[]` | `places` | "Remote in USA" sets `workModel: remote` and `remoteScope` US |
| `date_posted` | `postedAt` | Unix seconds |
| `active`, `is_visible` | listed or not | |
| `sponsorship` | `statements` | "Offers Sponsorship" -> sponsorship yes; "Does Not Offer Sponsorship" -> no; "U.S. Citizenship is Required" -> US citizen only; "Other" -> unknown |
| `terms` / `season` | description line "Season: Summer 2027" | |
| `degrees` | description line | |
| `source`, `company_url` | not kept | `source` can be a contributor's user name |

## Field map (speedyapply markdown)

Columns are found by the header row: `Company`, `Position`, `Location`, `Salary` (only in some tables), `Posting`,
`Age`. The `Posting` link is the employer's posting; images are ignored. `Salary` such as `$60/hr` becomes pay per
hour in USD. `Age` ("9d") is relative to an unknown build time, so `postedAt` stays unknown. A header that lacks
`Company`, `Position` or `Posting` means the format changed: the run fails and closes nothing.

## ATS board discovery

Every posting link is also checked for a board that jobleft can crawl: `job-boards.greenhouse.io/<board>`,
`boards.greenhouse.io/<board>`, `jobs.lever.co/<board>`, `jobs.eu.lever.co/<board>`, `jobs.ashbyhq.com/<board>`,
`apply.workable.com/<board>`, `<board>.recruitee.com`, `<board>.jobs.personio.de` / `.com`. Links to Workday,
iCIMS, SmartRecruiters, Oracle and other hosts are counted but never contacted
(`jobleft-sources discover`).

## Fixtures

| File | What it covers |
|---|---|
| `fixtures/github/simplify-listings.json`, `fixtures/github/vanshb03-internships.json`, `fixtures/github/vanshb03-newgrad.json` | Shape of the real files of 2026-09-25 with made-up companies, titles and links, including inactive rows, a sponsorship note, a Workday link and a Greenhouse link with `?utm_source=Simplify` |
| `fixtures/github/speedyapply-swe/*.md`, `fixtures/github/speedyapply-ai/*.md` | The real table layouts (FAANG+ table with Salary, Other table without) with made-up rows |
| `fixtures/github/shape.json` | Key and type signature of the real JSON files and the real markdown header rows |
