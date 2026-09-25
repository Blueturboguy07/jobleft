# @jobleft/parsers

Pure parsers for the facts of a job posting: seniority level, pay, US location and HTML to plain text.
No network, no clock, no file access. Safe in any process.

Status: ported from the S1 spike (`spikes/s1-ingest/crawler/src`). 12 of the 76 ported S1 tests live here.
The full interface is in [docs/INTERFACES.md](../../docs/INTERFACES.md), section `@jobleft/parsers`.

| Export | What it does |
|---|---|
| `htmlToText(html)` | Block tags become lines, list items become "- " bullets, entities decode, scripts and styles vanish |
| `unescapeEncodedHtml(s)`, `decodeEntities(s)` | Decode one entity layer only when encoded tags outnumber live tags (Greenhouse serves encoded bodies) |
| `levelFromTitle(title)` | Fine-grained `Level` from a title, most senior marker first. Works for non-tech titles. `null` = unknown |
| `levelFromDescription(text)` | Weak fallback from "N+ years of experience" |
| `parsePayFromText(text)` | The first plausible pay range with currency and period, or `null`. Conservative on purpose |
| `annualize(value, period)` | Converts hour, day, week or month pay to a yearly figure (2,080 hours, 260 days) |
| `isUsLocation(text, countries?)` | `true` US, `false` clearly elsewhere, `null` unknown (plain "Remote" is unknown) |
| `isRemoteText(text)` | The place text says remote |

Rule for every parser: a wrong fact is worse than a missing one. Return `null` (unknown) rather than a default.

## Commands

| Command | What it does |
|---|---|
| `pnpm --filter @jobleft/parsers test` | Run the tests (`node --test "test/*.test.ts"`) |
| `pnpm --filter @jobleft/parsers typecheck` | Type-check (`tsc -p tsconfig.json`) |
