# Greenhouse

Decision: **crawled** (adapter `greenhouse` in `packages/crawler/src/sources/greenhouse.ts`, owned by the crawler lane; this note records the evidence for the source list).

## Checked on

| Fact | Date | By |
|---|---|---|
| Job Board API documentation | 2026-09-25 | sources-ats lane (re-read) |
| robots.txt of boards-api.greenhouse.io | 2026-09-24 | audit 05 |

## Evidence

| Source | Quote |
|---|---|
| Greenhouse Job Board API: https://docs.greenhouse.io/job-board.html | "Job Board data is publicly available, so authentication is not required for any GET endpoints. Only the application submission endpoint ... requires Basic Auth." |
| robots.txt, https://boards-api.greenhouse.io/robots.txt (audit 05, 2026-09-24) | Only `Disallow: /embed/` |

## Endpoints and limits

`GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`, one request per board, no paging. No published rate limit; jobleft sends at most 1 request per second per host. Field map: see the crawler adapter.

## Recognition

`detectAts` recognises `boards.greenhouse.io`, `job-boards.greenhouse.io`, `job-boards.eu.greenhouse.io` (region `eu`), embed links (`?for=`), `boards-api` links, and company pages that carry `gh_jid` (job known, board not named).
