# Acceptance outcomes: sources-ats (more ATS adapters)

Area: jobleft crawls more ATS families than Greenhouse, Lever and Ashby, and each one gives the same kind of local job.
Plan references: `docs/PLAN.md` decisions 7, D1, D2, D5, Phase 1, and section 6 ("Hosts that say no", "Never", "Crawler identity").
Written for: a stranger who can use only public interfaces. These outcomes say what must be true. They do not say how to build it.

## Words used here

| Word | Meaning |
|---|---|
| ATS | An applicant tracking system that hosts employers' job boards (for example Workable) |
| Supported ATS | An ATS family that the product's source list marks as crawled |
| Board | One employer's public job list on one ATS |
| Stand-in board | A local server on localhost that serves recorded or hand-made board replies |
| Crawl report | What the product shows or writes after a crawl: per-board results and errors |

## What an observer can expect

- The package README tells how to start a crawl, how to point a crawl at stand-in boards, and where to read the source list, the stored jobs and the crawl report.
- `docs/INTERFACES.md` lists any HTTP endpoints that return jobs, sources or crawl results.
- No observation below needs a live request to a real job board.

## Outcomes

### O1 (MUST) Every supported ATS gives the same kind of job

A crawl turns the public board of each supported ATS into local jobs of one common shape. At least Workable, Recruitee and Personio are supported in addition to Greenhouse, Lever and Ashby, and each job carries title, company, location, description, a link to the posting, and the posted date and pay when the board gives them.

Observe: For each supported ATS, serve a stand-in board with 3 known jobs, run the crawl, and read the stored jobs through the README command or the jobs endpoint. Compare each field with the stand-in reply. Every ATS gives the same set of fields with the same meaning.

Adversarial angles:
- One ATS puts the department or the company name in the location field.
- The XML-based or paged ATS gives fewer fields than the JSON ones.
- A regional host variant (for example an EU host or a second country domain) is not read at all.
- Pay comes out in cents from one ATS and in dollars from another.

### O2 (MUST) The source list says what is crawled, what is not, and why

The product publishes a source list that names each ATS family it crawls, and each family it does not crawl with a reason and the date the reason was checked. Valid reasons include: no documented public feed, a robots.txt that disallows the feed, terms that forbid automated access, a login is needed, or the owner has not approved it.

Observe: Open the source list the README names. SmartRecruiters, Workday, iCIMS, Oracle, UKG, Taleo, LinkedIn, Indeed and Glassdoor each appear as "not crawled", with a reason and a date. Each ATS in O1 appears as "crawled", with a link to its public feed documentation or other evidence that the feed is public.

Adversarial angles:
- A reason is vague ("legal") and names no source.
- A new ATS starts to be crawled but never gets a list entry.
- A host restriction that the plan records (for example a "no AI training" signal or a crawl delay) is missing from the list.
- The list says "not crawled" but the product still crawls that ATS (O3 catches this).

### O3 (MUST) The product never contacts an excluded host

The product never sends a request to a host that the source list marks as not crawled, and never to LinkedIn, Indeed, Glassdoor or SmartRecruiters, even when a user pastes a job or careers URL on such a host. The user sees a plain message that this source is not supported.

Observe: Route all traffic through a request-logging proxy. Paste one URL from each excluded host into the add-company flow, then run a full crawl with a board directory that also lists such entries. The log shows zero requests to those hosts. A screenshot shows the "not supported" message.

Adversarial angles:
- A supported board redirects to an excluded host, and the crawler follows the redirect.
- A careers page on a company domain links to a Workday or iCIMS board, and discovery fetches it.
- The shipped board directory contains entries for excluded hosts, and a background refresh tries them.
- A "check this job is still open" step sends a request to the excluded host.

### O4 (MUST) A bad board never stops the crawl

A board that returns an error, nothing, or garbage never crashes the crawl and never stops other boards. The crawl finishes, keeps the jobs from good boards, and names each bad board with a short plain reason.

