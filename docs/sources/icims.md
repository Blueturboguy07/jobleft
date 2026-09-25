# iCIMS

Decision: **not crawled**. Reason: no documented public feed (sitemaps and HTML pages only), and the owner has not approved it.

## Checked on

2026-09-24 (audit 05) and 2026-09-25 (sources-ats lane, from the plan and the audit). No request was sent to iCIMS to write this note, and none ever is: its hosts are on jobleft's never-contact list.

## Evidence

- audit 05 section 1.2 (2026-09-24): "No JSON API"; HTML parsing is fragile; 16 of 25 sampled sitemaps answered 404.
- Plan section 6: "Leave SmartRecruiters out. Ask you before any Workday crawl." and docs/INTERFACES.md section 10: Workday is refused in code; iCIMS, Oracle, UKG and Taleo are "Held back until the owner approves".

## What jobleft does with a iCIMS link

`detectAts` recognises `careers-*.icims.com`, `*.icims.com` and answers `crawlable: false`. `classifyUrl` answers "jobleft does not support iCIMS links ... Nothing was sent to <host>." The crawl CLI's fetch wrapper (`politeFetch`) also refuses these hosts before a request leaves, and a board list entry for this family gets "no adapter" and sends nothing.
