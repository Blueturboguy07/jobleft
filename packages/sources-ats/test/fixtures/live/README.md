# Live fixtures

Each file is one real answer from a public board, fetched once on 2026-09-25 with the User-Agent
`jobleft/0.1.2 (+https://github.com/Blueturboguy07/jobleft; no personal data)`, after reading the host's robots.txt. They are public job
postings published by the employers. They hold no personal data: a scan for e-mail addresses found only job and
role mailboxes (`job.<id>@bunq.recruitee.com`, `accommodations@gem.com`), and no phone numbers.

| File | Request | Trimmed |
|---|---|---|
| `workable-huggingface.json` | `GET https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true` | 4 of 8 jobs kept |
| `workable-careers-ewingirrigation.json` | `GET https://apply.workable.com/api/v1/widget/accounts/careers-ewingirrigation?details=true` | 5 of 85 rows kept: the 4 rows of one job listed once per city, and 1 other job |
| `recruitee-bunq.json` | `GET https://bunq.recruitee.com/api/offers/` | 3 of 16 offers kept |
| `personio-personio.xml` | `GET https://personio.jobs.personio.de/xml?language=en` | not trimmed (1 position) |
| `teamtailor-career.rss` | `GET https://career.teamtailor.com/jobs.rss` | 3 of 15 items kept |
| `gem-gem.json` | `GET https://api.gem.com/job_board/v0/gem/job_posts/` | not trimmed (4 posts) |

Trimming removed whole jobs only; no field inside a kept job was changed.
