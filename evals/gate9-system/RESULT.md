# Gate 9 (System) result, 2026-09-25T16:24:29.483Z

Three personas through the documented API on a copy of the gate 2 store (11,957 real jobs), with loopback stand-ins for the model, the assistant model and one employer page; cross-origin probes from headless Chrome; egress and marker checks; a 100,000-job store for timing.

| Check | Result | Evidence |
|---|---|---|
| setup | PASS | 11957 real jobs in the store (copy of gate 2); model stand-ins on loopback; employer page on 127.0.0.1:47991 as careers.example-employer.test |
| A.1.onboarding | PASS | Jordan Testwell, new-grad software engineer: profile saved 200; resume PDF imported 200; the proposed profile (2 jobs, 12 skills) saved 200 |
| A.2.five-jobs | PASS | top 5: "Senior Software Engineer, Frontend (Auth" 97%; "Forward Deployed Software Engineer - Aut" 97%; "Forward Deployed Software Engineer - Aut" 97%; "Software Engineer, AI SDK" 89%; "Staff Software Engineer, Web Product Ena" 85% — 5/5 fit the persona's line of work; all open: true |
| A.3.why-fit | PASS | job "Senior Software Engineer, Frontend (Auth": 97% strong; parts experienceLevel 100, skills 100, industryExperience 100; 5 reasons, e.g. "The job is software engineering work (title "software engineer"); you have 3 years 4 month"; 4 why-fit chips |
| A.4.tailored-pdf-docx | PASS | tailor -> 200 (1 proposed changes, each shown with its text); accept -> 200; PDF 200 (1136 chars, names Testwell: true); DOCX 200 (names Testwell: true) |
| A.5.tracker | PASS | PATCH tracker -> 200; Applied tab shows the job with status "applied" and 1 reminder (2026-09-28) |
| A.6.external-job | PASS | POST /jobs/external {url} -> 200: "Operations Analyst - Example Employer" at careers.example-employer.test; in the External tab: true |
| A.7.network | PASS | import -> 200 (14 new contacts); who to contact at Affirm: 2 ranked, first "Priya Sampleton" (Company in your file: "Affirm".; Works in recruiting: the title is "Recruiter".;) |
| A.8.assistant | PASS | chat -> 200; answer (74 chars): "I can look at your jobs, tracker and matches. What would you like to know?" |
| B.1.onboarding | PASS | Riley Careford, registered nurse open to Texas and California: profile saved 200; resume built from the profile 200 |
| B.2.five-jobs | PASS | top 5: "Pediatric Private Duty Nurse – RN or LVN" 60%; "Pediatric Private Duty Nurse – RN or LVN" 60%; "Pediatric Home Health RN – Flexible Hour" 60%; "Pediatric Home Health RN – Flexible Hour" 60%; "Pediatric Home Health RN – Flexible Hour" 60% — 5/5 fit the persona's line of work; all open: true |
| B.3.why-fit | PASS | job "Pediatric Private Duty Nurse – RN or LVN": 60% fair; parts experienceLevel 85, skills 17, industryExperience 100; 7 reasons, e.g. "The job is nursing work (title "lvn"); you have 7 years 4 months in it, as "Registered Nur"; 2 why-fit chips |
| B.4.tailored-pdf-docx | PASS | tailor -> 200 (2 proposed changes, each shown with its text); accept -> 200; PDF 200 (682 chars, names Careford: true); DOCX 200 (names Careford: true) |
| B.5.tracker | PASS | PATCH tracker -> 200; Applied tab shows the job with status "applied" and 1 reminder (2026-09-28) |
| B.6.external-job | PASS | POST /jobs/external {url} -> 200: "Operations Analyst - Example Employer" at careers.example-employer.test; in the External tab: true |
| B.7.network | PASS | import -> 200 (2 new contacts); who to contact at MedCare Pediatric: 2 ranked, first "Nia Wardsley" (Company in your file: "MedCare Pediatric".; Same field as the job (healthcare): ) |
| B.8.assistant | PASS | chat -> 200; answer (74 chars): "I can look at your jobs, tracker and matches. What would you like to know?" |
| C.1.onboarding | PASS | Sam Ledgerly, accountant with 5 years who needs visa sponsorship: profile saved 200; resume built from the profile 200 |
| C.2.five-jobs | PASS | top 5: "Senior Accountant" 75%; "Senior Revenue Accountant" 72%; "Senior Accountant" 72%; "Senior Revenue Accountant" 70%; "Senior Accountant" 70% — 5/5 fit the persona's line of work; all open: true |
| C.3.why-fit | PASS | job "Senior Accountant": 75% good; parts experienceLevel 100, skills 53, industryExperience n/a; 9 reasons, e.g. "The job is accounting and audit work (title "senior accountant"); you have 7 years 3 month"; 4 why-fit chips |
| C.4.tailored-pdf-docx | PASS | tailor -> 200 (1 proposed changes, each shown with its text); accept -> 200; PDF 200 (565 chars, names Ledgerly: true); DOCX 200 (names Ledgerly: true) |
| C.5.tracker | PASS | PATCH tracker -> 200; Applied tab shows the job with status "applied" and 1 reminder (2026-09-28) |
| C.6.external-job | PASS | POST /jobs/external {url} -> 200: "Operations Analyst - Example Employer" at careers.example-employer.test; in the External tab: true |
| C.7.network | PASS | import -> 200 (2 new contacts); who to contact at Blue Bottle Coffee: 2 ranked, first "Lee Auditwell" (Company in your file: "Blue Bottle Coffee".; Does the same kind of work as the j) |
| C.8.assistant | PASS | chat -> 200; answer (74 chars): "I can look at your jobs, tracker and matches. What would you like to know?" |
| O3.feeds-differ | PASS | overlap of the top 20 between personas: A/B 0, A/C 0, B/C 0 |
| C.sponsorship-hedged | PASS | top job for C: sponsorship facts {"key":"bluebottlecoffee","name":"Blue Bottle Coffee","aliases":[],"facts":{},"h1b":null,"isStaffingAgency":null,"factsFreshUntil":null,"updatedAt":"2026-09-25T; the words "does not sponsor"/"No H1B" appear: false |
| SEC.O1.other-origin-gets-nothing | PASS | in headless Chrome from http://127.0.0.1:47992: fetch blocked: TypeError / with token blocked: TypeError / no-cors blocked: TypeError / script tag error / img error / cross-site PATCH blocked: TypeError / data seen: false; from Node with browser headers: cross-site+token 403, script-dest 403, preflight 403, text/plain POST 403, token in query 400; any Access-Control-Allow-Origin: false; persona data in any answer: false |
| SEC.O2.loopback-only | PASS | listening sockets on port 47821: 127.0.0.1:47821 |
| EGRESS.approved-hosts-only | PASS | this run: 0 crawl-side requests to (none); the gate 2 crawl of 41 real boards: 44 requests to api.ashbyhq.com, boards-api.greenhouse.io, api.lever.co; not on the approved list: none |
| EGRESS.no-personal-data-to-employers | PASS | 6 requests reached the employer page; User-Agent names jobleft and carries no address: true ("jobleft-build/0.1 (research build; no personal data)"); persona markers in employer or job-board requests: 0; (markers do reach the chosen AI stand-in, as designed: true) |
| PERF.O1.search-fast-at-100k | PASS | 100000 jobs crawled from 50 stand-in boards in 61 s (217 MB on disk); first search after launch (cold): 64 ms; then 100 varied searches (20 words x 5 filter sets, Recommended sort): median 8 ms, p95 62 ms, slowest 101 ms, failures 0; feed page median/p95 8/9; detail 2/10 |
| PERF.O1.awkward-input | PASS | "senior engineer" -> 200 in 5 ms (0); full-stack -> 200 in 5 ms (0); C++ -> 200 in 6 ms (0); C# -> 200 in 5 ms (0); * -> 200 in 8 ms (100000); zzqqxxnothing -> 200 in 5 ms (0) |

Verdict: PASS