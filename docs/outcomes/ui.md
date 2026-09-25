# Outcomes: Consumer UI (area "ui")

These outcomes say what a person must see and be able to do on the jobleft screens. They do not say how to build the screens.

Scope: the consumer screens for plan items I1 to I9 and P2, and the screens that show M1, M3, M5 and M6.
Sources read: `docs/PLAN.md` (sections 1 to 8), `jobright-research/GAPS.md`, `jobright-research/ui/UI-SPEC.md`, `jobright-research/ui/UI-SPEC-LOGGED-IN.md`.

## Words used in this file

| Word | Meaning |
|---|---|
| Job | One item in the app's list |
| Posting | The employer's own page or feed entry for a job |
| Screen text | The visible text of a screen, plus its tooltips, window title and spoken (accessible) labels |
| Reference capture | The screenshots and notes in `jobright-research/ui/` |

## Test setup for every "Observe" line

1. Start the app as the package README says.
2. Use the made-up persona "Jordan Testwell" (jordan.testwell@example.com). Never use a real person's data.
3. Load fixture postings and use a local mock of the publik API, as the README documents. No check needs the live publik service or live employer sites.
4. Crawled posting text from employers is exempt from the text searches below. The app's own text, images, help and demo data are not exempt.

## Outcomes

### O1 (MUST) Every job-hunt screen exists and is easy to reach

A person reaches each screen the job hunt needs from navigation that stays on screen: the job feed (Recommended, Liked, Applied, External), job detail, the application tracker, the dashboard, the resume workspace, the profile, the network tool, the copilot chat, interview practice and settings (AI provider, balance, alerts). Each screen is at most two clicks from any other, and no screen is a blank page, an endless loader or a "coming soon" stub.

Observe: Load the persona. Click every navigation item, tab and sub-tab, and take a screenshot of each. Each screenshot must show a titled screen with real content or a designed empty state. From three different start screens, count the clicks to every other screen.

Adversarial angles:
- A screen stays on a loader forever. The reference capture shows this failure on its agent screen.
- A screen opens only from a deep link, not from the navigation.
- A navigation item for an excluded feature (live coaching, community, member referrals) stays in as a stub.
- A close or back control on a sub-screen goes to the wrong screen.

### O2 (MUST) Never show another company's brand

No screen, window title, app icon, image, illustration, tour, tooltip, notification or error message shows the Jobright name, logo, mascot, product names or marketing sentences. Where the product names itself, it says "jobleft".

Observe: Search the screen text of every screen, every macOS notification the app sends, and the text strings inside the installed app for this list: "Jobright", "jobright.ai", "Orion", "Turbo", and ten verbatim sentences picked from the reference capture. Put the app icon and every illustration next to the reference screenshots and look for copies.

Adversarial angles:
- The name survives in a rare place: the About box, a notification title, image alt text, a help tooltip or a crash dialog.
- An empty-state illustration or a mascot is a traced copy of a reference image.
- A marketing sentence from the reference is reused word for word as button, tour or tooltip copy.
- The name appears in the product's own demo data or help pages.

### O3 (MUST) Job facts on screen are true, or absent

Every job card and job detail shows only facts that the posting supports: title, company, location, work model, job type, level, pay, years of experience and posted time. When the posting does not state a fact, the screen leaves it out or says "not listed". The screen never shows a guessed value, "$0", "NaN", "undefined", "null" or a value from another job.

Observe: Load fixture postings where some have pay and some do not, and some pay is hourly and some yearly. For 30 cards, compare each fact on screen with the posting (follow the "original posting" link) and with the stored job as the local interface in `docs/INTERFACES.md` returns it. Scroll fast through 500 cards, then check 10 cards again. Search all screen text for "undefined", "null", "NaN", "[object Object]" and "$0".

