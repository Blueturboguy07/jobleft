# Gate 6 (i-ext) result, 2026-09-25T15:20:34.174Z

The real extension (apps/extension/dist) in headless Chrome with a scratch profile and no internet, against the real app on 127.0.0.1:47821, on the lane's practice pages (which log every submit and Next press).

| Check | Result | Evidence |
|---|---|---|
| setup.app | PASS | real app on port 47821 |
| setup.data | PASS | resumes imported: Jordan_Testwell_Resume.pdf, Jordan_Testwell_Acme.pdf |
| O2.unpaired-refused | PASS | curl no pairing 403; page on another port 403; unpaired extension id with a made-up token 401 |
| O2.unpaired-popup | PASS | unpaired popup says: "jobleft / fills job applications from your own app / This browser is not paired with your jobleft app. jobleft does nothing until you pair i"; fields still empty: true |
| O1.paired | PASS | popup: "jobleft / fills job applications from your own app / This browser is not paired with your jobleft ap"; app lists 1 paired browser(s) with a date: 2026-09-25T15:20:18.569Z |
| O5.job-named | PASS | job A popup names: true; job B popup names: true; a page that is no stored job names neither and offers to add it: true ("jobleft / fills job applications from your own app / Paired with jobleft 0.1.0 on this computer. / U") |
| O7.saved-facts-only | PASS | first Jordan, last Testwell, email jordan.testwell@example.com, phone +1 555 0100; links (none saved) left empty: true |
| O6.only-the-application-form | PASS | job-alert sign-up, outside and hidden trap fields untouched: alert "", outside ssn "", hidden email "" |
| O8.sensitive-untouched | PASS | sensitive fields on the page: gender, hispanic, race, veteran, disability; all unchanged (nothing saved in the profile): true; now: "Please select", "Please select", "Please select", "Please select", "Please select" |
| O9.drafts-not-inserted | PASS | 2 draft(s) offered; open-question fields still empty: true (why, project, comments) |
| O14.typed-value-kept | PASS | the value the person typed before the fill: "JT typed this" |
| O10.right-resume | PASS | the chosen (second) resume goes in, not the first: report "Resume attached: Jordan_Testwell_Acme.pdf"; file field holds: "Jordan_Testwell_Acme.pdf:43757" |
| O12.never-submits | PASS | submits 0, next presses 0 after a fill |
| O11.honest-report | PASS | report says Done and lists what it left: true; excerpt: "jobleft / Greenhouse · supported / – / × / Software Engineer · Acme Robotics / Done. Check every field, then submit the application yourself. / 21 filled / 22 need you / 1 kept / 2 drafts / 1 required field is still empt" |
| O13.no-confirm-no-change | PASS | tracker after a fill and a closed tab: "null" |
| O13.confirm-marks-applied | PASS | two-step confirm: after step 1 "null", after "Yes, I submitted it" "applied" with resume the one used in the fill; panel: true |
| O12.captcha | PASS | captcha page report: "jobleft / not a supported site / – / × / jobleft does not know this job. It is not in your jobleft app yet. / Add this job to jobleft / This site is not on the " |
| O4.permissions | PASS | permissions: storage, activeTab, scripting; hosts: http://127.0.0.1:47821/*, http://127.0.0.1:47822/*, http://127.0.0.1:47823/*, http://127.0.0.1:47824/*, http://127.0.0.1:47825/*, http://127.0.0.1:47826/*, http://127.0.0.1:47827/*, http://127.0.0.1:4 |
| O1.survives-restart | PASS | after restarting the app and the browser, the popup shows: "jobleft / fills job applications from your own app / Paired with jobleft 0.1.0 on this computer. / Unpair / This page: G" |
| O15.blocked-boards | PASS | www.linkedin.com: refused true, page unchanged true; www.indeed.com: refused true, page unchanged true; www.glassdoor.com: refused true, page unchanged true; app log lines about those pages: 0; popup: "jobleft / fills job applications from your own app / Paired with jobleft 0.1.0 on this com" |
| O3.unpair | PASS | unpair -> 200; paired list 0; popup: "jobleft / fills job applications from your own app / This browser is not paired with your jobleft ap" |

Verdict: PASS