# jobleft build: paused (2026-09-25 about 06:45)

The workflow was stopped by hand at a safe moment: no merge was in flight, `main` was consistent.

## How to resume

Run the workflow again with the same run id. Everything finished is embedded in the script, so nothing that is done re-runs.

```
Workflow({
  scriptPath: "/Users/mannbellani/.claude/projects/-Users-mannbellani-jobleft-spikes-s2-snapshot/a25a4a57-d9aa-4b27-bcf6-eb5dbb1883a1/workflows/scripts/jobleft-build-wf_5d0016d6-f40.js",
  resumeFromRunId: "wf_5d0016d6-f40"
})
```

Before you resume: free some disk (see below). The workflow's disk guard only checks at merges, and its stored disk numbers are stale.

## Done

- Foundation, contracts, 26 independent outcome docs.
- All 14 first-wave lanes built, gated once (one blind evaluator, one fix round, one quick re-check) and merged into `main`: ai-engine, boards, crawler, extension, match, network, parsers, resume, server, sources-ats, sources-other, static-data, store, ui.
- 12 packages pass their own tests together on `main`: 613 of 615 (2 skipped, 0 failed). These are builder-written tests, not the independent gate.

## Open defects merged with the lanes (high or critical, after the re-check)

| Lane | Open defect |
|---|---|
| crawler | Two different jobs with the same company and title can merge, and one vanishes |
| parsers | A foreign remote area with a US board address can be read as US. Third-party pay estimates and public wage records can be read as the job's pay |
| resume | The truth gate can attach a person's own job title to the wrong job |
| boards, sources-other | Failed the re-check, but no high or critical defect is left |

## In flight when paused (restart from their saved branches)

| Lane | Saved work |
|---|---|
| i-core | 3 commits, 846 lines |
| i-ai | 3 commits, 3,812 lines |
| i-network | 2 commits, 712 lines |
| i-resume | 3 commits, 499 lines |
| i-ext | 3 commits, 667 lines |
| i-shell | none |

Their worktrees are in `~/jobleft-wt/`. On resume each builder continues from its branch.

## Not started

`i-ui` (waits for i-core and i-resume), then the 3 system gates (journeys, parity, security), then `docs/BUILD-REPORT.md`.

## Known state of `main`

- Four `cli.ts` files show a mode change only (`chmod +x` by evaluators) and one evaluator probe file has a small edit. Harmless.
- `evals/` holds independent probes. Most are untracked.
- Still outside the build: G-publik, G-resale, G-store, G-release, the OpenRouter flag, and the crawler contact address.

## Disk

About 13 GB free at pause. Regenerable: `/private/tmp/jl*` (evaluator scratch, about 1.8 GB), the session scratchpad, package caches.
