# @jobleft/network

The Network tool of jobleft. It works on your own `Connections.csv` (the connections file from your LinkedIn data
archive). It does these things:

- It imports the file on this computer. It keeps every real row exactly as written. It tells you how many people it
  imported and which rows it skipped, with the line number and the reason for each.
- It says "You know N people at <Company>" on job cards, on the job detail and in a company view. The list behind
  the count always holds exactly those N people. Name variants ("Stripe, Inc." and "stripe") join. Different
  companies ("Stripe Partners Ltd", "Apple Leisure Group", "Metaview", "Blockchain Labs") never join.
- It ranks who to message first at a company. Each person gets short reasons. Each reason quotes your file.
- It keeps a coffee-chat plan, stages (To contact, Messaged, Replied, Met, Follow-up due), notes, follow-up dates
  and reminders. A newer file never erases them.
- It shows your target companies (the companies of jobs you liked) where you know someone, and where you know no one yet.
- It drafts a short message with the AI provider you choose (a model on this computer works). A draft uses only
  this contact's name, title and company, the job, and a short summary of you. The app checks each draft for
  invented facts. You copy the draft and send it yourself.
- It deletes one contact, or all network data, for real. Your own file is never touched.

What it never does: it never contacts LinkedIn or any people-lookup or email-finder service. It never guesses an
email. It never opens a profile page by itself. It never sends a message, an email or a connection request. It
never keeps a copy of your file.

Until the app screens and the app server exist, this package brings its own front ends: the command-line tool
`jobleft-network` (`src/cli.ts`) and a small local server with the Network screens (`serve`). Both use the same code
and the same data as the app will. A mock AI provider comes with it. No step below needs the internet.

## 1. What you need

- Node 24 or newer, and pnpm. From the repository root, run `pnpm install` once.
- For the screens: any browser. For the scripted browser check: Google Chrome in `/Applications` (it runs headless
  with a new scratch profile; your own Chrome profile is never used).
- macOS for desktop notifications and for `draft --copy`. Everything else works on any system.

All commands below run from the repository root.

## 2. Set up a test shell

Run this in each terminal that you use:

```sh
export JOBLEFT_HOME=/private/tmp/jl-network-demo      # the data folder (created if missing; delete it when done)
jn() { node packages/network/src/cli.ts "$@"; }        # a shell function; `jn help` lists every command
```

Each `jn` command is a new process, like a new start of the app. The data lives in
`$JOBLEFT_HOME/data/jobleft.db` (SQLite). `jn status` prints where everything is.

Use only made-up people. Never import a real export for a test.

## 3. Make a test file

```sh
jn fixture demo --out /private/tmp/jl-demo-connections.csv
```

You see:

```
Wrote /private/tmp/jl-demo-connections.csv: 31 made-up people, then 2 rows that must be skipped (line 36: duplicate of line 11; line 37: broken row).
```

The file has the 3 note lines of the real export, the header, and 31 made-up people: "Stripe, Inc." (3 people),
"stripe" (1), "Stripe Partners Ltd" (1), "Apple" (2), "Apple Leisure Group" (1), 2 people with a blank company,
"Meta" and "Metaview", "Block" and "Blockchain Labs", quoted commas and accents ("Directora de Ingeniería, Pagos"),
an emoji name, Chinese, Japanese and Hebrew names, two garbled names ("JosÃ©"), placeholders ("Self-employed",
"Stealth Startup"), blank emails, and two different people named Val Stone. Then one duplicate row and one broken row.

`jn fixture demo-newer --out <file>` writes a newer export of the same people: Blake Ormond has a new position, Yara
Voss (Figma) is new, and Jules Varga is gone. `jn fixture synthetic --rows 30000 --out <file>` writes a large file.
You can also write your own file: the header must be
`First Name,Last Name,URL,Email Address,Company,Position,Connected On`.

## 4. The screens

Terminal 1:

```sh
jn serve
```

You see:

```
Network tool running. Open this address (the token is in the # part and never reaches a server):
http://127.0.0.1:47841/#token=<a new random token>
```

Open that address. The page removes the token from the address bar at once. Stop with Ctrl-C; `jn serve` again is a
restart (a new token each time). The screens and `jn` commands can run at the same time on the same data.

