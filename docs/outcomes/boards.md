# Acceptance outcomes: boards (board discovery and directory)

Area: how jobleft finds employer job boards, keeps the board list that ships with the app, and keeps the boards a person adds.
Source: `docs/PLAN.md` sections 1 to 8 (decisions 7, D1, D5, section 6), `GAPS.md` (D1, D5), audit 05 sections 1.2, 1.4, 1.8 and 5.3.
These outcomes say what a person or a stranger must see. They do not say how to build it.

## Terms

| Term | Meaning in this file |
|---|---|
| Board | One employer's public job list on one job-board provider (for example, one company on one provider). |
| Provider | A hosted job-board system that publishes a public job feed. |
| Directory | The list of boards that ships with the app. |
| User board | A board that a person added, or a directory board on which a person made a choice (follow, hide, disable). |
| Mock host | A local test server that acts as a provider and records every request it receives. All request checks below use mock hosts or a local logging proxy, not live hosts. |
| Forbidden host | LinkedIn, Indeed, Glassdoor, SmartRecruiters, and every provider that the plan holds back until the owner approves it (Workday, iCIMS, Oracle, UKG, Taleo). |

## Outcomes

### O1 (MUST) A careers link finds the right board

A person pastes a careers link or a single job link from a supported provider. The app shows the provider, the employer name that the board itself reports, and the number of open jobs, and it adds the board only after the person confirms.

- Observe: Make a test set of at least 30 links with known answers. Include several link shapes per provider: board home page, single job page, embed link, regional host, upper-case letters, tracking parameters, trailing slash. Paste each link in the app, or send it to the add-board endpoint in `docs/INTERFACES.md`. Pass: every link gives the correct provider and board, and 0 links give a wrong board.
- Adversarial angles: tracking parameters or letter case change the board ID; a single job link resolves to the job instead of the board; a regional host is sent to the default host and gets "not found"; the employer name comes from the link text instead of from the board.

### O2 (MUST) The app says "cannot" plainly and never guesses

When a link holds no board the app can use, the app says so in plain words, gives the reason, and adds nothing. Reasons include: an unsupported provider, a page with no board, a broken link, text that is not a link, and no network.

- Observe: Paste 15 links with no usable board: an unsupported provider, a news article, a page that returns "not found", a company home page with no job links, plain text, and one valid link while the network is off. Pass: each paste shows a plain message with a reason in less than 30 seconds; the board count does not change; no new job rows appear; the offline paste keeps the link so the person can try again.
- Adversarial angles: the app tries the company name as a board ID and adds a different company's board with the same name; the screen shows a spinner that never stops; the message is a raw error code or stack trace; the app adds an empty board without a word.

### O3 (MUST) Employer-hosted careers pages work

Many employers host their careers page on their own domain and embed a board from a provider. When a person pastes such a page, the app finds the embedded board. When the page holds more than one board, the app lists each one and lets the person choose.

- Observe: Serve 12 local test pages from a local web server. Ten pages embed one board in different ways (a plain link, an embedded frame, a script embed, an "Apply" button link, a redirect to the provider). Two pages hold two boards each. Pass: the app finds the board on at least 9 of the 10 single-board pages and says "cannot" on the rest (see O2); both two-board pages show two choices.
- Adversarial angles: a footer link to a partner company's board is picked instead of the employer's own board; a redirect loses the board ID; the board loads only by script, and the app adds nothing and says nothing; the app picks one of two boards without asking.

### O4 (MUST) The same board is never added twice

Different links to the same board give one board, not two. The app tells the person that the board is already in the list. A user board that is also in the directory is fetched once per refresh, not twice.

- Observe: Paste 5 different links to one mock board (old host, new host, job link, board link, upper-case letters). Then follow the same board in the directory. Run one refresh. Pass: the board count grows by exactly 1; pastes 2 to 5 say "already added"; the mock host logs 1 list request for that board in the refresh; each job from that board shows once.
- Adversarial angles: an old host and a new host for one provider count as two boards; letter case makes a second board; a board in both the directory and the user list gets two requests per refresh and shows each job twice.

### O5 (MUST) The shipped directory is large and clean

