# Never crawled: LinkedIn, Indeed, Glassdoor

Decision: **not crawled**, ever (plan section 6, "Never"). These are job sites, not ATS families. They are listed here so the source list names them with a reason and a date.

| Site | Reason | Checked on | Evidence |
|---|---|---|---|
| LinkedIn | Terms forbid automated access: User Agreement 8.2 bans "software, devices, scripts, robots or any other means ... to scrape or copy the Services" | 2026-09-24 (audit 05 section 1.8) | https://www.linkedin.com/legal/user-agreement |
| Indeed | The plan says never. Indeed's terms ban automating the Indeed Apply flow outside official tooling (section A.3.5) | 2026-09-24 (audit 05 section 1.8) | https://www.indeed.com/legal |
| Glassdoor | The plan says never. Its terms page answered HTTP 403 to the audit, so no permission could be read | 2026-09-24 (audit 05 section 1.8) | https://www.glassdoor.com/about/terms/ |

No request was sent to these sites to write this note. jobleft refuses them in code: the crawler's never-crawl list (`DENY_HOST`), the CLI's fetch wrapper (`politeFetch`), and `classifyUrl`, which answers "jobleft does not support LinkedIn links: its terms forbid automated access. Nothing was sent to www.linkedin.com."
