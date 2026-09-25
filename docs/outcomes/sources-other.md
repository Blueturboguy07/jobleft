# Acceptance outcomes: other job sources

Area: `sources-other`. Date: 2026-09-25.
Inputs: `docs/PLAN.md` sections 1 to 8, `jobright-research/GAPS.md` (D1, D2, D5), `jobright-research/audit/05-data-supply.md` (sections 1.3, 1.7, 1.8, 5.3).

## Scope

"Other job sources" means every approved job feed that is not an employer's own ATS job board. Audit 05 names these examples:

| Kind | Examples | Terms that matter |
|---|---|---|
| Government job API | USAJOBS | Free key. The source asks for the registered email in each request |
| Remote-job boards | Remotive, Remote OK | Credit and link back are required. Remotive allows at most 4 fetches a day, and its jobs arrive 24 hours late |
| Level-labelled feed | The Muse | A key is needed beyond testing. Published hourly limits |
| Community lists | GitHub internship lists, HN Who is Hiring | Licence check per list |
| Per-query search partner (only if approved) | Adzuna | Terms bar storage or aggregation. Credit is required |

This file does not choose the list of sources. The outcomes apply to each source that the plan approves in this area.

How a stranger checks these outcomes: use only the commands in the package README, the endpoints in `docs/INTERFACES.md`, files that the product writes, and screenshots. Use local stand-in feeds, not the live hosts (see O15).

---

## O1. MUST: each source adds jobs that name their source and link back

When an approved source is on and answers normally, its jobs appear in the user's local job list. Each job shows the name of its source and a link that opens the original posting or the employer's apply page.

Observe: Serve a fixture feed with a known set of jobs for each source. Run a refresh. Compare the job list with the fixture: the count agrees (after any documented filter, such as non-US jobs). Each job card and each job detail shows the source name. Each link opens the exact URL in the fixture.

Adversarial angles:
- The link opens a page inside the app, or a tracking redirect, and not the original posting.
- The link loses part of the original URL, such as a job-id query parameter, and opens the wrong job.
- Jobs from one source carry the name of a different source.
- The card shows the source, but the detail view or the tracker entry does not.

## O2. MUST: credit required by a source's terms appears wherever its jobs appear

For a source whose terms ask for credit (for example Remotive and Remote OK), each of its jobs shows that credit and a link to the source on every surface: the card, the detail view, alerts and notifications, and any file the user exports.

Observe: Load fixture jobs from each source that requires credit. Take screenshots of the card, the detail view and an alert. Export the job list. The credit text and a working link to the source are present in each screenshot and in the exported file.

Adversarial angles:
- The credit appears only on a general "About" or "Sources" page, not next to the job.
- The credit is lost in notifications or exports.
- The credit disappears when the job is merged with a copy from another source (see O10).
- The credit link opens the wrong page or a dead page.

## O3. MUST: the app keeps each source's request limits

The app never asks a source more often than the source's published terms allow. For example, it makes no more than 4 fetches a day where a source sets that limit. It never sends more than 1 request a second to one host. This stays true when the user presses refresh many times, relaunches the app, or leaves the app in the tray.

Observe: Point each source at a local stand-in server that logs every request with a timestamp. Press refresh 10 times in 1 minute. Relaunch the app 5 times. Leave the app running for 24 hours (or use a documented clock setting, if the README gives one). Read the log: the gap between requests to one host is never under 1 second, and each daily count stays within the source's limit. When the user presses refresh too soon, the app says when the next refresh is allowed.

Adversarial angles:
- A launch catch-up and a background poll both run and double the requests.
- Retries after an error ignore the limit.
- The daily count resets when the app restarts.
- Two windows or two app processes each keep their own limit.

## O4. MUST: a source that needs a missing key is reported, skipped, and does not leak the key

When a source needs a key or a registration that the user has not given, the app shows "needs a key" for that source, with plain steps to add one. It sends no request to that source. The other sources continue. After the user adds a key, the source runs. The key never appears in logs, error text or exported files.

Observe: Start with no keys. The stand-in log shows 0 requests to the source that needs a key. The source status (in the app and at the status endpoint in `docs/INTERFACES.md`) says a key is needed. Jobs from the other sources arrive. Add the fake key `TESTKEY-0000-jordan`. Run a refresh: the source now runs. Search every log and exported file for `TESTKEY-0000-jordan`: there are 0 matches.

