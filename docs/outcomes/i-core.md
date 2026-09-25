# Acceptance outcomes: i-core (Integration: crawl, store, feed)

Scope: the whole path from a fresh start to a ranked feed. The crawl, the local job store and the Recommended feed must work together. Each part can pass its own tests and this area can still fail.

Who judges: a stranger with the built app, the package README, the endpoints in `docs/INTERFACES.md`, local mock job boards, the files the app produces, and screenshots. The stranger does not read the source.

Terms used below:

| Term | Meaning |
|---|---|
| Live run | A run against real public employer boards, under the crawl rules: at most 1 request a second per host, robots.txt obeyed, approved hosts only |
| Mock run | A run against local mock boards that the stranger controls (add, remove or break postings) |
| Employer page | The posting on the employer's own job board or careers site |
| Test persona | "Jordan Testwell", jordan.testwell@example.com, with a fake resume. Never a real person |

---

## O1 (MUST) First jobs arrive fast on a fresh install

A person starts the app with no stored data, finishes the preference step, and sees the first real job cards within 2 minutes. Within 10 minutes they can browse at least 200 open jobs from at least 25 employers, and more arrive with no restart and no manual refresh.

Observe: Start the app with an empty data folder on a live run. Complete the preference step as the test persona (job function, level, location, work model, job type). Record the time from the last preference click to the first card with a timestamped screenshot. At 10 minutes, count jobs and distinct employers from the feed count or the documented jobs endpoint. Count again 2 minutes later. Pass when the first card is under 2 minutes, the 10-minute count meets both numbers, and the second count is higher or the app says the first crawl is done.

Adversarial angles: The feed stays blank until the whole crawl ends. Bundled sample or demo jobs fill the feed and look real. All early jobs come from one or two employers. The window freezes or ignores clicks while the crawl runs.

## O2 (MUST) Every job is real, and its link goes to the employer

Every job in the feed is a live posting on the employer's own job board or careers site. Its apply link opens that posting, and the page shows the same title and company as the card.

Observe: On a live run, pick 30 jobs at random from the feed and open each apply link. Pass when at least 29 of 30 open a live employer page, every opened page shows the same title and company as its card, and zero links go to an aggregator, a search page or a board home page.

Adversarial angles: Test fixtures or synthetic rows leak into the real store. Title or company is swapped between two jobs from the same board. A link breaks because a job-id or query parameter was stripped. The link opens a third-party copy of the posting.

## O3 (MUST) Card facts come from the posting, and blanks stay blank

Pay, place, work model, job type, level, years of experience and posted date on a card agree with the employer's posting. When the posting does not state a fact, the card leaves it out or labels it (for example "first seen" in place of a posted date), and never shows a guess as fact.

Observe: For 30 random jobs from a live run, compare each fact on the card with the employer page. Pass when zero shown values contradict the posting or are absent from it, and pay units (per hour or per year) and currency match. Record how many cards show pay, and confirm each one has a pay figure in the source.

Adversarial angles: A signing bonus, a 401(k) match or a funding amount shows as salary. Hourly pay shows as a yearly figure. The posted date is the date the app first fetched the job, so every job looks new after the first crawl. The card says "Remote" because the text mentions a remote-friendly team, but the job is onsite.

## O4 (MUST) Sponsorship hints are hedged, and silence is never a "no"

A sponsorship hint appears only when the posting says so or the employer has recent public visa filings, and the hint states its basis and the date of its data. A posting's own "no sponsorship" text wins over filing history, and the app never says an employer does not sponsor because it found no record of that employer.

Observe: Check three jobs on a live or mock run: (a) a large, well-known sponsor with no sponsorship text, (b) a small employer with no filing record, (c) a posting whose text says sponsorship is not available. Pass when (a) shows a hedged "likely" hint with a data date, (b) shows no sponsorship hint of any kind, and (c) shows the posting's own statement and no "likely" hint. Then turn on the sponsorship filter and confirm that every result carries a hint.

Adversarial angles: A near-miss company name takes another firm's filing history (for example a sports team matched to an industrial firm with a similar name). A staffing firm's filings mark its client's jobs as sponsor-likely. A missing match renders as "No H-1B", a red dot or a negative icon. The hint shows no data date, so old filings read as a current promise.

## O5 (MUST) Closed jobs leave the feed, but not the person's own lists

When an employer takes a posting down, the job leaves the Recommended feed and search within 48 hours of normal running, and opening it says it has closed. It stays in the person's Liked and Applied lists with a "closed" mark and every note intact.

Observe: On a mock run, like job 1, mark job 2 as applied and add a note, then remove jobs 1, 2 and 3 from the mock board. Keep the app running through the closing window the README states. Pass when all three jobs leave the Recommended feed and search, jobs 1 and 2 stay in the Liked and Applied tabs with a closed mark and the note unchanged, and opening job 3 from a saved link shows a closed message, not a dead employer page.

