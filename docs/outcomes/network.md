# Acceptance outcomes: Network tool

Area: the Network tool (plan section 7, parity row M5). It replaces a hosted "insider connections" feature with one that works only on the person's own connections export.

How to read this file:

- Each outcome says what a person or a stranger must see. It does not say how to build it.
- MUST outcomes block the release of the area. SHOULD outcomes are strong targets.
- "Observe" uses only public interfaces: the import screen, commands in the package README, HTTP endpoints in `docs/INTERFACES.md`, files the product writes, and screenshots.
- Test data: use only a made-up connections file with made-up people. The job seeker in tests is "Jordan Testwell" (jordan.testwell@example.com). Never test with a real export.

A "connections file" in this file means the CSV that the person downloads from their own professional-network data archive. It starts with a few note lines, then has the columns First Name, Last Name, URL, Email Address, Company, Position, Connected On.

---

### O1 (MUST). The import keeps every real row and reports what it skipped

The person picks their own connections file and the app imports every real connection in it. The app then says how many people it imported and how many rows it skipped, with a reason for each skip.

Observe: Import a fixture file with a known count of people. Include the note lines at the top, blank emails, a company name with a comma inside quotes, a position with an accent, one duplicate row, and one broken row. The summary shows the exact expected counts. The network list shows the expected people and no one else. A position with a comma or accent shows the same text as the file.

Adversarial angles:
- The note lines at the top become fake people, or the header is not found when the file has a byte-order mark or Windows line endings.
- A comma inside a quoted field shifts the columns, so a job title lands in the "Connected On" column.
- A different CSV (for example a messages file or a spreadsheet export) imports as nonsense rows instead of a clear "this is not a connections file" message.
- The duplicate row becomes two people, or the broken row stops the whole import with no count.

### O2 (MUST). Network data stays on the laptop

Importing, matching, ranking, tracking and deleting network data send no connection data off the laptop. The only exception is a draft that the person asks a remote AI provider to write (see O8).

Observe: Run a full session (import, browse jobs, open company views, rank, track, delete) while you record all outbound traffic, or with the machine offline. No outbound request carries a connection's name, email, profile URL, company-and-name pair, or the file itself. With a local model selected, a draft also sends nothing off the machine. The network features work the same offline.

Adversarial angles:
- The app fetches avatars or profile pictures by profile URL, which tells a third party who the person knows.
- Error reports, crash logs or usage analytics include connection rows.
- The app keeps a copy of the file in a folder that a cloud sync service reads.
- A job-crawl or metered-fetch request includes connection names as search terms.

### O3 (MUST). The app never contacts the professional network and never sends a message

The app never makes a request to LinkedIn or to any people-lookup or email-finder service. It never opens profile pages by itself. It never sends a message, email or connection request for the person. The person sends every message themselves.

Observe: The traffic record from O2 shows no request to linkedin.com or to any contact-enrichment host. The product has no control that transmits a message. A profile link opens only after the person clicks it, one link per click, in their own browser.

Adversarial angles:
- An "enrich" or "find email" feature that looks up people on the web or guesses addresses.
- A "message all" action that opens a batch of profile tabs or sends through a mail account.
- The browser extension reads network pages while the person browses them.
- A metered search is used to look up the person's connections.

### O4 (MUST). "You know N people at <Company>" is correct

On a job card, on the job detail and in a company view, the person sees how many of their connections work at that company, and can open the list of names. The count tolerates harmless name variants but never joins different companies.

Observe: Use a fixture with "Stripe, Inc." (3 people), "stripe" (1 person), "Stripe Partners Ltd" (1 person, a different firm), "Apple" (2 people), "Apple Leisure Group" (1 person) and 2 people with a blank company. A Stripe job shows 4. An Apple job shows 2. A job at a company with no connections shows no count and no empty list. Opening the list shows exactly the people that the count claims.

