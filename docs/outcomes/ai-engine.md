# Acceptance outcomes: AI engine and publik client

Area: `ai-engine`. This area covers the choice of AI provider, how AI requests start, end and fail, the publik connection, the publik balance, and paid fetch and search.
Sources: `docs/PLAN.md` sections 1 to 8, `GAPS.md`, audits 01 to 04, and `UI-SPEC-LOGGED-IN` sections L09 to L11.
Date: 2026-09-25. Status: draft for review.

These outcomes say what a person sees. They do not say how to build it.

## How to read this file

- **MUST**: the area fails acceptance if this outcome fails.
- **SHOULD**: expected. A miss needs a written reason.
- **Observe** uses only public things: commands in the package README, HTTP endpoints in `docs/INTERFACES.md`, files the app writes, and screenshots.
- **Adversarial angles** are ways a build can look right and still fail. A checker tries each one.
- "Provider" means the place where AI answers come from. This file uses that word every time.

## Test setup that the checks assume

| Item | What it is |
|---|---|
| Stand-in publik server | A server on this computer that plays the publik API. It connects an app, holds a dollar balance, charges for calls, and can answer "balance too low". It logs every request. The README says how to point the app at it. No check uses the live publik service or real money |
| Stand-in model server | A server on this computer that speaks the OpenAI-style chat API. A tester can set it to answer, stream slowly, stall, refuse the key, say "model not found", or send broken text. It logs every request with its headers |
| Stand-in job host | A server on this computer that plays one employer job board. It logs every request |
| Real local model | Any local model server the tester has, such as Ollama or llama.cpp, with a 7B to 14B instruction model |
| Test persona | "Jordan Testwell" (jordan.testwell@example.com), a sample resume, and 5 sample jobs |
| Canary key | A fake key that holds a unique string, such as `sk-canary-7Q4Z-jobleft-test`. A tester searches for this string |

## Outcomes

### O1. MUST. Chat works through every type of provider

A person picks one of four providers: the publik API, a model server on this computer (Ollama, llama.cpp, MLX, or any local OpenAI-style server), a custom OpenAI-style address, or their own key for a named provider. Chat gives a reply through each one. The choice stays after a restart, and the chat panel shows which provider and model are active. No option signs in with a Claude consumer subscription.

**Observe:** For each provider type, point the app at the matching stand-in server or real local server, pick a model, and send "Reply with the word ready". Take a screenshot of the reply and of the active-provider label. Quit and open the app again, send again, and take a screenshot. Read the full list of provider options on the settings screen.

**Adversarial angles:**
- Only the publik provider works. The others save but fail on the first message.
- The model list shows models that the server does not have, or the app sends a fixed model name that the local server rejects.
- The custom address works only when it ends in `/v1`, or only when no key is set.
- After a restart, the app goes back to a default provider and does not say so.

### O2. MUST. Connecting publik needs no hand-copied key, and disconnecting stops all spending

A person connects their publik account from inside the app. They never copy, paste or type a key. When they disconnect, the app sends no more requests that spend their balance, and the key for that connection is gone from the computer.

**Observe:** Against the stand-in publik server, connect from the app and take a screenshot of each step. Count the fields that ask for a key (pass: zero). Disconnect. Use chat and one other AI action. Read the stand-in server log (pass: no new charged request). Search the app's data folder (the README names it), the log files and any export for the key that the stand-in server issued (pass: no match).

**Adversarial angles:**
- Disconnect hides the balance card, but the stored key still works and the app still uses it.
- The connect step puts the key where other apps or web pages can read it, such as the clipboard or a web address that stays in browser history.
- A second connect leaves two keys on the computer, and the app keeps the old one.
- A failed connect leaves the app half connected, with a balance of $0.00 and no message.

### O3. MUST. The setup check names the real problem

When a person saves a provider, the app tests it. It says in plain words that the provider works, or it names the problem: the address cannot be reached, the key was refused, the model does not exist, the address is not an AI server, or the publik balance is too low. The person can fix the problem from the same screen.

