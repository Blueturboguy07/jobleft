# @jobleft/contracts

The shared contracts of jobleft: TypeScript types, JSON Schemas and small runtime validators for every record
that crosses a package boundary, the LOCAL API (routes, auth, request and response bodies, error shape) and the
extension protocol. No dependency. It runs in Node 24, in the UI and in the extension.

Full reference: [docs/INTERFACES.md](../../docs/INTERFACES.md), section `@jobleft/contracts` and "Local API".

## One definition, three uses

Every contract is written once with the small builder in `src/schema.ts`:

```ts
import { obj, str, int, nullable, arr, enm, type Infer } from '@jobleft/contracts';

export const ThingSchema = obj({ id: str(), count: int({ minimum: 0 }), note: nullable(str()) }, { tags: arr(str()) });
export type Thing = Infer<typeof ThingSchema>; // { id: string; count: number; note: string | null; tags?: string[] }
```

1. `ThingSchema` is a plain JSON Schema object (draft 2020-12 subset).
2. `Infer<typeof ThingSchema>` is the TypeScript type.
3. `validate(ThingSchema, value)`, `isValid(...)` and `parse(...)` check a value at run time.

`scripts/gen-schemas.ts` writes every registered schema to `schemas/<Name>.schema.json` for readers outside
TypeScript. `test/schemas.test.ts` fails when the files are stale.

## What is here

| File | Contracts |
|---|---|
| `src/common.ts` | Dates, URLs (http and https only), ids, micros, evidence, source references, credits |
| `src/job.ts` | `Job`, `JobSummary`, `Pay`, `Place`, `RemoteScope`, `SourceAttribution`, ATS ids, levels, work models |
| `src/company.ts` | `Company` (every fact with a source and a date), `H1bSummary` (never a "no") |
| `src/filter.ts` | `JobFilter` (the "All Filters" set), `JobSort`, `JobSearchRequest`, `JobSearchResponse`, `JobListItem`, `SavedFilter` |
| `src/profile.ts` | `Profile`, `ProfileInput`, preferences, target titles, skills, work authorization, EEO answers |
| `src/resume.ts` | `Resume`, `ResumeDocument`, `ImportReport`, `AtsReport`, `KeywordGapReport`, `TailorProposal`, `CoverLetter`, `TruthViolation` |
| `src/match.ts` | `MatchResult` (percent, band, Experience Level, Skills, Industry Experience, why-fit chips, blockers, reasons), `bandFor` |
| `src/tracker.ts` | `TrackerEntry` (Applied, Interviewing, Offer Received, Rejected, Archived, liked, hidden, external), `TrackerPatch` |
| `src/network.ts` | `NetworkContact`, outreach stages, import summary, ranking, coverage, drafts |
| `src/wallet.ts` | `PublikWallet`, `PublikConnection`, `formatDollars` (dollars, never "credits") |
| `src/ai.ts` | Provider settings (never the key), setup check, chat request and stream events, `Embedder`, `SecretStore` |
| `src/sources.ts` | Boards, sources, crawl progress and report, fit-index status, datasets, H-1B and place lookups |
| `src/extension.ts` | Extension protocol: pairing, fill request and response, review result |
| `src/api.ts` | The LOCAL API table `LOCAL_API`, headers, ports, error codes and body, `matchRoute`, `buildPath` |
| `src/clock.ts` | `nowMs()` with the test time-skip (`JOBLEFT_NOW`, `JOBLEFT_CLOCK_OFFSET`) |
| `test/fixtures.ts` | Typed fixtures for tests in any package (persona: Jordan Testwell) |

## Rules that every contract follows

- `null` means unknown or not stated. It is never replaced by a default value ("$0", "Onsite", "United States", "50%").
- Links are absolute http or https URLs. Any other scheme is refused by the schema.
- Money is integer micros of a US dollar. UI copy says "balance" and dollars, never "credits".
- Objects allow unknown keys, so a newer writer never breaks an older reader.

## Change rules (additive only)

1. Never remove or rename a field, a route, an enum value or an export. Never change a field's meaning or type.
2. A new field is optional (the second argument of `obj`) or nullable. Readers treat a missing field as unknown.
3. A new enum value is allowed. Every reader handles values it does not know (it shows nothing and never crashes).
4. A new route is allowed. A changed route is a new route with a new path.
5. In the same commit: bump `CONTRACTS_VERSION` (minor), run `pnpm --filter @jobleft/contracts run gen`, and update
   docs/INTERFACES.md.
6. A breaking change needs the owner's approval and a new API version (`/api/v2`).

## Commands

| Command | What it does |
|---|---|
| `pnpm --filter @jobleft/contracts test` | Run the tests |
| `pnpm --filter @jobleft/contracts typecheck` | Type-check |
| `pnpm --filter @jobleft/contracts run gen` | Regenerate `schemas/*.schema.json` |
