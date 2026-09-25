# Adzuna

| Field | Value |
|---|---|
| Source id | `adzuna` |
| Kind | `search_partner` |
| Decision | **Not crawled**: its terms forbid storing or aggregating results without written consent, and the plan has not approved a per-query search partner |
| Checked on | 2026-09-25, lane sources-other (from audit 05, section 1.7, which read the terms on 2026-09-24) |

## Evidence

| What | Fact | Where |
|---|---|---|
| Terms | Using the data "in its original format or in aggregation" needs written consent, except during a 14-day trial. A "Jobs by Adzuna" credit is required | https://developer.adzuna.com/docs/terms_of_service (as quoted in audit 05) |
| Limits | Default 25 a minute, 250 a day, 1,000 a week, 2,500 a month | same |

## What jobleft does

It lists Adzuna in the source list with this reason so the person can see why it is absent. No adapter exists and no
request is sent. If the owner approves it later, it must run as a per-query search whose results are never saved
(`storable: false`, `Job.ephemeral: true`), shown with the "Jobs by Adzuna" credit, and kept out of the saved list,
alerts and exports (sources-other O13). The runner already refuses to store results from any feed marked
`storable: false`.