**Observe:** Set the stand-in model server to each failure in turn: stopped, key refused, model not found, and an HTML page as the reply. Set the stand-in publik balance to $0.00 for the fifth case. Save the provider each time and take a screenshot. Pass: five different messages, each one correct, each within 60 seconds.

**Adversarial angles:**
- Every failure shows the same "Something went wrong".
- A refused key shows as "balance too low", or the reverse, so the person pays or types a key again for nothing.
- The message shows a raw error dump, a stack trace, or the key.
- The check says "works" because the server sent a model list, but chat then fails.

### O4. MUST. A dead, slow or silent provider never hangs the app

Every AI request ends. A provider that is off gives a plain message within 10 seconds. A provider that stops sending data gives a plain message after no more than 2 minutes of silence. The person can cancel any running request, and the rest of the app stays usable while they wait. If an answer stops part way, the part already shown stays and is marked as incomplete. The person's own message is never lost.

**Observe:** With the stand-in model server: (1) stop it and send a message; (2) set it to accept the request and send nothing; (3) set it to stream half an answer and then stop. Time each case. During case 2, open the job feed and the tracker and take screenshots. Press cancel and time how long the request takes to stop (pass: less than 2 seconds). Take a screenshot of the chat after case 3.

**Adversarial angles:**
- A spinner turns forever, because the app waits with no time limit.
- Cancel hides the spinner, but the request continues and later adds text or charges the balance.
- A broken stream deletes the partial answer, or shows it as a complete answer.
- The app tries again in a loop, so a dead provider gets many requests and a paid provider charges many times.

### O5. MUST. The app is useful with no provider at all

With no provider set up, the person can search and filter jobs, open job details, use the tracker, keep notes, and import their contacts file. Each feature that needs AI says so and offers to set up a provider. It never shows an empty or zero value in place of the missing answer.

**Observe:** Start a new install with no provider and with all stand-in servers off. Go through the job feed, the filters, a job detail, the tracker, notes, and the Network import with a sample contacts file. Take screenshots. Click each AI action once and take a screenshot.

**Adversarial angles:**
- The app waits for an AI check at start and does not open when the computer is offline.
- An AI panel shows a spinner that never ends, or a blank card with no reason.
- A value that needs AI shows "0%" or "N/A" and does not say that AI is off, so the person reads it as a real result.

### O6. MUST. Running out of money gives one plain message with one link, and loses nothing

When the publik balance is too low for a request, the person sees one short message in plain words. It says that the balance ran out, shows the balance in dollars, and has exactly one link to add money. The text the person typed stays, so they can send it again after they add money. The app does not try other providers, and it does not try again by itself.

**Observe:** Set the stand-in publik balance to $0.00. Send a chat message and start one other AI action. Take screenshots. Count the links in the message (pass: exactly 1). Read the link address, but do not open it against the live service. Make sure the typed message is still in the input box, or in the history as "not sent". Read the stand-in server log (pass: one request per action, no repeats). Add $5.00 on the stand-in server and send again with no restart (pass: the request works).

**Adversarial angles:**
- The message says "error 402", "quota exceeded" or "out of credits", not plain words about the balance.
- The message has many buttons and links (plans, upgrade, contact), or a link that goes nowhere.
- The typed text is gone after the failure.
- After money is added, the app still says the balance is empty until a restart.

### O7. MUST. The balance is shown in dollars and is correct

The app shows the publik balance in US dollars and cents. The number matches the balance that publik holds, and it changes after paid use with no restart. The app never calls this money "credits" and never shows it in another unit.

**Observe:** Set the stand-in balance to $5.00. Send 3 paid chat requests that the stand-in server charges at $0.01 each. Wait 10 seconds and take a screenshot of the balance (pass: $4.97). Search the text of every screen, menu, error message and notification, and the text in the app bundle, for "credit" used as a unit of money (pass: no match).

**Adversarial angles:**
- The app reads the balance once at start, and the number goes stale.
- Rounding shows $0.00 while money is left, or $0.01 when nothing is left.
- The app shows its own cost estimate, and this differs from the amount that publik charged.
- Text from a reused project still says "credits" or "tokens" on one screen, such as an error or a notification.