A fresh install holds a directory of at least 3,000 boards across at least 3 providers. Every entry has a provider, a board ID and an employer name. The directory has no duplicate boards, no blank names, and no board on a forbidden host. Most entries are live.

- Observe: Use the README command or the documented endpoint that lists or exports the directory. Count the rows and the providers. Check for duplicate provider and board pairs, blank names and forbidden hosts. Pick 100 entries at random and check each one live at 1 request per second per host with the project User-Agent. Pass: at least 3,000 rows; 0 duplicates; 0 blank names; 0 forbidden hosts; at least 80 of the 100 sampled boards answer as a live board.
- Adversarial angles: half of the entries are dead boards; one employer appears three times under different spellings; the list includes boards on forbidden hosts; the count is reached with test or placeholder rows.

### O6 (MUST) The directory has a clean licence and a stated source

The product states where the directory came from and under which licence. No directory entry comes from a source whose licence forbids commercial use.

- Observe: Read the third-party notices file and the directory's own header or notice. Pass: each source of entries is named with its licence, and no source is non-commercial (for example, CC BY-NC). A reviewer can follow each named source to a public page.
- Adversarial angles: the rows are a copy of a known non-commercial board list with a different source name on top; the notice names no source; the notice is in the repository but not in the shipped app.

### O7 (MUST) Dead boards stop wasting requests

When a board keeps answering "not found" or keeps failing, the app marks it as unreachable, shows that status with the last check time and the next check date, and stops fetching it on each refresh. When a dead board answers again at a later check, the app makes it live again with no action from the person. One failed request does not make a board dead.

- Observe: Run the app against a mock host with 20 boards. 15 answer with jobs. 3 always answer "not found". 1 answers "not found" once and then works. 1 times out once and then works. Run 10 refresh cycles. Pass: each always-dead board gets requests in at most the first 2 cycles and none after that until its stated next check date; the 2 boards that failed once stay live; live boards get 1 list request per cycle. Then make one dead board answer again, move to its next check date, and refresh. Pass: that board is live again and its jobs appear.
- Adversarial angles: one timeout or one server error marks a good board as dead; a dead board gets a request on every refresh forever; a board that comes back never returns to live; the screen still says "live" for a board that has failed for a month.

### O8 (MUST, negative) A board failure never closes its jobs

When a board fails, returns "not found", or returns an empty list after it had jobs, the app never treats that as "every job at this company closed". It marks the board as unavailable and keeps its jobs as they were.

- Observe: Give a mock board 20 jobs and refresh. Then make it answer in turn with a server error, "not found", an empty list, and a broken reply, with a refresh after each. Pass: after each refresh all 20 jobs are still listed and none shows as closed; the board shows a warning status. Then remove 1 job from a working reply for 2 refreshes a day apart. Pass: only that 1 job becomes closed.
- Adversarial angles: an empty but valid reply closes all jobs; a "not found" on the board closes all jobs; a broken reply is read as zero jobs; the warning shows on the board screen but not on the jobs.

### O9 (MUST, negative) User boards are never lost

Boards a person added, and choices the person made on directory boards (follow, hide, disable), survive app restarts, app updates, directory updates, and a crash during a refresh. A directory update never removes, renames or re-enables them.

- Observe: Add 5 boards by link. Disable 3 directory boards. Follow 3 others. Then, in turn: quit and restart; force-quit during a refresh; install a newer build; load a newer directory that drops one of the added boards and renames another. After each step, list the boards with the README command or the documented endpoint. Pass: all 5 added boards are present with their original names; the 3 disabled boards are still disabled and get 0 requests; the 3 followed boards are still followed.
- Adversarial angles: a directory update replaces the whole board list; the directory marks a board dead and that removes the person's own add; an app update drops user rows; a crash during a write leaves the list empty or damaged.

### O10 (MUST, negative) Forbidden hosts get no requests

No board action ever sends a request to a forbidden host. Board actions include paste, directory load, refresh and re-check. When a person pastes a link on a forbidden host, the app says plainly that it does not support that site and sends nothing to that host.

