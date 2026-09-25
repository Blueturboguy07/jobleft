# Outcomes: sys-parity (visual and behavioural parity)

Date: 2026-09-25.
Area: how every in-scope screen looks and behaves, compared with the reference set.
Inputs read: `docs/PLAN.md` sections 1 to 8, `GAPS.md`, `ui/UI-SPEC.md`, `ui/UI-SPEC-LOGGED-IN.md`.
These outcomes say what a stranger must be able to see. They do not say how to build it.

## Terms

| Term | Meaning |
|---|---|
| Reference set | The capture of the reference product: `UI-SPEC-LOGGED-IN.md` with its 84 screenshots (L00 to L12), and `UI-SPEC.md` sections 07b, 08, 08b and 09 (app shell, job list, job detail). Folder: `~/jobright-research/ui/`. |
| In-scope screen | A reference screen that the plan keeps (PLAN sections 3 and 8). See the list below. |
| Excluded element | A reference screen or element that PLAN section 8 drops. See the list below. |
| Persona | The made-up test user "Jordan Testwell" (jordan.testwell@example.com): Software Engineer, United States, full-time, open to remote. The reference capture used the same persona. |
| Parity map | A table in the product repo. Each row pairs one reference screenshot with one jobleft screenshot, or gives the PLAN section 8 reason for an exclusion. |

In-scope screens and states:

1. Jobs feed (Recommended): filter row, each filter popover, sort menu and its help, the full filter drawer (four groups), saved filters, right column.
2. Liked tab, with Active and Closed.
3. Applied tab, with the five status sub-tabs and a search.
4. External tab: paste a job link and add it.
5. Job detail inside the app: header, match panel, fit chips, Responsibilities, Qualification, Benefits, Company, H-1B, Funding, Leadership, News, tools rail, and the Network panel (it replaces the reference's insider panel).
6. Resume list, row menu, add-resume dialog.
7. Resume editor, report strip, section-layout popover, analysis report drawer.
8. Profile: five sections, edit drawers, work-authorization questions.
9. Copilot chat panel.
10. Settings: alerts, AI provider, balance, local data.
11. Interview practice: rehearsal and a personal question bank (partial by design, PLAN M6).
12. Dashboard, and in-app messages or notifications.
13. Loading, empty, error and end-of-list states for each list above.

Excluded elements (they must be absent, see O10 and O11): public marketing pages, sign-in and sign-up dialogs, mobile web, coaching pages and pop-ups, the coaching checklist card, subscription upgrade sheets, interview pass sheets, the locked "hidden jobs" filter, applicant counts and "early applicant" chips, member-referral cards and locked or blurred person cards, the email finder, and the curated interview question bank.

## Outcomes

### O1 (MUST) Every in-scope screen has a real counterpart

A stranger can open every in-scope screen and state in the running app by clicks from the main navigation. The parity map pairs every reference screenshot with a screenshot of the running jobleft app, or with an exclusion reason from PLAN section 8.

Observe: Follow the README to launch the app with the persona and to capture the screenshots. Open the parity map. Count the rows that have neither a jobleft screenshot nor an exclusion reason: the count must be 0. For 10 random rows, reach the screen by clicks only and compare it with its screenshot.

Adversarial angles:
- The screenshots come from a mock page or a design file, not from the running app.
- The map leaves out hard screens (the filter drawer, the resume editor, the report drawer), or it marks an in-scope screen as excluded.
- A screen exists, but it opens only from a typed address or a debug menu.

### O2 (MUST) Job cards show the same facts in the same order

Each job card shows, in the reference reading order: posted time, logo, title, company with industry and stage, a facts grid (location, work model, job type, level, pay, years), and a match tile with the percent, the band and up to three highlight lines. The footer holds like, hide, ask-the-copilot and apply, and a hover shows the three part scores in place of the facts.

Observe: Put 5 jobleft cards beside reference screenshots L01a to L01c. Check the zone order, the facts grid and the footer controls. Hover over 5 cards: the part scores appear, and they go away when the pointer leaves. Open the original post for 10 cards: a pay or years field is on the card only when the post states it.

Adversarial angles:
- A long title or company name pushes the match tile off the card, or wraps into the facts grid.
- A missing logo shows a broken-image icon instead of a neutral tile.
- Pay shows in mixed formats ("$120000" on one card, "$120K/yr" on another), or an hourly rate shows as a yearly one.
- The hover face stays after the pointer leaves, or it flickers while the list scrolls.

### O3 (MUST) One job has one score, on every view, every time

The card tile, the card hover face and the job detail panel show the same overall percent, band and three part scores (experience level, skills, industry) for a job. The numbers do not change between reloads or restarts while the profile and the job stay the same, and the band always follows the fixed cut-offs (85 and up, 70 to 84, below 70).

Observe: For 20 jobs, write down the numbers from the tile, the hover face, the detail panel, and the job's match data from the local endpoint in `docs/INTERFACES.md`. All four must agree. Quit and relaunch the app 3 times and repeat: no number may change. Check each band label against its percent. Hover the tile: a tooltip names the parts of the score in plain words. Change one skill in the profile: the scores that it affects change on all three views.

Adversarial angles:
- The card rounds 84.6 up to 85 (top band), and the detail panel cuts it to 84 (middle band).
- The score uses time, load order or a random input, so it moves between loads (the reference moves by up to 12 points).
- The detail view keeps an old score after a profile edit, while the card shows the new one.
- The band colour uses different cut-offs from the band label.

### O4 (MUST) Filters, sort and saved filters change the list truthfully

Every filter control, the filter drawer and the three sort orders change the list as their labels say, and an active filter looks different from an inactive one. A saved filter keeps its name and values after a restart, and the filter row and the drawer always show the same values.

Observe: Set work model to Remote and date posted to Past 24 hours. Scroll to the end of the list: every card must say Remote and must be less than 24 hours old by its original post. The result count must equal the number of cards. Sort by Most Recent: posted times never go up as you move down the list. Sort by Top Matched: percents never go up. Reset each filter: the list returns to its earlier count. Save a filter, rename it, quit and relaunch: it is still there with the same values. Open the drawer: it shows the same values as the row.

Adversarial angles:
- A filter looks active, but the list ignores it, or it filters on a different field (crawl time instead of posted time).
- A hidden row cap stops the list early while the count says more (the old tool stopped at 400 rows).
- The drawer and the row disagree after an edit in one of them.
- Confirm with no change reloads the list and loses the scroll position.

### O5 (MUST) The job detail opens in place and returns you to the same spot

A card click opens the job detail inside the app with the navigation still visible, and Esc or the close button returns to the same list, filters and scroll position. The detail shows the reference sections in the reference order, keeps its action bar visible during a scroll, and links to the employer's own posting and apply page.

Observe: Scroll to card 30, open it, then press Esc: card 30 is still on screen and the filters did not change. Do it again with the close button. Compare the section order with L03a to L03g. Scroll the detail: the action bar stays, and the Overview and Company tabs follow the scroll position. Click the original-post link and the apply button: the employer's page opens in the default browser. Like or hide the job on the detail: the card shows the same state.

Adversarial angles:
- Esc sends the list back to the top, or runs the search again in a new order.
- The detail opens in a new window, so Esc and the close button do not return to the list.
- The original-post link goes to an aggregator, a search page or a dead page.
- Like on the detail and like on the card are two different states.

### O6 (MUST) Resume and profile screens work like the reference

The resume list shows each resume with its grade, primary marker, analysis state, target title and dates, and the editor, the report strip and the report drawer agree on the grade and the issue counts. The profile shows five sections with edit panels, including the work-authorization and sponsorship questions, and a saved change shows at once and stays after a restart.

Observe: Add two resumes (one PDF, one Word) for the persona. Compare the list with L04a to L04c and the add dialog with L04l. Open a resume: the urgent, critical and optional counts on the strip equal the sum of the issue chips under the sections, and the drawer shows the same numbers. Try to delete the only resume: the app refuses or asks, and it says why. Edit the city in the profile and save: the new city shows at once and is still there after a restart.

Adversarial angles:
- The strip, the section chips and the drawer count issues in different ways.
- An upload that is too large or of the wrong type fails with no message.
- Closing an edit panel with unsaved changes loses them with no warning.
- The row menu offers an action (export, use as primary) that does nothing.

### O7 (MUST) The copilot panel is one click away and sends nothing on its own

A round button on every app screen opens the copilot chat panel beside the page, and the page stays usable. "Ask" on a job card opens the same panel with that job named as the context, and no message leaves the laptop until the user sends one.

Observe: Open the panel from 5 different screens: it opens in the same place, and you can still scroll and click the page behind it. Click "Ask" on a card: the panel names that job. With a network monitor running, open and close the panel and read its greeting and suggestions: no request goes to any AI provider. Accept a suggestion (for example, "add this location"): the preference changes only after your click, and the filter row shows the change.

Adversarial angles:
- The panel covers the apply button or the filters, and you cannot move or close it.
- The panel sends the profile to a provider to write its greeting.
- A suggestion changes the saved filter with no click.
- "Ask" opens the panel with the previous job still as the context.

### O8 (MUST) Tabs and the tracker keep every change

Like, hide, apply, status changes and external jobs update the tab counts at once, and they survive a restart. A liked or applied job whose posting closes stays visible in its closed state and never disappears without a trace.

Observe: Like 3 jobs. Mark 2 as applied. Move 1 to Interviewing and 1 to Rejected. Add 1 job by pasting its link in the External tab. Check the counts on the tabs and the sub-tabs. Quit and relaunch: the counts and the rows are the same. Let a crawl close one liked posting (use a board where a posting was removed): the job moves to Liked, Closed. Empty tabs show a short message and a way back to Recommended (compare with L02a to L02c).

Adversarial angles:
- A count updates only after a restart or a tab switch.
- A crawl that closes a posting also deletes the user's like, notes or status.
- The same external link added twice makes two rows.
- Hide removes a job, and there is no way to see or undo hidden jobs.

### O9 (MUST) Every control does something, and every wait shows a state

Every visible button, chip, menu item and link does its job, opens a surface, or looks disabled and says why in a tooltip. Every list and panel has a loading state, an empty state, an error state and an end-of-list state, and no error clears what the user typed.

Observe: On each in-scope screen, click every control once. Record each control that shows no change within 1 second: the list must be empty. Disconnect the network. Then run a search, a job-link import and a copilot message: each shows a plain error and keeps the typed text. Scroll the feed to its end: a clear end-of-list state shows, not an endless loader.

Adversarial angles:
- Buttons copied from the reference layout (share, report issue, feedback) have no action.
- A long AI action shows nothing until it ends, so the user clicks again and runs it twice.
- A failed crawl shows the "no jobs yet" empty state and hides the failure.
- A button that looks disabled still runs its action.

### O10 (MUST) Never show a fact the app does not have

The app never shows a pay range, years of experience, posted time, company stage, funding, investor, leader, news item or visa claim that is not in the posting or in a named data source, and it never shows crowd signals that it cannot know (applicant counts, "early applicant", "top applicants"). A visa label says only "sponsor likely" and names its source, and a company with no match in the sponsor data never gets a negative visa label.

Observe: For 20 cards and their details, compare every shown fact with the employer's original post and the named source. Each fact must be there, or its slot must be empty or say "not listed". Search all screenshots for "applicants" and "early applicant": 0 hits. Find a company that is not in the sponsor data: it shows no visa label. For 5 reposted or old jobs, compare the posted time with the date on the employer page.

Adversarial angles:
- The pay parser reads a bonus, a stipend or a benefit figure as the salary, or reads an hourly rate as yearly.
- "3 hours ago" comes from the crawl time, not from the posting date.
- Sample data from the reference capture (leaders, funding, news, photos) leaks into real screens.
- An empty company section shows "$0", "Unknown stage" or a stock photo instead of being hidden.

### O11 (MUST) Never use the reference brand, copy, assets or paywalls

No screen, tooltip, notification, window title, export or About box shows the reference product's name, mascot, logos, illustrations, paid-tier name, copilot name or copied sentences, and the product calls itself jobleft. Money shows only as a balance in dollars, never as "credits", and each action that costs money shows its dollar price before the click.

Observe: Run text recognition on all screenshots, and search the app bundle's text, for "Jobright", "Orion", "Turbo", "credit" and "credits", and for any run of 8 words copied from the two UI spec files: 0 hits outside the third-party notices. Compare every icon and illustration with the reference screenshots: none is a copy. Open settings: the balance shows in dollars. Start each paid action (for example, a company-facts lookup): the dollar price shows before it runs. Open 20 screens with no clicks on paid actions: the balance does not change.

Adversarial angles:
- A copied string hides in a tooltip, an error message or an empty state.
- An illustration or icon is traced from a reference screenshot.
- A low-balance message says "credits", or offers a subscription tier.
- Opening a job detail starts a paid lookup with no click.

### O12 (MUST) Never leak personal data while you use the screens

Using any screen sends no profile, resume, tracker, note, network or search text off the laptop, except a message that the user sends to the AI provider that the user picked. No request is caused by a like, a status change, a profile edit or a resume upload, and the app sends no analytics.

Observe: Run the app behind a logging proxy or a macOS connection monitor. As the persona, visit every in-scope screen, open 20 details, like 5 jobs, change 2 statuses and edit the profile. Search all request lines, headers and bodies for the persona's name, email, phone, resume phrases and liked company names: 0 hits. List all hosts: only employer job sources, the logo and company-data hosts named in the docs, and the chosen AI provider after a sent message.

Adversarial angles:
- A logo or company-data request puts the user's email or search text in its address.
- A crash or error report uploads screen content that holds resume text.
- The copilot panel sends the profile before the user sends anything.
- A like or an apply starts a company lookup that tells a third party which employers the user targets.

### O13 (SHOULD) It looks like one polished product at every window size

All screens share one set of colours, type sizes, corner radii, spacing, icons and button styles, and they keep the reference layout regions (left rail, top bar with title and tabs, list column, right column, right-side drawers). No text overlaps, clips without an ellipsis, or shows placeholder text at any window size that the app allows.

Observe: Capture every in-scope screen at the app's smallest window, at 1388 x 662 (the reference size) and at 1920 x 1080. Put each beside its reference screenshot. Check that the same regions are in the same places and that the main action is the strongest element. Search the screenshots for "undefined", "null", "NaN", "lorem", "TODO" and "{": 0 hits. Check that every modal and drawer fits in the window and closes with its close button.

Adversarial angles:
- The layout works at one size only. At the smallest size the match tile or the apply button is cut off.
- Two screens use different button or chip styles for the same action.
- A template shows "undefined" in place of a missing company name (the reference has this bug).
- A pop-up is taller than the window, so its close button is off screen (the reference has this bug).

### O14 (SHOULD) Keyboard and screen-reader users can do the main job

A user can open a job, like it, close it, open and apply filters, and switch tabs with the keyboard only, and Esc closes the top-most popover, drawer, modal or detail. Every icon-only button has a name that a screen reader reads and a tooltip, and text meets WCAG 2.1 AA contrast.

Observe: With the keyboard only, do the flow above. Look for a visible focus ring at each step. Turn on VoiceOver: each icon button (like, hide, close, filters) reads a clear name. Measure the contrast of body text, chips and buttons with a contrast checker: at least 4.5 to 1 for normal text.

Adversarial angles:
- White text on the bright brand green fails the contrast check.
- Focus stays behind an open drawer, or it is trapped in the drawer with no way out.
- Esc closes the whole detail when only a popover was open.

### O15 (SHOULD) It feels instant

With a store of at least 50,000 jobs, the feed shows cards within 2 seconds of launch, and a tab switch, filter change, sort change or detail open shows its result within 300 ms. The feed scrolls with no blank cards and no jumps.

Observe: Fill the store with the crawl or seed command in the README. Record the screen at 60 frames a second while you launch, switch tabs, apply 3 filters, change the sort and open 5 details. Count the frames from each click to its result. Scroll fast through 500 cards: no card stays blank for more than 300 ms, and the list does not jump.

Adversarial angles:
- A detail waits for a network lookup of company facts before it shows anything.
- Infinite scroll loads the same page twice, so cards repeat.
- The first launch after a crawl blocks the window while it builds search data.