### O8. MUST. Never: a saved key is shown again, logged, or written in plain text

After the person saves a key, the app shows no more than its last 4 characters. The key never appears in logs, error messages, exports, backups, crash reports or diagnostic reports. It is never in plain text in any file that the app writes.

**Observe:** Save the canary key for the custom provider. Cause a "key refused" error. Export data and make a backup with the app's own commands. Make a diagnostic report if the app has one. Search the app's data folder, the log files, the export and the backup for the canary string (pass: no match). Take a screenshot of the settings screen after the save and of the error message (pass: no more than the last 4 characters are visible).

**Adversarial angles:**
- A debug log writes each request with its headers.
- A "show" control, or a web inspector, shows the full key again on the settings screen.
- The export or the backup includes the saved settings with the key.
- The key is in plain text in the app's data files, so any program that can read those files can read the key.

### O9. MUST. Never: a key goes to a place other than its own provider

A key that the person enters for one provider goes only to the address of that provider. It never goes to publik, to a different provider, to an employer's job site, or to a web page. It never appears in a web address.

**Observe:** Set up the custom provider with the canary key. Also run a stand-in publik server, a second stand-in model server, and the stand-in job host. Use chat, run a job refresh against the stand-in job host, and use each AI action. Read the request logs of all stand-in servers (pass: the canary string appears only in the log of the matching server, only in a header, and never in a web address).

**Adversarial angles:**
- The app adds the last key it used to every outgoing request, including job refresh requests.
- When the person changes provider, the first request to the new provider carries the old key.
- The key goes in the web address, where servers and proxies log it.
- The publik connection key goes to a custom provider.

### O10. MUST. Never: the app moves a request to another provider by itself

If the chosen provider fails, the app reports the failure. It never sends the request, the resume or the profile to a different provider unless the person chooses to at that time. This keeps the data of a person who chose a local model on their computer, and it keeps the balance of a person who did not choose publik.

**Observe:** Choose the stand-in model server as a local provider. Stop it. Use chat and each other AI action, and wait for one background job refresh. Read the logs of the stand-in publik server and the second stand-in model server (pass: zero requests). Compare screenshots of the balance before and after (pass: no change).

**Adversarial angles:**
- The app tries publik when the local server fails, so the resume leaves the computer.
- One feature, such as company facts or contact drafts, has its own provider setting that still points to publik after the person chose local.
- A background task, such as scoring new jobs, uses a default provider and not the chosen one.

### O11. MUST. "Local" means that no AI data leaves the computer

With a local model chosen, chat and every other AI action work with the network off. No prompt, resume, profile, job or chat text leaves the computer for an AI purpose.

**Observe:** Choose a real local model server. Turn off Wi-Fi and disconnect any network cable. Use chat, ask about a saved job, and run each AI action. Take screenshots (pass: all complete). Turn the network on. Run the same actions through a proxy or network monitor that logs outgoing connections (pass: no connection to a publik or AI host, and no outgoing request that contains text from the sample resume).

**Adversarial angles:**
- One AI action, such as a contact draft or company facts, still calls a cloud provider.
- The app sends usage or error reports that contain prompt text.
- The app downloads a model or a file at first use, and fails offline with no plain message.

### O12. MUST. Never: a bad model answer becomes an invented result

When an answer is empty, cut off, in the wrong form, or out of range, the app says that it cannot use the answer and offers to try again. It never fills the gap with an invented value, such as a default score, a skill, a date, a salary or a job link that the model did not give and that the person's data does not contain.

**Observe:** Set the stand-in model server to send, in turn: an empty answer, an answer cut off half way, plain text where a structured answer is expected, and a match score of 140%. For each case, run a fit analysis, a resume tailoring and a chat about a job. Take screenshots. Pass: each case shows a plain "cannot use this answer" message with a retry, or a partial result that is clearly marked as partial. No screen shows a number, skill or link that the stand-in server did not send and that the sample data does not contain.

