# BambooHR

Decision: **not crawled**. Reason: no documented public feed. Status: skipped (no adapter was built).

## Checked on

2026-09-25, sources-ats lane. Documentation pages only; no request was sent to any BambooHR careers page.

## Evidence

| Source | What it says |
|---|---|
| BambooHR API documentation index: https://documentation.bamboohr.com/llms.txt | Every job-related endpoint needs an authenticated caller, for example "Get Job Summaries: Get a list of job opening summaries. The authenticated caller must have access to ATS settings." (https://documentation.bamboohr.com/reference/get-job-summaries) |
| Same index | No public, keyless job feed is listed. |
| Audit 05 section 1.2 (2026-09-24) | `GET https://{slug}.bamboohr.com/careers/list` works without a key, but "The path is what the hosted career page uses. It is not a documented API." robots.txt disallows only `/jobs/embed.php` and `/jobs/embed2.php`. |

The careers page's own JSON is undocumented: BambooHR can change or close it at any time and has not said that programs may read it. Under this lane's rule (build only on a feed the vendor documents), BambooHR is skipped.

## What would change the decision

A BambooHR page that documents a public job feed, or the owner's approval to read the careers-page JSON.

## Recognition

Links on `*.bamboohr.com` are recognised (`detectAts` gives `bamboohr`, `crawlable: false`), and a pasted link gets the message "jobleft does not crawl BambooHR: No documented public feed ...". Nothing is sent.
