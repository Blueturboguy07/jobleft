# Acceptance outcomes: local server and API

Area: the local server (the jobsync fork) and the HTTP API that the app window and the paired browser extension use.
Status: draft, 2026-09-25.
Sources read: `docs/PLAN.md` sections 1 to 8, `jobright-research/GAPS.md`, audit 02 (jobsync), audit 04 (desktop embedding section).

This file says what a person or a stranger must be able to see. It does not say how to build it.

## Words used in this file

| Word | Meaning |
|---|---|
| the app | The jobleft desktop app: its window, its tray item and its local server |
| the server | The local HTTP server that the app starts |
| the person | The one local user of the app |
| the data folder | The one folder that holds the person's data |
| the secret | Anything that proves to the server that a caller is the app or the paired extension. This file does not fix its form |
| confirmed save | The app shows that a change is saved, or the API returns success for a write |
| refused | The server returns an error status, changes nothing, and the reply holds no personal data |
| a stranger | A tester who has the built app, the README and `docs/INTERFACES.md`, but not the source code |

## Rules for every observer

- Use a scratch data folder and the test persona "Jordan Testwell" (jordan.testwell@example.com). Use no real personal data.
- Use headless Chrome with a scratch profile for browser tests. Do not use a real browser profile.
- Point publik, AI provider and job-board URLs at local mock servers. Make no live request to publikhq.com.
- "Count per kind" means the number of records of each kind (jobs, tracked jobs, notes, resumes, contacts, and so on), read through the API.

---

### O1 (MUST) Only the app can use the server

Only the app and an extension that the person paired can read or change the person's data. Another program on the same Mac, another user account on the Mac, or any device on the network gets a refusal and learns nothing.

Observe:
1. Start the app with the test persona loaded.
2. Run `lsof -nP -iTCP -sTCP:LISTEN`. Every port that an app process opens listens on 127.0.0.1 or ::1 only.
3. Call each data endpoint in `docs/INTERFACES.md` with `curl`, first with no secret, then with a wrong secret. Each call is refused.
4. Read the same data with the secret. Nothing changed.
5. From a second machine or VM on the same network, try to connect to each app port. Each connection fails.
6. Run `ls -l` on the data folder. Files that hold the secret or personal data are not readable by other user accounts.
7. Copy the secret, restart the app, and use the old secret. It is refused.

Adversarial angles:
- A health, status or version endpoint answers without the secret and shows the persona's name, the data-folder path or job counts.
- The server accepts the secret in a URL query string, so the secret goes into browser history and logs.
- A second port (a debug inspector, a dev server, a scheduler) listens on all interfaces, or on the IPv6 wildcard.
- The secret is the same on every install, or a secret from an earlier run still works.

### O2 (MUST) A web page can never reach the person's data

A web page that the person opens in any browser can never read, change or delete the person's data through the server. This includes a page that uses DNS tricks to pose as a local address.

Observe:
1. Serve a test page from a different local port (for example `python3 -m http.server 8099`). Open it in headless Chrome.
2. From the page, try each of these against each documented endpoint: `fetch` with and without credentials, a plain HTML form POST, an image or script tag, and a request from a sandboxed iframe (Origin "null").
3. Read the count per kind through the API before and after. No count and no record changed.
4. Check each reply. No reply carries an `Access-Control-Allow-Origin` header with the test origin, "null" or "*". The page reads no reply body.
5. Send a request with the correct secret and a foreign Host header: `curl --resolve attacker.example:<port>:127.0.0.1 http://attacker.example:<port>/...`. It is refused.

Adversarial angles:
- A cross-site form POST with a plain-text body changes data, although the page cannot read the reply.
- The server copies any Origin into its reply headers, or it trusts Origin "null".
- The secret sits in a cookie, so the browser sends it with cross-site requests on its own.
- The Host check accepts any name that contains "localhost" or "127.0.0.1", such as `127.0.0.1.attacker.example`.

### O3 (MUST) The person controls extension pairing

The browser extension gets access only after the person approves it inside the app. The person can see each paired extension and unpair it. An unpaired extension loses access at once.

