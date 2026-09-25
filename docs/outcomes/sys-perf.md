# Acceptance outcomes: sys-perf (Performance and resources)

Area: how fast jobleft answers, how much memory, CPU, disk and battery it uses, and how it behaves when a crawl runs or resources run out.
Author role: acceptance-outcome author. These outcomes say what a user or a stranger must see. They do not say how to build it.

## How to measure

| Term | Meaning |
|---|---|
| Reference machine | An Apple silicon Mac with 16 GB of memory, on mains power, with no other heavy work running. Record the model and macOS version with every result |
| Large store | 100,000 jobs in the app, loaded by a real crawl or by the documented fixture or seed command in the package README |
| Very large store | 500,000 jobs, loaded the same way |
| p95 | Run the action 100 times with varied input. 95 of the 100 runs must meet the limit |
| All jobleft processes | The app window process and every helper process it starts (web view, local server, workers). Never measure only the main process |
| Mock boards | Local test servers that act like public job boards. A stranger uses them for crawl tests, so no real employer host gets load |

Numbers come from the plan: spike S2 (search at most 55 ms at 100K rows and 93 ms at 500K rows), spike S3 (first page in about 1 s, idle memory about 550 MB), and audit 05 (about 8 KB of disk per real posting with a text index, 0.3 to 0.8 GB for 25K to 60K postings, a 15 to 17 minute refresh for 2,000 companies). Synthetic data proves speed only. Disk limits assume real-sized postings.

---

### O1 (MUST) Search is fast on a large store

With a large store, a keyword search with common filters (location, work model, level, date posted) shows its first page of results in under 200 ms at p95. The median is under 100 ms.

Observe: Load the large store. Send 100 varied searches to the search endpoint in docs/INTERFACES.md and time each answer. Then type 20 searches in the app's search box while you make a screen recording, and count the frames from the last key press to the first changed result.

Adversarial angles:
- A very common term ("engineer", "manager") that matches a large part of the store, with the "Recommended" or "Top Matched" sort.
- The first search after launch (cold) against the tenth search (warm).
- Input with quotes, hyphens, `C++`, `C#` or a lone `*` that makes the search slow or makes it fail.
- A search with zero results that scans the whole store before it answers.

### O2 (SHOULD) Search stays fast on a very large store

With a very large store, the same searches as O1 still answer in under 200 ms at p95. The app does not turn off a feature (filters, sort, semantic ranking) to stay fast unless it tells the user.

Observe: Load the very large store. Repeat the O1 run through the search endpoint and the search box. Compare the result sets with the large-store run for the same filters and sorts.

Adversarial angles:
- Time grows in line with the job count, so 500K takes five times as long as 100K.
- The app quietly limits "Recommended" to a sample of jobs and misses the best matches.
- Memory use jumps past the O5 limit because all 500K rows load at once.

### O3 (MUST) Everyday actions feel instant

With a large store, each of these actions shows its result within 300 ms at p95: open a job's detail view, switch between the Recommended, Liked, Applied and External tabs, apply or clear a filter, change a tracker status, and like or hide a job. The control the user clicked shows a visible response within 100 ms.

Observe: Make a screen recording at 60 frames a second while you do each action 20 times. Count the frames from the click to the complete result. Where docs/INTERFACES.md lists an endpoint for the action, also time 100 calls to it.

Adversarial angles:
- The detail view opens fast but the match breakdown, company panel or H-1B tag fills in several seconds later.
- A tab with 2,000 applied jobs is much slower than an empty tab.
- A tracker change waits for a network call before the card moves.
- Filter counts on the filter chips update seconds after the list.

### O4 (MUST) The app opens in a few seconds, with or without a network

From a click on the app icon, the window shows real job cards from the local store, ready to scroll, within 3 seconds when the app launched before in this login session, and within 6 seconds after a restart of the Mac. The app does not wait for the network or for the catch-up crawl before it shows the list.

Observe: Make a screen recording from the click to the first real job card, 10 times for each case. Do it with the large store, then with Wi-Fi off, then with the mock boards set to answer only after 60 seconds. The times must be about the same in all three cases.

Adversarial angles:
- A splash screen or grey placeholder cards appear fast, but real jobs take 20 seconds.
- The first launch after an update runs a long data upgrade with no progress shown.
- The catch-up crawl on launch blocks the first screen, or makes the first screen empty until it finishes.
- Launch time grows in line with the store size.