Adversarial angles:
- Over-merge: "Meta" matches "Metaview", "Block" matches "Blockchain Labs", or "Apple" matches "Apple Leisure Group".
- Under-merge: legal suffixes, case or punctuation ("Inc.", "LLC", "Corp") split one company into two counts.
- A blank company matches a job whose company name is also blank or unknown.
- The count on the card differs from the number of people in the list behind it.

### O5 (MUST). Who to message first, with true reasons

For each company the person cares about, the app shows who to message first, in a ranked order, and each person shows short reasons for their place. Every reason is true for that person's row, and the same data always gives the same order.

Observe: Import the fixture, note the order for one company, restart the app, and check again: the order is the same. For each person, check each reason against the file. A title with "Recruiter" can give a recruiter reason. A blank email never gives an "email on file" reason. Add an email to one person in the file and re-import: that person's reasons change to match, and nobody else's do.

Adversarial angles:
- A reason claims a fact the data does not hold, such as "same school", "same team" or "hiring manager for this job".
- A reason contradicts the row, such as "connected recently" for a connection from many years ago.
- The order changes between loads with no change in data.
- Seniority is misread, so "Senior Recruiting Coordinator" ranks as an executive.

### O6 (MUST). A draft never invents facts

The draft message is short and uses only facts from the person's profile, the chosen connection's row and the chosen job. It never claims a shared school, a past job together, a prior talk, a referral promise, or any number that the inputs do not hold. If the AI output contains such a claim, the app does not present it as ready to send without a visible warning.

Observe: Point the app at a local mock AI provider (documented in the README) and draft for several fixture people. Every person name, company, school, job title and number in each draft appears in the inputs. Then make the mock return a draft with an invented shared employer and a wrong first name: the app shows a warning on that draft, or does not show it as ready. The short variant fits a stated character limit.

Adversarial angles:
- The draft greets the wrong person, for example the previous connection's name in a batch.
- The draft names the wrong job or the wrong company.
- The draft says "we worked together at X" or "as we discussed" with no data to support it.
- The draft is long, so it does not fit a short connection note.

### O7 (MUST). The draft belongs to the person

The person can read, edit and copy the draft in one action, and the copied text is exactly the text on screen. The person chooses the AI provider, and a local model works for drafts. When a draft uses the publik API, any cost shows in dollars from the person's balance.

Observe: Draft, edit one word, copy, and paste into a plain text editor: the pasted text matches the screen, with the edit. Switch the provider to a local model (or a local mock that stands in for one) and draft again: it works. With the publik provider selected against a local mock, the screen shows the cost in dollars and says "balance", never "credits".

Adversarial angles:
- Copy puts the old text on the clipboard, not the edited text.
- Copy adds hidden characters, markup or placeholder tokens such as "{first_name}".
- Drafting fails, or shows no clear message, when no remote provider is set up.
- The cost shows as credits or tokens, not as dollars.

### O8 (MUST). A draft request sends only what that draft needs

When the person uses a remote AI provider for a draft, the request carries only the facts for that one draft: the chosen connection's name, title and company, the chosen job, and a short summary of the person. It never carries other connections, email addresses, profile URLs, or the whole list.

Observe: Point the app at a local mock provider that logs request bodies. Draft for one fixture person. The logged body holds that person's name, title and company. It holds no other fixture person's name, no email address and no profile URL. Before the first remote draft, the app tells the person which provider receives the text and what it sends.

Adversarial angles:
- The whole list goes into the prompt "to help ranking" or "for context".
- The chat assistant can read the full network and sends it with an unrelated question.
- A batch draft sends every selected person in one request with their emails.
- The app keeps logs of full request bodies on disk after the draft is done.

### O9 (MUST). Tracking survives restarts and re-imports

The person can put each contact in a stage (To contact, Messaged, Replied, Met, Follow-up due), add a note, set a follow-up date and get a reminder on that date. Stages, notes and dates are never lost when the app restarts or when the person imports a newer connections file.

Observe: Set stages, notes and follow-up dates for 3 fixture people. Quit and relaunch: all are the same. Import a newer fixture file in which one of the 3 has a new position and one new person appears: the 3 keep their stages and notes, the changed person shows the new position, and the new person is in "To contact". Set a follow-up date to today: a desktop notification appears, and the person shows in a due list.

