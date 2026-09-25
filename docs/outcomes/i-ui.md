# Acceptance outcomes: i-ui (Integration: real API in the UI, polish)

Scope: the finished desktop app, seen as a whole. Every screen uses real data from the product's own local API. The app looks and feels like a polished consumer job-search product.

Screens in scope (from PLAN sections 3 and 7): the jobs feed with its tabs (Recommended, Liked, Applied, External), job detail, onboarding and profile, the resume workspace, the tracker, the dashboard and alerts, the Network tool, the copilot chat, interview rehearsal, and the balance card and settings.

Rules for the checker:

- A "stranger" has only the package README, the HTTP endpoints in `docs/INTERFACES.md`, the files the product writes, and screenshots. The stranger does not read the source code.
- Use the fake persona "Jordan Testwell" (jordan.testwell@example.com) for every test. Never use real personal data.
- Use local stand-in servers for the publik API and for employer job boards where a check needs control of the data. Do not call publikhq.com.
- "The visible text of a screen" means text read from the app window: copied, read through the accessibility tree, or taken by text recognition from a screenshot.

---

### O1 (MUST): Every screen shows the user's real data, not demo content

On a fresh install, each screen shows either the user's own data or an honest empty state. No screen shows sample companies, filler text, hard-coded numbers or a broken value such as "undefined".

Observe: Start the app from the README with an empty data folder. Take a screenshot and the visible text of every screen in scope. Then import the Jordan Testwell resume, run a crawl, and do the same again. Search all visible text for "lorem", "sample", "example company", "TODO", "undefined", "null", "NaN" and "[object Object]". Change one profile field and one tracker note through the documented API. Reload, and confirm that the screens show both changes.

Adversarial angles:
1. A screen still reads a built-in demo file. It passes only because the demo data looks real.
2. A template prints a missing field as "undefined". The reference product shows "Previously@undefined" on a live screen.
3. A count, chart or dashboard tile is a fixed number that never changes when the data changes.
4. A screen works after onboarding but crashes or goes blank when the profile is empty.

### O2 (MUST): Job facts on the card and the detail page agree with the stored job and the employer's posting

For any job, the card, the detail page and the documented API show the same title, company, locations, work model, level, pay, years of experience, posted time and apply link. The apply link opens that job on the employer's own site.

Observe: Take 25 jobs at random from the documented jobs endpoint. For each job, compare the card, the detail page and the API record field by field. Open each apply link and confirm that it goes to that exact posting (use a local stand-in board to control the data). Include jobs paid by the hour, jobs with 3 or more locations, and jobs posted near midnight.

Adversarial angles:
1. Hourly pay shows as a yearly figure, or a range loses one end.
2. A time-zone error moves "posted 3 hours ago" to the wrong day. The card and the detail page disagree.
3. Multiple locations collapse to the first one and hide "Remote".
4. The apply link opens the board's front page, a different job with the same title, or a copy of the job inside the app.

### O3 (MUST): The app never invents a fact it does not have

When a fact is unknown, the app leaves it out or says plainly that it is unknown. It never shows a guess or a default as a fact. This applies to pay, years of experience, level, H-1B status, company size, funding, investors, leaders and news. The app never says that a company does not sponsor H-1B visas only because no record matched. Positive H-1B wording stays hedged ("likely"), and the app names the public source.

Observe: With the documented API, find jobs with no pay, no years, no H-1B match and no company facts. Take screenshots of their cards and detail pages. Confirm that no "$0", "0+ years", "No H1B", empty funding card or made-up company text appears. For a company with an H-1B match, confirm that the text says "likely" and names its source. Where company facts show, confirm that each one shows its source or states that the AI wrote it.

Adversarial angles:
1. Default values ("$0", "0+ years", "Unknown Stage", "1-10 employees") show as real facts.
2. A missed company-name match shows as "No H1B", which tells a visa holder not to apply.
3. AI-written company text (funding, leaders, news) shows with the same look as sourced data and gives no sign that the AI wrote it.
4. Facts for one company show on the page of a different company with a similar name (for example, "Delta" the airline and "Delta" the faucet maker).

