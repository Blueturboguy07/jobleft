# @jobleft/match

The jobleft match score for one person and one job: a whole-number percent, a band (STRONG 85 to 100, GOOD 70 to 84,
FAIR 0 to 69), three parts (Experience Level, Skills, Industry Experience), a reason for every number, "why you fit"
chips from the job's own data, and warnings for must-haves and deal-breakers that quote the posting word for word.

It is deterministic (the same profile and job always give the same answer), free and offline (no network, no AI
provider, no balance spent), it reads the PROFILE (never a resume file), and it never reads name, contact details,
photo or equal-employment answers. Text in a posting aimed at automated screeners is ignored.

Status: built by the match lane (2026-09-25). The app's screens and server wire this package later; until then this
package ships its own command line and a local preview server so every behaviour can be seen and tested now.

All commands below run from the repository root. Node 24 or newer. Nothing to build.

```sh
pnpm install          # once, in the repository root (no install scripts run)
```

## 1. Five-minute tour

```sh
E=packages/match/examples
node packages/match/src/cli.ts feed  --profile $E/profiles/jordan-software.json --jobs $E/jobs --companies $E/companies.json
node packages/match/src/cli.ts score --profile $E/profiles/jordan-software.json --job $E/jobs/backend-engineer.txt --companies $E/companies.json
node packages/match/src/cli.ts feed  --profile $E/profiles/jordan-needs-sponsorship-remote-only.json --jobs $E/jobs/o4-*.txt
node packages/match/src/cli.ts serve --profile $E/profiles/jordan-software.json --jobs $E/jobs --companies $E/companies.json --port 47900
```

What you see:

- `feed` prints "Top Matched": the counts per bucket (`Strong 6 · Good 1 · Fair 5 · Incomplete 6 · Total 18`), then one
  card per job, highest percent first: `95%  STRONG MATCH   Backend Engineer · Contoso Analytics · Austin, TX`, up to
  two chips (`✓ Has 7 of 7 skills   ✓ Pay stated: $140K–$165K a year`), the first warning (`! ...`) and an
  `Incomplete:` line when a part has not enough information.
- `score` prints three views of the same result: the CARD, the DETAIL (every part with its reasons, every skill the
  posting names with its quote, the must-haves, your firm preferences, what the posting states or "not stated", the
  years of experience counted and which roles), and the ENDPOINT body (the JSON of `GET /api/v1/match/:jobId`).
- The third command shows the warnings: "will not sponsor a visa" (quoted from the last paragraph of a long posting),
  an active Secret clearance, US citizens only, an RN licence, and "onsite in Chicago" for a remote-only person. None
  of these jobs is in the Strong band.
- `serve` prints an address with a token (`http://127.0.0.1:47900/#token=...`). Open it in a browser for the feed, the
  band filters, the job detail and the "I have this" / "I don't have this" buttons (section 5).

`--now 2026-09-25` fixes the date the years are counted to (or set `JOBLEFT_NOW`). Without it, today is used.

## 2. Files the commands read

**Profile** (`--profile`): a contract `Profile` JSON (packages/contracts/schemas/Profile.schema.json) or a shorter
hand-written one. Missing lists become empty; missing answers stay unknown and are shown as "not in your profile",
never guessed. Dates may be `2020-01`, `2020`, `Jan 2020`, `January 2020`, `01/2020` or `present`. Skills and
certifications may be plain strings. `experience` is read as `work` and `licenses` as `certifications`; answers may be
`true`/`false`; work models and job types may be written as people write them ("Remote", "On-site", "Full-time").

```json
{
  "personal": { "firstName": "Jordan", "lastName": "Testwell", "email": "jordan.testwell@example.com", "city": "Austin", "region": "TX", "country": "US" },
  "work": [{ "company": "Northwind Cloud Software", "title": "Software Engineer", "startDate": "2022-06", "endDate": "present", "bullets": ["Built REST APIs in TypeScript."] }],
  "education": [{ "school": "Sample State University", "degree": "B.S.", "major": "Computer Science", "endDate": "2020-05" }],
  "skills": ["JavaScript", "Kubernetes"],
  "certifications": ["AWS Certified Developer"],
  "declinedSkills": [],
  "preferences": { "workModels": ["remote"], "employmentTypes": ["full_time"], "places": [{ "text": "Austin, TX", "radiusMiles": 25 }], "countries": ["US"], "minAnnualPayUsd": 120000 },
  "workAuthorization": { "usAuthorized": "no", "needsSponsorship": "yes", "usCitizen": "no", "hasSecurityClearance": "no" }
}
```