| Tab | What you see |
|---|---|
| Import | How to get the file (5 steps) and what it holds: first-degree connections only, many blank emails, some garbled non-Latin names. A file picker. After an import: people imported, rows skipped (each line and reason), new, updated, unchanged, kept from an earlier file, and notes |
| People | Search, filters (stage, follow-up due, in plan, no company). Each person: name (with "name may be garbled" when the export damaged it), title, company, email or "No email in your file", Connected On, stage, follow-up date, note, plan, "Draft a message", "Open profile" (opens that one link in your browser only when you click it), "Delete" |
| Companies | Every company with its count and the names as written. Blank companies are "Unknown company"; Self-employed, Stealth and the like are "No specific company". "Open" shows the company view |
| Jobs | Stand-in jobs (see section 9). Add a job, like it. A card shows "You know N people at <Company>" only when N is 1 or more. Click it for the job detail: the count, how it was made, and who to message first for this job |
| Targets | The companies of liked jobs: "You know someone" with counts and "Add top 2 to plan", then "No one yet" |
| Plan | The coffee-chat plan by company, in rank order, with the next step for each person |
| Due | Follow-ups due today or earlier, and "Check reminders now" |
| Settings | The AI provider for drafts, and the persona the drafts use ("Jordan Testwell") |
| Privacy & delete | What stays on this computer, delete one person, and "Delete all network data" (type DELETE) |

The draft window: choose short (a 300-character connection note) or longer, a job, or "Plain template (no AI)".
It shows where the text goes before you draft. The result is an editable text box with a live character count,
"Ready" or a red list of warnings, the provider, and for publik the cost and the balance left in dollars. "Copy"
copies the text in the box exactly as shown. "I sent it: mark as Messaged" sets the stage.

## 5. The mock AI provider

Terminal 2, a stand-in for a model on this computer:

```sh
jn mock-ai --port 4031 --log /private/tmp/jl-mock-ai.log
```

Terminal 3, a stand-in for the publik API, with a balance of $5.00 and $0.01 for each draft:

```sh
jn mock-ai --port 4032 --publik --balance 5 --price 0.01 --log /private/tmp/jl-mock-publik.log
```

Each mock logs every request with its full body at `http://127.0.0.1:<port>/__admin/log` and in its `--log` file.
Keep those logs outside `$JOBLEFT_HOME`: they hold request bodies on purpose, and jobleft itself never does.

Choose the provider (or use the Settings tab):

```sh
jn ai use local --url http://127.0.0.1:4031             # "stays on this computer"
jn ai use publik --url http://127.0.0.1:4032/api/v1     # "the text leaves this computer"
jn ai use custom --url http://127.0.0.1:4031            # a custom address (treated as remote)
jn ai use none                                          # drafts then offer the plain template
```

In this build, every AI address must be on this computer (127.0.0.1 or localhost). Any other address is refused.

Change the mock's behaviour while it runs:

```sh
curl -s -X POST http://127.0.0.1:4031/__admin/mode -H 'content-type: application/json' -d '{"mode":"bad"}'
```

| Mode | The mock answers |
|---|---|
| `ok` | A true draft built only from the facts in the request |
| `bad` | A wrong first name ("Hi Taylor") and an invented shared employer ("great working with you at Initech") |
| `invent` | "we worked together at Initech", "great to reconnect", "You offered to refer me when we met" |
| `wrong-name` | Greets "Taylor" |
| `numbers` | "7 years of experience", "a team of 12" |
| `placeholder` | "{first_name}" and "[Your Name]" |
| `markup` | Markdown, HTML tags, zero-width characters and a "Here is a draft:" line |
| `long` | About 1,500 characters |
| `custom` | The exact text you set: `{"mode":"custom","text":"..."}` |
| `empty`, `error500`, `slow` | An empty answer; HTTP 500; a delay (`"slowMs"`) |

For publik: `POST /__admin/balance {"usd":0}` sets the balance. `GET /__admin/state` shows the balance and mode.

## 6. How to check each outcome

The outcomes are in `docs/outcomes/network.md`. `jn` is the shell function from section 2.

### O1. The import keeps every real row and reports what it skipped

```sh
jn import /private/tmp/jl-demo-connections.csv
```

```
Imported 31 people from the file: 31 new, 0 updated, 0 unchanged.
Skipped 2 rows:
  line 36: Duplicate: the same profile link as line 11. Line 11 was kept.
  line 37: Broken row: it has 3 fields, but the header has 7.
People in your network now: 31.
Notes:
  2 names look garbled by the export. They are shown exactly as in the file.
  26 of 31 people have no email address in the file (normal for this export). No email is guessed.
```