### O4 (MUST): The match score is the same everywhere, does not change between loads, and shows its reasons

A job's match percent, its band and its three parts (experience level, skills, industry experience) are the same on the feed card, the card's "why" view, the detail page and the documented API. Reloading the page or restarting the app does not change them. They change only when the profile, the resume or the job changes. The band follows the number: STRONG at 85 and above, GOOD from 70 to 84, FAIR below 70. Every score shows the reasons for it.

Observe: For 20 jobs, record the score from each place, reload 3 times, restart the app once, and compare. Find jobs that score 69, 70, 84 and 85, and check the band labels. Sort by "Top Matched" and confirm the order goes down. Remove one skill from the profile. Confirm that the scores that depend on it change and that the reasons name that skill.

Adversarial angles:
1. The card shows an old stored score but the detail page computes a new one, so the two differ.
2. Rounding differs between places, so 84.6 shows as "85 GOOD" or as "85" on one screen and "84" on another.
3. The AI text in "why you fit" contradicts the number (a high score with "you lack most required skills").
4. The sort compares text, not numbers, so "9%" ranks above "85%".

### O5 (MUST): The app never loses the user's work silently

Likes, hidden jobs, tracker status changes, notes, reminders, profile edits, resume edits, saved filters and Network tool statuses stay saved after a reload, a quit, a force-quit and a relaunch. They also stay saved after a crawl refresh. If a save fails, the app says so and lets the user try again. It never shows a failed change as saved.

Observe: Do each action. When the app shows the action as done, force-quit the app process at once. Relaunch it. Confirm the state on screen and through the documented API. Run a crawl refresh (README command) and check again. Then make the data folder read-only, or stop the local server, and do one more edit. Confirm that the app shows a clear error and the edit is not shown as saved.

Adversarial angles:
1. The screen updates at once but the write never completes, so a force-quit loses it.
2. A re-crawl of a job resets its Liked flag, its tracker status or its notes.
3. Two postings merge as duplicates, and the notes or status of one of them disappear.
4. Closing a panel with Esc or the close button throws away a half-typed note with no warning.

### O6 (MUST): Counts match what the user can see

Every count equals the number of items the user can reach. This includes the tab counts (Liked, Applied, External), the tracker status counts, the search result count, dashboard numbers and alert or notification counts. The count updates when items are added, removed, closed or moved.

Observe: For each count, scroll the list to its end and count the rows. Compare both numbers with the documented API. Like 3 jobs, hide 1, move 1 through the tracker statuses and add 1 external job. Check each count after each step. When a system notification says "N new jobs", open the feed and confirm that N new jobs are there.

Adversarial angles:
1. Counts include hidden, closed or duplicate jobs that the list does not show.
2. A count comes from an old cached value and does not change after a crawl.
3. The list stops loading early (for example, at 50 items), so the count is higher than what the user can reach.
4. A notification counts reposts or duplicates as new jobs.

### O7 (MUST): Filters, sort and search return exactly what they say

Every job in the list matches all active filters and the search text. No matching job is left out. "Most Recent" is ordered by posted time. A saved filter restores the same criteria after a restart. Clearing all filters returns the full set. Hidden jobs stay hidden. When a filter depends on a fact that some jobs lack (for example, minimum pay), the app tells the user how it treats those jobs.

Observe: Apply 5 combinations of filters (for example: Remote, Entry Level, Past week, H-1B likely, and a minimum salary). For each combination, compare the list with a query that uses the same criteria on the documented API. Check 30 visible cards for rule breaks. Save a filter, restart the app and reopen the filter. Search by company name only and by title only.

Adversarial angles:
1. A job with several levels or locations is left out when only one of them matches.
2. "Past 24 hours" uses the wrong time zone and gains or loses jobs at the boundary.
3. Jobs with no stated pay disappear under a salary filter and the app does not say so.
4. A search for a company name finds nothing because search looks only at titles.