### O5 (MUST) Memory stays reasonable and does not creep

With a large store, after 10 minutes of idle time with the window open, all jobleft processes together use less than 1 GB of memory. Over 8 hours with the app idle and background refreshes running, that total grows by less than 10%.

Observe: Use Activity Monitor or `ps` to add the memory of all jobleft processes. Sample it every minute for 8 hours. Let at least 4 background refreshes run against the mock boards in that time. Record the value after 10 minutes and the value at the end.

Adversarial angles:
- Only the main process is measured, and the web view or local server holds most of the memory.
- Memory rises during each refresh and never falls back, so it grows each hour.
- A local AI model or all job embeddings stay loaded after the feature that needed them is closed.
- The memory limit holds at 25K jobs but not at 100K jobs.

### O6 (MUST) A running crawl never freezes the app

While a full refresh of about 2,000 companies runs, the user can search, scroll, open jobs and change tracker status. Search still answers in under 300 ms at p95, clicks still show a response within 100 ms, and macOS never marks the app as "Not Responding".

Observe: Start the documented "refresh now" action or README crawl command against 2,000 mock boards. During the refresh, repeat the O1 search run through the endpoint and make a screen recording of 5 minutes of normal use. Watch Activity Monitor for the "Not Responding" label and for the spinning wait cursor in the recording.

Adversarial angles:
- The store blocks all reads while it writes a big batch of new jobs.
- Scoring or embedding the new jobs uses every CPU core, so the window stutters.
- One mock board sends a 50 MB answer, or sends data very slowly and never ends.
- One board fails and its retries flood the log or the CPU.

### O7 (SHOULD) Background work is light and lets the Mac sleep

With the window hidden and no refresh running, all jobleft processes together average less than 2% of one CPU core over 10 minutes. The app never stops the Mac from sleeping when no refresh runs, and a refresh never keeps the display awake.

Observe: Sample CPU for all jobleft processes with `top` or Activity Monitor for 10 minutes. Run `pmset -g assertions` before, during and 5 minutes after a refresh, and list the sleep assertions that jobleft processes hold.

Adversarial angles:
- A timer wakes the app every second to check if a refresh is due.
- A sleep assertion from a refresh is never released after the refresh ends.
- A failing board makes the app retry in a tight loop all night.

### O8 (MUST) Disk use is visible and predictable

The app shows how much disk its data uses, split at least into jobs and the user's own files, and the figure matches the size macOS reports for the data folder within 10%. Disk use grows about in line with the number of jobs, and a large store of real-sized postings uses less than 1.2 GB in total (jobs, search index, embeddings and caches).

Observe: Read the disk figure in the app. Compare it with `du` on the data folder that the README names. Measure again at 25K, 50K and 100K jobs, and check that the size per job stays within 25% between the three points.

Adversarial angles:
- Temporary or journal files next to the store are not counted, so the app shows half the real size.
- Raw board answers are cached and kept for ever.
- Each job keeps two or more copies of its embedding or its full text.
- Log and crash files sit outside the data folder and are not shown.

### O9 (MUST) Disk use never grows without limit

When the set of boards stays the same, repeated refreshes never make disk use climb for ever: closed jobs stay only for a period the app states, and logs and caches have a fixed upper size. After 30 refresh cycles with normal churn, the data folder is no larger than the O8 size per job times the number of jobs the app says it keeps, plus at most 100 MB.

Observe: Run 30 refresh cycles against mock boards that add and remove about 4% of jobs each cycle. After each cycle, record the data folder size with `du` and the kept job count the app shows. Plot size against cycle number.

Adversarial angles:
- Each refresh stores a new copy of jobs that did not change.
- Deleted rows free no space, so the file never shrinks.
- The log writes one line for each request and has no size cap.
- Closed jobs are never removed, so the store fills with vanished postings.

### O10 (MUST) The app never loses or damages user data when resources run out

If the disk fills, the app is force-quit, or the Mac loses power during a crawl, the user's tracker, notes, likes, resumes and profile are intact at the next launch, and each job is saved in full or not at all. When space runs out, the app stops crawling and says so in plain words, and it never reports a refresh as complete when saves failed.