`jn list --limit 100` lists the 31 people and no one else. `jn list --q Núñez` shows the position
`Directora de Ingeniería, Pagos` and the company `Acme Robotics, LLC` exactly as in the file.

Rules you can test:

- The note lines above the header never become people. A byte-order mark, Windows line endings, a semicolon or tab
  file, a UTF-16 file and a Windows-1252 re-save are all read.
- A quote that opens and never closes breaks only its own line. The rows after it are kept.
- A row with too few or too many fields is skipped with the count ("it has 8 fields, but the header has 7 (a comma
  outside quotes may have split a field)"). The fields of the other rows never shift.
- A duplicate row (the same profile link, or every field the same when there is no link) is skipped and names the
  line that was kept. Two people with the same name and different links stay two people.
- Another CSV (for example `messages.csv` from the same archive, or a spreadsheet export) is refused: "Not imported.
  This is not a connections file: no header row with First Name, Last Name, Company, Position and Connected On was
  found... It looks like messages.csv from the same archive. Pick Connections.csv instead." Nothing you had changes.
  The exit code is 2.

### O2 and O3. Data stays on the laptop; no contact with the professional network; nothing is sent

- The only outbound connection the tool can open is to the AI address you chose, and in this build that address must
  be on 127.0.0.1. Import, match, rank, track and delete work with the network off.
- No avatar, logo, font or script loads from the internet. The screens send `Content-Security-Policy` with
  `connect-src 'self'` and `X-DNS-Prefetch-Control: off`, and show profile links as buttons, not links, so the
  browser does not even look up linkedin.com until you click one.
- There is no "send", "message all", "enrich" or "find email" control. `draft --copy` and the Copy button only put
  text on your clipboard.
- The data folder holds `data/jobleft.db`, `network-dev/standin.json` (stand-in jobs, persona, AI address; no
  connection data), `run/network-dev.json` while `serve` runs, and `logs/network-dev.log` (method, route name,
  status, time; no data). There is no copy of your file.
- `node packages/network/scripts/ui-check.ts` walks the screens in headless Chrome and fails if the page makes any
  request outside 127.0.0.1.

### O4. "You know N people at <Company>" is correct

```sh
jn count "Stripe"                  # You know 4 people at Stripe: then the 4 names ("Stripe, Inc." x3, "stripe" x1)
jn count "Apple"                   # You know 2 people at Apple:
jn count "Figma"                   # You know no one at Figma in your connections file.
jn explain "Stripe"
```

```
Stripe: 4 people counted (company key "stripe").
  counted  "Stripe, Inc." (3): Same company name once the legal suffix "inc" is ignored.
  counted  "stripe" (1): Same name; only upper and lower case differ.
  not counted  "Stripe Partners Ltd" (1): Not counted: "Stripe Partners Ltd" has the extra word "partners", so it can be a different company.
```

On the screens: add a job at "Stripe" and one at "Apple" in the Jobs tab. The Stripe card says "You know 4 people
at Stripe"; opening it lists exactly 4. A job at a company where you know no one shows no line. `jn list --no-company`
shows the 2 blank-company people and the placeholders; they match no job, and a job with a blank company shows nothing.

The rule: a person counts only when the two names give the same key. The key ignores case, accents, punctuation,
"&" versus "and", a leading "The" and legal suffixes (Inc., LLC, Corp, Ltd, Co., GmbH and similar). It never drops an
ordinary word, so "Meta" is not "Metaview", "Block" is not "Blockchain Labs" and "Apple" is not "Apple Leisure Group".
A short form in brackets at the end ("Amazon Web Services (AWS)") also matches without the brackets.

### O5. Who to message first, with true reasons

```sh
jn jobs add --title "Backend Engineer" --company "Stripe" --department Engineering --like
jn rank "Stripe" --job "Backend Engineer"
```

```
Who to message first at Stripe for "Backend Engineer":
1. Devon Marsh (Senior Recruiting Coordinator)  score 48  [c_8916900b877a2e2ed4c2]
     - Company in your file: "stripe".
     - Works in recruiting: the title is "Senior Recruiting Coordinator".
     - Senior title: "Senior Recruiting Coordinator".
     - Connected 2 years ago (17 Jul 2024).
     - Has an email address in your file.
2. Avery Quill (Technical Recruiter)  score 45  ...
3. Blake Ormond (Engineering Manager, Payments)  score 44  ...
     - Same field as the job (engineering): the title is "Engineering Manager, Payments", the job is "Backend Engineer".
     - A manager title in the job's field (engineering).
4. Casey Brandt (Software Engineer II)  score 20  ...
     - Connected 11 years ago (14 Mar 2015), a long time.
```