Adversarial angles:
- The app sends a request with an empty key and reports the rejection as "0 jobs found".
- The problem appears only in a log file, and the screen shows nothing.
- A wrong key looks the same as a source with no jobs.
- The key is printed in an error message, a debug log or a screenshot of the status screen.

## O5. MUST: a source that is down or changed shape is reported and isolated

When a source times out, returns an error, returns a web page instead of data, or changes the shape of its data, the app shows which source failed, when, and a short reason in plain words. Jobs from the other sources still arrive. The app tries that source again later, within its limits (O3).

Observe: Set the stand-in server so that source A returns HTTP 500, source B returns data with renamed fields, source C never answers, and source D returns good data. Run a refresh. D's jobs appear. A, B and C each show a different plain-language status with a time. The app stays usable during and after the refresh.

Adversarial angles:
- One bad source stops the whole refresh.
- A changed shape turns into rows with blank titles, "undefined" or "null".
- The error is hidden, and the status says "OK, 0 new jobs".
- A source that never answers blocks the other sources for a long time.

## O6. MUST: the app never loses jobs silently when a fetch fails

An error, an empty answer, or a cut-off answer from a source never marks that source's saved jobs as closed and never deletes them. A job that the user liked, noted or tracked keeps its link and its tracker status whatever the source does.

Observe: Serve a fixture with 20 jobs and run a refresh. Like 2 of them and mark 1 as applied. Then make the stand-in return an error, then an empty list, then a truncated body, with a refresh after each. After each refresh, all 20 jobs are still shown as open, the source status shows the problem, and the liked and applied jobs are unchanged.

Adversarial angles:
- An empty but successful answer closes every job from that source.
- A source that fails on its second page of results closes the jobs on the later pages.
- A tracked job disappears from the tracker, or loses its link, when its source fails.
- The app deletes a job instead of marking it closed, so the user cannot see what happened.

## O7. MUST: jobs that a source stops listing stop showing as open

When a source answers normally and no longer lists a job, the app stops showing that job as open, within the time the README states. The job is hidden from the default list or marked closed. A new job in the source appears after the next allowed refresh.

Observe: Serve a fixture with 20 jobs and run a refresh. Change the fixture to 19 of those jobs plus 1 new job. Run refreshes as the README says (for example, 2 refreshes a day apart, if a documented clock setting exists). The removed job is no longer shown as open. The new job appears with its source and link (O1).

Adversarial angles:
- Closed jobs from remote-job boards stay in the list for weeks.
- A job that returns to the source stays marked closed.
- The removed job still appears in alerts after it closed.

## O8. MUST: the app never invents facts about a job

Where a source gives no pay, level, work model, location or posted date, the app shows the field as unknown or leaves it out. It never shows a guess as a fact. Values that it shows agree with the source: the pay amount, the pay period (hour, month or year), the currency, the location, and the date the source says the job was posted (not the date the app fetched it).

Observe: Serve fixtures that include: a job with no pay and no level; a job paid $30 an hour; a job paid in euros; a job with a federal pay grade; and a feed that arrives 24 hours after its posted dates. Compare each card and detail view with the fixture.

Adversarial angles:
- The fetch time shows as "Posted 1 hour ago" for a job the source dated yesterday.
- "$30 an hour" shows as "$30 a year" or "$30K".
- A euro amount shows with a dollar sign.
- A level such as "Senior", or a salary, appears for a job whose source gave neither and whose text does not state it.

## O9. SHOULD: remote eligibility appears as the source states it

For remote jobs, the app shows where the employer accepts applicants when the source states it (for example "USA only", "Europe only" or "Worldwide"). When the source does not state it, the app says so. A job restricted to another region never looks open to US applicants.

Observe: Serve remote-board fixtures with "USA only", "Europe only", "Worldwide" and no region. Filter the list to remote jobs open to US applicants. Only the "USA only" and "Worldwide" jobs appear by default. The job with no region shows "region not stated", or appears only when the user includes unknown regions.

Adversarial angles:
- A "Europe only" job appears under a US location filter.
- The company's headquarters city replaces the remote region.
- "Worldwide" is treated as "not stated", and the user loses good jobs.

