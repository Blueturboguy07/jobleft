# Lever

Decision: **crawled** (adapter `lever` in `packages/crawler/src/sources/lever.ts`, owned by the crawler lane; this note records the evidence for the source list).

## Checked on

| Fact | Date | By |
|---|---|---|
| Postings API README | 2026-09-25 | sources-ats lane (re-read) |
| robots.txt of api.lever.co | 2026-09-24 | audit 05 |

## Evidence

| Source | Quote |
|---|---|
| Lever postings API: https://github.com/lever/postings-api (README) | "Note that all job postings in the `published` state are publicly viewable." |
| robots.txt, https://api.lever.co/robots.txt (audit 05, 2026-09-24) | `Allow: /`, `Crawl-delay: 1` |

## Endpoints and limits

`GET https://api.lever.co/v0/postings/{site}?mode=json` (EU boards: `api.eu.lever.co`), one request per board. robots.txt asks for a 1-second crawl delay, which the pacer obeys. The application POST route is rate limited (2 per second) and is never used.

## Recognition

`detectAts` recognises `jobs.lever.co`, `jobs.eu.lever.co` (region `eu`) and `api.lever.co` / `api.eu.lever.co` links.