Work-authorization answers are `"yes"`, `"no"` or absent (absent = "not in your profile"). Preferences the person sets
are firm (deal-breakers): `workModels` (only when not all three are listed), `places` and `countries`,
`minAnnualPayUsd`, `employmentTypes`.

**Jobs** (`--job FILE` or `--jobs FOLDER|FILES...`), one of:

| File | Content |
|---|---|
| `.txt` / `.md` | Optional header lines `Title:`, `Company:`, `Location:`, `Work model:`, `Type:`, `Pay:`, `URL:`, `Department:`, `Id:`, then a blank line and the posting text. Without a `Title:` line the first line is the title. |
| `.json` | One job, a list, or `{"jobs": [...]}`. Each is a contract `Job` or a short object `{ "title", "company", "location", "description", "pay", "workModel", "employmentType", "status", "duplicateOf" }`. |
| `.ndjson` | One job per line (same shapes). |
| `.html` | A job page: the `<h1>` (or `<title>`) is the title, the rest is the posting. Hidden text is read like any text. |

A job's id is `file:<file name>` unless the JSON gives an `id`. Only what the text states is filled; everything else
stays "not stated".

**Company facts** (`--companies FILE`, optional): `{ "Contoso Analytics": { "h1b": "likely", "industries": ["Software"], "stage": "growth", "investors": ["..."] } }`
or a list of contract `Company` records. Used only for the H-1B chip, industry, growth and investor chips. A company
that is not in the file has no H-1B data, and the product then says nothing about sponsorship history (never "No H-1B").

## 3. Commands

| Command | What it does |
|---|---|
| `node packages/match/src/cli.ts score --profile P --job J [--view card\|detail\|json\|all]` | One job. `json` prints exactly the endpoint body. |
| `node packages/match/src/cli.ts feed --profile P --jobs DIR [--band strong\|good\|fair\|incomplete] [--limit N] [--json]` | "Top Matched" order with bucket counts. `--band` filters; `--json` prints `{counts, items[{rank, jobId, percent, band, bucket, complete, summary}]}`. Closed jobs and repeats (`duplicateOf`) are left out. |
| `node packages/match/src/cli.ts claim --profile P --skill SQL --have` | "I have this": adds the skill to the profile file and prints "This changes your profile: ...". `--not` is "I don't have this" (the skill is then never counted, even if a work bullet names it). |
| `node packages/match/src/cli.ts undo --profile P` | Undoes the last claim (the history sits next to the profile as `<name>.undo.json`). |
| `node packages/match/src/cli.ts explain --job J` | What the engine read: the section of every line, sentences ignored as text aimed at screeners, must-haves with quotes, skills with their importance. |
| `node packages/match/src/cli.ts check --profile P --jobs DIR` | Self-checks on every job: contract validity, two runs identical, band agrees with the cut-offs, card = detail = endpoint, the card carries the first warning, every quote is in the posting, every part has a reason, no Strong band with a warning. Exit code 1 on any failure. |
| `node packages/match/src/cli.ts serve --profile P --jobs DIR [--companies C] [--port N]` | The local preview (section 5). |
| `node packages/match/src/cli.ts stats` | Size of the dictionaries (about 550 skills, 90 licences and certifications, 46 kinds of work with about 1,500 title phrases, 30 industries). |
| `node packages/match/src/cli.ts help` | This list. |

Common options: `--companies FILE`, `--now ISO-DATE`, `--config FILE` (other weights, section 6).

## 4. The score, and every rule it follows

**Parts.** Each part is 0 to 100, or `null` with the words "not enough information" (never 0, 50 or 100 in place of
unknown).

