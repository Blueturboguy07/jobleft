# SmartRecruiters

Decision: **not crawled**. Reason: robots.txt disallows the feed, and the plan says never.

## Checked on

2026-09-24 (audit 05) and 2026-09-25 (sources-ats lane, from the plan and the audit). No request was sent to SmartRecruiters to write this note, and none ever is: its hosts are on jobleft's never-contact list.

## Evidence

- audit 05 section 1.2 read `https://api.smartrecruiters.com/robots.txt` on 2026-09-24: `User-agent: * Disallow: /`, allowing only `LinkedInBot` on `/v1/companies/`. The documented Posting API also names an API key or OAuth.
- Plan section 6: "Leave SmartRecruiters out. Ask you before any Workday crawl." and docs/INTERFACES.md section 10: Workday is refused in code; iCIMS, Oracle, UKG and Taleo are "Held back until the owner approves".

## What jobleft does with a SmartRecruiters link

`detectAts` recognises `*.smartrecruiters.com` (jobs, careers, api) and answers `crawlable: false`. `classifyUrl` answers "jobleft does not support SmartRecruiters links ... Nothing was sent to <host>." The crawl CLI's fetch wrapper (`politeFetch`) also refuses these hosts before a request leaves, and a board list entry for this family gets "no adapter" and sends nothing.