(The "Connected ... ago" reasons depend on today's date.) Run it again, or after `jn serve` restarts: the order is
the same. Ties break by last name, first name, then id; ids come from the profile link, so a fresh import of the same
file gives the same ids. Points: recruiter 30, same field as the job 20, a manager, director or VP title in that field
+10, seniority 1 to 8, connected within a year 10 (within 3 years 6, within 7 years 3), an email in the file 5, not in
your latest file -5. Every reason quotes the title or the date from your file. No reason says "same school", "same
team" or "hiring manager for this job". "Senior Recruiting Coordinator" is a senior recruiter, not an executive;
"Executive Assistant to the CEO", "Account Executive" and "Chief of Staff" are not executives.

Add an email to one person in the file and import it again: only that person's reasons change ("Has an email
address in your file", +5).

### O6. A draft never invents facts

```sh
jn ai use local --url http://127.0.0.1:4031
jn draft "Avery Quill" --job "Backend Engineer"
```

```
Draft for Avery Quill (short, 153/300 characters, by local:mock-draft-7b):
-----
Hi Avery, I'm Jordan Testwell. I'm interested in the Backend Engineer role at Stripe and would value your perspective. Would you be open to a short chat?
-----
Ready: no unsupported claim found. Read it, change it if you like, and send it yourself.
```

Set the mock to `bad` (section 5) and draft again:

```
Hi Taylor, it was great working with you at Initech! I'm Jordan Testwell. Could you refer me for the Backend Engineer role at Stripe?
-----
NOT READY. Check these before you send anything:
  ! Greets "Taylor", but this contact's first name is "Avery".
  ! Claims a shared past that your file does not show: "working with you at Initech".
  ! Names "Initech", which is not the job's company, the contact's company or your profile.
```

The check flags: a greeting to another name; claims of a shared past, school or employer, a past meeting or talk,
or a referral promise; any number, name, company, school or job title that is not in the inputs; placeholders;
email addresses and links; and a draft over its limit (300 characters short, 1,200 long). A draft with any warning
has `ready: false`. Markup and hidden characters are removed first. The words are never changed.

The claim checks read the structure of a statement, not one phrasing. The contact's row holds only a name, a title,
a company and "Connected On", so any statement about what you and the contact did, said, studied or promised is
unsupported, even when the school or company named is yours (your school is in the inputs, so a name check alone
cannot catch "Since we both graduated from Sample State University"). Each of these is flagged, in any wording:
"we" or "both of us" with a past verb, "fellow", "mutual" or "same" with a school or employer word, "you" with a past
verb ("you said", "you offered", "you also went to"), thanks for a past favor ("thanks again for the help", "thanks for
offering to refer me"), "your offer", "as promised", "following up on", "I remember", and "your talk", "your post" or an
event ("at the state nursing summit"). A question is not a claim ("Have you worked with new nurses?"), and asking for
advice, a chat or a referral is allowed. Try it with the mock in `custom` mode:
`{"mode":"custom","text":"Hi Avery, You said you would put in a good word for me."}` then `jn draft "Avery Quill"`.

### O7. The draft belongs to you

- Screens: draft, change one word in the box, press Copy, paste into a text editor: the text is the text in the box,
  with your change. `scripts/ui-check.ts` checks this through the real clipboard.
- CLI: `jn draft "Avery Quill" --copy` (macOS) or `--out <file>` writes exactly the text shown between the lines.
- A local model works: `jn ai use local --url http://127.0.0.1:4031` (or a real local server on 127.0.0.1).
- publik: `jn ai use publik --url http://127.0.0.1:4032/api/v1`, then `jn draft "Blake Ormond" --yes`:
  `Cost: $0.01 from your publik balance. Balance left: $4.99.` The screens show the same line. The word "credits"
  appears nowhere.
- With no provider: `jn ai use none` then `jn draft "Avery Quill"`: "No AI provider is set up. Run `ai use local
  --url <address>` (a model on this computer works), or add --template for the plain template." The screens show
  the same message and a "Use the plain template" button. `--template` builds a draft from the inputs with no AI.
- At balance $0.00: "No draft: Your publik balance ran out ($0.00 left). Add money, then draft again." and one
  "Add money:" link.

### O8. A draft request sends only what that draft needs

```sh
jn preview "Blake Ormond"           # exactly what a draft sends, and to whom; sends nothing
curl -s http://127.0.0.1:4031/__admin/log     # after a draft: the request bodies the mock received
```

A request holds the contact's first name, last name, title and company, the job's title and company, and a short
summary of you ("Name: Jordan Testwell. Current role: ... Skills: ..."). It never holds another person, an email
address, a profile link or your own contact details. If a title or company in your file itself holds an email address
or a link, the request carries "[email removed]" or "[link removed]" in its place.

Before the first draft to a remote provider (publik or a custom address), you must confirm. CLI: it shows what goes
where and asks `Send to publik (stand-in at 127.0.0.1:4032)? [y/N]` (or add `--yes`). Screens: the draft window
shows "Before the first draft with ..." and the exact facts, with "Send to ... and draft". Nothing reaches the
provider before you confirm (the mock's log shows no request). A model on this computer needs no confirmation.
No draft and no request body is stored.

### O9. Tracking survives restarts and re-imports

```sh
jn stage "Avery Quill" messaged
jn note "Avery Quill" "Asked about the payments team."
jn follow-up "Avery Quill" 2026-10-02
jn stage "Blake Ormond" replied; jn note "Blake Ormond" "Coffee on Tuesday"
jn stage "Jules Varga" met; jn note "Jules Varga" "Met at a meetup"
jn fixture demo-newer --out /private/tmp/jl-demo-connections-newer.csv
jn import /private/tmp/jl-demo-connections-newer.csv
```

```
Imported 31 people from the file: 1 new, 1 updated, 29 unchanged.
Skipped 0 rows.
Kept 1 person from an earlier import who is not in this file.
...
  1 person from an earlier import is not in this file. They are kept with their stages and notes and marked "not in latest file". Delete them one by one if you want.
```

`jn show "Blake Ormond"` shows the new position with stage Replied and the note. `jn show "Jules Varga"` shows
"not in latest file" with the note. `jn show "Yara Voss"` is To contact. No one is duplicated (`jn status`: 32 people).

Reminders: `jn follow-up "Avery Quill" today`, then `jn remind`: "1 network follow-up is due. Open Network > Follow-ups to
see who. (desktop notification shown)". `jn due` lists the person. Each date reminds once; a missed reminder shows at
the next start. With `jn serve` running, a follow-up set to today shows a notification at once (and the server checks
every 30 seconds). The notification holds a count, never a name. macOS shows it as coming from "Script Editor"; if
nothing appears, allow notifications for Script Editor in System Settings > Notifications. "Today" is your own
calendar date in your time zone (`JOBLEFT_TZ=America/Chicago` sets it; `JOBLEFT_NOW=2026-10-02T12:00:00Z` moves the
clock for a test).

### O10. Delete removes all of it

```sh
jn delete "Casey Brandt"                        # only that person
jn delete-all --yes                             # everything; the screens: Privacy & delete, type DELETE
grep -rlaF -e "Quill" -e "avery.quill@example.com" -e "Coffee on Tuesday" "$JOBLEFT_HOME"   # no output
shasum /private/tmp/jl-demo-connections.csv     # the same as before
```

`jn delete-all --yes` prints "Deleted all network data: 31 people with their notes, stages, dates and plan. Your own
file was not touched." After that, `jn list --q Quill` finds no one and no job card says "You know". Deletes are
real: the database overwrites deleted text with zeros (`secure_delete`) and empties its write-ahead log, so a byte
search of every file in the data folder finds nothing, also while `jn serve` is running. No draft, note history or
search index is kept anywhere else. `DELETE /api/v1/network` answers `{"ok":true,"deleted":31,"logCleared":true}`;
`logCleared` is false only when another program kept the database busy during the delete (the screens then say so,
and the next start finishes the job).

### O11. Other web pages cannot read the network

With `jn serve` running (the token is in `$JOBLEFT_HOME/run/network-dev.json`, mode 0600):

```sh
PORT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.JOBLEFT_HOME+'/run/network-dev.json')).port)")
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.JOBLEFT_HOME+'/run/network-dev.json')).token)")
curl -s http://127.0.0.1:$PORT/api/v1/network/contacts                                        # 401 unauthorized
curl -s "http://127.0.0.1:$PORT/api/v1/network/contacts?token=$TOKEN"                         # 401: tokens in a URL are refused
curl -s -H "x-jobleft-token: $TOKEN" -H "Origin: https://evil.example" http://127.0.0.1:$PORT/api/v1/network/contacts   # 403 forbidden_origin
curl -s -H "x-jobleft-token: $TOKEN" -H "Origin: null" http://127.0.0.1:$PORT/api/v1/network/contacts                  # 403 forbidden_origin
curl -s -H "x-jobleft-token: $TOKEN" -H "Host: 127.0.0.1.attacker.example:$PORT" http://127.0.0.1:$PORT/api/v1/network/contacts   # 403 forbidden_host
curl -s -X POST -H "x-jobleft-token: $TOKEN" -H "content-type: text/plain" --data '{}' http://127.0.0.1:$PORT/api/v1/network/plan  # 415
curl -s -H "x-jobleft-token: $TOKEN" "http://127.0.0.1:$PORT/api/v1/network/contacts?companyKey=stripe"                 # 200, the 4 people
```

The server listens on 127.0.0.1 only. It never sends an `Access-Control-Allow-Origin` header, so a page on another
origin can never read an answer. A paired browser extension origin is refused too: the extension gets no network
data. Error answers never hold a name, an email, a note or a row. `GET /api/v1/health` answers without a token and
holds no data.

### O12. Missing or garbled data stays visibly missing

The Import tab states the steps and the three limits. `jn list --q Ormond` shows "email: (none in the file)".
`jn list --q Garc` shows `JosÃ© GarcÃ­a  [name may be garbled by the export; shown as in the file]`. A correct
Chinese, Japanese or Hebrew name (张 伟, 山田 太郎, דוד כהן) is not marked. A blank company shows as "(no company in
the file)" and belongs to the "Unknown company" group; it never takes the company of the row above. No email is ever
guessed, and a name is never "repaired".

### O13. Companies where you know nobody

```sh
jn jobs add --title "Backend Engineer" --company "Stripe" --like      # A: you know people here
jn jobs add --title "Product Designer" --company "Figma" --like       # B
jn jobs add --title "Data Analyst" --company "Northwind Traders" --like   # C
jn coverage
```

```
Target companies where you know someone:
  Stripe: 4 (top: Devon Marsh, Avery Quill, Blake Ormond)
