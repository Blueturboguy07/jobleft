# Gate 3 (i-resume) result, 2026-09-25T14:55:43.868Z

Fixtures: F1 jordan-one-column.pdf, F2 jordan-word.docx, F5 jordan-accents.pdf, F4 scanned/locked/text-named; J-fit, J-gap, J-inject added as text. Hostile mock model answers every call with invented facts.

| Check | Result | Evidence |
|---|---|---|
| O2.import | PASS | import F1 -> 200 resume res_eb639e77-954c-40cc-ac47-f579f4e46bf4 |
| O2.profile-fields | PASS | 2 jobs with the right titles and employers: true; skills found 12/12; degree and school: true; numbers kept in bullets 5/7; name/email: Jordan Testwell jordan.testwell@example.com |
| O2.profile-saved | PASS | PUT /profile with the proposed profile -> 200  |
| O2.other-formats | PASS | DOCX -> 200; accents PDF -> 200, skills kept as written: Node.js, C#, C++, R&D |
| O2.bad-files-refused | PASS | scanned.pdf -> 400 This PDF has no text in it: it looks like a scan or a picture of a resume, so jobleft cann / locked.pdf -> 400 This PDF is protected with a password. Save a copy without the password and upload that co / text-named.pdf -> 415 The file is named like a PDF but it holds plain text. Upload the real PDF, or import the t |
| O5.match | PASS | J-fit 60% fair (exp 100, skills null, industry null) > J-gap 56% fair (exp 85, skills null, industry null); identical on a second read; 4 reasons, e.g. "The job is software engineering work (title "software engineer"); you have 3 years 4 months in it, as "Software Engineer" |
| O7.proposal | PASS | tailor F1 for J-gap without AI -> 200; 2 proposed changes, each with before/after: [skills.order] PostgreSQL, TypeScript, JavaScript, Python, React, Node.js,  / [bullets.order] Led a migration of 12 services to PostgreSQL with zero downt |
| O7.accept | PASS | accept all -> 200; version res_1b2c742f-65ff-49b3-920a-d85d5bc2bd86 kind tailored for job external:text:f02201ad3929506a |
| O6.truthful-no-ai | PASS | PDF text: invented facts [], untraceable capitalised terms []; employers kept 3/3, skills kept 12/12; DOCX invented [] |
| O9.one-page-and-formats | PASS | PDF pages 1; name, email and section headings present in the PDF text; DOCX has the same skills (12 vs 12) |
| O8.keyword-gaps | PASS | missing terms: kubernetes, terraform, go |
| setup.ai | PASS | local mock model set up -> 200 {"ok":true,"problem":null,"message":"Works: the local AI server at http://127.0.0.1:54069 (mock-model) answered a test m |
| O6.hostile-proposal | PASS | hostile model + injected posting -> 200; 3 changes offered, 1 carry a warning; invented facts offered as clean changes: 0; refused/left out: "" |
| O6.hostile-output | PASS | accepting everything the hostile model offered was refused: 409 A change you accepted holds a fact that is not in your profile: "Junior Developer" ("Junior Developer" is your title at Contoso Example Corp, not at Northwind Sample Labs.) Nothing was saved. Untick t |
| O6.hostile-output-clean | PASS | accepting only the unflagged changes (2): invented facts in the PDF []; untraceable terms [] |
| O11.letter | PASS | letter for J-fit -> 200; ready true; names Fabrikam true, not Woodgrove true; invented facts []; violations: []; notice: Left out AI sentences that were not usable or held facts that are not in your profile (Kubernetes, B1, B2, $5M, Contoso Ltd, B3). The AI text could not be used,; text: Jordan Testwell / jordan.testwell@example.com / 555-0100 / Austin, TX / https://example.com/jordan / https://github.com/jordan-testwell-example / Dear Hiring Manager, / I am writing to apply for the Backend Software Engineer at Fabrikam Payments role at Fabrikam Payments. / In my current role as Software Engineer at Northwind Sample Labs, I led a migration of 12 services to PostgreSQL with zero do |
| O11.letter-export | PASS | letter PDF -> 200; starts with the name: true |
| O11.letter-edited | PASS | hand-edited truthful letter -> 200, ready true; export -> 200; violations [] |
| O10.ats-stable | PASS | ATS report -> 200: grade A score 100, 0 findings, identical on a second run: true |
| O3.edit-survives-restart | PASS | after restart: title "Senior Software Engineer", Linux gone true; match reasons mention Linux: false |
| O10.ats-after-restart | PASS | ATS score after restart 100 vs before 100 |
| O9.versions-listed | PASS | 3 resumes listed: base, tailored for a job, tailored for a job |
| O12.delete | PASS | delete base with versions -> 200; resumes left: 0 |
| privacy.mock-only | PASS | 4 model calls, all to the loopback mock |

Verdict: PASS