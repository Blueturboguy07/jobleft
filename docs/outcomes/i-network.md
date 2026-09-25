# Outcomes: i-network (the Network tool inside the app)

Scope: what a person sees and does with the Network tool inside jobleft, from the import screen to the job feed, the job detail, the network page, drafts, tracking and reminders. This file judges the whole experience. It does not judge how the tool is built.

Source of intent: `docs/PLAN.md` sections 1, 2, 3 (M5) and 7; `GAPS.md` row M5; the insider-connection screens in `UI-SPEC.md` section 06 and `UI-SPEC-LOGGED-IN.md` section L03.

Test data for every check: a synthetic connections file in the LinkedIn export shape (3 note lines, then `First Name, Last Name, URL, Email Address, Company, Position, Connected On`) with made-up people only, for example "Jordan Testwell" (jordan.testwell@example.com). Never use a real export for acceptance checks. For drafts, use a local mock AI provider. Never use a live paid provider.

Words used here:

- "Target company": a company the person shows interest in through the app (a liked, tracked or preferred job or company).
- "Network page": the in-app screen that lists the imported people.
- "Public interfaces": commands in the package README, HTTP endpoints in `docs/INTERFACES.md`, files the product writes, and screenshots of the app.

---

### O1 (MUST): Import from the app, with an honest report

A person picks their exported connections file on an import screen in the app. The screen tells them how to get the file from LinkedIn. After the import, the app says how many people it read and how many rows it skipped, with a reason for each skipped row. The network page then lists the people.

Observe: Open the import screen and take a screenshot. The export steps must be visible. Import a fixture of 50 people plus 3 note lines, 1 malformed row and 1 fully blank row, through the UI or the import endpoint in `docs/INTERFACES.md`. The report must say 50 read and 2 skipped, with reasons. The network page (or the list endpoint) must return exactly 50 people.

Adversarial angles:
- The 3 note lines at the top of the file appear as people, or the header row appears as a person.
- A position with a comma inside quotes ("Director, Sales") splits into two columns and shifts the company.
- A different CSV (for example a messages file or a random spreadsheet) imports without an error and fills the network with nonsense.
- The import says "done" but silently drops rows, so the count on the page is lower than the report.

### O2 (MUST): Jobs show who you know at the company, and the count is right

On the job feed and on the job detail, a job at a company where the person has connections shows a line such as "You know 3 people at Stripe". The job detail lists those same people with name, position and a link to their profile. A job at a company with no connections shows no such line.

Observe: Import a fixture with 3 people at "Stripe, Inc." and 1 person at "Stripe Tax Advisors LLP" (a different firm). Load a local job from "Stripe". Take screenshots of the card and the detail. The card must say 3, and the detail must list the same 3 names. Load a job from a company with no fixture people. It must show no network line, and never "You know 0 people".

Adversarial angles:
- Legal suffixes and punctuation ("Inc.", "LLC", ", Inc", "The") block a true match, so the person sees nothing.
- A loose match joins different companies ("Meta" and "Metabase", "Apple" and "Applied Materials").
- The number on the card differs from the number of people in the detail.
- The card still shows the old count after a new import or after the data is deleted.

### O3 (MUST, negative): Never show a person who is not in the imported file

The app never shows, suggests or drafts to a person who is not in the person's own file. It never invents an email address, a title, a school, a past employer or a "beyond your network" contact. Before any import, the tool shows an empty state with a prompt to import, not sample people.

Observe: On a fresh install, open a job detail and the network page, and take screenshots. They must show an empty state. Then import the fixture. Collect every name, email and title that the UI and the documented endpoints return for 20 jobs and the network page. Each value must match a fixture row exactly. A fixture row with a blank email must show "no email" (or equal words), never an address.

Adversarial angles:
- Demo or seed contacts from development ship in the product and mix with real imports.
- The AI draft or the copilot names a colleague or hiring manager who is not in the file.
- The app guesses an email from a name pattern (first.last@company.com) and shows it as fact.
- A title is "cleaned up" into a different role (for example "Talent Partner" becomes "Hiring Manager").

### O4 (MUST): "Who to contact first", with reasons in plain words

For each target company, the app ranks the people the person knows there. Each person shows the reasons for their place in plain words, for example "Recruiter", "Works on an engineering team", "Senior", "Connected 3 months ago", "Has an email". The same data always gives the same order.

Observe: Import a fixture with 6 people at one target company: a recruiter with an email, an engineer, a senior manager, an intern, a person connected 8 years ago and a person with a blank position. Open the ranking for that company 3 times, with an app restart between loads. The order must be identical each time. Each person must show at least one reason. Each reason must agree with that person's row in the fixture.