Target companies where you know no one yet:
  Figma: no one yet
  Northwind Traders: no one yet
```

Import the newer file (it adds Yara Voss at Figma): Figma moves to the known group. `jn plan top "Stripe" --n 2`
(or "Add top 2 to plan" in Targets) puts the top two people in the plan; `jn plan` and `jn list --in-plan` show them,
in To contact. If no connections are imported, `coverage` and the Targets tab say so first. A failed import changes
nothing.

### O14. Large files import fast and do not slow the app

```sh
jn bench --rows 30000 --jobs 2000
```

It makes a made-up 30,000-row file in a temporary folder under `/private/tmp` (deleted after), times the import, and
times a job feed of 2,000 jobs in pages of 50 before and after the import. On an Apple-silicon Mac the import takes
under 1 second (the bar is 30 seconds). Job cards read counts from one map kept in memory and rebuilt only when the
network data changes, so the feed does not query per card. Files up to 10 MiB import through the screens; the CLI
has no size limit. The import runs in one transaction: it finishes, or nothing changes.

## 7. HTTP endpoints

The network routes follow `docs/INTERFACES.md` section 6.4. Every route needs the `x-jobleft-token` header.

| Route | Method and path |
|---|---|
| `importNetwork` | `POST /api/v1/network/import` with the file bytes as `text/csv` or `text/plain` |
| `listContacts` | `GET /api/v1/network/contacts?companyKey=&stage=&q=&due=&inPlan=&noCompany=&limit=&offset=` |
| `networkCompanies` | `GET /api/v1/network/companies` |
| `explainCompanyMatch` | `GET /api/v1/network/match?companyKey=stripe&companyName=Stripe` |
| `rankContacts` | `GET /api/v1/network/rank?companyKey=stripe&jobId=<id>` |
| `networkCoverage` | `GET /api/v1/network/coverage` |
| `planTopContacts`, `networkPlan` | `POST /api/v1/network/plan {"companyKey":"stripe","count":2}`, `GET /api/v1/network/plan` |
| `updateContact` | `PATCH /api/v1/network/contacts/<id> {"stage":"messaged","note":"...","followUpOn":"2026-10-02","inPlan":true}` |
| `previewDraft` | `POST /api/v1/network/contacts/<id>/draft/preview {"variant":"short","jobId":"<id>"}` |
| `draftOutreach` | `POST /api/v1/network/contacts/<id>/draft {"variant":"short","jobId":"<id>"}`; add `"confirmRemote":true` after the 409 for a remote provider, or `"template":true` for no AI |
| `deleteContact`, `deleteNetwork` | `DELETE /api/v1/network/contacts/<id>`, `DELETE /api/v1/network` |
| `listNotifications` | `GET /api/v1/notifications` (due follow-up reminders waiting to be shown) |

Stand-in routes of this tool only (section 9): `GET|POST /api/v1/network-dev/jobs`, `GET|DELETE
/api/v1/network-dev/jobs/<id>`, `POST /api/v1/network-dev/jobs/<id>/like {"liked":true}`,
`GET|PUT /api/v1/network-dev/profile`, `GET|PUT /api/v1/network-dev/ai {"provider":"local","baseUrl":"http://127.0.0.1:4031"}`,
`GET /api/v1/network-dev/status`, `POST /api/v1/network-dev/reminders/check {}`.

## 8. All commands

`jn help` prints the full list. In short:

```
import <file> [--json] · status · list [--company <name>] [--no-company] [--stage <s>] [--q <text>] [--due] [--in-plan] [--limit <n>] [--json]
show <contact> · companies · count <company> · explain <company> · rank <company> [--job <id or title>] · coverage
plan · plan top <company> [--n 2] [--job <id or title>] · plan add <contact> · plan remove <contact>
stage <contact> <to_contact|messaged|replied|met|follow_up_due> · note <contact> <text> | --clear
follow-up <contact> <YYYY-MM-DD|today|tomorrow|clear> · due · remind
ai show | ai use local|custom|publik --url <address> [--model <m>] | ai use none
preview <contact> [--job ...] [--variant short|long] · draft <contact> [--job ...] [--variant short|long] [--template] [--yes] [--copy] [--out <file>] [--json]
delete <contact> · delete-all --yes
jobs list|add|like|unlike|remove|clear|import <file.json>|seed --synthetic <n> · profile show | profile set --first ... --skills a,b
serve [--port <p>] [--no-notify] [--offline] · mock-ai [...] · fixture demo|demo-newer|synthetic ... · bench [--rows] [--jobs]
```

A `<contact>` is an id from `list`, the start of an id, or a name in quotes ("Avery Quill"). When a name matches more
than one person, the command lists the ids and does nothing.

## 9. What is interim in this build

| Part | In this package now | In the app later |
|---|---|---|
| Jobs and likes | Stand-in jobs you add (`jn jobs ...`, Jobs tab), in `network-dev/standin.json` | The store's jobs and tracker (liked, applied, tracked jobs are the targets) |
| Your profile | The made-up persona "Jordan Testwell" (`jn profile ...`, Settings tab) | The real profile, through `profileSummary(profile)` |
| AI provider | An interim OpenAI-style client, addresses on 127.0.0.1 only; publik through the local stand-in | `@jobleft/ai-engine` (`AiEngine.client()`): local servers, custom addresses, own keys, the real publik connection |
| Company key | `@jobleft/static-data` `companyKey` when that lane is built in the checkout; otherwise an interim key with the same documented rules (`jn status` says which). Stored keys are rebuilt when the key function changes | `@jobleft/static-data` `companyKey` |
| Screens and server | `jn serve` (plain HTML, 127.0.0.1:47841 to 47850) | apps/ui and apps/server call the same routes (`handleNetworkRoute`) |

## 10. Tests

```sh
pnpm --filter @jobleft/network test          # 52 unit and route tests (node --test "test/*.test.ts")
pnpm --filter @jobleft/network typecheck     # tsc, no output files
node evals/network/csv-fixtures/run.ts       # probe for O1 and O4: 96 labelled checks, prints one JSON line
node packages/network/scripts/ui-check.ts    # headless Chrome walk through the screens (19 checks), screenshots in /private/tmp/jobleft-network-ui
```

When you are done: `rm -rf /private/tmp/jl-network-demo /private/tmp/jl-demo-connections*.csv /private/tmp/jl-mock-*.log`.
