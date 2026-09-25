# i-shell: acceptance outcomes (Integration: desktop shell)

Scope: the jobleft desktop app as one whole on a Mac, as a person meets it. This covers the first open, the window, the menu bar item, background job checks, notifications, reminders, quit, relaunch, where the data lives, and what the app lets in and sends out. Other outcome files cover the crawler, the store, matching and the other parts. This file judges how those parts hold together in the running app. Windows comes later and is out of scope here.

How to judge: each outcome says what must be true and how a stranger can check it with public interfaces only. Those interfaces are the commands in the package README, the HTTP endpoints in `docs/INTERFACES.md`, the files the product produces, standard macOS tools (Activity Monitor, System Settings, Notification Center, `pgrep`, `lsof`, `pmset`, `codesign`, `nettop`) and screenshots or screen recordings.

- MUST: a release is blocked until it passes.
- SHOULD: expected. It can ship only with a written reason.

Test set-up that several checks use:

| Item | Value |
|---|---|
| Machine | An Apple-silicon Mac, macOS 14 or later |
| Store size | 100,000 stored jobs, unless an outcome says otherwise |
| Job boards | Local fixture boards that copy a public ATS board format. The README must say how to point the app at them |
| Check interval | The shortest interval the app allows. The README must say how to set it |
| Persona | "Jordan Testwell", jordan.testwell@example.com. Never real personal data |
| Data check | A command, named in the README, that reports whether the stored data is damaged |

---

## O1 MUST: It opens fast from a double-click

A person double-clicks jobleft in Applications or the Dock and gets a working window. On a new install that window is the first-run setup. After that, it is the job feed. The person never needs a terminal, a browser tab or a "server is starting" page.

Observe: Record the screen from the double-click to the first screen that accepts a click. Pass: at most 5 s on the first launch after a Mac restart, and at most 2 s on later launches, both with 100,000 stored jobs. No Terminal window, browser window, blank white page or error page appears at any time.

Adversarial angles: (a) the first launch after an install or an update runs slow one-time setup behind a blank window; (b) the window opens before the local service is ready and shows a connection error that goes away on reload; (c) launch time grows with the store, so 500,000 jobs make it slow; (d) the port the app wants is busy and the app shows an error instead of opening.

## O2 MUST: It works offline and with no account

With no internet, the app opens and shows the jobs, tracker, resumes and notes that are already on the Mac. It says plainly that it is offline. No local feature asks the person to sign up or sign in.

Observe: Turn off Wi-Fi and disconnect all networks, then launch. Screenshot: the stored jobs show, a tracker card moves to a new stage, a note saves, and an offline status is visible. Repeat on a new install with no network: the setup completes, and the feed says that it will get jobs when the Mac is online. No sign-in or create-account screen appears at any point.

Adversarial angles: (a) launch waits for a network download (a setup tool, a model or a data file) and hangs or fails offline; (b) the app shows an endless spinner or a general error instead of the stored data; (c) an AI feature fails offline and takes the whole window down with it; (d) a hidden sign-in wall appears in front of the tracker or the resumes.

## O3 MUST: The first run is useful while the first crawl runs

On a new install, the person can finish setup and browse while jobs arrive in the background. The feed fills without a manual reload, and the progress is visible. If the person quits in the middle, the next launch continues. It does not start again from zero and it does not duplicate jobs.

Observe: Do a new install that points at 30 fixture boards. Pass: the first jobs appear in the feed within 60 s after setup ends; a progress line (for example "412 jobs from 9 of 30 boards") changes on screen; during the crawl, a click on a card opens it within 1 s. Quit at about half way and launch again. At the end, the number of jobs in the feed is equal to the number of different postings in the fixtures, with no duplicate cards.

Adversarial angles: (a) the feed stays empty until the full crawl ends; (b) the crawl freezes the window, so clicks and scrolling stop; (c) a quit in the middle leaves half-saved jobs that show with blank titles, or that show twice after the next launch; (d) the progress line says "done" while boards are still waiting.