Adversarial angles:
- The order changes between page loads or between restarts with no change in data.
- A reason contradicts the row (it says "Recruiter" for a software engineer, or "Has an email" when the email is blank).
- Reasons are empty or vague ("Good match", "Recommended").
- People at non-target companies rank above people at the target company.

### O5 (SHOULD): A coffee-chat plan that the person controls

The person can add the top people for each target company to a coffee-chat list, remove them, and see the list on the network page. The list stays after an app restart.

Observe: Add 3 people from 2 companies to the list through the UI. Restart the app. Take a screenshot of the network page: it must show the same 3 people, grouped or labeled by company. Remove one person. That person must leave the list and must stay in the network.

Adversarial angles:
- The list clears on restart.
- Removing a person from the list deletes them from the network.
- The app fills the list by itself with people the person did not choose, with no way to undo.

### O6 (MUST): Drafts that the person sends, with no invented facts

For a chosen person and job, the app writes a short outreach message. The person can edit it and copy it. The person sends it through their own channel. The draft uses the correct first name and company. It states only facts that come from the person's profile, the job and the connection row.

Observe: With a local mock AI provider, make a draft for "Jordan Testwell" at the fixture company. The draft must name Jordan and the correct company and job title. Edit a word, press Copy, and paste into a text editor: the pasted text must include the edit. A network log of the session must show no request to any mail, messaging or LinkedIn host. The only outbound request allowed is to the chosen AI provider.

Adversarial angles:
- The draft claims shared history that no data supports ("we worked together at X", "fellow alumnus of Y").
- The draft uses the wrong name, for example the name of the person ranked above, or the user's own name as the recipient.
- The app sends the message, opens a pre-filled send action, or schedules it without the person pressing anything.
- Placeholder text leaks into the draft ("{first_name}", "undefined", "@null").

### O7 (MUST): Track each contact, with reminders that arrive on time

Each person has a status from this set: To contact, Messaged, Replied, Met, Follow-up due. The person can set a follow-up date. On that date the app shows a system notification. Status, dates and notes stay after an app restart.

Observe: Set 3 people to Messaged, Replied and Met. Give one of them a follow-up date that falls 2 minutes from now (or use a test clock command from the README). Take a screenshot of the notification when it arrives. Restart the app. The 3 statuses, the date and any note must still show on the network page and through the documented endpoints.

Adversarial angles:
- The reminder fires twice, or never, or one day off because of the time zone.
- A status change on the job detail does not show on the network page, or the reverse.
- Notes disappear after a restart or after the app updates.

### O8 (MUST): A new import never loses the person's work

A person imports a newer file later. The app keeps the statuses, notes, dates and coffee-chat entries of every person who is still in the file. It adds new people without duplicates. It updates the company and position of people who changed jobs. It tells the person who is no longer in the file, and it does not delete their history without asking.

Observe: Import fixture A (50 people). Give 5 people a status and a note. Import fixture B: 45 people from A (2 with a new company), plus 10 new people, and 5 people from A left out. The report must show 10 added, 2 updated and 5 missing. The network page must show 55 current people with no duplicates. The 5 missing people must either show as "no longer in your file" with their notes intact, or be removed only after the person confirms. The 5 statuses and notes must survive for the people who are still present. The 2 people who moved must show on jobs at their new company only.

Adversarial angles:
- A re-import wipes every status and note (silent loss).
- The same person appears twice, because one field (for example the email) changed.
- A person who moved company still shows as a contact at the old company on job cards.
- People missing from the new file vanish together with their notes, with no warning.

### O9 (SHOULD): A map of target companies where the person knows nobody

The network page shows the target companies where the person has no connections. The person can see where they need to build new contacts.

Observe: Mark 4 companies as targets through the app. The fixture has people at 2 of them only, one under a spelling with a legal suffix. Take a screenshot of the map: it must list exactly the other 2 companies. After an import that adds a person at one of those 2, the map must list only 1.

Adversarial angles:
- A company appears on the map even though the person knows someone there, because of a name spelling difference.
- The map lists companies that the person never targeted.
- The map is empty with no explanation when the person has no targets yet.

### O10 (MUST, negative): Never send the network anywhere the person did not choose

Import, matching, ranking, the map, tracking and reminders make no network requests. Only a draft the person asks for may leave the laptop, and only to the AI provider the person chose. That request carries only the one contact it concerns, not the list. With a local model, no connection data leaves the laptop at all.

