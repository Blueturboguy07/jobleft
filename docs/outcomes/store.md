# Acceptance outcomes: store (local job store, fit indexing and search)

Area: the jobs that live on the laptop, how a person finds them, and how the app ranks them by fit to a profile.
Sources: `docs/PLAN.md` sections 1 to 8 (decisions 7 and 8, D1, D2, D5, I2, I4, M2, spike S2), `GAPS.md` (I2, D5, M2), the job list and filter screens in `ui/UI-SPEC.md` section 08 and `ui/UI-SPEC-LOGGED-IN.md` L01 and L02, and `audit/05` part 5.

How to read this file:

- MUST: the release fails if this outcome fails.
- SHOULD: a failure needs a written reason and a fix date.
- "Observe" uses only public interfaces: commands in the package README, HTTP endpoints in `docs/INTERFACES.md`, files the product writes, and screenshots of the app.
- "Fit indexing" means the work that lets the app rank jobs by how well they fit a profile. "Fit order" means the Top Matched and Recommended sorts.
- A "known job set" is a file of jobs whose every field the tester wrote by hand. The tester loads it through the README's documented import path, or serves it from a local mock job board and lets the app crawl it. A "synthetic set" is a generated set of that size with realistic text lengths.
- "Target Mac" means an Apple silicon Mac with 16 GB of memory, or the smallest Mac the README says the app supports, if that is smaller.

---

## O1 (MUST) Word search finds the right jobs

A person types words and gets the jobs whose title, company or description contains them, with the best word matches first. Unusual words such as `C++`, `C#`, `.NET`, `Node.js`, `401(k)` and company names with accents such as `Société Générale` work like any other word.

Observe: Load a known job set of 1,000 jobs with 20 planted target jobs. Run 20 queries through the search endpoint and in the app. Each planted job whose title holds the query words is in the first 20 results. Run 30 queries that hold quotes, asterisks, brackets, hyphens, a lone `-`, or the words AND, OR, NOT and NEAR. Each one returns results or a plain "no results" state, never an error and never a blank screen.

Adversarial angles:
- Punctuation is stripped, so `C++` and `C` return the same jobs, or `C#` finds nothing.
- A query with a quote mark or a search operator word causes a server error.
- Accented or non-English company names are not found when typed with or without the accent.
- An empty query returns nothing instead of the normal list.

## O2 (MUST) Every result obeys every active filter

A person who sets filters (location, work model, job type, experience level, required years, date posted, minimum pay, H-1B sponsor likely, include or exclude company, industry, skill, staffing agency) sees only jobs that meet all of them. This is true for word search, for fit order and for Most Recent.

Observe: Load a known job set of 5,000 jobs. Run 200 random filter combinations, each in all three sort orders, through the search endpoint. Compare every returned job's fields with the filters. The number of jobs that break a filter is 0. Then check the opposite: for 20 of the combinations, every job in the known set that meets all the filters appears somewhere in the results.

Adversarial angles:
- A job with unknown pay passes a minimum pay filter as if it met it.
- A job with several locations is found only by its first city.
- An exclude filter loses to an include filter (a job at an excluded company shows because it matches an included skill).
- "Past 24 hours" uses the wrong day boundary near midnight or across time zones.

## O3 (MUST) Fit order puts jobs that fit the profile first, even when the words differ

With a profile set, the Top Matched order puts jobs that fit the profile at the top, also when the job uses different words for the same work. With no profile, the app says that fit order needs a profile. It never shows an ordinary list under a fit label.

Observe: Write 30 pairs of a short profile and a target job that shares few words with it (for example, a profile about "invoices, vendor payments and month-end close" and a job titled "AP Specialist"). Add the 30 targets to a synthetic set of 10,000 jobs. For at least 25 of the 30 profiles, the target job is in the first 10 results of fit order. Change the profile to a different field of work. Within 30 seconds, the first page of fit order changes to jobs of the new field. Delete the profile. Fit order then shows a plain "needs a profile" message.

Adversarial angles:
- Fit order only rewards shared words, so it misses jobs that use other words for the same work.
- Fit order ignores a filter that word search obeys.
- A profile change does not change the order until the app restarts.
- With no profile, fit order shows random or stale scores.

## O4 (MUST) Search is fast at 100,000 and at 500,000 jobs

At 100,000 jobs and at 500,000 jobs, word search, filtered search and fit order each return the first page in well under a fifth of a second.

Observe: On a target Mac, load a synthetic set of 100,000 jobs, then one of 500,000 jobs. For each size, send 300 mixed queries through the search endpoint and time them end to end. The mix: words only, filters only, words and filters, fit order with filters, broad filters that match most jobs, narrow filters that match fewer than 10 jobs, and page 20 of a long list. Pass: median under 100 ms, 95th percentile under 150 ms, and no query over 200 ms. The first search after a launch returns in under 2 seconds.