**Adversarial angles:**
- The app shows a middle score, such as 50%, when it cannot read the number.
- A cut-off list shows as a complete list.
- The app saves a failed answer to the history or to a resume as a good answer, so it comes back later as fact.
- The chat names a job or an apply link that is not in the person's job list.

### O13. SHOULD. Common small local models are good enough

With a common 7B to 14B instruction model on a local server, each AI action gives a usable result for the test persona in at least 4 of 5 tries. With a model that "thinks" before it answers, the person sees the answer and not the thinking, and the model does not stop after the thinking with no answer.

**Observe:** Use a real local model server with a 7B to 14B model. Run each AI action 5 times on the sample resume and the 5 sample jobs. Record pass or fail for each try in a table (pass: at least 4 of 5 for each action). Do the check again with one reasoning model and take screenshots.

**Adversarial angles:**
- Structured tasks fail because small models break the expected answer form, and the app has no second way to read the answer.
- A long resume and a long job text are too large for the model, and the answer is cut off with no message.
- The thinking text shows in the chat, or the answer is empty because the model used all its output on thinking.

### O14. MUST. Never: a web page spends the balance or reads a key

No web page that is open in the person's browser can make the app send an AI request, spend the publik balance, change the provider, or read a saved key. Only the app, and the browser extension after the person pairs it, can do these things.

**Observe:** Serve a test page from a different local port. From that page, send requests to each endpoint in `docs/INTERFACES.md` that starts an AI request, reads settings or changes the provider. Try with no token, with a guessed token, with a changed Host header, and with a plain form post. Pass: the app refuses all of them, the stand-in server logs show no request, and the balance does not change.

**Adversarial angles:**
- The app accepts requests from any web origin.
- A plain form post, which a browser sends with no pre-check, still starts the action, even though the page cannot read the reply.
- A DNS-rebinding page reaches the app under a different host name.
- The access token is in a place that a web page can read.

### O15. SHOULD. Never: paid fetch or search spends money before the person turns it on

The app never spends money on paid page fetching or web search, through publik or through the person's own provider key, unless the person turns this on. Before they turn it on, the app shows the price in dollars for each 1,000 requests. When it is on, the app tries a free plain fetch first. It uses the paid route only when the free fetch cannot get the page.

**Observe:** With paid fetch off, run a job refresh that includes a stand-in job page that needs a browser to show its content, and look up company facts for 3 companies. Read the stand-in publik server log (pass: no paid fetch or search requests). Turn paid fetch on and take a screenshot of the price text. Run the refresh again (pass: for each page, the stand-in job host log shows a free request before any paid request in the stand-in publik log).

**Adversarial angles:**
- The paid route is on by default, or it turns on when the person connects publik.
- A background refresh uses the paid route for every page, also for pages that the free fetch can read.
- The app sends a failed page to the paid route again and again, and the balance drains.
- Company facts use paid search with no price shown and no opt-in.

## Where each outcome comes from

| Outcome | Source in the plan and research |
|---|---|
| O1 | Plan decision 4, section 2 (AI engine), section 6 (Claude subscription login is not shipped) |
| O2 | Plan P1 (publik key from the provisioning pattern), P2 |
| O3, O4 | Plan section 5, spike S3 (a local provider failed as shipped until a fix); seed idea on dead providers |
| O5 | Audit 01, section 5.5 (with no AI provider, the job list still works) |
| O6, O7 | Plan P2 (balance card, dollars, never "credits"); `UI-SPEC-LOGGED-IN` L10i and L11 (the reference product uses per-feature credits, which jobleft does not copy) |
| O8, O9 | Seed idea on keys; audit 02 (a reference backup strips keys) |
| O10, O11 | Plan section 2, "What leaves the laptop" table |
| O12 | `GAPS.md` "Where the base is ahead" and T1; audit 03 (a reference tool shows a fake middle score when the model fails) |
| O13 | Plan section 6, "Local model quality" risk |
| O14 | Plan section 6, "Local API has no login" risk |
| O15 | Plan section 1 (metered fetch and search), section 4 gate G-resale, section 6 cost table |