Adversarial angles:
- After fast scrolling, a card shows the pay, logo or score of the job that was in that place before.
- Hourly pay shows as yearly pay, or a pay range shows as one number.
- Posted time is wrong by the time-zone offset, or says a job was posted "in 3 hours".
- A text template prints a gap such as "Previously@undefined". The reference capture shows this bug.

### O4 (MUST) Never show signals the app cannot back up

The app never shows applicant counts, "early applicant" badges, comparisons with other applicants, or claims about where else a job is or is not listed. It never says that a company does not sponsor H-1B visas only because no record matched. Sponsorship shows only as a hedged "likely" statement that names its public data source.

Observe: Search the screen text of the feed, the job detail and the dashboard for "applicants", "early applicant", "top applicant", "not visible on", "No H-1B", "No H1B" and "does not sponsor". Open a job at a company that is not in the sponsor data, and take a screenshot of the sponsorship area. Open a job at a company that is in the data, and check that the hedge word and the source name show.

Adversarial angles:
- A negative tag comes from a missing match.
- A compact card drops the hedge word and shows only "H-1B Sponsor".
- A "0 applicants" placeholder fills the place where the reference shows a count.
- The sponsorship tooltip gives no source and no date.

### O5 (MUST) One stable match score that explains itself

Each scored job shows one whole-number percent, a band word that agrees with it (Strong at 85 and above, Good from 70 to 84, Fair below 70), three part-scores (experience level, skills, industry) and short reasons. The card and the detail show the same numbers. The numbers do not change on reload, reopen or restart unless the profile or the job changed.

Observe: For 20 jobs, write down the card score and part-scores, open the detail and compare. Restart the app and compare again. Check every band word against its percent. For 5 jobs, check that each reason points to a line in the posting or in the profile.

Adversarial angles:
- The card rounds and the detail cuts off decimals, so the two differ by one point.
- The score drifts between loads. The reference capture shows drift of up to 12 points on one part-score.
- A job with almost no description gets a confident high score, not a "not enough information" note.
- A reason names a skill that the profile does not have.

### O6 (MUST) Job detail is complete and puts the person back where they were

Opening a job shows its full description, its facts, the match breakdown, company facts where known, and a clear apply control that opens the employer's own posting. Closing the detail (with its close control or with Esc) returns the person to the same list, the same filters and the same scroll position.

Observe: Turn on two filters, scroll the feed to about the 40th card, open a job, then press Esc. Take screenshots before and after, and compare them. Click the apply control on 10 jobs. Check that each one opens a page whose address matches the posting's source.

Adversarial angles:
- Closing the detail resets the list to the top or clears the filters.
- The apply control opens a search page, or the wrong job when a posting has several locations.
- A closed posting still shows an active apply control with no warning.
- Company facts from a different company with a similar name appear on the job.

### O7 (MUST) Filters, search and sort do exactly what they say

Every job in the list meets every active filter and the search text. The result count agrees with the list. Active filters look different from inactive ones. "Most recent" orders jobs by posted time, "Top matched" orders them by match score, and "Recommended" keeps the same order on reload. A saved filter comes back exactly as saved after a restart. The screen tells the person how a filter treats jobs with an unknown value, for example a pay filter and a job with no stated pay.

Observe: Apply 5 combinations of location, level, job type, work model, date posted, minimum pay, sponsorship and company include or exclude. For each combination, page through all results, or export them through the interface in `docs/INTERFACES.md`, and check every job against the filters. Check that each sort order never goes the wrong way. Save two filters, quit, relaunch and compare every field.

Adversarial angles:
- Jobs with no stated pay silently pass, or silently disappear, under a pay filter.
- The count shows the old query while the list shows the new one.
- A saved filter loses one field, for example the excluded companies, after a restart.
- Fast typing in search shows the results of an older, shorter query last.

### O8 (MUST) Feed tabs and tracker stay in step

Liking a job adds it to Liked at once. Marking a job applied adds it to Applied. Moving a job through the statuses (Applied, Interviewing, Offer, Rejected, Archived) moves it between those views. Every count badge equals the number of jobs that its view lists. When the posting of a liked or tracked job closes, the job moves to a "closed" view and does not disappear. Pasting a job link in External adds that job with its facts, or says in plain words why it cannot.

