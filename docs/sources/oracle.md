# Oracle Recruiting

Decision: **not crawled**. Reason: the owner has not approved it; no public feed has been verified.

## Checked on

2026-09-24 (audit 05) and 2026-09-25 (sources-ats lane, from the plan and the audit). No request was sent to Oracle Recruiting to write this note, and none ever is: its hosts are on jobleft's never-contact list.

## Evidence

- audit 05 section 1.1 (2026-09-24): "Oracle, UKG and Paycom: UNVERIFIED by me. Legal risk is higher for all of them."
- Plan section 6: "Leave SmartRecruiters out. Ask you before any Workday crawl." and docs/INTERFACES.md section 10: Workday is refused in code; iCIMS, Oracle, UKG and Taleo are "Held back until the owner approves".

## What jobleft does with a Oracle Recruiting link

`detectAts` recognises `*.oraclecloud.com` pages under `/hcmUI/CandidateExperience/` and answers `crawlable: false`. `classifyUrl` answers "jobleft does not support Oracle Recruiting links ... Nothing was sent to <host>." The crawl CLI's fetch wrapper (`politeFetch`) also refuses these hosts before a request leaves, and a board list entry for this family gets "no adapter" and sends nothing.