Adversarial angles:
- A re-import erases stages or notes, or duplicates people who were already there.
- Two different people with the same name merge into one, so one person's notes show on the other.
- A reminder fires on the wrong day because of the time zone, or does not fire after a restart.
- A person who is gone from the newer file silently loses their notes, with no message.

### O10 (MUST). Delete removes all of it

The person can delete one contact or all network data from one clear place. After deletion, no name, email, note or draft from the network remains anywhere in the product, and the person's original file on disk is not touched.

Observe: Import the fixture, rank, draft, track and add notes. Delete all network data. Search the app for a unique fixture name: no result. Search every file in the app's data folder for a unique fixture email and name, after the app says the delete is complete: no match. Job cards no longer show "You know N people". The original fixture file is still where it was, unchanged. Repeat for one contact: only that person is gone.

Adversarial angles:
- A "soft delete" leaves the rows in the database file.
- Draft history, chat history, search indexes or stored vectors still hold names or note text.
- The app keeps its own copy of the imported file and does not remove it.
- The delete removes the person's original file, or deletes a different contact.

### O11 (MUST). Other web pages cannot read the network

A web page open in the person's browser can never read network data from the app, even though the app runs a local server on the same machine.

Observe: With the app running and the fixture imported, send requests for network data to the app's local endpoints (as listed in `docs/INTERFACES.md`) from a page on another origin, and from a plain command-line request with no pairing token. Both are refused and no fixture data comes back. The paired browser extension receives no network data unless a documented feature needs it.

Adversarial angles:
- A permissive cross-origin setting lets any site read the list.
- A request with a forged Host header, or through a DNS-rebinding name, gets through.
- An error page or a debug endpoint echoes connection rows.
- The launch token is written in a place that web pages can read, such as a URL.

### O12 (MUST). Missing or garbled data stays visibly missing

The import screen tells the person how to get the file and states its limits: it holds first-degree connections only, many emails are blank, and some non-Latin names come out garbled. The app never fills a missing email, company or title with a guess, and never "fixes" a garbled name into a different name.

Observe: Read the import screen: the steps and the three limits are there. In the fixture, a row with a blank email shows no email. A row with a garbled name shows the text from the file, with or without a "may be garbled" note, and no invented spelling. A row with a blank company shows under an "unknown company" group and matches no job.

Adversarial angles:
- The app guesses emails in the form first.last@company.com.
- The app transliterates or "repairs" a name and so shows a name the person never had.
- A blank company inherits the company from the row above it.
- The screen claims the file holds second-degree connections or full contact details.

### O13 (SHOULD). Companies where the person knows nobody

The person sees which of their target companies (the companies of jobs they liked, applied to or tracked) have no connection yet, next to those where they know someone, and can put the top people into a coffee-chat plan in one action.

Observe: Like jobs at three companies A, B and C, with fixture connections at A only. The coverage view shows A with its count and B and C as "no one yet". Re-import a file that adds a person at B: B moves to the known group. Add the top two people at A to the plan: they show in the plan and in "To contact".

Adversarial angles:
- A near-name match shows a company as covered when it is not (see O4).
- Target companies with no jobs in the local store silently drop off the view.
- A failed import makes every company show "no one yet" with no error message.

### O14 (SHOULD). Large files import fast and do not slow the app

A connections file with 30,000 rows (the largest size the person is likely to have) imports in under 30 seconds on the reference Mac. The job feed with "You know N people" lines stays about as fast as it was before the import.

Observe: Generate a synthetic 30,000-row fixture with made-up people. Time the import from the click to the summary. Time the job feed load before and after the import with the same filters. The import is under 30 seconds and the feed load time grows by no more than 20 percent.

Adversarial angles:
- The import blocks the whole app, so the window stops responding until it ends.
- The count on each job card is computed again for every card on every scroll, and the feed becomes slow.
- A large file runs out of memory and the import stops with a partial list and no message.