Observe: Like 5 jobs, mark 3 applied and move one job through every status. After each step, compare each badge with the rows in its view. Remove one fixture posting from its board, run a refresh and find the job in the closed view. Paste 3 links in External: a good posting, a dead link and a page that is not a job. Take a screenshot of each result.

Adversarial angles:
- A badge counts hidden or closed jobs, so it disagrees with its list.
- A tracked job disappears with its notes when its posting closes.
- A page that is not a job becomes a "job" with invented facts.
- The same link pasted twice makes two tracker rows.

### O9 (MUST) Never lose the person's work silently

Likes, hides, tracker statuses, notes, reminders, resume edits, profile edits, saved filters and pasted jobs stay after a normal quit and after a force-quit 2 seconds after the action. If a save fails, the screen says so and keeps what the person typed. Closing a drawer or an editor with unsaved changes asks the person first.

Observe: Do each action, force-quit the app within 2 seconds, relaunch and check that each change is there. Make the app's data folder read-only, edit a note, and take a screenshot of the error and of the text that stays in the field. Type in the profile editor and press Esc.

Adversarial angles:
- The screen shows "saved" before the write finishes, and the write then fails.
- Two open screens hold the same record, and the older one overwrites the newer edit.
- An edit in progress is lost when the Mac sleeps or the app goes to the background.
- A reminder set in the tracker never fires after a relaunch.

### O10 (MUST) Every state is designed: first run, loading, empty and error

On the first launch, the feed shows crawl progress and fills with jobs as they arrive. It does not wait for the whole crawl to finish. Loading, empty and error states look different from each other. Every empty view tells the person what to do next. When something fails (no internet, an employer site is down, the AI provider does not answer), the screen says in plain words what failed and offers a retry, and the rest of the app keeps working.

Observe: Start with an empty data folder. Take a screenshot of the feed every 10 seconds for the first 2 minutes. Empty each tab and take a screenshot of each empty state. Turn off the network, stop the mock AI server, then start a refresh, a chat message and a resume tailor, and take a screenshot of each result. With the network off, browse stored jobs, the tracker and the resumes.

Adversarial angles:
- A loader spins with no end and no message.
- A raw stack trace, HTTP status code or block of JSON shows on screen.
- One failed panel blanks the whole screen.
- "No jobs match" shows while the first crawl still runs, so the person thinks the search found nothing.

### O11 (MUST) Fast enough to feel instant

On an Apple silicon Mac with 50,000 stored jobs, after the first run:

| Action | Limit |
|---|---|
| Launch to a usable feed | 3 seconds |
| Filter, sort or search change to an updated list | 0.5 seconds |
| Switch between main screens | 0.5 seconds |
| Scroll through 500 cards | No blank cards and no visible stutter |

A background crawl does not freeze any screen.

Observe: Load 50,000 fixture jobs. Record the screen at 60 frames a second. Measure launch to first cards, click to updated list for 10 filter changes, and 10 screen switches. Scroll through 500 cards and count the frames that show an empty card box. Do all the timings again while a crawl runs.

Adversarial angles:
- The first launch after a big crawl blocks the screen while the app prepares its data.
- Search runs on every key press, and the field lags behind the typing.
- Memory grows while the person scrolls, and the app slows after 30 minutes.
- Opening a job detail redraws the whole feed and loses the scroll position.

### O12 (MUST) Looks and behaves like one polished consumer product

All screens share one visual system: one type family, a small set of text sizes, and the same spacing, corner radii, colours and icons. Familiar patterns (side navigation, top tabs, cards, popovers, drawers, tooltips) look and act the same on every screen. Next to the reference capture, the screens show the same layout ideas and the same level of finish. At the smallest window size that the README states (no larger than 1280 x 720) and at full screen on a large display, nothing overlaps, no important text is cut off without a way to read it, and no screen scrolls sideways.