## O10. MUST: the same job from two places shows once, with every credit kept

When the same posting comes from one of these sources and from the employer's own board, or from two of these sources, the user sees one job. It keeps each source's credit and link. Likes, notes and tracker status are not split and not lost. Different jobs with the same title at the same company stay separate.

Observe: Serve one job in both an employer-board fixture and a remote-board fixture. The two copies differ only in tracking parameters and title case. The list shows one entry, and its detail view names both sources with working links. Also serve two jobs with the same title at the same company in different cities. They show as two entries.

Adversarial angles:
- Two different jobs merge because they share a title.
- The same job shows twice because the links carry different tracking parameters.
- The merged job loses a credit that a source requires (O2).
- One source closes the job while the other still lists it, and the open job disappears.

## O11. MUST: the app never contacts a forbidden host and never sends personal data

No request goes to LinkedIn, Indeed, Glassdoor, SmartRecruiters, or any host outside the approved list. No request carries the user's name, email, resume text or profile. The one exception: a contact detail that a source's own terms require, which the user entered for that source, goes only to that source's host.

Observe: Load the test persona "Jordan Testwell" (jordan.testwell@example.com) with a resume and a profile. Route all outbound traffic through a logging stand-in. Run a full refresh and a search. Check the log: every host is on the approved list. The persona's name and resume words appear in 0 requests. The persona's email appears only in requests to the source that requires it, and only after the user entered it for that source.

Adversarial angles:
- The User-Agent header carries the user's email to every host.
- The app follows a redirect from an approved host to a forbidden host.
- A per-query search sends resume text or the profile as the query.
- An error report or usage ping sends job or profile data off the laptop.

## O12. MUST: a job description never runs code and never loads remote content

Text and HTML from any source show as plain, safe content. Opening a job never runs a script from the description. It never loads an image, font or frame from the network, so a source cannot track who opened which job.

Observe: Serve a fixture job whose description contains a script tag, an image with an error handler, an inline frame, and a 1-pixel image on a stand-in host. Open the job. No dialog appears. The app's behaviour does not change. The stand-in log shows 0 requests from the opened description.

Adversarial angles:
- A script in the description runs and reads local data or calls the app's local server.
- A tracking pixel loads and shows the user's IP address to the source.
- A link in the description opens inside the app window instead of the user's browser.

## O13. MUST: terms that forbid storage are kept

If the app offers any source whose terms forbid storing or re-listing its jobs (for example a per-query search partner), results from it appear only for the current search and carry its credit. They do not enter the saved job list, alerts or exports. The user can still save one of these jobs by its link to the tracker.

Observe: Run a search that uses such a source through a stand-in. The results show the source's credit. Close and reopen the app. The saved job list, alerts and a fresh export contain none of those results, except a job that the user saved on purpose, which keeps its link.

Adversarial angles:
- The results enter the local job list and appear in later alerts.
- The results appear in an export or backup file.
- The results lose the credit that the source requires.

## O14. SHOULD: the user can see and control each source

The user can see every other source in one place, with: on or off, the last successful fetch time, the number of open jobs, and the last problem. The user can turn any source off. When a source is off, it gets no requests, and its jobs are hidden or marked. Tracked jobs stay in the tracker. The user can also filter the job list by source, and the counts agree with the list.

Observe: Take a screenshot of the source list after a refresh. The counts agree with the fixtures. Turn one source off and run a refresh: the stand-in log shows 0 requests to it. Filter the list by each source: the number of jobs shown equals the count on the source list.

Adversarial angles:
- The switch hides the source on screen, but requests still go out.
- The counts on the source list are old or wrong.
- Turning a source off deletes jobs that the user tracked.

## O15. SHOULD: a stranger can check every source without live requests

The package README gives a command to run each other source against a local stand-in feed. The stand-in covers normal data, errors and changed shapes. A stranger can check O1 to O14 with no network access and no keys.

Observe: Disconnect the network. Follow the README to start the stand-in feeds and run a refresh. Every source produces the fixture jobs or its expected error status. No request leaves the laptop.

Adversarial angles:
- The stand-in covers only the good path, so O5 and O6 cannot be checked.
- One source quietly calls its live host even in stand-in mode.
- The fixtures differ from the real shape of the source, so the tests pass but real data fails.
