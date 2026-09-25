# Evals and probes

A **probe** is a small, repeatable check that measures one quality of jobleft against labelled data and prints a
score. Unit tests say "this code does what I wrote". A probe says "this feature is good enough for a person":
for example, how often the pay parser agrees with a human label, or whether the match score puts a strong fit above
a weak one.

The acceptance outcomes in `docs/outcomes/` are judged by reviewers with their own test material. Probes are the
lanes' own way to see, before review, whether they meet those outcomes. A probe never replaces a unit test, and a
reviewer never trusts a probe's own pass mark without running it.

## Layout

```
evals/
  <area>/                 parsers, crawler, store, match, resume, network, static-data, ai-engine, extension, ...
    <probe-name>/
      README.md           the question, the data, the pass bar, and how to run it
      data/               labelled inputs (made-up or public data only; licence and source stated)
      run.ts              the probe (Node 24, type stripping; imports workspace packages)
      out/                results of local runs (ignored by git)
```

## Rules for every probe

1. **Offline by default.** A probe reads its `data/` folder and local stand-in servers. A probe that needs live
   requests says so in its README, is not run in CI, obeys robots.txt, sends at most 1 request per second per host,
   and uses the User-Agent `jobleft-build/0.1 (research build; no personal data)`.
2. **No personal data.** Labelled data holds made-up people (the persona "Jordan Testwell",
   jordan.testwell@example.com) and public postings only. Never a real person's resume, contacts or messages.
3. **Deterministic.** The same code and data give the same score. A probe that calls an AI provider records the
   provider and model, uses a local stand-in or a local model, and states how many runs its score averages.
4. **One summary line.** `run.ts` prints one JSON line last:
   `{"probe":"<area>/<name>","n":<items>,"score":<0..1 or value>,"pass":<bool>,"bar":"<the pass bar in words>"}`.
   Details go to `out/`.
5. **Honest bars.** The pass bar comes from the outcome it serves (for example parsers O2: at least 98% of shown pay
   agrees with the label). A probe never changes its bar to pass.
6. **Licences.** Data copied into `data/` has a stated source and licence. Never data under a non-commercial licence.

## Running

```sh
node evals/<area>/<probe-name>/run.ts
```

## Probes to build first (from the plan and the outcomes)

| Probe | Serves | Question |
|---|---|---|
| `parsers/pay-labelled` | parsers O2 to O4 | Does shown pay agree with human labels, and is "no pay" never filled? |
| `parsers/level-labelled` | parsers O5 | Is seniority right for tech and non-tech titles? |
| `parsers/place-traps` | parsers O7, O8; static-data O13, O14 | Are places complete, and is no job put in the wrong country? |
| `match/ranking-pairs` | match O3; store O3 | Do strong fits rank above weak fits, in tech and non-tech jobs? (the plan's "small labeled eval set before Phase 3 ships") |
| `resume/truth-gate` | resume O3, O4 | How many facts in tailored output fail to trace to the profile? (target: zero) |
| `static-data/h1b-variants` | static-data O4, O5 | Do name variants match one record, and do look-alike names never match? |
| `network/csv-fixtures` | network O1, O4 | Does the import keep every real row, and are company counts right? |
