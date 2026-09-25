# Acceptance outcomes: sys-e2e (end-to-end journeys)

Area: the whole job hunt, done by a real person, from first launch to a tracked application.
Author role: acceptance-outcome author. These outcomes say what a person or a stranger must see. They do not say how to build it.
Inputs read: `docs/PLAN.md` sections 1 to 8, `jobright-research/GAPS.md`, `jobright-research/ui/UI-SPEC-LOGGED-IN.md`.
Date: 2026-09-25.

## How to use this file

- MUST: the release fails if the outcome fails.
- SHOULD: a failure needs a written reason and an owner.
- "Observe" uses only public interfaces: commands in the package README, HTTP endpoints in `docs/INTERFACES.md`, files the product writes, and screenshots. A tester may also record the laptop's outbound traffic with a tool of their choice (a logging proxy or the operating system's network monitor).
- A "test board" is a job board that the tester controls on the laptop. A "stand-in AI server" is a local server that answers like an AI provider. The README must say how to point the app at each one. No test in this file needs a live call to the publik service.
- All test data is fake. Use only made-up people and `example.com` addresses.

### Test personas (fake data only)

| Persona | Goal | Notes |
|---|---|---|
| A: Jordan Testwell (jordan.testwell@example.com) | New-grad software engineer, Austin TX, open to remote | Resume lists Python, TypeScript, React, SQL. No Go, no Kubernetes |
| B | Registered nurse, open to relocation in two states | No technical skills. Tests that non-tech jobs are first-class |
| C | Accountant, 5 years, needs visa sponsorship | Tests the sponsorship path and hedged wording |
| D | Any of A to C, but chooses a local model only | Tests the privacy path |

### Journey task list (used by O1 and others)

1. Finish onboarding: resume, job function, job type, location, pay, work authorization.
2. Find 5 open jobs that suit the persona.
3. Say why one job is a good or poor fit.
4. Make a tailored resume for one job and save it as PDF and DOCX.
5. Mark a job as applied and set a reminder.
6. Add a job from a link found elsewhere.
7. Import the persona's own connections file and find a person to contact.
8. Ask the assistant a question about one job.

---

## Outcomes

### O1 (MUST). A stranger completes the whole job hunt without help

A person who has never seen jobleft installs it and completes all 8 journey tasks for their own goal. They use only the app and its README. They do not create an account, log in, edit a settings file, open a terminal after install, or ask anyone.

Observe: Give three testers (personas A, B and C) the README and the task list only. Record each screen. Count the steps where a tester needed the terminal, a settings file, the source code or outside help. Pass: the count is 0 for each tester, and each task ends on a screen that shows its result (a job list, a fit breakdown, a saved file, a tracker row, a contact list, an answer).
Adversarial angles:
- A task is reachable only by a URL, a keyboard shortcut or a hidden menu that the tester cannot find.
- One step (for example resume import or AI setup) fails for persona B or C because the flow assumes a software career.
- The app asks for an account, an email address or a sign-in before it shows any job.
- A task "finishes" but leaves no visible result, so the tester cannot tell if it worked.

### O2 (MUST). First launch shows real, current jobs quickly

After a fresh install, a person finishes onboarding in under 10 minutes and sees real job cards within 2 minutes after onboarding ends. More jobs arrive while they use the app. The app stays usable during the first collection of jobs.

Observe: Start with an empty data folder (the README says how to reset). Time onboarding and the time to the first job card with a stopwatch and screenshots. Take 20 jobs from the first feed. Open each "apply" link. Pass: at least 19 of 20 open the employer's own live posting for the same title and company. During the first collection, open a job, change a filter and open the tracker. Pass: each action responds in under 2 seconds.
Adversarial angles:
- The feed shows sample, demo or stale bundled jobs as if they were live.
- The first collection blocks the window with a spinner until it ends.
- Apply links point to an aggregator page, a search page or a closed posting.
- Onboarding cannot finish because the resume parse fails on a two-column or DOCX resume.

### O3 (MUST). People with different goals get different, relevant feeds

Each persona sees a feed that fits their own job function, level and place. A nurse sees nursing jobs, not software jobs. An accountant who needs sponsorship can narrow the feed to employers likely to sponsor.