Observe: Take a screenshot of every screen at the smallest window size and at full screen. Put each one next to the matching reference screenshot. Ask two people who did not build the app to mark each screen pass or fail on this list: alignment, even spacing, one button style per action type, no cut-off text, no unstyled default controls. Check that the close control of every modal and drawer is visible at the smallest window size.

Adversarial angles:
- Some screens show plain unstyled controls next to themed ones.
- A long job title or company name is cut off and the person cannot read the rest.
- A modal is taller than the window, and its close control is off screen. The reference capture shows this bug.
- The same action, for example "Save", has three different button styles on three screens.

### O13 (SHOULD) Readable and usable with the keyboard and a screen reader

Text and controls meet WCAG 2.1 AA contrast. The person can reach and use every control with the keyboard, and the focus is always visible. Esc closes the top-most drawer, popover or detail and puts the focus back where the person was. Icon-only buttons (like, hide, close) have spoken names. Content that shows on mouse hover is also reachable with the keyboard. At 150% zoom, every screen stays usable.

Observe: Run an automated WCAG 2.1 AA checker on each screen. Use only the keyboard to go from the feed to a job, like it, open the detail, open the apply control and come back. Turn on VoiceOver and listen to the controls of 10 cards. Zoom to 150% and take a screenshot of every screen.

Adversarial angles:
- Brand-green or light-grey text on white fails the contrast check.
- The focus is trapped in a drawer, or jumps to the top of the page after a modal closes.
- The match reasons show only on mouse hover.
- A tour or a tip takes the focus while the person types.

### O14 (MUST) Money is a dollar balance, and nothing is spent or sent without a click

Wherever the app shows money, it shows US dollars and the word "balance", for example "Balance: $4.37". Outside posting text, it never says "credits", and it shows no plan upsell, struck-out price or countdown. Before an action that charges the balance, the screen says that the action charges and shows the expected cost. The app never spends balance, sends a message, submits an application or changes the person's preferences unless the person clicks a control that names that action. It never opens sales popups by itself, and the person can close any tip or tour for good.

Observe: Point the app at the local publik mock with a balance of $4.37 and a charge log. Take a screenshot of each place that shows the balance. Search all screen text, outside posting text, for "credit". Run one scripted session: onboarding, browse 20 jobs, open 10 details, tailor 1 resume, draft 1 network message, send 3 chat turns. Compare the mock's charge log with the clicks that confirmed a paid action. Count the popups that opened with no click. Select a local model and check that no balance prompt blocks an AI action.

Adversarial angles:
- "credits" survives in an error message that the app passes through from the server.
- An AI action starts when a detail opens, and it charges with no click.
- A chat suggestion button silently edits the saved preferences. The reference capture shows such a button.
- The balance shows an old figure after a charge, or a long decimal such as $4.3699999.

### O15 (MUST) Never send the person's data anywhere they did not choose

The screens send the person's profile, resumes, searches and tracker to nobody. Requests go only to employers' public job sources, to the AI or metered service the person chose (for an action the person started, or to read the balance), and to the documented update source for the app's shipped data. Only the text that the person sends to the chosen AI service carries personal data. Before an AI action sends text off the Mac for the first time, the screen names the service that gets it. With a local model, the screen says that nothing leaves the Mac. The screens load no analytics, trackers, crash reporters or remote fonts.

Observe: Run the app behind a logging proxy or a macOS network monitor. Walk through every screen as Jordan Testwell, first with a local model and then with the publik mock. List every host that the app contacts. Search every request address and body for the persona's name, email, resume phrases and search words. With the local model selected, check that the app makes zero requests to AI hosts.

Adversarial angles:
- Search words go out in the address of a logo or icon service.
- A bundled component sends analytics or crash reports.
- The provider label says "local" while a fallback quietly uses a remote service.
- Company logos or fonts load from a third-party site, which then learns which companies the person views.
