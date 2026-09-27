# qa: the black-box kit

Testers who never saw the code drove the shipped app through these drivers (headless Chrome over the DevTools
protocol; no packages) and wrote replay scenarios that run on both systems.

| Path | What |
|---|---|
| `bin/driver.mjs` | drive the app's screens (built from `apps/ui/scripts/browser.ts`; Chrome path from `JOBLEFT_CHROME` or the default place) |
| `bin/ext-driver.mjs` | Chrome with the unpacked extension loaded (built from `apps/extension/scripts/cdp.ts`) |
| `bin/practice-server.mjs` | fake application forms for the extension on http://127.0.0.1:47900/practice/; `GET /__log` counts submits |
| `bin/wait-for-jobs.mjs` | starts one refresh when the store is empty and waits until jobs exist |
| `bin/run-all.mjs` | runs `scenarios/*.mjs` in order against one running app; exit 1 when any failed |
| `scenarios/` | one replay per surface; the contract is in `scenarios/README.md` |
| `fixtures/` | resume PDFs/DOCX and LinkedIn-style CSVs |

Local use against a running app: `JOBLEFT_QA_URL=http://127.0.0.1:<port>/#token=<token> JOBLEFT_QA_API=http://127.0.0.1:<port>/api/v1 JOBLEFT_QA_TOKEN=<token> node qa/bin/run-all.mjs`.
Windows: `.github/workflows/windows.yml` (job `replay`) installs the built exe on a runner and runs the same.
Rebuild the drivers after a change to the scripts: `esbuild apps/ui/scripts/browser.ts --format=esm --platform=node --target=node24 --outfile=qa/bin/driver.mjs` (same for the extension's cdp.ts).
