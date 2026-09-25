# Rippling

Decision: **not crawled**. Reason: the terms that govern the API could not be read, so automated reading could not be verified; the owner must approve it. Status: skipped (no adapter was built).

## Checked on

2026-09-25, sources-ats lane. Documentation pages only; no request was sent to api.rippling.com or ats.rippling.com.

## Evidence

| Source | What it says |
|---|---|
| Rippling developer docs, "Recruiting Job Board": https://developer.rippling.com/documentation/job-board-api | "A Recruiting Pro subscription is required to use this API." (a requirement on the employer) |
| Job Boards OpenAPI v2: https://developer.rippling.com/docs/job-board-api-v2.yaml | `GET https://api.rippling.com/platform/api/ats/v2/board/{board_slug}/jobs` with `page` and `pageSize` (max 1000); no security scheme is declared. "Rate Limit: 100 requests every 10 minutes". Each item has `id`, `url`, `department` and `locations`; the schema shows no title, no description and no posted date. |
| Rippling developer docs, "Terms of Use": https://developer.rippling.com/documentation/developer-portal/legal/terms | "By using the Rippling development platform you acknowledge and agree that access to the Rippling APIs and app submissions for App Shop review are governed by the Rippling Developer Terms of Use." The link goes to https://app.rippling.com/developer/tos |
| https://app.rippling.com/developer/tos | A web app page that showed "Something went wrong while loading the page" to a plain fetch on 2026-09-25. The terms could not be read. |

Two reasons, either one enough under the lane rule:

1. Rippling says its APIs are governed by Developer Terms that could not be read without the web app (and probably an account). jobleft creates no accounts, so it cannot verify that automated reading by a third party is allowed.
2. The documented list has no job text and no posted date. The text lives only on HTML job pages, which are not a documented feed.

## What would change the decision

The owner reads the Rippling Developer Terms and approves this use, and a documented way to read the job text exists.

## Recognition

Links on `ats.rippling.com` and `api.rippling.com/.../board/...` are recognised (`rippling`, `crawlable: false`); nothing is sent.