Observe:
1. Follow the pairing steps in `docs/INTERFACES.md` with a test extension build or a `curl` script.
2. Before the person approves in the app, call each extension endpoint. Each call is refused.
3. Approve in the app. Take a screenshot of the list of paired items. The documented extension calls now work.
4. Call an endpoint that the extension does not need, such as backup or provider settings. It is refused.
5. Unpair in the app. Repeat a call. It is refused.
6. Restart the app. The pairing list is as the person left it.

Adversarial angles:
- Pairing completes with no action by the person, or a web page can trigger the approval.
- The server allows unlimited guesses at a pairing code.
- A paired extension can read stored provider keys, the publik key or a full backup.
- Unpairing removes the item from the list, but the old secret still works.

### O4 (MUST) Every confirmed save survives restarts and crashes

After a confirmed save, the change is still there after a quit, a force quit, a crash or a reboot. This covers profile, preferences, resumes and uploaded files, tracker status, notes, likes, reminders, saved filters, contacts, the network import and chat history.

Observe:
1. With the test persona, make one change of each kind in the list above. Take a screenshot of each result.
2. Within one second of each confirmed save, stop every app process with `kill -9`.
3. Launch the app again. Take the same screenshots and compare them.
4. Read each record through the API. All changes are there, with the same text, dates and order.

Adversarial angles:
- The server confirms a save before the data is on disk, so a force quit loses the last change.
- Text with non-Latin characters, emoji or a very long note comes back changed or cut.
- A date or a reminder time moves by some hours after a restart because of time-zone handling.
- An uploaded resume file is lost while its record stays, or the reverse.

### O5 (MUST) The app never loses or overwrites data in silence

When a save fails, the person sees a clear error, and the data from before the attempt stays intact. A background task (a crawl, a poll, a match run) never overwrites or deletes a change that the person made.

Observe:
1. Make writes fail: put the data folder on a small, full disk image (made with `hdiutil`), or make its files read-only while the app runs. The README must say how to choose the data folder for a test.
2. Try a save. Take a screenshot of the error. The API returns an error status, not success.
3. Free the space, restart, and read the data. The data from before the attempt is intact. No half-written record exists.
4. Track a job from a mock board. Set a status, a like and a note on it. Then change the job on the mock board and run a crawl as the README says.
5. After the crawl, read the job. The person's status, like and note are unchanged.
6. Remove the job from the mock board and crawl again. The tracked job and its notes stay in the tracker, marked as closed.

Adversarial angles:
- The API returns success, or the app shows "saved", for a write that failed.
- A change that spans several records is saved in part (for example, a status change with no history entry).
- A crawl refresh replaces the person's edits with the posting's data.
- A closed posting takes the person's tracked job and notes with it.

### O6 (MUST) All data lives in one folder

All of the person's data lives in one folder, and the app tells the person where it is. The app writes no personal data anywhere else. The one exception is secrets that the app keeps in the system's protected secret store, if it uses one.

Observe:
1. Read the folder path from the app's settings screen (take a screenshot) or from the README.
2. Run `touch /private/tmp/marker`.
3. Use the app for a full session with the test persona: import a resume, edit the profile, add notes, generate a document, run a chat.
4. Run `find ~ /private/tmp /private/var/folders -newer /private/tmp/marker -type f`. Search each file outside the data folder for "Testwell" and "jordan.testwell". There are no hits.

Adversarial angles:
- Temporary copies of resumes or generated PDFs stay in a temp folder after use.
- Log files outside the data folder hold resume text, prompts, chat text or the persona's email.
- The web view's own cache or storage keeps a second copy of profile data.
- Two copies of the database exist, and the app reads one but backs up the other.

### O7 (MUST) Backup and restore bring back everything

The person can make one backup file and restore it into a fresh install on the same Mac or on another Mac. After the restore, every kind of item from O4 is back, uploaded files included. A damaged or foreign file is refused, and the current data stays as it was.

Observe:
1. Seed the test persona with at least one item of each kind from O4.
2. Make a backup in the way the README or the app documents.
3. Record the count per kind. Record the SHA-256 of each uploaded file as the API serves it.
4. Delete the data folder, or use a second macOS user or a VM. Install the app and restore the backup.
5. Compare counts, hashes and screenshots. They match.
6. Try to restore a cut-short backup, a random zip file and a backup with one changed byte. Each is refused with a clear message. The current data is unchanged.

