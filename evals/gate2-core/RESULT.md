# Gate 2 (i-core) result, 2026-09-25T14:48:58.372Z

Boards: greenhouse:stripe, greenhouse:datadog, greenhouse:cloudflare, greenhouse:gitlab, lever:palantir, ashby:vanta, greenhouse:careaccess, greenhouse:cortica, greenhouse:blankstreet, greenhouse:everlane

| Check | Result | Evidence |
|---|---|---|
| setup.profile | PASS | reused the earlier run's profile |
| setup.boards | PASS | 10/10 boards added |
| O1.crawl-starts | PASS | POST /crawl/run -> 200 {"started":true} |
| O1.first-jobs-fast | PASS | first jobs seen after 2.1 s; whole crawl of 10 boards in 1 s; run summary {"startedAt":"2026-09-25T14:43:43.662Z","finishedAt":"2026-09-25T14:44:32.094Z","boards":41,"ok":41,"failed":0,"inserted":11957,"updated":0,"closed":0,"requests":41} |
| setup.boards-ok | PASS | 10/10 of the checked boards ok; whole run: 41 ok of 41 (no failures) |
| O2.O9.counts-match-boards | PASS | 9/10 boards agree with their own API (3% tolerance for postings that change during the run)<br>greenhouse:stripe: board lists 692, app has 692 (missing 0, extra 0); titles equal 688/692; links to employer 692/692<br>greenhouse:datadog: board lists 449, app has 449 (missing 0, extra 0); titles equal 449/449; links to employer 449/449<br>greenhouse:cloudflare: board lists 391, app has 391 (missing 0, extra 0); titles equal 387/391; links to employer 391/391<br>greenhouse:gitlab: board lists 201, app has 201 (missing 0, extra 0); titles equal 198/201; links to employer 201/201<br>lever:palantir: board lists 324, app has 324 (missing 0, extra 0); titles equal 321/324; links to employer 324/324<br>ashby:vanta: board lists 88, app has 88 (missing 0, extra 0); titles equal 88/88; links to employer 88/88<br>greenhouse:careaccess: board lists 35, app has 35 (missing 0, extra 0); titles equal 34/35; links to employer 35/35<br>greenhouse:cortica: board lists 62, app has 62 (missing 0, extra 0); titles equal 62/62; links to employer 62/62<br>greenhouse:blankstreet: board lists 95, app has 95 (missing 0, extra 0); titles equal 95/95; links to employer 95/95<br>greenhouse:everlane: board lists 40, app has 40 (missing 0, extra 0); titles equal 37/40; links to employer 40/40 |
| O2.links | PASS | 0 of 11957 jobs without a web link |
| O3.pay-traceable | PASS | 25/25 sampled pay figures appear in the posting text or come from a board field; 16/25 sampled jobs keep a blank (level or pay) rather than a guess |
| O4.hedged | PASS | sponsorship tags seen across 11957 jobs: likely_by_history, post_says_no, post_says_yes (never a flat "no") |
| O7.stable | PASS | recommended order identical on two reads (50 ids); match of the top job identical twice: 67% fair (experience 51, skills 63, industry null) |
| O7.ranked-for-person | PASS | 10/10 of the top recommended jobs look like software roles for a software engineer profile: Palantir Technologies: Forward Deployed Software Engineer - US Government / Palantir Technologies: Forward Deployed Software Engineer - US Government / Palantir Technologies: Forward Deployed Software Engineer - Intel / Palantir Technologies: Forward Deployed Software Engineer - US Government - Federal Health and Civilian / Palantir Technologies: Forward Deployed Software Engineer - US Government - Federal Health and Civilian / Palantir Technologies: Forward Deployed Software Engineer - US Government / Palantir Technologies: Forward Deployed Software Engineer - US Government / Palantir Technologies: Forward Deployed Software Engineer - Japan Forward Deployed / Palantir Technologies: Forward Deployed Software Engineer - Korea Forward Deployed / Palantir Technologies: Forward Deployed Software Engineer - US Government |
| O8.non-tech-kept | PASS | 232 jobs from the 4 non-software boards; search "barista" -> 20, "nurse" -> 20 |
| O12.polite | PASS | 44 requests to 3 hosts; 0 pairs closer than 0.9 s on one host |
| O11.no-personal-data | PASS | 0 request URLs carry the person's name or email |
| O12.never-hosts | PASS | 0 requests to never-crawl hosts |
| O5.setup | PASS | mock board: 3 jobs stored |
| O5.closed-leaves-feed | PASS | second crawl closed 1; dropped job in default list: false |
| O5.tracker-kept | PASS | tracker still shows the closed job with its note and status: {"jobId":"greenhouse:gatemock:2","liked":true,"hidden":false,"external":false,"status":"applied","statusHistory":[{"status":"applied","at":"2026-09-25T14:48:54. |
| O6.failing-board-closes-nothing | PASS | unreachable board: failed=1 closed=0; 2 open jobs remain |

Verdict: PASS