### O8 (MUST): A closed job never shows as open, and its history stays

When a posting disappears from its employer's board, the app marks it closed on every screen where the user sees it. It leaves the open feed, moves to the closed part of the Liked tab, and keeps its tracker status, notes and reminders. Its apply button is off or clearly labelled. A board that fails to load does not close its jobs.

Observe: With a local stand-in board, like a job and mark it Applied with a note. Remove the job from the board and run a refresh (README command). Check the feed, Liked, Applied and the detail page. Then make the whole stand-in board return an error and refresh again. Confirm that its other jobs stay open.

Adversarial angles:
1. A network error empties a board, and hundreds of jobs show as closed at once.
2. A reposted job shows as new, and the old record loses its notes and status.
3. The closed job still appears in Recommended, or its apply button still looks active.
4. The closed label shows on the card but not on the detail page, or the other way round.

### O9 (MUST): Loading, empty and error states are honest, and the first run shows progress

Every screen has a clear loading state, a helpful empty state and a plain-language error state. On the first run, the feed shows jobs as they arrive while the crawl continues, and it shows progress until the crawl ends. No loading indicator stays for more than 30 seconds without a result, a change in progress or an error. When the network or the AI provider is not available, the app says so and the rest of the app still works.

Observe: Start with an empty data folder and finish onboarding. Take a screenshot of the feed every 30 seconds during the first crawl. Confirm that the job count grows without a manual reload and that a progress sign is visible. Open each empty tab and take a screenshot. Disconnect the network, or stop the stand-in AI server, and start an AI action. Record what the screen shows and how long it takes. Put one malformed job record in a stand-in board and confirm that the app does not crash.

Adversarial angles:
1. A spinner turns forever. The reference product's Agent screen stayed on its loader for more than 60 seconds with no text.
2. An error is shown as "0 results", so the user thinks no jobs exist.
3. An error message disappears before the user can read it, or it shows raw technical text only.
4. One bad record makes the whole feed go blank.

### O10 (MUST): Money shows as a dollar balance that matches the wallet, never as "credits"

The app shows publik money as a "balance" in dollars and cents. The balance agrees with the wallet. The user can see what each paid action cost. When the balance is too low, the app refuses the action and tells the user why. With a local model or the user's own key, no publik charge shows. The word "credits" never appears anywhere in the app.

Observe: Point the app at a local stand-in publik server with a known balance, as the README describes. Take a screenshot of the balance. Run 3 paid AI actions. Compare the new balance and the costs shown with the stand-in server's ledger (they must agree to within $0.01). Set the balance to $0 and try a paid action. Switch to a local model and repeat the actions. Search the visible text of every screen, message and tooltip for "credit".

Adversarial angles:
1. The balance shows an old cached value after a spend.
2. Rounding shows "$-0.00", drops the cents, or shows a cost that differs from the ledger.
3. An error message from an upstream service passes the word "credits" through to the screen.
4. A failed AI call still shows a charge, or a charge happens with no sign on screen.

### O11 (MUST): The app never sends the user's data anywhere the user did not choose

Profile, resume, tracker, notes, contacts and crawled jobs stay on the laptop. The only exception is an AI request to the provider that the user picked. The app loads no remote fonts, analytics, crash reports, tracking pixels or third-party logo services. Other programs or web pages on the same computer cannot read the user's data from the app.

Observe: Choose a local model. Record all outbound connections of the app's processes with an operating-system network monitor while you use every screen for 20 minutes. The list of hosts must contain only employer job-board and employer-site hosts. Repeat with the stand-in publik API selected. The only new host must be that stand-in. Search the recorded traffic for the persona's name, email, phone and resume text. They must appear only in requests to the chosen AI provider. From a plain web page on another origin in a normal browser, try to read the documented profile endpoint. The request must fail.

Adversarial angles:
1. The design system pulls fonts or icons from a public CDN, and that tells a third party when the app is in use.
2. A logo service gets the list of companies that the user looks at.
3. A crash reporter or usage counter is on by default.
4. With a local model selected, a failed call falls back to a cloud provider without asking.