Adversarial angles:
- The backup holds the records but not the uploaded resumes or the generated documents.
- The backup leaves out crawled jobs, and the liked or tracked jobs that point at them come back empty.
- Restore mixes old and current data without telling the person, and makes duplicates.
- A crafted backup writes files outside the data folder when it is restored (for example with `../` paths).

### O8 (MUST) Secrets and personal text never leak into backups, logs or error replies

A backup, an export or a log file never holds the person's AI provider keys, the publik key, or any server or pairing secret in readable form. Error replies and logs never hold resume text, chat text or the persona's contact details.

Observe:
1. Enter fake keys with unique markers (for example `sk-test-MARKER123`) in each provider setting. Pair a test extension.
2. Make a backup and each documented export. Unpack them. Search them for the markers and for the current secrets. There are no hits.
3. Send malformed requests to each documented endpoint. No error reply holds a stack trace, a file path with the account name, a database query or personal text.
4. Search the app's log files for "Testwell", "jordan.testwell" and the markers. There are no hits.

Adversarial angles:
- The backup holds the keys in encrypted form, and the key that decrypts them is in the same backup.
- A crash report or debug log prints a full request, with its secret header or the resume text.
- A server error returns a stack trace that shows `/Users/<name>/...`.
- A CSV export includes a settings table.

### O9 (MUST) The server starts fast on a free port and stays responsive

The app shows the person's data within 5 seconds of launch, with 100,000 stored jobs, on an Apple-silicon Mac. If the usual port is busy, the app still starts and works. The API answers reads within 1 second while a background crawl runs.

Observe:
1. Store 100,000 jobs through a crawl of mock boards, or through a seed command if the README lists one.
2. Launch the app 5 times. Record the time from launch to the first screen with data. Each run takes 5 seconds or less.
3. Hold the port from the last run with `nc -l <port>`, and hold some common ports too. Launch the app. It works.
4. Start a crawl of mock boards. During the crawl, time 20 documented read calls. Each answers within 1 second.
5. Launch the app a second time (`open -n`). Check `ps` and `lsof +D <data folder>`. Only one server uses the data folder, and the first window still works.

Adversarial angles:
- The app uses a fixed port and shows a blank window when that port is taken.
- The server moves to a free port, but the paired extension or another part of the app still calls the old port.
- Startup waits for a catch-up crawl, an update check or an embedding task before it shows data.
- Two servers write to the same data at the same time and corrupt it or lose writes.

### O10 (MUST) The app works offline

With no network, the app starts, and every feature that needs no network works: profile, resumes, tracker, notes, saved and liked jobs, search over stored jobs, backup and restore. A feature that needs the network says so plainly within 10 seconds and does not hang.

Observe:
1. Turn off all network interfaces. Do this once for a fresh install and once for an app with existing data.
2. Launch the app. Use each feature in the list above. Take a screenshot of each.
3. Try a crawl and an AI call that uses publik. Each shows a clear message within 10 seconds.
4. Turn the network on again. Read the job counts. No stored job changed state because of the offline period.

Adversarial angles:
- The first run needs a download (a database tool, fonts, a model or a board directory) and fails offline.
- The window loads scripts or fonts from the internet and looks broken offline.
- Startup waits for a balance check or an update check.
- An offline crawl run marks every job as closed because every board seemed to vanish.

### O11 (MUST) The app shuts down cleanly

When the person quits the app, the server and every helper process stop, and the port is free. The next launch needs no repair step. If the app shell crashes, the server stops on its own within 10 seconds.

Observe:
1. Quit the app in the documented way (menu or tray).
2. After 5 seconds, run `ps` and `lsof -nP -iTCP -sTCP:LISTEN`. No app process and no app port remain.
3. Launch again. No "database locked" or recovery message shows, and all data is there.
4. Stop only the shell process with `kill -9`. Within 10 seconds, the server process is gone.
5. Quit during a crawl and during a save. On the next launch, every confirmed save is there.