## O4 MUST: Closing the window leaves jobleft in the menu bar

When the person closes the window, jobleft keeps running as an item in the macOS menu bar. From that item, the person can open the window, check for jobs now, pause and continue the checks, see the time of the last check, and quit. jobleft starts at login only if the person turns that on.

Observe: Close the window with the red button or Command-W. The menu bar item stays, and `pgrep -fl jobleft` still lists the app. The item's menu shows the five actions above. A double-click on the app in Finder or the Dock brings the window back. On a new install, jobleft is not in System Settings > General > Login Items. After the person turns on "open at login" in the app, it is there. After the person turns it off, it is gone.

Adversarial angles: (a) closing the window also stops the background work, so no checks run; (b) on a full menu bar the item hides behind the camera notch, and the person has no other way to get the window back; (c) reopening makes a second menu bar item or a second window; (d) the app adds itself to Login Items without asking.

## O5 MUST: It keeps checking for jobs and catches up after a gap

While jobleft runs, with or without its window, it checks the job boards on a schedule. After the Mac wakes from sleep, or after the app was not running, it does one catch-up check soon. It does not run a burst of all the checks it missed. It stays polite to every host.

Observe: Close the window, then add a new posting to a fixture board. Pass: the posting appears in the feed within one check interval plus 2 min. Put the Mac to sleep for more than two check intervals, then wake it: exactly one check starts within 2 min of the wake, and the fixture server log shows one pass for each board. For the full test, the fixture log never shows more than 1 request per second to one host, and every request carries the jobleft User-Agent.

Adversarial angles: (a) the schedule stops after the first sleep and never runs again; (b) after a long sleep, the app runs every missed check at once; (c) a manual "check now" during a scheduled check makes two checks run together and doubles the request rate; (d) "pause" changes the menu text but the requests continue.

## O6 MUST: New matches arrive as notifications that tell the truth

When a check finds new jobs that fit the person's alert settings, jobleft shows a macOS notification. A click on it opens that job, or the list of new jobs, in the app. The notification says the same thing as the job page. If the person blocked notifications for jobleft, the app says so and still marks the new matches inside the app.

Observe: Set the alerts to one role and one city. Add one posting that fits and one that does not fit to a fixture board. Pass: one notification appears within 1 min after the posting enters the feed; it names only the posting that fits; its title, company, place, pay and match value are the same as on the job page it opens; a click opens that job within 2 s, both when the window is closed and when the app is hidden. Then block jobleft notifications in System Settings and repeat: the app does not crash, its alert settings show a visible note about the block, and the new job has a "new" marker in the feed.

Adversarial angles: (a) a notification for a job that does not fit the alert settings; (b) the notification shows a different pay or match value from the job page, or a match value for a job that has no score yet; (c) the click opens the home screen, a blank page, or a job that closed since, with no sign that it closed; (d) with notifications blocked, new matches go away with no sign in the app.

## O7 MUST: It never floods or repeats notifications

jobleft never sends two notifications for the same job. It never turns a large crawl into a stream of notifications. It always obeys the person's alert switch and alert limit.

Observe: On a new install, run the first crawl of 30 fixture boards (thousands of jobs). Pass: at most one summary notification. Quit and launch three times: no job notifies again. Remove a posting from its fixture board and put it back unchanged: it does not notify again. Set the limit to one alert a day and add a fitting posting every hour for 24 h: at most one alert notification. Turn alerts off and repeat: zero notifications, and the new postings still show in the feed.

Adversarial angles: (a) the first crawl, or the catch-up after a week away, sends hundreds of notifications; (b) a relaunch forgets which jobs it already announced; (c) the same job posted again with a new ID but the same apply link notifies again; (d) the daily limit starts again at each relaunch, so a restart gets around it.

