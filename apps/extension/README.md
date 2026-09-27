# @jobleft/extension: the jobleft Chrome extension (assisted apply)

The extension fills job applications with the facts in your own jobleft app on this computer.
It fills. You check. You press submit. The extension never submits, never presses "Next" or "Save",
and never solves a human check (CAPTCHA).

Until the real app (`apps/server`) exists, a **stand-in app** in this folder plays the app for the extension.
The stand-in follows the same local API rules. It makes no outbound request.

## 1. What the extension reads, when, and where it sends it

| When | What it reads | Where it goes |
|---|---|---|
| You never click it | Nothing. It has no content script on any site. It does not see your tabs or your history | Nowhere |
| You click the jobleft button | The address of this tab. On a paired browser, also a few markers in the page that name the job system (for example an element id). Never the page text | The address goes to the jobleft app on this computer, to find the job and your resumes. The markers stay in the browser |
| You press "Fill this application" | The fields of the one application form on this tab: each label, name, choices and limits. Never hidden fields, never other forms, never the job text | Only to the jobleft app on this computer. The app answers with your values. The values go into that form |
| You press "Make drafts" | The labels of the open questions | Only to the jobleft app. The app uses the draft provider you chose |
| You press "I submitted this application" | The page address | Only to the jobleft app, which marks the job "Applied" |

The extension talks only to `http://127.0.0.1`, on the one port you type with the pairing code (the app shows its
port next to the code). The browser enforces `127.0.0.1`: the manifest's `connect-src` rule allows nothing else. The
code enforces the port: the pairing code and later the pairing key go to the paired port only, never to another
program that answers like jobleft on another port. When that port stops answering, the popup says the app is not
running; if the app moved to another port, unpair and pair again with the new port.

Chrome's details page for the extension shows these permissions. They agree with the table above:

| Chrome shows | Why |
|---|---|
| Site access: `127.0.0.1` (ports 47821 to 47830, the app's usual ports) | To talk to the jobleft app on this computer. An app on another port answers the extension through its own CORS rule |
| `activeTab` (no warning) | To read the tab you clicked the button on, only then, and only that tab |
| `scripting` | To put the fill code into that tab after your click |
| `storage` | To keep the pairing key. Only the extension's own pages can read it; pages cannot |

It never works on **LinkedIn, Indeed or Glassdoor**, including their country domains and subdomains
(`uk.linkedin.com`, `indeed.co.uk`, `de.indeed.com`, `glassdoor.co.uk` and so on). On those sites the popup says
"jobleft does not work on this site", shows no Fill button, reads nothing and sends nothing.

## 2. Where it works

| System | Level | How it was checked |
|---|---|---|
| Greenhouse | supported | Two saved copies of public application pages (`fixtures/recorded/greenhouse-*.html`, the new job board and its embedded form) and the hand-made page `job-a.html` |
| Lever | supported | Two saved copies of public apply pages (`fixtures/recorded/lever-*.html`) and `job-b.html` |
| Workable | supported | Two saved copies of public apply pages (`fixtures/recorded/workable-*.html`) |
| Ashby | supported | The hand-made page `ashby-like.html` only (Ashby markup: `data-field-path`, `_systemfield_*`, custom dropdowns, hidden radio buttons). A saved copy was not possible: Ashby's `robots.txt` disallows `/api/`, and its form loads from there |
| Workday | **partial** | The hand-made page `workday-like.html` only (not recorded; no live Workday request is allowed). jobleft fills the step you can see. It does not add work or education rows. It never presses "Save and Continue" |
| iCIMS | **partial** | Not tested (no live iCIMS request is allowed). jobleft uses its general mode |
| Any other site | not supported | jobleft still tries in its general mode and tells you to check every field |

The popup shows the level before a fill. On a saved copy of a page, it finds the system from the page's
"saved from" comment and markers.

## 3. Start it (a stranger's steps)

You need macOS or Linux, Node 24 or newer, pnpm, and Google Chrome.

1. Install the workspace (from the repository root):
   ```sh
   pnpm install
   ```
2. Build the extension. The output folder is `apps/extension/dist`:
   ```sh
   pnpm --filter @jobleft/extension build
   ```
   You see `built .../apps/extension/dist`.
3. Start the stand-in app in a second terminal:
   ```sh
   pnpm --filter @jobleft/extension standin
   ```
   You see `open this page ...: http://127.0.0.1:47821/#token=...`. Open that address in any browser.
   It shows the stand-in app's page: pairing, the profile of the test persona "Jordan Testwell"
   (jordan.testwell@example.com), jobs, resumes, the tracker and the draft provider.
   Its data is in `.jobleft-dev/extension-standin/` at the repository root. Add `-- --home <folder>` to use another
   folder, and `-- --reset` to start again from the persona.
   (With the real app, use `pnpm app:up` instead. The extension finds either one.)
4. Start the practice pages in a third terminal:
   ```sh
   pnpm --filter @jobleft/extension practice
   ```
   You see `practice pages: http://127.0.0.1:47900/ ...`. The list is at
   `http://127.0.0.1:47900/practice/index.html`. Saved copies of real pages are at
   `http://127.0.0.1:47900/recorded/index.html`. The log of every request, submit attempt, "Next" press and page
   change is at `http://127.0.0.1:47900/__log`.
5. Start Chrome with a scratch profile (never your own profile):
   ```sh
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=/private/tmp/jobleft-chrome-test --no-first-run
   ```
6. In that Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose
   `apps/extension/dist`. Pin the jobleft button (the puzzle icon, then the pin).
7. Pair: in the stand-in page, click **Pair a browser extension**. It shows a 6-digit code and the app's port. Click
   the jobleft button in Chrome, type the code and the port, and click **Pair**. The popup says "Paired with jobleft
   ... on this computer (port ...)".
   The stand-in page lists the paired browser with the date.
8. Fill: open `http://127.0.0.1:47900/practice/job-a.html`. Click the jobleft button. The popup shows
   "This page: Greenhouse · supported", the job "Software Engineer · Acme Practice Co" and the resume made for this
   job. Click **Fill this application**.
9. Read the report: a panel opens on the right of the page. Each field it wrote has a teal outline. Each required
   field that is still empty has a dashed amber outline. Click a row to scroll to its field.

## 4. What you see

**Popup** (click the jobleft button):

| State | The popup shows |
|---|---|
| Not paired | "This browser is not paired with your jobleft app. jobleft does nothing until you pair it.", the steps, the code and port boxes, and the list of what jobleft reads |
| App not running | "The jobleft app is not running on this computer (nothing answers on port ...)", **Try again** and **Unpair**. No Fill button. No other port is tried |
| Pairing removed in the app | "not paired" again, with the code box |
| Paired | The app version and **Unpair**; the page's system and level; the job (or "This page is not a job in your jobleft app"); "You already marked this job as applied on <date>" when the tracker says so; the resume to attach (you can pick another; a resume made in the app goes as a PDF the app makes); **Fill this application** |
| LinkedIn, Indeed, Glassdoor | "jobleft does not work on this site. It reads nothing here and fills nothing here." No Fill button |

**Report panel** (on the page, after a fill):

- the level of the site and the job;
- the phase: reading, asking your app, filling (with **Stop**), checking, done;
- totals: filled, need you, not filled, kept, drafts;
- notices: a human check on the page, an account step, a form in a frame from another site (with a link to open it on its own page), Workday is partial, new fields appeared after the fill;
- the resume: the file name attached, or why the upload failed;
- open questions: a draft for each one (edit it, then **Insert into the form** or **Discard**), or, for a paid provider, **Make drafts ($0.02)** with your balance in dollars first;
- every field of the application form, in three groups: **Needs you** (with the reason), **Filled by jobleft** (the value and the profile item it came from), **Kept as they were** (a value you typed, or one the page set);
- the other forms and hidden fields it left alone;
- **Undo fill**, **Fill again**, and **I submitted this application** (it asks "Yes, I submitted it" first).

## 5. The rules it keeps

| Rule | What happens |
|---|---|
| Pairing first | Nothing happens before pairing. The code comes from the app. Five wrong codes void it. A pairing survives restarts of the app and of Chrome. Remove it in the app, and the next request fails and the popup asks to pair again |
| No copy of your profile | The extension keeps only the pairing key. Each fill asks the app again, so a changed phone number goes in at the next fill |
| Exact values | Values come from the profile, or are the same fact in the form's format ("TX" = "Texas", "2021-05" = "05/2021"). A list with no option that means your value stays empty and says "needs you". No near match: not "Austin, MN" for Austin, TX, not "Bachelor of Arts" for a B.S., not "United States Minor Outlying Islands" for the United States |
| Your details once | Your name, email and phone go into the first matching field only. A referrer, a reference or an emergency contact field stays empty |
| Sensitive questions | Race, ethnicity, gender, sexual orientation, disability, veteran status, age, date of birth, criminal history, ID numbers, work authorization, sponsorship and pay stay empty unless you saved an answer for that exact topic in the app. Pay, age, date of birth, criminal history and ID numbers are never answered. A saved answer fits only its own topic: a saved veteran answer does not answer "military spouse" |
| No invented facts | A middle name, a GitHub link, a second degree, a certification or years with a tool that your profile does not hold stay empty |
| Drafts | A draft uses only profile facts and never your contact details. It goes into the form only when you press Insert, into that one box |
| Hidden fields and other forms | Hidden, zero-size, off-screen and see-through fields are never written. Job alert, newsletter, search, sign-in, "refer a friend", cookie banner and chat forms are left alone. Page text is never sent and never read for instructions |
| Your typing | A field that has a value is kept. A second fill updates only values that jobleft wrote and that you did not change. Undo puts back every field the fill changed, the resume box too, and keeps the changes you made after the fill |
| Never submits | No submit, next, save or continue control is pressed. No key is pressed (an Enter can submit). Password fields are never filled: an account step stops the fill. A CAPTCHA is never touched |
| Checks what the page kept | After a fill, each value is read back. A value the page rejects or clears (then, or while the panel is open) shows as "not filled" or "cleared by page" |
| Tracker | Only your confirm ("I submitted this application", then "Yes, I submitted it") marks the job Applied. A second confirm keeps one entry. Links with tracking parameters are the same job; links that differ in a job id are different jobs |
| Money | A paid draft shows its price in dollars and your balance before it spends. It says "balance", never another word |

## 6. The stand-in app

`pnpm --filter @jobleft/extension standin` starts it. Its page is the address it prints (the launch token is in the
part after `#`). On that page you can:

- pair the extension (the click is your approval), see each paired browser, and **Remove** one;
- change the profile: the quick fields, the saved answers to sensitive questions (empty = not saved), or the whole profile as JSON;
- add jobs (title, company, page address); a page whose address matches a job is that job;
- upload resumes, choose the default, and mark a resume as made for a job;
- see the tracker ("Applied" entries with the date, the page address and the resume);
- choose the draft provider: **Local template** (free, on this computer) or **publik API (simulated)**, which has a price per draft and a fake balance in dollars (nothing is charged anywhere);
- read the log of requests it received (method, path, answer, caller; no personal data), and quit it.

It keeps the local API rules of `docs/INTERFACES.md` section 6.1 for its routes: it listens on 127.0.0.1 only; a Host
other than `127.0.0.1:<port>` or `localhost:<port>` gets 403; an Origin other than its own page or the paired
extension gets 403 (`null` too); there are no CORS headers; writes need `application/json`; tokens travel only in
headers. Try it from a page on another port, with no token or a wrong token: every call is refused and holds no
profile data.

## 7. Checks you can run

| Command | What it does |
|---|---|
| `pnpm --filter @jobleft/extension test` | Unit tests of the answer engine, the strict option matcher, page keys and blocked hosts |
| `pnpm --filter @jobleft/extension typecheck` | Type check |
| `pnpm --filter @jobleft/extension e2e` | Builds, then runs the real extension in headless Chrome (scratch profile, no internet) against the stand-in app and every practice page and saved copy: pairing, fills, traps, undo, drafts, prices, the tracker, CAPTCHA, account step, frames, Workday, blocked boards, app closed, unpaired. It prints PASS or FAIL for each check. It takes about 2 minutes and needs ports 47821 to 47830, 47900 and 47943 (another jobleft server on one of the app ports is fine) |
| `pnpm --filter @jobleft/extension e2e -- --only joba,blocked --shots /private/tmp/jl-shots` | A part of the checks, with screenshots |

The e2e run presses the toolbar button through Chrome's DevTools (`Extensions.triggerAction`), which gives the same
one-tab access as a real click. Every click on the panel is a real (trusted) mouse click.

### The blocked-board check by hand

These sites force HTTPS, so serve a practice page over HTTPS and map their names to it:

```sh
pnpm --filter @jobleft/extension practice -- --https --port 47943
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=/private/tmp/jobleft-chrome-test \
  --host-resolver-rules="MAP www.linkedin.com 127.0.0.1:47943, MAP www.indeed.com 127.0.0.1:47943, MAP www.glassdoor.com 127.0.0.1:47943" \
  --ignore-certificate-errors
```

Open `https://www.linkedin.com/practice/blocked.html`, click the jobleft button, and read the popup. The stand-in's
request log shows no request about that page.

### Saving more copies of public pages

`pnpm --filter @jobleft/extension record -- --ats lever --board <board> --count 1` saves copies of public application
pages into `fixtures/recorded/`. It reads `robots.txt` first and obeys it, sends at most one request a second per host
with the User-Agent `jobleft/0.1.0 (+https://github.com/Blueturboguy07/jobleft; no personal data)`, blocks images, fonts and every host outside
the job system, and stops at a request budget. Use it only for public pages, never for sign-in pages.

## 8. For the app (the server lane)

The app answers the extension. This package exports the pure answer engine so the app and the stand-in agree:

```ts
import { answerFill, openQuestions, pageKey, templateDraft } from '@jobleft/extension';
// POST /api/v1/extension/fill:
const res = await answerFill(fillRequest, { profile, resume: { id, fileName, mimeType, base64 }, draftOffer, draft, jobId });
```

`docs/INTERFACES.md` section 7 describes the protocol and the two routes the extension added
(`POST /api/v1/extension/page` and `POST /api/v1/extension/drafts`).

## 9. Known limits

- The saved copies of real pages have no scripts, so their custom dropdowns do not open. The report says
  "This list did not open for jobleft" for them. Custom dropdowns were tested on the hand-made Ashby and Workday pages.
- Ashby was checked only on a hand-made page; iCIMS was not checked.
- Workday: no work or education rows, no account step, one step at a time.
- A form inside a frame from another site is not filled. The report gives its address to open it on its own page.
- A page that sends each change to the employer as you type still does so when jobleft writes a value. jobleft cannot
  stop a page's own scripts. The practice pages do not do this.
- Some pages upload the resume as soon as a file is chosen. That is the page's own behavior.
- No Chrome Web Store listing (gate G-store). Load it unpacked.

## Code layout

| Path | What |
|---|---|
| `src/answer.ts`, `src/classify.ts`, `src/options.ts`, `src/places.ts`, `src/drafts.ts` | The answer engine (runs in the app): field topics, strict option matching, values, notes, drafts |
| `src/support.ts`, `src/pagekey.ts` | Support levels, blocked hosts, page keys |
| `src/background.ts` | The service worker: pairing, the only network code, the fill run |
| `src/popup.ts`, `static/popup.html`, `static/popup.css` | The popup |
| `src/content/` | The content script: form scan (`dom.ts`), writing and undo (`fill.ts`), custom dropdowns (`combobox.ts`), the report panel (`panel.ts`) |
| `manifest.json`, `scripts/build.ts` | The manifest and the build (esbuild, not minified) |
| `scripts/standin-app.ts`, `scripts/standin-ui.html` | The stand-in app |
| `scripts/practice-server.ts`, `fixtures/practice/`, `fixtures/recorded/` | Practice pages and saved copies |
| `scripts/e2e.ts`, `scripts/harness.ts`, `scripts/cdp.ts` | End-to-end checks in headless Chrome |
| `scripts/record-fixture.ts` | The polite recorder |