Observe: Onboard personas A, B and C in three separate fresh data folders against the same jobs. Screenshot the top 20 of each "Recommended" feed. Pass: at least 16 of 20 jobs in each feed match the persona's job function and place (or remote, when chosen), and no two personas share more than 3 of their top 20 jobs. For persona C, turn on the sponsorship filter. Pass: every remaining job carries the sponsor-likely tag.
Adversarial angles:
- Non-tech jobs are missing because the job collection keeps only technical roles.
- All three personas get the same order, because the ranking ignores the profile.
- A job function that the app does not know (for example "Clinical Nurse III") falls out of every feed.
- The sponsorship filter removes all jobs or keeps jobs with no sponsor data.

### O4 (MUST). Every fact on a job is true to the posting, and unknowns stay unknown

Pay, work model (remote, hybrid, on-site), level, years of experience, place and post date on each card and detail page agree with the employer's posting. When the posting does not state a fact, the app says it is not listed. The app never says an employer does not sponsor visas just because it has no record of that employer.

Observe: Take 30 jobs across personas A to C. Compare each shown fact with the employer's posting (open the apply link, or read the job's full text in the app). Pass: 0 facts contradict the posting, and 0 facts appear that the posting does not support. Find 5 employers that have no sponsor record. Pass: their cards and detail pages show "no data" or nothing, never "No H-1B", "does not sponsor" or similar.
Adversarial angles:
- A number such as "401(k)", "$50M Series B" or "$5,000 sign-on bonus" shows as the salary.
- An hourly rate shows as a yearly salary, or the other way round.
- The post date shows the day the app collected the job, not the day the employer posted it.
- "Remote-friendly team in New York" shows as "Remote".

### O5 (MUST). Closed jobs stop showing as open, and nothing the person saved is lost

When an employer removes a posting, the app stops showing it as open after the next refresh of that board. If the person liked it, applied to it or wrote notes on it, the job stays in their lists, marked closed, with all notes. A board that is down or returns nothing does not close its jobs.

Observe: Use a test board with 10 jobs. Like one, apply to another and add a note to it. Remove both from the test board and refresh. Pass: neither job appears in "Recommended"; both appear in their lists marked closed, with the note intact. Then make the test board return an error, and then an empty list. Pass: none of the remaining 8 jobs is marked closed.
Adversarial angles:
- A board outage closes every job from that employer.
- A closed job is deleted together with the person's notes and tracker status.
- A closed job still appears in the feed or in new-job alerts.
- A job that comes back on the board appears twice.

### O6 (MUST). The person can understand why a job fits, and the score does not drift

Every job shows a match percent, a band (strong, good or fair), three parts (experience level, skills, industry experience) and plain reasons. Each reason names something in the person's own profile and something in the posting. The same job with the same profile shows the same numbers every time.

Observe: For persona A, open 10 job detail pages and screenshot the score and reasons. Reload each page, then quit and relaunch the app, and screenshot again. Pass: all numbers are identical. Check each reason against the profile and the posting text. Pass: 0 reasons cite a skill, title or fact that is absent from either one. Pass: the band matches the stated cut-offs for every job. Open a job with a very short description. Pass: the app shows a score with a note that the posting has little detail, or says it cannot score; it never shows a blank, "NaN" or an error code.
Adversarial angles:
- Reasons praise a skill the person does not have.
- The score moves between reloads, or after the app refreshes jobs.
- The overall percent disagrees with its three parts (for example 95% overall with all three parts under 50%).
- The score needs an AI provider, so persona D sees no score at all.

### O7 (MUST). A tailored resume is truthful, and every change is visible

A person picks a job and gets a tailored resume as PDF and DOCX. It contains no employer, title, date, degree, number, certificate or skill that is not in their own resume or profile. The app shows each change before it is final. Skills the job asks for that the person lacks appear as gaps, not as resume lines.

Observe: For persona A, tailor for a job that asks for Go and Kubernetes. Repeat for 10 jobs across personas A to C. Extract the text of each output file. Pass: every skill, employer, title, date, number and certificate in the output is present in the source resume or profile (0 exceptions over all 10). Pass: "Go" and "Kubernetes" appear in the gap list and not in the resume. Pass: when one page is requested, the PDF has exactly one page. Pass: the change view lists every changed line, and a rejected change is absent from the saved file.
Adversarial angles:
- The resume gains keywords copied from the posting.
- A metric is invented or inflated ("improved speed by 40%").
- A job title, date or degree is "improved".
- The AI returns broken or partial output, and the app saves a half-empty resume without a warning.