Adversarial angles: Closed jobs stay in the feed for weeks. Closing a job deletes it from the Liked or Applied tab, or deletes its note. A closed job comes back as open on the next refresh with its like gone. A job gets a "fake" or "ghost" label, or a stale mark with no reason shown.

## O6 (MUST) A failing board never wipes out its jobs

The app never closes a board's jobs because the board failed to answer properly: a timeout, an error, an empty list or one unusually short reply leaves the stored jobs open. The person can see which boards are unavailable.

Observe: On a mock run with 3 boards of 20 jobs each, make board A return a server error, board B return an empty list with a success code, and board C return 2 of its 20 jobs once, then all 20 again. Keep the app running through at least the closing window from O5. Pass when boards A and B keep all 20 jobs open, board C never shows fewer than 20 open jobs, and a visible status or sources view names A and B as unavailable.

Adversarial angles: An empty success reply reads as "all jobs closed". A "too many requests" reply or a redirect to a login page counts as an empty board. A network drop mid-refresh closes every job not yet fetched. A board that recovers does not bring its jobs back.

## O7 (MUST) The feed is ranked for this person, and the ranking holds still

The Recommended feed puts jobs that fit the person's stated preferences at the top, and each ranked job shows at least one plain reason. With the same data and preferences, a reload gives the same order and the same scores.

Observe: On one store from a live run, set the preferences to "registered nurse, Texas, onsite, full-time" and save the top 20. Change them to "senior backend engineer, remote US, full-time" and save the top 20 again. Pass when at least 16 of each top 20 match that function and location rule, the two lists share at most 2 jobs, every card shows a reason, and three reloads of each give an identical top 20 with identical scores.

Adversarial angles: Every preference set gets the same list. Scores move between reloads. A firm preference is ignored, so remote jobs in other states rank above onsite Texas jobs. Jobs with missing fields rise or sink with no stated reason.

## O8 (MUST) Every kind of job is kept, not only tech

People outside software find their field: jobs in nursing, sales, finance, operations, teaching, trades and similar fields are kept and shown at every level from intern to director. The app keeps at least 95% of the postings that each crawled board lists.

Observe: After the first live crawl ends, search or filter for 6 non-software functions and each experience level. Pass when each function returns jobs wherever the board list holds employers that post them (check 3 jobs per function against the employer page), and every level returns jobs. Then pick 5 boards, count their postings by hand on the employer site, and compare with the app's count for those employers from the documented jobs endpoint. Pass when the app holds at least 95% of them.

Adversarial angles: A tech-only filter from reused code drops non-software roles. An internship-only or senior-only default hides other levels. Jobs with no department or category are thrown away. Unusual or non-English titles are dropped as noise.

## O9 (MUST) One posting, one card, and different postings stay apart

The same posting never shows as two cards, whether it was fetched twice, seen again on a later refresh or reached by two routes. Two different postings with the same title, such as one role in two cities, never merge into one card.

Observe: After three refreshes on a live run, list the jobs of 5 large employers and count cards that share one employer page link. Pass when that count is zero. On a mock board, publish two postings with the same title and company but different ids and cities. Pass when both show as separate cards.

Adversarial angles: Each refresh adds another copy of every job. Tracking parameters in a link make the same job look new. Dropping a job-id parameter from company-hosted links merges different jobs. A change in title case or spacing creates a duplicate.

## O10 (MUST) The feed stays fresh without the person doing anything

While the app runs, even with only its menu-bar icon open, it refreshes jobs by itself, and a catch-up refresh starts by itself when the app opens after a long break. The feed shows when jobs were last refreshed, and "Most Recent" and the date-posted filter follow the employer's posting date.

Observe: On a mock run, close the main window and leave the app in the menu bar. Add a posting to a mock board. Pass when it appears within the refresh interval the README states, with no click. Quit the app, add another posting, wait past the catch-up threshold the README states, and start the app. Pass when the new posting arrives with no manual refresh. Screenshot the "last refreshed" text before and after. Add a mock posting dated 60 days ago and confirm it does not sort above a posting dated today under "Most Recent".

Adversarial angles: Refresh happens only on a manual button. The menu-bar refresh and the launch catch-up run at once and double the load on each host. A job first seen today but posted two months ago tops "Most Recent". The "last refreshed" time moves forward even when every fetch failed.

## O11 (MUST) Nothing personal leaves the laptop during crawling

The crawl never sends the person's name, email, phone, resume text or typed search words to any job board or other host, and it never contacts LinkedIn, Indeed, Glassdoor or SmartRecruiters. Stored jobs and the profile stay on the laptop.

