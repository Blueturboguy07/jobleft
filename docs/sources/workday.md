# Workday

Decision: **not crawled**. Reason: the owner has not approved it (plan section 6: "Ask you before any Workday crawl"), and the CXS endpoint is not a documented public API.

## Checked on

2026-09-24 (audit 05) and 2026-09-25 (sources-ats lane, from the plan and the audit). No request was sent to Workday to write this note, and none ever is: its hosts are on jobleft's never-contact list.

## Evidence

- audit 05 section 1.2 (2026-09-24): the CXS `POST .../wday/cxs/{tenant}/{site}/jobs` route is "Not a documented API"; offsets wrap after 2,000 rows.
- Plan section 6: "Leave SmartRecruiters out. Ask you before any Workday crawl." and docs/INTERFACES.md section 10: Workday is refused in code; iCIMS, Oracle, UKG and Taleo are "Held back until the owner approves".

## What jobleft does with a Workday link

`detectAts` recognises `*.myworkdayjobs.com`, `*.myworkdaysite.com`, `*.workday.com` and answers `crawlable: false`. `classifyUrl` answers "jobleft does not support Workday links ... Nothing was sent to <host>." The crawl CLI's fetch wrapper (`politeFetch`) also refuses these hosts before a request leaves, and a board list entry for this family gets "no adapter" and sends nothing.