### O12 (MUST): The app never shows another brand's identity, excluded features or fake persuasion

The product is called jobleft everywhere. The app never shows the Jobright name, logo, mascot, copy, images or trademarks. It never shows features that the plan excludes: applicant counts, "Early applicant", "Top Applicants", member referrals, community content or coaching sales. It never shows made-up testimonials, countdown timers or "limited time" pressure.

Observe: Collect the visible text of every screen, dialog, tooltip, notification and error. Search it for "Jobright", "Orion", "Turbo", "applicants", "Early applicant", "coach" and verbatim reference copy (for example, "Why This Job Is A Match" and "Get Hired Faster"). Check the app name in the window title, the menu bar, the Dock and the About box. Put screenshots next to the reference screenshots and check for copied icons, illustrations or logos.

Adversarial angles:
1. Reference copy survives in a tooltip, an empty state or an onboarding step.
2. An icon or illustration is traced from the reference product.
3. A data field for applicant counts still renders, for example as "0 applicants".
4. A default sample in a chat or tour uses the reference product's assistant name.

### O13 (MUST): The app never acts for the user without a clear, deliberate click

The app never submits a job application, sends a message or email, connects to an outside account, or spends the user's balance unless the user clicks a control that says what will happen. Background work (crawling, scoring, company lookups) never spends money unless the user has turned on paid lookups and can see the cost.

Observe: Record the stand-in publik ledger and the stand-in board server's log. Use every screen for 30 minutes and open many job details, but click no paid or send action. Confirm that the ledger shows no charge and the board server received no application submission. Then click one paid action and confirm that exactly one charge appears, with the amount the app showed. In the Network tool, confirm that an outreach draft can only be copied and is never sent by the app.

Adversarial angles:
1. Opening a job detail starts a paid company-facts lookup in the background.
2. A "Try it now" step in a tour or checklist runs a paid action in one click.
3. A retry after an error sends a paid request twice and charges twice.
4. An assisted-apply flow submits the form without a final review step.

### O14 (SHOULD): Every screen looks finished and stays usable at every window size

All screens use one visual system: the same type scale, colours, spacing, buttons and icons. Nothing clips, overlaps or scrolls sideways from the smallest window that the app allows up to a full large screen. Long or unusual text does not break a layout. Every dialog can be closed and every action can be reached with the keyboard. Esc closes the top panel. Body text is easy to read against its background.

Observe: Take screenshots of every screen at the smallest window size, at 1440 x 900 and at full screen. Add a job with a 120-character title, a 60-character company name, 12 locations, and a Chinese, Japanese or Hebrew contact name. Check the card, the detail page and the Network tool. Go through each screen with the keyboard only. Run an automated accessibility checker on the screens. Check body-text contrast against the common 4.5 to 1 guideline.

Adversarial angles:
1. A dialog is taller than the window and its close button is off screen. This happens in the reference product.
2. A long title pushes the match score or the apply button out of the card.
3. Non-Latin names show as broken characters.
4. The keyboard focus is invisible or gets trapped inside a drawer.

### O15 (SHOULD): The app stays fast with a full job store

With 100,000 stored jobs, the feed, filter changes, search and job detail all feel instant. In 19 of 20 tries, the first results show within 1 second of the action. Scrolling through 500 cards never freezes the window for more than half a second. A crawl that runs in the background does not slow the screens the user is on.

Observe: Load a store of 100,000 jobs in the way that the README documents. Make a screen recording or read the timing from the app's documented diagnostics. Time 20 filter changes, 20 searches and 20 detail openings, and give the median and the slowest. Scroll 500 cards and look for freezes in the recording. Repeat the timing while a crawl refresh runs.

Adversarial angles:
1. The first screen waits until all match scores are computed.
2. The screen loads every job at once and memory grows until the app stalls.
3. A filter change runs a new crawl or a new AI call.
4. Timings pass with 1,000 jobs but fail at 100,000.
