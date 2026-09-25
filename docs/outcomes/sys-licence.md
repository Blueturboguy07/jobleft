# Acceptance outcomes: sys-licence (licences, brand and privacy)

Status: draft, 2026-09-25.
Sources read: `docs/PLAN.md` sections 1 to 8, `jobright-research/GAPS.md`, the licence, brand and privacy notes in `jobright-research/audit/01..05` and `jobright-research/ui/UI-SPEC*.md`.

These outcomes say what a user or a stranger must be able to see. They do not say how to build it.

## Terms

| Term | Meaning in this file |
|---|---|
| Personal data | Anything about the person or about people they know: name, email, phone, resume text, profile answers, tracker entries, notes, chat, imported contacts, API keys |
| Shipped artifacts | The installed app, the browser extension package, and every data file the app downloads after install |
| Marker persona | The fake test person "Jordan Testwell" (jordan.testwell@example.com), plus a few made-up values that occur nowhere else: a skill "Quorvex", a phone "(555) 014-2883", a past employer "Hollowbrook Tiling", and a contact "Priya Markerdahl". A marker value found in a request or a file proves a leak |
| Mock hosts | Local servers that stand in for employer job feeds, the publik API and AI providers. Acceptance checks never call the real publik API |
| Recorded traffic | Every outbound connection from the app, its helper processes and the extension, captured from outside the product (for example with a recording proxy or the operating system's network monitor) |

## Outcomes

### O1 (MUST) Every borrowed piece is listed, and its licence is honoured

Outcome: Inside the installed app and inside the extension, a stranger finds a notices list that names every outside source of code, data, fonts, models and templates, with its licence, its copyright holder and what jobleft took from it. The full licence texts ship too, and the app shows them on an "Open-source notices" screen.

Observe: Open the notices screen in the app and `THIRD_PARTY_NOTICES.md` in the repository. Pick 10 shipped items that came from elsewhere: a font, the embedding model, a resume template, a data table, and 6 source modules whose header or history names another project. Each item maps to an entry with the correct licence and the original copyright line. Each file changed from an Apache-2.0 source says that it was changed.

Adversarial angles:
- A ported module loses its original header, so the copy is invisible and not listed.
- The notices exist in the repository but not in the built app or the extension package.
- Non-code items are forgotten: the embedding model, fonts, icon sets, the city list.
- An entry names the wrong licence or holder, for example MIT where the source is Apache-2.0.

### O2 (MUST) Never ship code or data under a licence the product cannot honour

Outcome: No shipped artifact contains code or data under a GPL or AGPL family licence, a "no selling" clause, a non-commercial licence, or no licence at all. Share-alike data, if the app uses any, stays in its own separate file with its own credit.

Observe: Run any off-the-shelf licence scanner over the dependency tree of the built app and over the extension package. It reports no GPL, AGPL, Commons Clause, BUSL, non-commercial or unknown item. List every bundled program, font, template and data file. Each one has a permissive, public-domain or attribution-only licence in the notices. Compare a sample of modules with the reference-only projects named in the research (ApplyPilot, job-ops, Skyvern, offerPilot, JobCtrl, open-resume, resume-lm). No module is a copy or a close translation.

Adversarial angles:
- A GPL command-line tool (for example a PDF-to-text program) ships inside the app for resume import.
- A board or company list comes from a non-commercial data set, from a directory whose terms ban scraping (such as an accelerator's company directory), or from a hand-made list with no stated source.
- A resume template carries a non-commercial or share-alike licence.
- Code from a reference-only project is translated line by line into another language, so a scanner does not see it.

### O3 (MUST) Outside facts carry their source

Outcome: Every job shows which employer board it came from and links to the employer's own posting. Sponsor history, company facts, place data and news each show their source, and news shows only a headline, outlet, date and link, never the article text.

Observe: Crawl a set of mock boards and open 20 random jobs. Each job names its source, and its apply link opens the mock employer's own posting for that same job. Take screenshots of a job with sponsor history, a company panel and a news block. Each one shows a source credit (for example "US Department of Labor data") and a date or a working link. The notices screen credits every attribution-licence data set that the app uses for places or companies.

Adversarial angles:
- Two postings merge as duplicates, and the result links to the wrong job or the wrong employer.
- A company fact shows with no source, so the person cannot tell a filed fact from a model guess.
- Full news or encyclopedia text is copied into the company panel.
- The place-name data set needs attribution, and the app shows none.

### O4 (MUST) Never show the Jobright name, marks or words

Outcome: No screen, file, notification, installer, extension listing or network request of the product shows the Jobright name, logo, bird mascot, its assistant or plan names ("Orion", "Turbo"), its images or its marketing sentences. A job that this company posts, shown like any other employer's job, is not a breach.

Observe: Search every file in the built app, the extension package and the downloaded data files for "jobright" in any letter case. The only hits are employer rows in job or board data. Search all user-visible text for "Orion" and "Turbo" used as product or plan names: zero hits. Take a screenshot of every main screen and of the extension popup. Compare the logo, icons, illustrations and headline copy with Jobright's public pages: none is the same or a close copy.

Adversarial angles:
- Code comments, source maps or theme names inside the bundle name the competitor ("jobright tokens", "same as Jobright's card").
- Marketing lines or claims are copied word for word or closely reworded ("Get Hired Faster", "save 80% of your time").
- The extension popup or an empty-state picture copies the competitor's mock-up art.
- The copilot has the competitor's assistant name.

### O5 (MUST) The product carries only its own identity

Outcome: The app, the extension, the installer, notifications and the identity the app gives to servers all use the name jobleft and jobleft's own logo. No name, logo or photo from a borrowed project, and no investor or accelerator logo used as a badge or endorsement, ships in the product.

Observe: List every image in the built app and in the extension. None is the logo of a borrowed project (for example freehire or career-ops), a photo of a real person, or an investor or accelerator mark. Search user-visible text for the names of borrowed projects: they occur only on the notices screen. Check the name in the menu bar, the Dock, notifications, the installer and the extension listing: each says jobleft.

Adversarial angles:
- A borrowed project's favicon, mascot or sample photo ships as a default picture or avatar.
- A borrowed project's name stays in a window title, an error message or a default setting.
- Accelerator or investor logos from a borrowed project show as badges on company cards.

### O6 (MUST) Money is a balance in dollars, never "credits"

Outcome: Every place that shows the person's publik money calls it "balance" and shows a dollar amount. No screen, notification, extension view or error message uses "credit" or "credits" as a unit of money.

Observe: Take screenshots of the balance card, the low-balance warning, the provider settings and the extension popup. Each shows a dollar amount, for example "$4.37". Search all user-visible text in the app and the extension for "credit" in any letter case. No hit is about the person's money ("credit card" as a payment method is allowed). Make the mock publik server return an "out of money" error. The message the person sees says "balance", not "credits".

Adversarial angles:
- An error text from the server ("insufficient credits") goes to the screen word for word.
- The extension popup counts "autofills left" or "credits left" in the competitor's style.
- A daily free-use counter is labelled in credits.

### O7 (MUST) In local mode, nothing personal leaves the laptop

Outcome: With a local AI model and the paid fetch-and-search route off, the app contacts only the hosts on its published list: employers' public job feeds and the product's own update and data-file hosts. None of these requests contains personal data, and the app's own "What leaves this laptop" page lists exactly these hosts.

Observe: Install fresh and load the marker persona. For one session, use every main feature with a local mock model and mock boards: resume import, crawl, match, tailor, cover letter, chat, contact import, tracker and notifications. Compare the hosts in the recorded traffic with the app's privacy page and with the README: they are the same. Search all recorded requests for every marker value: zero hits outside the laptop.

Adversarial angles:
- A crash reporter or analytics tool from a borrowed project is still on.
- Fonts, icons or scripts load from a public CDN when a screen opens.
- A logo service receives the list of companies the person liked or applied to.
- The embedding model downloads from a model hub on first run, and the privacy page does not say so.

### O8 (MUST) Remote services get data only after the person picks them

Outcome: Personal data goes to a remote AI provider or to the paid fetch-and-search route only after the person picks that service, and only to that one service. Before first use, the app says in plain words what kinds of data it will send, and a switch back to a local model stops all traffic to the old service.

Observe: Set up two mock providers, A and B. Pick A, then run match, tailor and chat: marker values occur only in requests to A. Switch to B and repeat, then switch to local and repeat. After each switch, the recorded traffic shows no request to the earlier service from the app, the tray poller or the extension. Take a screenshot of the notice that shows before first use.

Adversarial angles:
- The local model fails or is slow, and the app silently falls back to the publik API.
- Background scoring or embeddings use a different remote service from the one the person picked.
- The key for one service goes to another, for example the publik key goes to a custom address.
- The tray poller keeps using the old provider until the app restarts.

### O9 (MUST) Never put personal data or a false identity into crawl requests

Outcome: Requests to employers' job feeds and to public data hosts never carry personal data, the person's cookies or keys, and never pretend to be a web browser. They name the product ("jobleft/" and a version) with a project contact that is never a personal address, and they keep normal certificate checks.

Observe: Load the marker persona and crawl the mock boards. Read the headers, address and body of every recorded request: each identity header starts with "jobleft/", no request has cookies or an auth header, and no request holds a marker value. Serve one mock board over HTTPS with a certificate that no trusted authority signed. The app refuses that board and shows it as failed.

Adversarial angles:
- A developer's personal email is hard-coded in the identity header (this happened once in the research phase).
- When a host blocks the product, a fallback sends a browser-like identity.
- A borrowed adapter adds an extra trusted root certificate or turns certificate checks off.
- The person's name or email goes into the query string of a "subscribe" or "apply" call.

### O10 (MUST) Never contact forbidden sites, and obey each site's rules

Outcome: The app never sends a request to LinkedIn, Indeed, Glassdoor or SmartRecruiters, and a default install sends none to Workday, iCIMS, Oracle, UKG or Taleo job sites. For every other host, it obeys robots.txt and sends at most one request a second.

Observe: Add boards on those hosts through the app's add-board feature, and paste a LinkedIn and an Indeed job URL as external jobs. The recorded traffic shows zero requests to those hosts, and the app tells the person that it cannot fetch that site. Serve a mock board whose robots.txt disallows the job path: zero requests go to that path. Log request times per host on the mock servers: no two requests to one host are less than one second apart.

Adversarial angles:
- A company-facts lookup follows a LinkedIn or Glassdoor link found in public data.
- A link preview or favicon fetch for an apply link reaches a forbidden host.
- The app caches robots.txt forever, or treats a server error on robots.txt as "allow all".

### O11 (MUST) Web pages and other machines cannot read the person's data from the app

Outcome: While the app runs, no web page the person visits and no other device on the network can read or change their data through the app's local connection. Only the app's own window and the paired extension get answers.

Observe: With the app running, open a page from another origin in headless Chrome with a scratch profile. From that page, call each endpoint in `docs/INTERFACES.md`: every call is refused, and no reply holds personal data. From another device on the same network, try the app's port: no answer. Send requests with a foreign Host header, or with no pairing token: each is refused.

Adversarial angles:
- The local server accepts calls from any origin.
- A hostile page uses a DNS-rebinding name that points to the laptop.
- The server listens on every network interface, not only on the laptop itself.
- The pairing token appears in a URL, a log, or a place that a web site can read.

### O12 (MUST) The extension reads only what it says, and reports only to the app

Outcome: The browser extension says in plain words, before install and in its settings, which sites it can read and why. What it reads goes only to the jobleft app on the same laptop, and the extension itself never sends page content or form answers to any remote server.

Observe: Read the extension listing text and the permissions that Chrome shows at install: each broad permission has a plain reason. Load the extension in headless Chrome with a scratch profile, pair it with the app, and fill a mock application form with the marker persona. The recorded requests from the extension go only to the local app and to the mock form page. Open a mock site outside the list the extension states: it reads nothing and sends nothing.

Adversarial angles:
- The extension polls a public code host for updates, which tells that host who uses it.
- It asks for access to every site, or for debugger rights, with no explanation, and Chrome shows a debugging bar that nobody told the person about.
- It sends form answers straight to an AI provider and so goes around the provider choice in O8.
- It keeps a full copy of the profile in browser storage after the person unpairs it.

### O13 (MUST) Contacts from the network file stay on the laptop

Outcome: The people in an imported connections file never leave the laptop as a list. Contact details go to the chosen AI service only when the person asks about specific contacts, and then only those contacts' name, company and role, never an email address.

Observe: Import a fake connections file of 50 made-up contacts. Each contact has a marker name and a marker email. Browse, rank and map them with a remote mock provider: the recorded traffic holds no contact marker. Ask for a draft message to one contact: the request holds that one contact's name, company and role, and no email address. Ask the copilot who the person knows at one company: the request holds only contacts at that company, with no email addresses.

Adversarial angles:
- The ranking step sends all contacts to the remote model for scoring.
- The copilot adds the whole contact list to its context.
- An email-finder or enrichment lookup sends contact names to an outside service.
- The draft request includes the contact's email address "for the greeting".

### O14 (MUST) Logs, crash files and temp files hold no personal data or keys

Outcome: Nothing the app writes for its own diagnosis (logs, crash reports, temp files, exported diagnostics) contains resume text, contact details, chat text or API keys. After the person saves a key, the screen never shows it in full again.

Observe: Run a full session with the marker persona and a mock provider key that is itself a marker value. Stop the mock provider in the middle of a reply to cause a failure. Search the app's log folder, the system temp folder, the crash-report folders and any diagnostic export for every marker value: zero hits. Take a screenshot of the provider settings: the key shows masked.

Adversarial angles:
- A failed model reply, which contains resume text, goes into the log.
- Debug logging writes full request bodies, or headers that include the key.
- Generated PDFs or parsed resume text stay in the temp folder after use.
- A crash report holds resume text from memory and goes to a remote host with no question to the person.

### O15 (SHOULD) The person can export everything, then delete everything

Outcome: The person can export all their data in one step and remove all of it in one step, and after removal no copy of their data stays on the laptop. Nothing is lost silently: the export holds every resume, tailored version, tracker entry, note, contact, chat and setting.

Observe: Fill the app with the marker persona and export. Each marker value is in the export. Run the delete-all action. Then search the app's data folders, caches, temp folders, the system password store and the extension's storage for every marker value: zero hits outside the saved export.

Adversarial angles:
- Search indexes or stored vectors keep resume text after the source rows are deleted.
- The extension keeps the profile after the app deletes its data.
- The export leaves out tailored versions or chat, and the person learns this only after the delete.
- API keys stay in the system password store.

## Coverage

| Failure that matters to a real person | Outcomes |
|---|---|
| Legal exposure from borrowed code or data | O1, O2, O3 |
| Brand confusion or a trademark claim | O4, O5, O6 |
| Wrong or invented facts shown as sourced | O3 |
| Personal data leaves the laptop | O7, O8, O9, O12, O13, O14 |
| Other people's data leaks (contacts) | O13 |
| A hostile page or device reads local data | O11 |
| Terms breach with job sites | O9, O10 |
| Silent data loss or silent retention | O14, O15 |

Negative outcomes ("never"): O2, O4, O9, O10.