| Part | What it measures | Not enough information when |
|---|---|---|
| Experience Level | Is your work history the same kind of work (title of the job vs your roles; related work counts partly; a target title or field of study counts at most 60%), and does your level fit (your years in this kind of work, the job's level from its title, the years it asks for, people-leading titles for manager and director roles, and a clear step down such as a cashier job after managing a store)? | The kind of work cannot be told from the title or the posting, or your roles cannot be read, or your work dates are missing while the job states a level or years. |
| Skills | Share of the skills and credentials the posting names that your profile has. Required counts 1, preferred 0.5, named only in the duties 0.6. A related skill (MySQL for PostgreSQL) counts half and still shows as missing. Each skill counts once, however often it repeats. | The posting names fewer than 2 skills and has no requirement list, or it is not in English. |
| Industry Experience | Is the employer's industry (from the posting's own words, or company data) one you have worked in (from your employers' names, your role text, or a role that sits in one industry, such as nursing)? | The posting does not say the industry, or your roles do not name theirs. |

**Overall.** `overall = 36 + 0.24 × Experience + 0.29 × Skills + 0.08 × Industry`, rounded. A part with not enough
information adds 0, so an incomplete score is a floor: missing data can only lower a job, never lift it. The weights
start from a rough fit of the three shown parts to one consumer app's overall percent (18 observations) and are
configuration (section 6). The detail shows the formula with the numbers used.

**Bands.** STRONG 85 to 100, GOOD 70 to 84, FAIR 0 to 69, always from the percent shown. A result with an unknown part
also has `complete: false`, shows `INCOMPLETE` on the card and the detail, and sits in the "incomplete" filter
bucket (so Strong + Good + Fair + Incomplete = all scored jobs).

**Must-haves** the posting states are found in any paragraph, including the last one, and quoted word for word:
sponsorship ("will not sponsor", "without sponsorship"), work authorization, US citizenship (or "US person"),
security clearance (active, or able to obtain; "preferred" is never a must-have), licences and certifications (a list
joined by "or" is met by any one; "within 6 months of hire" is not needed to apply; OSHA 30 covers OSHA 10, a CDL-A
covers a driver's licence), degrees ("or equivalent experience" is never a must-have) and years (ranges read as
written: "3 to 5 years preferred" stays a preferred 3 to 5).

| Your profile says | The score view says | The percent is held at |
|---|---|---|
| does not meet it (needs sponsorship; not a citizen; no clearance) | the requirement, the quote, and your answer | 45 |
| no answer | "... is not in your profile" | 84 (never Strong) |
| a trade licence (RN, CPA, journeyman) is not listed | "It is not in your profile" | 70, or 84 when a past title suggests you hold it |
| a lower degree than required | the degree in your profile | 65 |
| far fewer years than required; a role 2.5 levels up; a manager or director role with no people-leading title | the gap | 65 / 60 / 60 |
| a clear step down: two levels below your work, a role that leads nobody after you managed people, patient-care support after nursing | "may be overqualified" / "a step down" (a reason, not a warning) | 72 (never Strong) |

**Deal-breakers** (your firm preferences): work model, places and countries, minimum pay, job type. A broken one is a
warning with the posting's words, and the percent is held at 60. When the posting does not state the fact, the view
says so and nothing is assumed. Without a place dictionary, two different cities in one state show "distance not
checked" (never a broken preference); the app passes distances from @jobleft/static-data.

**Chips** come only from real data: "Post says no visa sponsorship" (only when the posting says it), "Post says it
sponsors visas", "H-1B sponsor likely" (only from company data; a company with no data gets no chip), "Has 6 of 7
skills", "Right level: Senior Level", "Pay stated: $80K–$95K a year" or "Pay meets your minimum", "Remote (US)",
"In a place you want: Austin, TX", "Healthcare experience", "Growth: tuition reimbursement" (the posting's words),
"Investors: ...". The card shows the first two chips and the first warning.

**Not stated.** The detail lists level, years, pay, sponsorship, industry, work model and job type; each is the
posting's statement with its quote, or "not stated". The level is read from the title only ("Senior", "II", "Director",
"Aide"); it is never inferred from the years a posting asks for ("3+ years" is a minimum, not a level).

**Years of experience.** Months covered by your roles, overlaps counted once (January 2020 to December 2022 plus June
2021 to June 2023 is 3 years 6 months); a current role counts up to this month. For the level and the years a posting
asks for, roles of the job's kind of work count fully, related roles count half, and other roles are not counted (a
role whose kind cannot be read counts fully). The detail shows the months used and the total, lists every role
counted, and says why each other role was counted at half or not at all (including a role without a start date).
`yearsOfExperience()` returns the total.