Adversarial angles:
- After a crash, a server with no parent keeps running, holds the data and still accepts the old secret.
- Quit waits minutes for a crawl or a model call to end, and the system has to force it.
- A leftover lock file stops the next launch.
- A background helper (the poller or the embedder) keeps running and using CPU after quit.

### O12 (MUST) Upgrades keep the person's data

When a newer version opens a data folder from an older version, it keeps every item. If an upgrade step fails, the app says so, leaves the old data untouched, and does not run on half-upgraded data. An older version never damages data that a newer version wrote.

Observe:
1. Use a data folder from the oldest supported release, or a fixture folder that the repo ships for this test.
2. Record the count per kind and the file hashes through the old version's API.
3. Launch the new version. Compare the counts and hashes. They match.
4. Make the upgrade fail (make the folder read-only, or fill the disk). Record `shasum -a 256` of the data files before and after. The app shows a clear error, and the hashes match.
5. Open a newer data folder with the older version. It refuses with a clear message, and the files are unchanged.

Adversarial angles:
- An upgrade that fails halfway leaves data that neither version can open.
- The upgrade needs the network.
- New fields get default values that look like real facts (for example, every old job gets today's posted date).
- The older version opens a newer folder and drops the fields it does not know.

### O13 (MUST) The server never invents or changes a fact

The API and the app show each stored value exactly as stored. A missing value stays missing and shows as unknown. The server never fills a gap with a guess: no crawl time as a posted date, no $0 salary, and no "no H-1B sponsor" when there was no match.

Observe:
1. Put jobs on a mock board, or add them through the documented write endpoint. Some jobs have pay, a posted date, a location, a work model and years of experience. Others miss one or more of these.
2. Read each job through the API. A missing field is null or absent. A present field matches the source to the cent, to the day and character for character.
3. Take screenshots of the card and the detail page of each job. Each missing field shows as not listed, not as a value.

Adversarial angles:
- A missing posted date comes back as the time of the crawl or the time of import.
- Pay of "$120K to $150K" is stored as 120000 only, or hourly pay shows as yearly pay.
- A date near midnight moves by one day because of time zones.
- One endpoint returns an empty field as an empty string and another returns null, so the page shows "$0" or "0 years".

### O14 (SHOULD) The API is documented and has no hidden doors

`docs/INTERFACES.md` lists every endpoint that the server answers. Each endpoint behaves as the document says and rejects bad input with a clear message. No endpoint serves a file from outside the data folder.

Observe:
1. For each documented endpoint, send one valid request and three invalid ones (wrong type, missing field, a body that is too large).
2. The replies match the document. All errors have one shape and a readable message. Nothing from an invalid request is stored.
3. With the secret, probe common undocumented paths: admin, debug, developer, file-serving and agent-tool paths. Add `..` and `%2e%2e` path segments.
4. Each probe returns "not found" or is refused. No file from outside the data folder comes back.

Adversarial angles:
- A tool endpoint for outside AI agents, left from the upstream project, still answers with its own weaker check.
- A file endpoint returns `/etc/passwd` or a file from `~/.ssh` through an encoded `..` path.
- A very large upload (for example 500 MB) stops the server or fills the disk.
- An endpoint stores invalid input, and the page that shows it later breaks.

### O15 (MUST) The server never sends the person's data off the laptop on its own

The server makes outbound requests only for things that the person turned on: employers' public job APIs, the AI provider that the person picked, and publik when the person uses a publik feature. With a local model, no resume, profile, tracker or chat text leaves the laptop. There is no telemetry.

Observe:
1. Point the publik and provider URLs at local mock servers, as the README documents. Pick a local OpenAI-compatible mock as the AI provider.
2. Turn the crawl off. Import a resume, chat, tailor a resume and edit the tracker.
3. Watch connections with `nettop -m tcp` or `lsof -i` during the session. No connection goes to a non-loopback host.
4. Turn the crawl on against mock boards. Only the mock board hosts get requests. Search the mock logs for "Testwell" and "jordan.testwell". There are no hits.

Adversarial angles:
- An analytics, crash-report or tracing hook is on by default, or a leftover setting turns it on.
- When the local model fails, the app sends the prompt to a cloud provider without asking.
- Crawl requests carry the person's name, email or profile details in a header or a query.
- An update or balance check sends a device ID or the data-folder path.