Observe: Run the app with all outbound traffic recorded. Import the fixture, browse 20 jobs, open the network page and the map, change statuses, and trigger a reminder. The recording must show no request that carries any fixture name, email or profile URL. Then make one draft through the local mock of the publik API. That request may carry one contact only. Repeat with a local model: the recording must show no outbound request with fixture data.

Adversarial angles:
- A crash report or usage metric includes contact rows.
- The app sends people or companies to the metered fetch or search route to "enrich" them.
- The draft prompt includes the whole list, or every person at the company.
- Avatar lookups send a hash of each email to an image service (for example Gravatar).

### O11 (MUST, negative): Never contact LinkedIn or any people-lookup service

The Network tool works only from the file the person imports. The app never logs in to LinkedIn, never loads LinkedIn pages in the background, and never calls an email-finder or people-search service. A profile link opens only when the person clicks it, and it opens in the person's own browser.

Observe: With outbound traffic recorded, do the full flow from O1 to O9. The recording must show zero requests to linkedin.com (and its subdomains) and zero requests to any people or email lookup service. Click one profile link: the default browser must open that URL, and the recording must show that the app itself made no request to it.

Adversarial angles:
- The app pre-fetches profile pages to show photos or link previews.
- A "find email" box appears that sends a profile URL to a lookup service.
- An autofill or copilot feature reads the network and visits profiles for "more context".

### O12 (MUST): One action removes all network data

The person can delete all imported network data with one clearly labeled action. After that, no name from the file shows on any job, page, search result, draft history, reminder or exported file, and no copy of the imported file stays in the app's data.

Observe: Import the fixture, make 2 drafts and set 1 reminder. Use the delete action. Restart the app. Search the UI and every documented endpoint for 5 fixture names: zero results. No reminder for a deleted person may fire. Search the app's data folder, as named in the README, for the 5 names and the fixture emails: zero matches (except in a file the README names as a user-made backup).

Adversarial angles:
- Names stay in a search index, a draft cache or a chat history after the delete.
- A copy of the original file stays in a temporary or upload folder.
- A reminder for a deleted person still fires.
- The delete action removes other data too (the tracker, resumes or jobs) with no warning.

### O13 (SHOULD): Messy real files give honest results

Real exports are messy. The app handles blank emails, rows with no company, non-Latin names and a byte-order mark at the start of the file. It shows each value as it is, or says clearly that a value is missing. It never shows placeholder words such as "undefined" or "null".

Observe: Import a fixture that starts with a UTF-8 byte-order mark and contains a blank email, a blank company, a blank position, a correctly encoded Japanese name and a Hebrew name. Take screenshots of the network page and of a job detail. The first column header must read correctly. The Japanese and Hebrew names must show exactly as they are in the file. The row with no company must be listed and not matched to any job. No screen may show "undefined", "null", "NaN" or "@" followed by nothing.

Adversarial angles:
- The byte-order mark breaks the first column, so every first name is lost.
- The app itself corrupts correctly encoded non-Latin names.
- A row with no company is dropped without a line in the import report.
- A template prints a missing company as "Previously@undefined".

### O14 (SHOULD): The tool works without AI, and money is shown as balance in dollars

With no AI provider set, import, matching, ranking, the plan, tracking, reminders and the map all still work. Drafting says clearly that an AI provider is needed, or offers a plain template. When the person drafts through the publik API, any cost is shown in dollars against their balance. The UI never says "credits". A failed draft does not reduce the balance.

Observe: Remove all AI providers. Do the O1 to O9 flow: every step except the draft must work. Take a screenshot of the draft screen. Then use a local mock of the publik API that fails on the first draft request and succeeds on the second. The balance shown must change once, not twice. Search all network screens (screenshots or UI text) for the word "credit": zero hits.

Adversarial angles:
- The network page shows an error or a blank screen when no AI is set.
- A failed or cancelled draft still charges the balance.
- Copy borrowed from other products says "email credits" or "credits left today".

### O15 (SHOULD): It stays usable with a large network

The largest file LinkedIn exports has about 30,000 connections. With a file of that size and a full local job store, the import finishes and the job feed with network lines stays smooth.

Observe: Import a synthetic file of 30,000 people. Time the import from the click to the report: it must finish within 60 seconds on a recent Apple-silicon laptop, and the window must stay responsive during the import. Then scroll 200 job cards and open 10 job details. Each detail must show its network list within 1 second (timed from a screen recording).

Adversarial angles:
- The window freezes during the import, so the person thinks the app crashed.
- Network lines load one by one and the cards jump while the person scrolls.
- The import runs out of memory and leaves a half-imported network with no error.
