# Acceptance outcomes: crawler (production crawler core)

Status: draft, 2026-09-25. Source: `docs/PLAN.md` sections 1 to 8, `GAPS.md` (D1, D2, D5), audit 05 (data supply) and audit 01 section 3 (ingestion).

Scope: the part of jobleft that fetches jobs from employers' public job boards onto the laptop, keeps them current, and closes jobs that employers remove. Matching, the H-1B tag, company facts and the metered fetch route are out of scope here.

These outcomes say what a user or a stranger must see. They do not say how to build it.

Test setup that the checks assume:

- The package README explains how to run a crawl against a board list that the tester chooses, including boards on local mock servers.
- Each mock server counts as its own host, and it logs every request it gets (time, path, headers, body).
- The tester uses the fake persona "Jordan Testwell" (jordan.testwell@example.com) for any profile data.
- Live checks use only approved public boards, at most 1 request per second per host.

---

## O1 (MUST): Jobs from a public board arrive with the facts the board states

For each job that an employer's public board lists, jobleft shows the title, the company, every place, the pay when the board states it, the posted date, the full description and a link to that job's page on the employer's own site.

Observe: Serve a mock board with 40 known jobs. Run the crawl command from the README. Query the jobs endpoint in `docs/INTERFACES.md`. Each of the 40 jobs is present, and each field matches the mock data. On a live run of 5 approved boards, open 20 random job links. Each link opens the employer's page for that same job.

Adversarial angles:
- A board with more jobs than one page holds arrives only in part.
- A job listed in 3 cities keeps only the first city.
- A long description arrives cut short, or loses its lists and headings.
- The link goes to the board's list page or to a guessed address, not to the job.

## O2 (MUST): jobleft never invents a fact about a job

When a board does not state the pay, the posted date, the place or the work model, jobleft shows that field as not stated. Every pay figure that jobleft shows can be found, with the same numbers and the same unit (per hour or per year), in the board's own data for that job.

Observe: Serve a mock board with jobs that have no pay, no date and no place, and jobs whose pay is only in the description text. Query the jobs endpoint and take a screenshot of the job cards. Missing fields are empty, not filled. For 50 live jobs that show pay, compare each figure with the employer's own page.

Adversarial angles:
- A missing posted date becomes the crawl date, so an old job looks new.
- "$45 per hour" shows as "$45/yr", or a monthly figure shows as yearly.
- A number from the benefits text ("401(k) match up to $5,000", "$2,000 sign-on bonus") shows as salary.
- An empty place becomes "United States" or "Remote" by default.

## O3 (MUST): A job the employer removes stops showing as open

When an employer removes a job from its board, jobleft marks it closed no later than 48 hours after the removal while the app runs. If the board lists the job again, jobleft shows it as open again. A closed job keeps its details, so a job the user saved or applied to still shows its title, company and description.

Observe: Serve a mock board with 20 jobs. Crawl it. Remove 3 jobs. Keep the app running for 48 hours, or use a time-skip that the README documents. Query the jobs endpoint. The 3 jobs are closed and carry a close time. The other 17 are open. Put 1 job back and crawl again. That job is open. Save 1 of the removed jobs to the tracker first. Its details are still readable after it closes.

Adversarial angles:
- A removed job stays open for weeks.
- A closed job is deleted, so the user's tracker entry loses its description.
- A job that comes back stays closed.
- A job closes after one quick miss that a second check would have caught as a false alarm.

## O4 (MUST): A failed crawl never closes a board's jobs

When a board answers with an error, times out, sends a broken reply, sends an empty list or disappears, jobleft never closes that board's jobs because of that crawl. The board's jobs stay as they were, and jobleft reports the board as unavailable, with the reason.

Observe: Serve a mock board with 30 jobs and crawl it. Then make it answer, one crawl at a time, with: a server error, a timeout, a reply cut off half-way, a web page in place of job data, a list with 0 jobs, and "not found". After each crawl, query the jobs endpoint. The 30 jobs are still open. The board status (endpoint or README command) names the failure.

Adversarial angles:
- A reply with 0 jobs during an employer's system move closes every job.
- A reply cut off half-way closes the jobs after the cut.
- A block page or sign-in page is read as "this board has no jobs".
- The failure is silent: the user sees fewer jobs and no warning.

## O5 (MUST): Each job appears once, and two jobs never merge into one

