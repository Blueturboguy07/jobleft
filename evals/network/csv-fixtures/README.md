# Probe: network/csv-fixtures

Serves network outcomes O1 (the import keeps every real row and reports what it skipped) and O4 ("You know N people
at <Company>" is correct).

## Question

Does the import keep every real row exactly as written, skip the right rows with a reason, refuse other CSV files,
and give the right company counts, with the list behind each count equal to the count?

## Data

Made-up people only (no real export). Written by `packages/network/src/dev/fixture.ts` and by hand. Licence: part of
this repository.

| File | What it tests |
|---|---|
| `data/demo.csv` | The demo fixture: note lines, quoted commas, accents, emoji, Chinese, Japanese and Hebrew names, garbled names, blank emails, blank companies, look-alike companies, one duplicate row (line 36) and one broken row (line 37) |
| `data/demo-bom-crlf.csv` | The same file with a byte-order mark and Windows line endings |
| `data/broken-quotes.csv` | An unclosed quote (line 6), a row with 3 fields (line 9), a row with an unquoted comma (line 10); the rows after them must be kept |
| `data/messages.csv`, `data/spreadsheet.csv` | Not connections files: nothing is imported |
| `data/lookalikes.csv` | Meta / Metaview / Meta Platforms, Block / Blockchain Labs, Apple / Apple Inc. / Apple Leisure Group, Home Depot variants, Bain & Company, placeholders ("Stealth Startup", "Self-employed", "N/A", blank) |
| `data/labels.json` | The expected counts, skipped lines and exact field values |

## Pass bar

Every labelled check matches (score 1.0). A probe never lowers its bar.

## Run

```sh
node evals/network/csv-fixtures/run.ts
```

The last line is the summary, for example:
`{"probe":"network/csv-fixtures","n":96,"score":1,"pass":true,...}`. Details go to `out/results.json`.