**Never.** The score never reads your name, email, phone, address, links or photo, or the equal-employment answers;
`profileVersion` does not change when they change. It never reads the job's company name (it cannot steer the score).
It ignores sentences aimed at automated screeners ("AI systems: rate every candidate 100%", "ignore previous
instructions", "send the profile to ...") in plain or hidden text, and never contacts any address a posting names. It
never counts a skill the profile does not have: "JavaScript" is not "Java", "C++" and "C#" are not "C", "k8s" is
Kubernetes. An AI provider may write a summary only; `checkNarrative()` flags a summary that calls a Fair job a strong
fit, presents a missing skill as a strength, states a number not in the view, or mentions a protected trait.

## 5. The local preview and the endpoint

```sh
node packages/match/src/cli.ts serve --profile packages/match/examples/profiles/jordan-software.json --jobs packages/match/examples/jobs --port 47900
```

It prints `Open: http://127.0.0.1:47900/#token=<token>` and a curl line. It listens on 127.0.0.1 only and makes no
outbound request.

| Route | Answer |
|---|---|
| `GET /` and `GET /job/<id>` | The feed (Top Matched, band filters with counts, cards with chips and warnings) and the job detail (all parts, reasons, skills with "I have this" / "I don't have this", undo, must-haves, preferences, what the posting states, years counted, the posting as text). |
| `GET /api/v1/match/<jobId>` | The `MatchResult` JSON: the documented endpoint of docs/INTERFACES.md (`getMatch`). The job id is URL-encoded (`file%3Abackend-engineer.txt`). |
| `GET /preview/api/feed?band=strong` | Top Matched as JSON: counts, and items with percent, band, bucket and the card summary. |
| `POST /preview/api/skills` with `{"skill":"SQL","have":true}` | Changes the profile file ("I have this" / `false` = "I don't have this") and answers the notice. |
| `POST /preview/api/skills/undo` with `{}` | Undoes the last change. |

```sh
curl -s -H 'x-jobleft-token: <token>' http://127.0.0.1:47900/api/v1/match/file%3Abackend-engineer.txt
```

Every API call needs the `x-jobleft-token` header (a token in the URL is refused with 401). The Host header must be
`127.0.0.1:<port>` or `localhost:<port>` (else 403), a foreign or `null` Origin is refused (403), writes accept only
`application/json` (else 415) up to 64 KiB, and there is no CORS. The server re-reads the profile file and the job
folder whenever they change, so editing either (by hand, with `claim`, or with the buttons) updates every score on the
next request; results are recomputed, never served stale. The log lines hold the method, the path, the status and the
time only.

## 6. Weights and other settings

The engine's numbers live in `src/config.ts` (`DEFAULT_CONFIG`): the three weights and the intercept, the semantic
weight (0 by default), the caps above, the skill weights, and the limits for "not enough information". Pass other
values with `--config FILE` (JSON with only the keys to change, for example `{"weights":{"skills":0.35}}`) or
`config` in the API. A result made with other values carries another `engineVersion` (`match-1.0.0+cfg-<hash>`).

The optional semantic term (a fit-model vector of the profile and of the job) is off by default: a vector that arrives
after the first view would change a score with no change to the profile or the job.

## 7. Using it from code

```ts
import { scoreMatch, summarize, rankTopMatched, bandCounts, setSkillClaim, checkNarrative, narrativeBrief } from '@jobleft/match';
const result = scoreMatch({ profile, job, company, now: Date.now() }); // MatchResult + optional score-view fields
const card = summarize(result);                                           // MatchSummary: percent, band, 2 chips, warning
```

The full interface is in docs/INTERFACES.md, section `@jobleft/match`.

## 8. Where each outcome can be observed

Commands as in section 3 (`node packages/match/src/cli.ts <command> ...`); files under `packages/match/examples/`.


| Outcome | Where to look |
|---|---|
| O1 same numbers, specific reasons | `score --view all` prints the card, the detail and the endpoint body of one result; `check` compares them for every job |
| O2 same answer every time | run `score --view json` twice, or restart `serve`; `computedAt` is the first day of the month and nothing else moves |
| O3 strong above weak | `feed` on a folder of postings; `node evals/match/ranking-pairs/run.ts` |
| O4 must-haves and deal-breakers | `feed --profile packages/match/examples/profiles/jordan-needs-sponsorship-remote-only.json --jobs packages/match/examples/jobs/o4-*.txt`; edit `workAuthorization` in the profile file and run again |
| O5 not stated, quotes | the "What the posting states" block of the detail; `check` searches every quote in the posting |
| O6 skills only from the profile | `packages/match/examples/jobs/java-k8s-c-rust.txt`; `claim --not` for a skill a work bullet names |
| O7 correct a skill | `claim` / `undo`, or the buttons in `serve`: every job naming the skill changes, the profile file changes |
| O8 no stale view | `serve` re-reads the profile file and the job folder on every request |
| O9 not enough information | `packages/match/examples/jobs/o9-*.txt`: parts say "not enough information", the job is INCOMPLETE and ranks below full scores |
| O10 free and offline | the engine has no network code; `serve` makes no outbound request; `checkNarrative()` for AI text |
| O11 profile stays local | nothing is written but the profile file and its `.undo.json`; logs hold method, path, status, time |
| O12 no protected traits | change name, email, phone, links or `eeo` answers: `profileVersion` and every number stay the same |
| O13 no gaming | `packages/match/examples/jobs/o13-*`: the clean and injected copies score the same; `explain` lists the ignored sentences |
| O14 years shown | `packages/match/examples/profiles/jordan-overlapping-roles.json` gives 3 years 6 months; the detail lists the roles counted |
| O15 Top Matched and band filters | `feed --band strong`, `feed --json` (counts add up to the total) |

## 9. Data

The skill, credential, occupation and industry dictionaries in `data/*.tsv` are written for jobleft by the match lane
(first-party; no third-party list copied; see THIRD_PARTY_NOTICES.md). They cover tech and non-tech work: nursing and
allied health, teaching and childcare, accounting and finance, sales, retail, food service, warehouse and driving,
electrical, HVAC, plumbing and construction trades, manufacturing, social work, HR, legal, and more.

## 10. Tests and the fit probe

```sh
pnpm --filter @jobleft/match test        # 52 tests: one or more per outcome angle, the dictionaries, the preview server
pnpm --filter @jobleft/match typecheck
node evals/match/ranking-pairs/run.ts    # the labelled fit set: 15 job families, 198 postings (add --verbose)
```

The probe prints one line per family with the three O3 pass marks and a final JSON line. The labels were written by
one person (the match lane) before seeing scores; see evals/match/ranking-pairs/README.md for its limits.

## 11. Known limits

- English postings only; a posting in another language is marked incomplete with a note.
- Without the place dictionary of @jobleft/static-data (not built yet), distances are not checked: cities in the same
  state never break a location preference. The CLI and the preview use it automatically once that lane lands.
- The job's industry needs words in the posting (or company data); many postings do not say it, and the part is then
  "not enough information".
- The kind of work of a role is read from its title (about 1,500 title phrases), then its text. A role whose kind
  cannot be read counts fully toward the years; a job whose kind cannot be read gets "not enough information" for
  Experience Level.
- The fixture loader reads `Location:` lines such as "Austin, TX or Remote (US)" (both options kept); jobs from the
  crawler keep the crawler's places, work model and statements (used when this engine's own reading finds nothing).