The same job shows once, however many times jobleft crawls it and even when it reaches jobleft by two routes. Two different jobs never merge, even when they have the same title at the same company.

Observe: Crawl the same mock board 5 times. The job count equals the mock count. List the same employer twice in the board list. Its jobs still appear once. Serve a mock board with 12 open jobs that all have the title "Deployment Strategist", with different places or different ids. All 12 appear.

Adversarial angles:
- An employer edits a job's text, and the edit appears as a second job.
- Two jobs with the same title in two cities merge, so the one in the user's city disappears.
- Two employers on the same job system use the same job number, and their jobs collide.
- A change in letter case or spacing in a title makes a copy.

## O6 (MUST): The crawler is polite to every host

jobleft sends at most 1 request per second to any one host. It follows each host's robots.txt, including a crawl delay longer than 1 second. It waits when a host says "too many requests" or "come back later", and it asks a failing board less often until that board works again. Every request names jobleft and its version honestly.

Observe: Serve 6 mock hosts that log request times. One host has a robots.txt that blocks a path. One asks for a 5-second crawl delay. One answers "too many requests" with a 30-second wait. One fails every time. Run a full crawl. Check the logs: no two requests to one host are less than 1 second apart; no request goes to a blocked path; the delay host gets requests at least 5 seconds apart; the "too many requests" host gets no request for 30 seconds; the failing host gets fewer requests over time. Every request carries the same honest product name and version.

Adversarial angles:
- Parallel work sends 4 requests a second to one host.
- Retries or redirects skip the pace.
- A robots.txt that answers with a server error counts as "everything is allowed".
- Every board refreshes at the same moment when the laptop wakes from sleep.

## O7 (MUST): The crawler never sends personal data

A crawl request never carries the user's name, email, resume text, profile, search words, saved filters or any mark that is unique to this person or this install. Plain crawling contacts only the employer boards and their robots.txt files. It never sends the job store or the list of boards to publik or to any other service.

Observe: Make a profile for Jordan Testwell with a resume that holds 5 unusual marker words. Save 3 searches. Run a crawl against mock hosts that log full requests. Search every logged URL, header and body for the name, the email and the marker words. There are 0 hits. Compare the headers from two fresh installs. They carry no install-unique value. A network log of the run shows no host other than the boards.

Adversarial angles:
- The contact address in the User-Agent comes from the user's profile or git settings.
- The user's search words go to a board as a query.
- A header carries an install id or a local page address.
- A background upload of "board health" data goes to a hosted service.

## O8 (MUST): The crawler never contacts a forbidden host and never poses as a browser

jobleft never sends a request to LinkedIn, Indeed, Glassdoor or SmartRecruiters. It never contacts Workday, iCIMS, Oracle, UKG or Taleo unless the owner turns that source on, and it ships with those sources off. It never pretends to be a web browser.

Observe: Add board entries and paste job links for each forbidden host. Point a mock board redirect at each one. Run a crawl with a network log. The log shows 0 requests to those hosts, and jobleft says plainly why it skipped each entry. Check every logged User-Agent. None claims to be a browser.

Adversarial angles:
- A careers page redirects to a LinkedIn or Indeed job page, and jobleft follows it.
- A short link hides a forbidden host.
- After a "forbidden" answer, the crawler retries with a browser-like identity.
- A shipped board list includes a Workday tenant that crawls by default.

## O9 (MUST): One bad board does not stop or slow the rest

A broken, slow, huge or hostile board does not stop the crawl or delay the other boards. The crawl ends, every healthy board's jobs are stored, and a report names each board that failed and why.

Observe: Serve 10 mock boards. One never answers. One sends data very slowly. One sends a 500 MB reply. One sends broken data. One sends a redirect loop. One lists 50,000 junk jobs. Four are healthy. Run the crawl. The four healthy boards' jobs are all stored within 2 minutes of the time they take without the bad boards. The app stays up and its memory stays under 1 GB. The board status report names each of the 6 bad boards with a reason.

Adversarial angles:
- One hung connection holds the whole queue.
- A huge reply fills memory and the app crashes.
- A redirect sends the crawler to an address on the user's own home network.
- The report says "done" and hides the 6 failures.

## O10 (MUST): Text from a board never runs as code in jobleft

A job's title, description or link never runs a script, never loads content from a third party and never opens a non-web address when the user views or clicks it. The text stays readable.