## O8 MUST: Tracker reminders fire on time, and a missed one is never lost

A reminder on a tracked application shows as a macOS notification at its due time while jobleft runs, also with the window closed. If the Mac was asleep or the app was not running at the due time, the reminder shows at the next wake or launch, marked as late. Each reminder fires one time only.

Observe: Set a reminder 3 min ahead and close the window. Pass: a notification appears within 1 min of the due time, and a click on it opens that application in the tracker. Set a second reminder, quit jobleft, wait past the due time and launch: within 10 s the reminder shows as overdue in the app and as one notification. Launch again: it does not fire again.

Adversarial angles: (a) a reminder that fell due while the app was quit or the Mac was asleep is dropped; (b) a time-zone change or a daylight-saving change moves the reminder by an hour or fires it twice; (c) a reminder that the person completed or deleted still fires; (d) marking it done in the app does not stop a notification that is already waiting.

## O9 MUST: Quit means quit, and nothing is lost

Quit from the menu bar item or Command-Q stops all of jobleft within a few seconds. No helper process, open port or crawl continues after that. Everything the person saved before the quit is there at the next launch. A forced stop or a power loss never makes the data unreadable.

Observe: Change a tracker note, then quit within 1 s. Pass: within 5 s, `pgrep -fl jobleft` lists nothing and `lsof -iTCP -sTCP:LISTEN` shows no jobleft port; the fixture server log shows no request after the quit; after the next launch, the note has the new text. Quit during a crawl: all of jobleft stops within 10 s. Start a crawl and stop every jobleft process with `kill -9`: the next launch opens normally, the data check reports no damage, and the interrupted crawl runs again.

Adversarial angles: (a) a helper process stays alive after quit, keeps crawling or keeps the port, and makes the next launch fail; (b) a quit during a crawl or a save loses the last change or leaves half-written jobs; (c) a forced stop leaves a lock or damaged data, and the next launch shows an error or an empty feed; (d) quit waits on a slow board reply, so the person must force-quit.

## O10 MUST: A second launch never makes a second copy or damages data

However the person launches jobleft again (double-click, Dock, Spotlight, a notification click or `open -n` in a terminal), only one jobleft runs for each macOS user. The new launch brings the open window to the front. A leftover from a crash never blocks the next launch.

Observe: With jobleft running, launch it 10 times in 2 s with mixed methods, including `open -n -a jobleft`. Pass: one menu bar item, one window in front, one app process group in `pgrep`, and the data check reports no damage; a tracker change made just before the launches is still there. Stop all jobleft processes with `kill -9`, then launch: it opens normally and does not say "already running". Launch an older build while a newer build runs, or after a newer build changed the data: the older build stops with a plain message and changes nothing.

Adversarial angles: (a) two copies start at the same moment and both write the same data; (b) the second launch opens a second window with its own view of the data, so edits in one window are lost in the other; (c) after a crash, a leftover lock says "already running" forever; (d) an older build opens data from a newer build and damages it.

## O11 MUST: The app's local service never answers strangers

Only the jobleft window and a browser extension that the person paired can use the app's local service. Web pages the person visits, other devices on the network and other programs without the pairing secret get nothing.

Observe: Use the endpoints in `docs/INTERFACES.md`. Pass: from another device on the same Wi-Fi, a connection to the app's port is refused; from a page on another origin in headless Chrome, a request to the local service returns no data and no response header allows that origin; from `curl` on the same Mac without the pairing secret, each endpoint rejects the request and the response body has no personal data; a request with a changed Host header (a DNS-rebinding attempt) is rejected. A secret from an earlier session, or from an extension that the person removed, no longer works.

Adversarial angles: (a) the service listens on every network interface, not only on this Mac; (b) a permissive cross-origin setting lets any web page read the profile or a resume; (c) DNS rebinding reaches the service through a site the person visits; (d) the pairing secret shows in a URL, a log file or the page source and stays valid forever.