Observe: Complete onboarding as the test persona with a fake resume, run a search, then run a full crawl through a local logging proxy or the app's documented request log. Search every captured URL, header and body for the persona's name, email, phone, a distinctive resume phrase and the typed search words. Pass when there are zero hits, zero requests to the four named sites, and zero requests to analytics, telemetry or other hosts outside the job boards and the documented static-data source.

Adversarial angles: The User-Agent or another header carries a personal email. Typed search words ride in the query string to a board that supports text search. A crash reporter or analytics library uploads the job store or the profile. Opening an apply link sends the local page address or the search words as a referrer.

## O12 (MUST) The crawl is polite to every host

The app sends at most 1 request a second to any one host, obeys each host's robots.txt, and waits when a host asks it to slow down. Several refresh triggers at once never add up to a faster rate.

Observe: From the proxy log or documented request log of a live first crawl plus one refresh, group requests by host and measure the gap between consecutive requests. Pass when no gap is under 1 second (allow 50 ms of clock noise) and no request hits a path that the host's robots.txt disallows for the app's agent. On a mock host that answers "too many requests" with a wait time, pass when the next request to that host waits at least that long.

Adversarial angles: Parallel workers each keep their own pace for the same host. Retries after an error fire in a burst. A launch catch-up overlaps a menu-bar refresh. A check on an opened job skips the per-host pace.

## O13 (MUST) Interruptions lose nothing

A quit, crash, sleep or network loss in the middle of a crawl leaves every stored job, like, status and note intact, and the next start continues the refresh. With no network, the feed still shows the stored jobs with an offline note and the last refresh time.

Observe: On a mock run, record the job count and the contents of the Liked and Applied tabs. Force-quit the app in the middle of a refresh. Start it again with the network off. Pass when the count and tabs match, no card lacks a title, company or link, and the feed shows an offline note with the last refresh time. Turn the network on. Pass when the refresh completes with no duplicate cards and no job closed that was still on its board.

Adversarial angles: A half-written job appears with a blank company or a broken link. The store is damaged and the app starts empty with no warning. With no network, the feed shows an error page or zero jobs. The resumed crawl closes jobs that it never checked again.

## O14 (SHOULD) The feed stays quick with a full store

With at least 50,000 stored jobs, opening the feed, changing a filter or sort, or searching by title or company shows results within 1 second. The window stays responsive while a crawl runs.

Observe: After a full live crawl, or a mock run with at least 50,000 postings across mock boards, time 10 feed loads, 10 filter or sort changes and 10 searches with a screen recording or the documented jobs endpoint. Pass when at least 9 of each 10 finish under 1 second and none takes over 3 seconds. Scroll during a crawl and pass when no freeze exceeds 1 second. Confirm that a job added in the last refresh is found by search.

Adversarial angles: A crawl blocks the feed while it writes. Search lags behind the store, so new jobs cannot be found. Infinite scroll repeats or skips cards. The result count disagrees with the number of cards you can scroll to.

## O15 (SHOULD) Filters tell the truth about unknown values

Each filter returns only jobs that meet it, and jobs whose posting does not state the filtered fact are handled in a way the person can see and change. Such jobs are never silently dropped and never silently counted as a match.

Observe: Set a minimum pay of $120,000 a year and the remote work model. Check 30 results. Pass when each result shows pay at or above $120,000 a year (hourly pay converted and labelled) and a remote work model, or shows a clear "not listed" mark that agrees with the chosen setting for unknown values. Change that setting. Pass when the result count changes by the number of "not listed" jobs.

Adversarial angles: Unknown pay counts as $0, and those jobs vanish with no notice. Unknown pay counts as a match, so the filter looks correct but is not. A range of $90K to $130K passes or fails with no explanation. "Remote (Europe only)" passes a US remote filter.

---

## Plan items these outcomes cover

| Plan item | Outcomes |
|---|---|
| D1 job volume, all levels | O1, O8 |
| D2 full text, years, skills, pay | O3, O15 |
| D4 sponsorship hint | O4 |
| D5 fresh jobs, no ghost jobs | O5, O6, O10 |
| I1 job cards | O2, O3 |
| I2 filters and sort | O7, O10, O14, O15 |
| I4 tabs and like | O5 |
| I7 tracker statuses and notes | O5, O13 |
| Architecture: local-first, polite crawling, privacy (sections 2 and 6) | O11, O12, O13 |
| Dedupe and link guard (decision 8) | O9 |

Negative outcomes ("never"): O3 (never a guess shown as fact), O4 (never "does not sponsor" from a missing record), O6 (never close jobs on a failed fetch), O11 (never send personal data or contact the four named sites), O15 (never silently drop or match unknown values).