Observe: Serve a mock board with a job whose description holds a script tag, an image with an error handler, a `javascript:` link and a remote image on a logging mock host. Crawl it. Open the job in the app and take a screenshot. No script runs, no alert shows, and the logging host gets 0 requests. A job whose apply link is not an `http` or `https` address shows no clickable apply link.

Adversarial angles:
- A description with a script tag runs code with the app's access to local data.
- A remote image in a description tells a third party when the user reads the job.
- An apply link opens a local file or a custom app address.

## O11 (MUST): An interrupted crawl resumes and loses nothing

When the app quits, crashes, loses power or loses the network in the middle of a crawl, the next start opens the job store without errors, keeps every job that was stored, and finishes the boards that were not done. A job is never half stored.

Observe: Start a crawl of 50 mock boards. Force-quit the app after about 20 boards. Start it again. The app opens with no repair step. The jobs from the first 20 boards are present. The mock logs show that the other 30 boards get crawled next. Repeat with a network cut and a power-style kill during a large write. No job has a title but no link, or a link but no title.

Adversarial angles:
- A force-quit during a write damages the store, and the app will not start.
- The restart reads the cut crawl as "all jobs gone" and closes jobs.
- The restart crawls all 50 boards again from the top.
- A job is stored without its description, and it never gets it later.

## O12 (MUST): Jobs in every field and at every level are kept and findable

Nursing, retail, warehouse, finance, trades, teaching and other non-tech jobs are stored and searchable the same way as software jobs. jobleft keeps every level, from intern to executive, and both hourly and salaried jobs.

Observe: Serve a mock board with 30 jobs across 10 fields and 6 levels, some hourly. Crawl it. The jobs endpoint returns all 30. Searches for "registered nurse", "forklift", "staff accountant" and "electrician" return the right jobs. On a live run, pick 2 approved boards whose jobs are mostly non-tech. The stored open count for each board equals the board's own count.

Adversarial angles:
- A tech-only keyword rule drops a nursing job.
- A job with no clear field is hidden by default.
- An hourly job loses its pay because the pay is not yearly.
- Every job is tagged as one level.

## O13 (SHOULD): The first run shows jobs as they arrive

On the first launch, jobs start to show within 2 minutes, and the count grows while the crawl runs. jobleft shows progress as boards done out of boards total. The user can search the jobs that have arrived before the crawl ends.

Observe: Start a fresh install with the shipped board list pointed at mock boards, or at an approved live subset. Every 30 seconds, query the jobs endpoint and the progress status, and take a screenshot. The job count rises. The progress rises to 100%. A search during the crawl returns results.

Adversarial angles:
- The screen stays empty until every board is done.
- Progress stops at 99% because of one hung board.
- The job count goes down while the first crawl runs.

## O14 (SHOULD): Freshness is shown honestly

Each job shows the date the employer posted it (when the board states it) and the time jobleft last saw it on the board. When jobleft has not been able to confirm a job for a while, the job says so. jobleft never calls a job "fake" or "ghost". It states the facts it saw, such as "open 142 days".

Observe: Serve a mock board with jobs posted 1, 30 and 200 days ago. Crawl it. Make the board fail for 3 days (or use a documented time-skip). Query the jobs endpoint and take a screenshot of the cards. The posted dates match the board. The "last seen" time is 3 days old and the card says it. Search the UI text and the endpoint output for "fake" and "ghost". There are 0 hits.

Adversarial angles:
- A card shows "posted 1 minute ago" from the crawl time, not from the employer's date.
- A time-zone error puts the posted date one day off, or in the future.
- A job the employer edited today but posted 200 days ago shows as new.
- A job from a board that has failed for a week still looks freshly confirmed.

## O15 (SHOULD): Jobs stay current while the app runs and after a break

While the app runs, including from the tray, jobleft refreshes each board on a regular schedule. After the laptop is off for days, jobleft starts a catch-up crawl when the app opens. A board that has not changed costs its host little.

Observe: Run the app with 10 mock boards for 6 hours with the window closed. The mock logs show each board requested again on the schedule the README states, and not more often. Add a job to a mock board. It appears within one refresh period. Quit the app for 3 days (or use a time-skip), then open it. The logs show a catch-up request to each board. For an unchanged board, the logs show a small reply, not the full job list.

Adversarial angles:
- Refresh stops when the main window closes.
- Refresh runs every minute and loads employer servers for no gain.
- The catch-up after a break skips boards, so old closed jobs still show as open.