Observe: Export the tracker, or read it through the endpoint in docs/INTERFACES.md, before and after each test. Force-quit all jobleft processes during a crawl 10 times, then compare. If the README documents a way to set the data location, put it on a small disk image (about 300 MB) and let a crawl fill it. Check the message in the app and look for jobs with blank titles or cut-off text.

Adversarial angles:
- A half-written store makes the app start empty, as if it were a new install, with no warning.
- The app shows "Refresh complete" and a new job count when writes failed.
- A force-quit during a data upgrade after an update leaves the store unreadable.
- Low disk space makes the app delete user files to make room.

### O11 (MUST) Speed never costs correct results

After the user changes the search text, a filter or the sort, the list shows only results for the new state, and a slow answer for an earlier state never replaces a newer one. The job count the app shows equals the number of jobs the user reaches by scrolling to the end of the list.

Observe: Type "data analyst", then change it fast to "data engineer", 20 times, with a screen recording. Check that every card shown at the end matches the final text and filters. Compare the shown count with the total from the search endpoint, then scroll to the end and count the cards.

Adversarial angles:
- Answers arrive out of order when the user types fast.
- Endless scroll adds page 2 of the old search under page 1 of the new search.
- Filter counts come from before the last refresh and do not match the list.
- The count is a fast estimate while the list is exact, and nothing says so.

### O12 (MUST) Work in progress is shown honestly, never filled with invented values

During the first crawl, the app shows jobs as they arrive and states its progress in real numbers (companies done of the total, jobs found so far) that match the search endpoint at the same moment. A job with no match score yet shows a clear "not scored yet" state, never a placeholder score, and is never sorted as if scored; a loading placeholder never looks like a real job.

Observe: Start a fresh install against mock boards. Take a screenshot every 30 seconds for the whole first crawl. Compare the progress numbers with the search endpoint total at the same time. Look for any job with a score before scoring of that job finished, and for any total that is larger than the store.

Adversarial angles:
- The progress bar reaches 100% while thousands of jobs still wait for scoring.
- Unscored jobs show 0%, 50% or the score of a different job.
- The "Recommended" sort hides unscored jobs without saying so, or puts them at the top.
- A large marketing-style total ("thousands of new jobs today") appears that the store does not hold.

### O13 (SHOULD) New jobs become findable and scored quickly

A job that a refresh saves appears in keyword search within 10 seconds. On the reference machine, with no graphics card used, the app scores at least 100 new jobs a second, so a first batch of 5,000 jobs is fully scored in under 1 minute after it is saved.

Observe: Run the README crawl command against a mock board with 5,000 new jobs that each hold one unique word. Poll the search endpoint once a second. Record when the first and last unique words are found, and when the app shows the last job as scored.

Adversarial angles:
- Scoring starts only after the whole crawl ends, so the first jobs wait 15 minutes.
- Scoring stops while the user is busy in the app and never catches up.
- Scoring uses a remote service by default, so it stops with no network.

### O14 (MUST) Performance and diagnostic data never leave the laptop

Timing data, crash reports, diagnostic files, search text, and the embeddings of jobs and of the resume never leave the laptop, except for a feature where the user chose a remote AI provider. Any log or diagnostic file the app writes stays on the laptop and holds no resume text, profile fields or contact details.

Observe: Set the AI provider to a local model. Use the app for 30 minutes (search, scroll, crawl, open jobs, edit the tracker) while `nettop` or another network monitor records every outbound host. The only hosts must be the mock boards and the static-data release host that the README names. Then search every file in the data and log folders for the test persona "Jordan Testwell" and "jordan.testwell@example.com".

Adversarial angles:
- A crash or analytics kit in the shell sends reports on its own.
- The search text is sent to a hosted service to build a query embedding.
- Logs copy the full resume, search text or contact rows.
- A "send report" feature uploads with no user click.

### O15 (SHOULD) Long scrolling stays smooth and uses bounded memory

With a large store, the user can scroll through 3,000 results in the job list with smooth motion and no stall longer than about 100 ms. Memory for all jobleft processes rises by less than 150 MB between the top of the list and result 3,000, and it falls back when the user returns to the top or changes tabs.

Observe: Make a screen recording at 60 frames a second while you scroll to result 3,000 and back. Count frames where the picture does not move while the scroll input continues. Sample memory before, at the end and after the return.

Adversarial angles:
- Every card the user passed stays in memory.
- Each card loads a full-size company logo or renders the full job text.
- A stall occurs at each page load of the endless list.