### O8 (MUST). The tracker keeps the whole hunt across restarts and crashes

A person moves jobs through Liked, Applied, Interviewing, Offer, Rejected and Archived, adds notes and sets reminders. After a normal quit, a forced quit or a power cut, every change that the app showed as done is still there. Each reminder appears once, as a desktop notification, at its set time.

Observe: For persona A, make 20 tracker changes (status, notes, reminders) across 8 jobs, one of them an external job. Force-quit the app process right after the last change shows as done. Relaunch. Pass: all 20 changes are present. Set a reminder 3 minutes ahead and wait. Pass: exactly one notification at the set time, and a click on it opens that job. Refresh all boards. Pass: no tracker entry is duplicated or reset.
Adversarial angles:
- The last change before a forced quit is lost although the app showed it as saved.
- A job refresh overwrites the person's status or notes.
- A reminder fires twice, fires late after a relaunch, or never fires.
- Counts on the tabs disagree with the rows in each tab.

### O9 (MUST). A job from elsewhere joins the hunt, and some sites are never contacted

A person pastes a link to a job from a public employer board. The job appears with its title, company and full text, gets a match score, and can be tailored and tracked like any other job. If the app cannot read the link, it says so and lets the person paste the job text. The app never fetches pages from LinkedIn, Indeed, Glassdoor or SmartRecruiters, even when the person pastes such a link.

Observe: Paste a link from a test board. Pass: the job appears with correct title, company and text, and a score. Paste the same link again. Pass: no second copy. Paste a link that returns "not found". Pass: a plain message and a paste-text option; no empty job row. Paste a LinkedIn job link and an Indeed job link while recording outbound traffic. Pass: 0 requests to those hosts, and the paste-text option appears.
Adversarial angles:
- A LinkedIn or Indeed link is fetched "just once" to read the title.
- A broken link creates an empty job with a 0% score.
- The same job, pasted twice or also found by the crawl, shows as two jobs with two tracker states.
- An external job cannot be tailored because it is not in the collected job list.

### O10 (MUST). The network file shows who the person knows, and nothing is sent for them

A person imports their own connections export. Job cards show how many people they know at that company. A ranked contact list shows who to ask, with reasons. The app drafts a message for the person to copy. The app never sends a message, and the file stays on the laptop.

Observe: Import a fake connections file with 50 rows, the 3 note lines at the top, blank emails, company names with legal suffixes ("Stripe, Inc.", "STRIPE"), a look-alike name ("Metamaterials Corp") and non-Latin names. Pass: the import finishes with a count of rows read and rows skipped (with reasons). Pass: the "people you know" count on each card equals a hand count of the file, with 0 false matches (no "Metamaterials" person on a "Meta" job). Pass: no screen has a control that sends a message. Pass: recorded outbound traffic contains no name, email or company from the file, unless the person asks an online AI provider for a draft, and then only that one contact's details.
Adversarial angles:
- Suffix and case differences make real contacts disappear from job cards.
- Short company names match unrelated companies.
- A file with garbled or non-Latin names stops the import part-way with no message.
- The whole file goes to the AI provider when one draft is asked for.

### O11 (MUST). The assistant answers from the person's data and asks before it changes anything

A person asks the assistant about a job, their fit, their resume or their search. The answer uses the job and the profile. When a fact is not known (pay not listed, no sponsor record, no company funding data), the assistant says it does not know. It never invents it. Before the assistant changes a preference, a filter or the tracker, it shows the change and waits for the person to confirm.

Observe: With a stand-in AI server and with a local model, ask about a job that lists no pay: "What does this job pay?". Pass: the answer says pay is not listed. Ask about sponsorship at an employer with no record. Pass: a hedged answer, never "they do not sponsor". Ask "Add Austin to my locations". Pass: a confirm step appears, and the preference is unchanged until the person confirms. Ask about fit for one job. Pass: the answer agrees with the job's shown score and reasons.
Adversarial angles:
- The assistant states a salary, funding round or leader name that no source in the app shows.
- The assistant changes filters or tracker status without a confirm step.
- The assistant works only with the online provider and fails with a local model.
- The assistant gives a fit answer that contradicts the score on the same screen.