Adversarial angles:
- A broad filter (all of the US, all levels) is much slower than a narrow one.
- A deep page (page 20 or later) is much slower than page 1.
- The first search after a launch or after a long idle period is slow, and the benchmark hides it by warming up first.
- The speed holds on a fast Mac but not on the smallest supported one.

## O5 (MUST) Closed and hidden jobs never show in results

A job that has closed, or that the person marked "not interested", never appears in any result list or result count, in any sort order. A liked or applied job that closes moves to a "Closed" view and keeps its likes, notes and tracker status. A board that fails to answer never makes its open jobs disappear.

Observe: Crawl a local mock board with 50 jobs. Remove 10 jobs from the board and run the refreshes the README says close a job. Search in all three sort orders: the 10 closed jobs are absent and the count drops by 10. One closed job was liked and one was applied to: both appear under the Closed view with their notes and status intact. Mark 10 open jobs "not interested", refresh the board and restart the app: the 10 jobs stay out of results, and the person can see them in a list and undo each one. Make the mock board return an error, then an empty list, for two refreshes: its open jobs still show.

Adversarial angles:
- A closed job is gone from word search but still shows in fit order, or still counts in the total.
- A job the person applied to disappears from the tracker when the posting closes (silent loss).
- A board outage or an empty answer closes every job on that board.
- A "not interested" job returns after the next refresh because the refresh wrote it again.

## O6 (MUST) A job never shows twice, and two different jobs are never merged

The same posting shows once, even when the app reached it through two links or crawled it many times. Two real postings stay two results, even when they have the same title at the same company.