- Observe: Run the app behind a local logging proxy. Paste 10 links on forbidden hosts, including a job link that names a real employer. Load the directory and run a full refresh. Pass: the proxy logs 0 requests to any forbidden host; each paste shows a plain "not supported" message.
- Adversarial angles: the app opens a job link on a forbidden host to find the employer's own careers page; a redirect chain passes through a forbidden host; a directory entry on a forbidden host is fetched on refresh; a link preview or icon fetch touches the host.

### O11 (MUST) Requests are polite

Every board request carries the project User-Agent and obeys the host's robots rules. Requests stay at 1 or fewer per second per host, also when a person pastes many links quickly while a refresh runs. The app slows down when a host asks it to.

- Observe: Run mock hosts that log the time and headers of each request. Paste 20 links on one host in 5 seconds while a refresh runs. Give one mock host a robots file that blocks its job path, and make another answer "too many requests" with a wait time. Pass: no two requests to one host are less than 1 second apart; each request has the project User-Agent; the blocked path gets 0 requests and the person sees a plain message; the app waits at least the stated time before the next request to the busy host.
- Adversarial angles: the paste path skips the rate limit that the refresh uses; the app ignores the robots file when fetching it fails; the app retries a busy host right away; parallel workers each keep their own limit and together go over 1 per second.

### O12 (MUST, negative) Board work leaks no personal data

A board request never carries the person's name, email, resume text, profile, or the list of the person's other boards. Only the host of the pasted link and its provider's public job host see a request.

- Observe: Set up a test profile for "Jordan Testwell" (jordan.testwell@example.com) with a resume. Run the app behind a local logging proxy. Paste 10 links and run a refresh. Search every logged URL, header and body for the name, the email, lines of the resume, and the IDs of other boards. Pass: 0 matches; every request goes to the pasted link's host or its provider's public job host.
- Adversarial angles: the User-Agent or a header holds the computer's user name or an email; a referrer header or query string leaks the app's local page; one request sends a batch of all the person's boards; the pasted link goes to an analytics or error-report service.

### O13 (MUST, negative) No paid lookup without consent

The app never sends a pasted link or a board to a paid or third-party fetch service unless the person asks for it and sees the price in dollars first. A paid lookup that the person declines costs nothing.

- Observe: Run the app with a local mock of the paid fetch service and a test balance. Paste 10 links that plain requests cannot resolve. Decline each paid offer. Pass: the mock paid service logs 0 requests; the balance does not change; each paste shows a plain "cannot" message. Then accept one offer. Pass: exactly 1 paid request; the balance falls by the price that the app showed; the app shows the price as a dollar amount of the balance, never as "credits".
- Adversarial angles: the app falls back to the paid service with no prompt; the app shows the price after the charge; one accepted offer charges more than once on retry; the prompt says "credits".

### O14 (SHOULD) A person can find and follow a directory board

A person can find an employer in the directory by typing part of its name, see its provider and status, and follow or hide it in one step. A followed board's jobs appear after the next refresh with no restart.

- Observe: Search "stripe", "STRIPE" and "Stripe, Inc." in the directory screen or the documented endpoint. Pass: the same entry is first for all three. Follow it. Run one refresh against a mock host. Pass: the board is in the followed list and its mock jobs appear without a restart. Hide another board. Pass: its jobs leave the feed and it gets 0 requests.
- Adversarial angles: a suffix such as "Inc." or a comma finds nothing; follow does nothing until a restart; hide removes the board from the screen but the app still fetches it.

### O15 (MUST) Board facts are real, never invented

For each board the app shows only facts it observed: the status, the time of the last good check, and the job count from that check. Before the first check it says "not checked yet". The employer name comes from the board or the directory, never from a guess.

- Observe: Start a fresh install with the network off and open the board list. Pass: every board says "not checked yet" and shows no job count and no "live" label. Turn the network on, point the app at mock hosts, and refresh. Pass: each job count equals the number of open jobs on that mock board; the last-check time is the refresh time.
- Adversarial angles: the app shows an old count from the directory file as a current count; the app shows "live" before any check; an AI tool makes up an employer name or logo for a board; the count includes jobs that are closed.