### O12 (MUST, never). Personal data never leaves the laptop unless the person chooses an online AI provider

With no AI provider set, or with a local model, a full journey sends no personal data anywhere. The only outbound traffic goes to employers' public job endpoints and to the app's own documented update and data files, and none of it carries personal data. When the person chooses an online provider, the app says what it will send before the first call, and it sends only what each action needs.

Observe: Run the full journey as persona D while recording all outbound traffic. Pass: every host in the log is an employer job endpoint or a host listed in the README as an app update or data host. Search every recorded request for the persona's name, email, phone, city, 5 distinctive resume phrases, a tracker note and a contact name from the network file. Pass: 0 hits. Then switch to a stand-in online provider. Pass: a notice about what is sent appears before the first AI call; recorded AI requests carry no network-file rows and no tracker notes unless the action needs them.
Adversarial angles:
- A crash reporter, usage counter or update check sends an ID or file paths that contain the person's name.
- Fonts, icons or a model file load from a third-party host at runtime without the README saying so.
- The resume parse or the match score quietly uses an online AI service.
- Personal data appears in a job-board request (for example the person's city in a search query or header).

### O13 (MUST, never). The app never crashes, hangs or loses saved work on bad input or outages

Across bad inputs and outages, the app never shows a blank window, never crashes and never loses data it already saved. Each failure shows a plain message that says what happened and what the person can do next.

Observe: Try each input and condition, and screenshot the result: an empty file, a 20-page resume, an image-only PDF, a non-English resume, a connections file with wrong columns, a job text of 5 MB, text with emoji and right-to-left script, no network at launch, the AI provider down, the AI provider slow (60 seconds), and a zero balance on the online provider. Before and after each one, export or screenshot the profile, the tracker and the saved resumes. Pass: no crash, no blank window, no endless spinner (every wait ends or can be cancelled within 90 seconds), no raw error codes or stack traces on screen, and 0 differences in the saved data. With no network, the app opens and shows the jobs, tracker and resumes it already has.
Adversarial angles:
- A failed resume parse overwrites the old profile with empty fields.
- A slow AI call leaves a spinner that never ends and blocks the rest of the app.
- A zero balance shows a raw server reply instead of a plain message.
- Launch without network hangs on the start screen.

### O14 (SHOULD). Jobs stay fresh without work from the person, and the app stays polite to employers

While the app runs, and at each launch after time away, new postings arrive and closed ones leave, without any action from the person. The app shows when jobs were last refreshed. New strong matches for the person's saved search raise one desktop notification each. The app never asks any single job host for more than one page a second.

Observe: Use a test board. Add a job that fits persona A's saved search. Pass: it appears in the feed within the refresh interval that the app shows, with exactly one notification. Quit the app, add 3 jobs, relaunch. Pass: all 3 appear without a manual refresh, and the "last refreshed" time updates. Record outbound traffic during a full refresh. Pass: no host gets more than 1 request in any 1-second window, and 0 requests go to hosts on the excluded list.
Adversarial angles:
- The same new job raises a notification on every refresh.
- A catch-up refresh after a week away freezes the app.
- Retries after errors break the one-request-a-second limit.
- The "last refreshed" time shows the time of the last attempt, even when the attempt failed.

### O15 (SHOULD). Money is plain and honest

When the person uses the online publik provider, the app shows their balance in dollars. Before a paid action, the person can see what it costs or a clear estimate. When the balance runs out, paid actions stop with a plain message, and every free and local feature keeps working. No screen says "credits".

Observe: Point the app at a stand-in publik server that reports a balance of $0.50 and then $0.00. Screenshot the balance and each paid action. Pass: the balance shows as a dollar amount, and it goes down by the amount the stand-in server charged. At $0.00, start a tailor action. Pass: a plain message and a way to add funds or switch to a local model; no partial resume is saved as final. Search the visible text of every screen in the journey. Pass: 0 uses of the word "credits" for money.
Adversarial angles:
- A retry after a timeout charges the person twice.
- The balance on screen is stale after a paid action.
- A run-out in the middle of an action saves partial output as a finished result.
- Local features (tracker, filters, network file) lock when the balance is zero.
