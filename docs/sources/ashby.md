# Ashby

Decision: **crawled** (adapter `ashby` in `packages/crawler/src/sources/ashby.ts`, owned by the crawler lane; this note records the evidence for the source list).

## Checked on

| Fact | Date | By |
|---|---|---|
| Job Postings API documentation | 2026-09-25 | sources-ats lane (re-read) |
| robots.txt of api.ashbyhq.com | 2026-09-24 | audit 05 ("Unauthorized", no policy) |

## Evidence

| Source | Quote |
|---|---|
| Ashby Job Postings API: https://developers.ashbyhq.com/docs/public-job-posting-api | "This API allows you to get data for all currently published Job Postings for your organization. If you host your own careers page, you can use this data to populate it." The example is `curl https://api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}?includeCompensation=true` with no key. |

## Endpoints and limits

`GET https://api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true`, one request per board. No published rate limit. Never the internal `non-user-graphql` route.

## Recognition

`detectAts` recognises `jobs.ashbyhq.com/{name}[/{job}]`, `api.ashbyhq.com` links and company pages that carry `ashby_jid`.