## O12 MUST: It never sends personal data out, and it says which hosts it contacts

The profile, resumes, tracker, notes, contacts and stored jobs stay on the Mac. When idle and when checking for jobs, the app connects only to employer job boards, the host of its static data files, and the AI or search provider that the person chose. It sends no analytics, tracking or crash reports unless the person turns them on.

Observe: Put a unique marker string into the persona's profile and resume. Set AI to a local model. Record all outbound connections with a logging proxy or `nettop` for 1 h of idle time and one full crawl. Pass: every host is an employer board, a fixture, or a host that the README lists; the marker string, "Jordan Testwell" and jordan.testwell@example.com appear in no request, header or URL; every board request carries the jobleft User-Agent with no personal detail. The README lists every host that the app can contact.

Adversarial angles: (a) an analytics or crash-report library sends a device ID, or a stack trace with file paths that contain the macOS user name; (b) an update check or a data-file check sends the profile, the saved filters or a machine ID; (c) the User-Agent or another header holds an email address; (d) with a local model chosen, an AI request still goes to a hosted provider.

## O13 MUST: Offline or asleep never looks like "all jobs closed" or "just updated"

A check that fails, stops early or never ran because the Mac was offline or asleep never marks jobs as closed. The app always shows the time of the last good check and names the boards that failed. It never shows old data as fresh.

Observe: Load 30 fixture boards. Turn off the network for two check intervals, then turn it on. Pass: no job changed to closed; while offline, the status says "offline" and shows the time of the last good check; after the network returns, the status shows a new check time. Make one fixture board return server errors: its jobs stay open and the status names that board as failing. Make one fixture board return a Wi-Fi login page in place of its job list: no job from that board closes.

Adversarial angles: (a) a failed check counts as "this board has no jobs" and closes all jobs from that board; (b) after a week asleep, the catch-up check runs before the network is ready and closes jobs in bulk; (c) the status says "updated just now" after a check that failed; (d) a hotel or café login page is read as a real board reply.

## O14 MUST: The person's data has one home and survives updates

All of the person's data lives in one per-user folder that the README names. A newer build keeps all of it. Deleting the app does not delete the data. The app never writes into its own app bundle. An in-app action deletes all the data after the person confirms.

Observe: Fill in the persona's profile, 2 resumes, 5 tracker cards, notes and a stored feed. Replace the app with a newer build and launch: every item is there, unchanged. After a day of use, `codesign --verify --deep --strict` on the app still passes, and the app bundle has no new or changed files. Move the app to the Trash and install it again: the data is there. Use the delete-all action and confirm: the folder that the README names is empty or gone, and the next launch is a new first run.

Adversarial angles: (a) the data upgrade in an update fails half way, and the app does not open and gives no way back; (b) the app writes caches or a runtime into its own bundle, which breaks the signature and the macOS permissions the person gave; (c) data is spread over many folders, so delete-all leaves resumes or crawled jobs behind; (d) a data upgrade drops a field (notes, reminder times) that the older build kept.

## O15 SHOULD: It is light on the Mac while it waits

Between checks, jobleft in the menu bar uses almost no CPU, does not keep the Mac awake and does not grow in memory over days.

Observe: Leave jobleft in the menu bar with the window closed for 24 h at the default check interval, with 100,000 stored jobs. Pass: in Activity Monitor, average CPU is below 1% outside checks; `pmset -g assertions` shows no jobleft sleep block outside checks; memory after 24 h is within 20% of memory after 1 h and stays below 1 GB; the Mac goes to sleep on its normal schedule.

Adversarial angles: (a) an idle loop wakes many times each second; (b) a sleep block taken for a check is never released, so the laptop stays awake and drains its battery; (c) memory grows with each check until the app slows down or macOS stops it; (d) after the crawl ends, background work (for example, scoring every stored job again) runs all day at full CPU.