Observe: Build a known job set that holds one posting reached by three links (plain, with tracking parameters such as `utm_source`, and on the company's own careers page with the job ID in the link) and three postings with the same title at one company but different cities or different job IDs. Search: the first posting shows once and the other three show as three. Refresh the board 3 times: the result count does not change.

Adversarial angles:
- Tracking parameters make each link a new job.
- The cleanup of links also strips a parameter that is the job ID, so different jobs on a company careers page merge into one.
- Each refresh adds a second copy of every job.
- "Stripe" and "Stripe, Inc." from two sources produce two copies of one posting.

## O7 (MUST) The result count is true and paging never repeats or skips a job

The number of results the app shows equals the number of distinct jobs the person can reach by paging to the end. Paging never shows a job twice and never skips one, also when new jobs arrive while the person pages.

Observe: For 20 queries, page through every result page through the search endpoint and collect each job's ID. There are no repeated IDs, and the number of IDs equals the shown count. Repeat 5 of the queries while a crawl adds 500 new jobs in the middle of paging. Every job that matched at the start and still matches appears exactly once.

Adversarial angles:
- The count includes closed, hidden or duplicate jobs, so the last pages come back empty.
- The count is taken before the filters.
- New jobs push the list down during paging, so one job shows on two pages and another is never seen.
- Fit order stops at a fixed number of jobs (for example 1,000) while the count says more.

## O8 (MUST) The store never invents or changes a fact

Pay, pay period, location, work model, job type, level and the posted date that the app shows match what the employer's posting said. A fact the posting did not give shows as not stated. It never shows as a default value.

Observe: Load a known job set of 200 jobs with every fact written by hand, including jobs with hourly pay, several locations, no pay, no work model and no posted date. Compare each fact in the search results, in the endpoint output and on the job screen with the known set: 0 mismatches. Jobs with no posted date are never shown with a posting time and never pass a "Past 24 hours" filter because of the crawl time.

Adversarial angles:
- A job with no posted date gets the crawl time, so a job that is 6 months old shows "1 hour ago".
- Hourly pay shows as yearly ($45 an hour shows as $45K a year).
- A missing work model defaults to "Onsite" or "Remote".
- A posted date moves by one day because of a time zone.

## O9 (MUST) Quitting, crashing or restarting loses nothing

After a normal quit, a force quit, or a crash in the middle of a crawl or of fit indexing, the app opens with every job, like, hidden job, saved filter and note it had before. The same query gives the same first page as before.

Observe: Record the job count, the liked and hidden lists, the saved filters, the fit-indexing status and the first page of 5 queries. Quit and relaunch: all are the same. Force-quit the app (`kill -9` on its processes) during a crawl of 5,000 new jobs, and again during fit indexing. Relaunch: the app opens with no error and no repair prompt, no job, like, note or saved filter from before the crawl is gone, and the 5 queries give the same first page.

Adversarial angles:
- A force quit during a write leaves a store that the app cannot open.
- The last minutes of likes and notes are lost on a crash.
- A restart throws away all fit indexing and starts again from zero.
- Two copies of the app open at the same time damage the store.

## O10 (MUST) Fit indexing never repeats work on jobs that did not change

A job is fit-indexed once. Refreshing a board with no changes, or restarting the app, causes no new fit-indexing work. A job whose text changes is indexed again, and fit order then uses the new text.

Observe: The README documents a status command or endpoint that shows how many jobs are fit-indexed, how many are waiting, and how many were indexed in the last run. After all jobs are indexed, refresh an unchanged mock board and restart the app: the number indexed in the last run is 0, and the app's CPU use returns to idle within 1 minute. Change the description of 5 jobs on the mock board and refresh: the status shows 5 jobs indexed again. A fit search written for the new text now finds those 5 jobs.

Adversarial angles:
- A change in a timestamp or a tracking field makes the whole board count as changed.
- Changed text is not indexed again, so fit order uses the old text.
- After an app update with a new fit model, jobs indexed by the old and the new model are mixed in one ranking with no warning.

## O11 (MUST) Fit indexing never blocks search, and new jobs are findable at once

While the app fit-indexes a large backlog, search stays fast. New jobs are findable by words and filters within seconds of arrival, before their fit indexing ends. In fit order, jobs that still wait for indexing are never silently left out.

Observe: Load 50,000 new jobs into a store of 100,000 jobs, which starts a large fit-indexing backlog. During the backlog, run the O4 query set: the 95th percentile stays under 200 ms and no search waits for indexing to finish. Search for a word that exists only in one new job: it is found within 5 seconds of the load. In fit order with a filter that matches only new jobs, all of those jobs appear (ranked or marked as not yet scored), and the app shows how many jobs still wait.

Adversarial angles:
- Indexing holds the store, so searches stall for seconds.
- The app window freezes or stops responding during indexing.
- Jobs not yet indexed are missing from Top Matched, and nothing tells the person.
- The backlog starts again from zero after every restart.

## O12 (MUST) Search works offline after the first model download

After the fit model downloads once, word search, filters and fit order all work with no network. Before the first download, word search and filters still work, and fit order says plainly that it is not ready yet.

Observe: Install fresh with the network on. The README states the model's download size and source. Let the download finish. Turn off all network access, quit and relaunch: word, filter and fit searches work and give the same results as with the network on. On a second fresh install with no network: word and filter searches work, and fit order shows a "not ready" message, not an empty or wrong list. On a third fresh install, cut the network in the middle of the download, then relaunch with the network on: the download finishes, and fit results equal those of a clean install.

Adversarial angles:
- The app checks for a model update on every launch and hangs when offline.
- A partial or damaged model file is used, and fit order becomes nonsense with no warning.
- Offline, fit order silently falls back to a plain list with a fit label.

## O13 (MUST) Search and fit indexing never send the person's data off the laptop

Search words, filters, the profile used for fit order, and the stored jobs never leave the laptop. Search and fit indexing make no network requests. The store and logs are readable only by the person's own account.

Observe: Run a network monitor for the app's processes (a logging proxy, or the macOS per-process network view) while doing 200 searches, 5 profile edits and the fit indexing of 10,000 jobs. The only outbound requests are job board refreshes and the one documented model download. No outbound request holds a search word or any profile text. Check the files the app writes: the store and its logs are readable only by the owner, and no log holds profile or resume text.

Adversarial angles:
- An analytics or crash report service sends search words or profile text.
- The model loader contacts its host on every launch, which leaks use and the IP address.
- The store or a log sits in a shared or world-readable folder.
- Search words are written in plain text into a log that support asks users to send.

## O14 (SHOULD) The same search gives the same order every time

The same query on the same data gives the same order every time, also after a restart. Most Recent shows the newest posted jobs first. Scores do not move between page loads.

Observe: Run 20 queries 5 times each in each sort order, with a restart between rounds 3 and 4: the order of the first 50 results is the same in all 5 rounds. In Most Recent, each job's posted date is the same as or older than the job above it. Open the same job 5 times: its fit score and its sub-scores are the same each time.

Adversarial angles:
- Ties are broken at random, so equal jobs swap places on each load.
- Most Recent sorts by when the app first saw a job, not by when the employer posted it.
- A fit score moves by several points between two loads of the same job.

## O15 (SHOULD) The store stays within a known disk and memory size

The person can see how much disk the job store uses and where it is. The store does not grow without limit, and memory use stays flat across long use.

Observe: On a target Mac, load synthetic sets of 100,000 and 500,000 jobs, with fit indexing finished. The files the app writes take at most 200 MB at 100,000 jobs and at most 1 GB at 500,000 jobs. The app's settings show the size and the location of the store. At 500,000 jobs the app's total memory stays under 2 GB during searches, and 1,000 searches in a row raise it by less than 10%. Run 30 refreshes of a mock board whose job count stays the same while jobs come and go: the store grows by less than 10%.

Adversarial angles:
- Each refresh keeps an old copy of every job, so the store grows forever.
- Removing jobs never makes the file smaller.
- Memory grows with each search until the app slows down or macOS stops it.
- The fit data is loaded into memory twice.
