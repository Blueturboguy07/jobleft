# Replay scenarios (run on Windows CI against the installed app, so every area's checks run on both systems)

One file per area: scenarios/<area>.mjs. Plain Node 24 ES module, no packages. Reads its target from the environment:

| Variable | Meaning |
|---|---|
| JOBLEFT_QA_URL | the page URL with the token in the hash (open it with the driver) |
| JOBLEFT_QA_API | http://127.0.0.1:<port>/api/v1 |
| JOBLEFT_QA_TOKEN | the launch token (header x-jobleft-token) |
| JOBLEFT_QA_FIXTURES | folder with the resume PDFs/DOCX and LinkedIn CSVs |
| JOBLEFT_QA_SHOTS | folder to write screenshots into (created for you) |
| JOBLEFT_QA_STATE | `fresh` (first run, no jobs yet) or `golden` (jobs crawled, a profile exists) |
| JOBLEFT_CHROME | Chrome binary path when not at the default place (the drivers read it) |

Rules: import the driver relative to the script (`new URL('../bin/driver.mjs', import.meta.url)`); no Mac-only paths;
print one line per check: `CHECK ok <name>` or `CHECK FAIL <name>: <why>`; exit code 1 when any check failed, 0
otherwise; finish in under 10 minutes; never assume a specific job title or company exists (the Windows run crawls
live boards; assert invariants: counts agree, filters are exact against the facts each card shows, nothing is lost
after a reload, banned words absent); close Chrome in a `finally`. Skip a check (print `CHECK skip <name>: <why>`)
when the state does not allow it (for example the extension needs the practice server: start it yourself from
`../bin/practice-server.mjs` with child_process and stop it after).
