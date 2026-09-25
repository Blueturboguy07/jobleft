# Probe: match/ranking-pairs

Serves: docs/outcomes/match.md O3 (strong fits rank above weak fits, in tech and non-tech jobs alike); store O3.

## Question

For each job family, with one test profile and its postings: in "Top Matched" order,

- (a) does every posting labelled a strong fit rank above every posting labelled a poor fit,
- (b) are at least 80% of the strong fits in the Strong or Good band,
- (c) is no poor fit in the Strong band?

## Data

`data/<family>/profile.json` (a "Jordan Testwell" test profile), `data/<family>/jobs/*.txt` (made-up postings for
made-up employers), `data/<family>/labels.json` (strong, possible or poor per posting).

| Families | Postings |
|---|---|
| software, nursing, accounting, retail management, electrician, teaching | 16 each |
| warehouse, truck driving, B2B sales, recruiting, social work, restaurant cooking | 12 each |

Ten of the twelve families are outside tech. Each family mixes clear fits, near roles, roles two or more levels up,
unrelated roles, roles with a must-have the profile does not meet, and a role in a far city.

Licence and source: written for this probe by the match lane (first party); no real posting, person or employer.

## Limits (read before trusting the pass mark)

- One labeller (the match lane) wrote the labels, before looking at any score, but the same person also wrote the
  engine. The outcome's labelled fit set needs two raters and drops the pairs they disagree on; this probe is a
  development check, not that set.
- The first six families were written first and used to tune the engine; the last six were written afterwards as a
  held-out check, then also used to fix what they exposed (inline headings, licence lists, "Account Manager" titles,
  experience in months). They are no longer a clean hold-out.
- The "far city" postings sit in the same state for two families; without the place dictionary of @jobleft/static-data
  those cities are not compared by distance (see packages/match/README.md, Known limits).

## Run

```sh
node evals/match/ranking-pairs/run.ts            # one line per family, then the summary JSON line
node evals/match/ranking-pairs/run.ts --verbose  # every posting: rank, label, percent, band, parts, warnings
```

Details of the last run go to `out/last-run.json` (ignored by git). Offline, deterministic (fixed date 2026-09-25).