Observe: Serve stand-in boards that give HTTP 404, 429, 500, a timeout, an empty body, invalid JSON, HTML in place of JSON, cut-off XML, a 30 MB body, a redirect loop, and one good board. Run the crawl. The command ends normally, the good board's jobs are stored, and the crawl report lists each bad board with its reason.

Adversarial angles:
- A board that sends one byte a second holds the crawl for hours.
- One malformed job inside a good board drops the whole board.
- An error on the last board throws away the results of the whole run.
- A 429 ("slow down") is reported as "board gone".

### O5 (MUST) A failed fetch never closes or deletes stored jobs

A failed, empty or unreadable fetch never closes, hides or deletes jobs that the product already stored from that board. A job closes only when its board answered properly with its other jobs and that job was missing.

Observe: Crawl a stand-in board with 5 jobs. Make the board return 500, then an empty list, then garbage, and crawl after each change. All 5 jobs stay open. Then serve the good board without 1 job and crawl as the README says (twice, if the README documents a two-miss rule). Only that job closes, and its view shows when it closed.

Adversarial angles:
- A valid reply with "0 jobs" closes every job on the board.
- The ATS renames a field, no job reads cleanly, and the whole board is closed.
- Page 2 of a paged board fails, and every job on page 2 is closed.
- A job that comes back on a later crawl stays closed.

### O6 (MUST) The product never invents job facts

The product never fills in pay, a posted date, a location, a work model or a deadline that the board did not give. A missing value shows as missing, and any value the product reads from the description text matches that text.

Observe: Serve stand-in jobs that lack pay, a posted date and a location, plus one job with pay only in its description. Crawl, then read each stored job and take a screenshot of each job view. No missing field has a value. The posted date is never the crawl date. The pay read from the text equals the text.

Adversarial angles:
- A job with no date shows "Posted today".
- Pay given in cents shows 100 times too large.
- A time-zone shift moves the posted date by one day.
- "Remote" is shown because the location field was empty.

### O7 (MUST) The crawl is polite to every host

The crawl sends at most one request a second to any one host, skips paths that the host's robots.txt disallows, obeys a longer crawl delay, and slows down when a host answers 429 or sends Retry-After. It names itself with the product's own User-Agent.

Observe: Run a crawl against stand-in hosts that log the time and headers of each request. One host serves a robots.txt that disallows one board path and sets a crawl delay of 3 seconds. Another host answers 429 with "Retry-After: 10". In the logs: the gap between requests to one host is at least 1 second (3 seconds for the delay host), the disallowed path gets no request, the 429 host gets no request for 10 seconds, and every request carries the product's User-Agent.

Adversarial angles:
- Two parallel tasks (for example a list call and detail calls) hit the same host at the same time.
- Retries after an error skip the pacing.
- robots.txt is read once and never read again during a long run.
- Different subdomains on one ATS are paced as one host, or one host is paced as many.

### O8 (MUST) No personal data leaves during a crawl

No request made by a crawl carries the user's name, email, phone, resume text, profile answers or search preferences, and a crawl never uploads stored jobs to any server. The only hosts a crawl contacts are the boards' own public hosts.

Observe: Fill the profile with the persona "Jordan Testwell" (jordan.testwell@example.com), a distinctive phone number and a resume that contains a unique token. Run a crawl behind a request-logging proxy. Search every logged URL, header and body for the persona strings. There are zero hits, and no host other than the stand-in boards appears.

Adversarial angles:
- The User-Agent or a "From" header carries an email address.
- The user's target title or city goes into a board's search query or request body.
- An error reporter sends crawl failures, with profile context, to a third party.
- A logo or link-preview fetch contacts a third-party service.

### O9 (MUST) Content from a board never runs as code in jobleft

Markup inside a posting (scripts, event handlers, script links, embedded frames) never runs in jobleft and never makes the app contact another host.

Observe: Serve a stand-in job whose description contains a script tag, an image with an error handler, a "javascript:" link and an iframe, each pointing at a logging stand-in host. Crawl, open the job, click its links, and take a screenshot. The logging host receives no request, and no dialog or unexpected action happens.

Adversarial angles:
- Escaped HTML is unescaped twice and becomes live markup.
- A title or company name (not only the description) carries the markup.
- Personio CDATA or Teamtailor-style RSS content skips the cleaning that JSON content gets.

### O10 (MUST) One job appears once, and different jobs stay apart

A job seen again on a later crawl, or reached through two URL forms, appears once. Two different jobs stay two jobs, even when they share a title and a place.

Observe: Crawl a stand-in board twice. The job count does not change. Serve two jobs with the same title and place but different job IDs. Both appear. Serve one job both through its board URL and through a company-hosted URL that carries the job ID as a query parameter (for example `gh_jid`). One job appears.

Adversarial angles:
- An edited title or description on a later crawl creates a second copy.
- URL tidy-up removes the job-ID parameter and merges different jobs.
- Case or a trailing slash in a URL makes a copy.

### O11 (SHOULD) Paged and large boards are read in full

For an ATS that splits a board into pages, the product reads every page, and the stored job count equals the board's own total with no gaps and no copies. No job is dropped because the product cannot classify it, for example a non-tech or non-US role.

Observe: Serve a stand-in board of 250 jobs across pages, including nurse, driver and non-US roles. Crawl, then compare the stored count and job IDs with the board. Serve a board whose "next page" never ends. The crawl stops it and names it in the crawl report.

Adversarial angles:
- An off-by-one error skips the last job on each page.
- A page cap cuts the board short and says nothing.
- A board's "total" field is missing on some pages and the crawl trusts it.
- The adapter keeps only jobs that match a tech category.

### O12 (SHOULD) Descriptions read as clean text from every ATS

Job descriptions from every supported ATS read as clean text with sections and lists kept. No raw tags, CDATA markers or entity codes (such as `&amp;`) show, and accents and non-Latin characters stay correct.

Observe: Serve stand-in jobs with HTML, escaped HTML, CDATA-wrapped XML, entity codes, accented places ("Zürich", "São Paulo") and Japanese text. Crawl, open each job and take a screenshot. Search the stored text for `<p>`, `&amp;`, `&lt;` and `CDATA`. There are no hits.

Adversarial angles:
- Double-escaped HTML shows as literal tags.
- Bullet lists collapse into one long paragraph.
- Non-ASCII names turn into garbled characters.

### O13 (SHOULD) The user can see the health of each source

After each crawl the user can see, per board and per ATS, when it was last checked, how many jobs it gave, how many were new or closed, and whether it failed and why. A board that used to give jobs and now gives no readable jobs is flagged, not shown as healthy.

Observe: Crawl a mix of good, failing and changed-format stand-in boards. Read the crawl report, or take a screenshot of its screen. The counts match the stand-in boards, and the changed-format board is flagged.

Adversarial angles:
- The report counts requests, not jobs.
- A board where every job failed to read shows "OK, 0 jobs".
- An old error stays on a board after it recovers.
- Per-board counts do not add up to the per-ATS totals.

### O14 (SHOULD) Each job links back to its own posting

Every job links to its own posting or apply page on the employer's ATS, not to a board home page or to a jobleft page, and the employer's name stays visible next to the link.

Observe: For each supported ATS, open a stored job and read its link (screenshot). The link's host and job ID match the stand-in record for that job.

Adversarial angles:
- The link points to the board's list page, so the user must search for the job again.
- A link built from the job ID uses the wrong regional host.
- An external job keeps a tracking or referral parameter that the board did not give.

### O15 (SHOULD) A user can add a company by pasting a URL

A user can paste a board URL or a job URL from any supported ATS, and the product recognises the ATS and the board, shows the company name for confirmation, and starts to show its jobs. A URL the product cannot use gets a clear message, not a silent nothing.

Observe: Following the README, paste one board URL and one job URL for each supported ATS (pointed at stand-in boards) and take a screenshot of each result. Paste a URL on an unknown ATS and a malformed URL. The screenshots show a clear message for each.

Adversarial angles:
- A job URL is read as a board name, and the product adds a board that does not exist.
- The same employer on two country domains becomes two companies, or two employers merge into one.
- A pasted board that fails every crawl never tells the user.
- The paste flow sends a request to an excluded host (see O3).
