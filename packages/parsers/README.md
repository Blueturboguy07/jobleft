# @jobleft/parsers

This package reads the facts of a job posting. It works offline and gives the same answer every time.

| Fact | What you get | Unknown |
|---|---|---|
| Pay | `min`, `max`, `currency`, `period` (hour, day, week, month, year), `ranges` (how many tiers the posting states), yearly figures | `null` |
| Seniority | `levels`: one or two adjacent steps of Intern/New Grad, Entry, Mid, Senior, Lead/Staff, Director/Executive. Also a fine-grained `level` | `[]` and `null` |
| Required years | `yearsRequired`: `{ min, max }`, the lowest number that meets the requirement | `null` |
| Place | `places`: every place the posting names, each with `city`, `region` (state or province), `country` (ISO code) | `[]` |
| US or not | `isUs`: `true`, `false` | `null` |
| Work model | `workModel`: `onsite`, `hybrid`, `remote`, and `remoteScope` (the areas a remote job is open to, in the posting's words) | `null` |
| Other | `employmentType`, and `statements` (visa sponsorship, clearance, US citizens only) | `null` |

Each fact that has a value also has `evidence`: the source (`board_field`, `title`, `description`, `location_text`) and the words that hold the fact.
The package never fills a missing fact with a default. It never makes a network request. It never reads a file (the CLI reads the files you give it).

The job endpoints, job cards and filters of the app come from other packages (`@jobleft/crawler`, `@jobleft/store`, the server and the UI). They call `extractFacts` from this package. Until those lanes land, use the CLI below to see the facts.

## Try it (5 minutes)

Run all commands from the repository root. You need Node 24 and pnpm.

1. Install the workspace.

   ```sh
   pnpm install
   ```

2. Read a sample job board in the Greenhouse format.

   ```sh
   node packages/parsers/src/cli.ts board packages/parsers/examples/greenhouse-board.json --table
   ```

   You see one row for each of the 8 sample postings:

   ```
   id  | title                          | pay                 | level                   | years | place               | US  | model
   101 | Registered Nurse - Night Shift | $48/hr              | Entry Level             | 1+    | Portland, ME, US    | yes | -
   103 | Software Engineer III          | -                   | Entry Level             | 0-2   | Canada              | no  | remote (CA)
   104 | Account Executive              | $60K/yr             | Mid Level               | 3+    | New York, NY, US +2 | yes | hybrid
   106 | Data Analyst                   | -                   | -                       | -     | Tbilisi, Georgia    | no  | -
   ...
   ```

   A `-` means unknown. Posting 101 shows `$48/hr`, not the `$4/hr` night differential or the `$5,000` sign-on bonus. Posting 104 shows the `$60K` base, not the `$120K` OTE.

   The same works for the Lever and Ashby formats:

   ```sh
   node packages/parsers/src/cli.ts board packages/parsers/examples/lever-board.json --table
   node packages/parsers/src/cli.ts board packages/parsers/examples/ashby-board.json --table
   ```

3. See every fact and its evidence as JSON.

   ```sh
   node packages/parsers/src/cli.ts board packages/parsers/examples/greenhouse-board.json
   ```

4. Read a posting that you paste or save as text.

   ```sh
   node packages/parsers/src/cli.ts text packages/parsers/examples/pasted-posting.txt
   pbpaste | node packages/parsers/src/cli.ts text -          # macOS clipboard
   node packages/parsers/src/cli.ts text posting.html --html  # a saved HTML page
   ```

   Without `--title`, the first non-empty line is the title. `--location "Austin, TX"` and `--workplace remote` add the board fields that a paste does not have.

5. Point the CLI at your own local mock board.

   ```sh
   node packages/parsers/scripts/serve-board.ts my-board.json --port 8765 &
   node packages/parsers/src/cli.ts board http://127.0.0.1:8765/v1/boards/acme/jobs --table
   ```

   The mock server logs each request to stderr. The CLI fetches only loopback URLs (`127.0.0.1`, `localhost`, `::1`). It refuses every other host.

6. Print the rule that pay filters and pay sorting use.

   ```sh
   node packages/parsers/src/cli.ts rule
   ```

7. Run the tests and the type check.

   ```sh
   pnpm --filter @jobleft/parsers test
   pnpm --filter @jobleft/parsers typecheck
   ```

## Board formats

`board` detects the format. Use `--format` to set it.

| Format | Input | Fields read |
|---|---|---|
| `greenhouse` | `{ "jobs": [...] }` from `/v1/boards/{token}/jobs?content=true` | `title`, `location.name`, `offices`, `content` (entity-encoded HTML), `pay_input_ranges`, `metadata` (workplace type, employment type) |
| `lever` | `[...]` from `/v0/postings/{site}?mode=json` | `text`, `categories.location`, `categories.allLocations`, `categories.commitment`, `workplaceType`, `country`, `description`, `lists`, `additional`, `salaryRange`, `salaryDescription` |
| `ashby` | `{ "jobs": [...] }` from `/posting-api/job-board/{name}?includeCompensation=true` | `title`, `location`, `secondaryLocations`, `address`, `isRemote`, `workplaceType`, `employmentType`, `descriptionHtml`, `compensation.compensationTiers` (Salary parts only) |
| `workable` | `{ "jobs": [...] }` or `{ "results": [...] }` | `title`, `location`, `locations`, `workplace`, `remote`, `employment_type`, `description`, `requirements`, `salary` |
| `recruitee` | `{ "offers": [...] }` | `title`, `location`, `locations`, `city`, `country_code`, `remote`, `hybrid`, `on_site`, `salary`, `experience_code`, `description`, `requirements` |
| `personio` | the XML feed as an object (`position` list) | `name`, `office`, `additionalOffices`, `employmentType`, `seniority`, `yearsOfExperience`, `jobDescriptions` |
| `jsonld` | a schema.org `JobPosting` object, a list of them, or an HTML page with `application/ld+json` blocks | `title`, `description`, `jobLocation`, `jobLocationType`, `applicantLocationRequirements`, `baseSalary`, `employmentType`, `experienceRequirements`. `estimatedSalary` is never read |

## How each fact is read

| Fact | Rules |
|---|---|
| Pay | The board's pay field, or the posting text. When both give pay and they differ, the text wins and `ranges` is at least 2. A figure needs a currency and either a period (`/hr`, `per year`, `mensual`, `brut annuel`, ...) or a pay word nearby (`salary`, `pay`, `rate`, `compensation`, `sueldo`, `Gehalt`, ...). The period is never guessed from a `k`. "Up to $X" has no minimum. "From $X" and "$X+" have no maximum. One figure is `min = max`, never a range. Bonuses, sign-on, stipends, differentials, tips, OTE (when base pay is stated), 401(k), tuition, HSA, company revenue and funding, budgets, estimates by job sites, and "similar jobs" blocks are never read as pay. With tiers (by city, zone or level), the tier that names the job's place wins, else the first; `ranges` says how many there are. A bare `$` in a Canadian job is CAD, in a Mexican job MXN |
| Seniority | The title gives a reading with a strength. Strong words (Intern, Director, VP, Chief ... Officer, Head of, people manager, supervisor) decide. Middle words (Senior, Junior, Staff and Principal in the tech sense, grades such as II, III, L4) agree with the stated years or move by one step; when the years are two or more steps away, the years decide. Weak words give a level only when nothing else speaks: Associate, Assistant, Cashier, Crew Member and other first-line jobs give Entry Level; licensed and trade jobs give the level their license or trade needs (Registered Nurse, Teacher, Technician, Driver: Entry or Mid; LCSW, Therapist, Counselor: Mid; Psychiatrist, Psychologist, Nurse Practitioner, Pharmacist, Veterinarian: Mid or Senior). "Senior Care Aide", "Staff Nurse", "Internal Audit", "Shift Manager" and "Account Executive" never become Senior, Lead/Staff, Intern or Director by one word. Posting words such as "new grads welcome" and "no experience required" give Intern/New Grad or Entry Level |
| Years | Only experience requirements: "18 years or older", "for over 50 years", "vests over 4 years", "four-year degree" and "within the last 3 years" are never read. Alternatives ("5 years, or 3 years with a master's") give the lowest. A preferred figure never replaces a required one. Several joint requirements give the highest |
| Place | Every place in the location field(s) and structured addresses. The stated state or country wins ("Paris, TX", "London, KY", "Portland, ME", "Tbilisi, Georgia"). A bare city takes its only country, a clear dominant reading, or the posting's own words; otherwise its country stays unknown. "Remote", "Multiple locations", "Various" and "N/A" are not places. Places in the text are read only when the board gives none, and a head-office line never counts |
| US or not | Board country codes first. A remote job limited to other areas (Canada only, EMEA, India) is not a US job. Plain "Remote" is unknown |
| Work model | The board's workplace field, work-model words in the location field and the title, and specific phrases in the text ("this role is fully remote", "3 days a week in the office", "this is not a remote position"). "Remote patient monitoring", "remote sensing", "remote teams" and "hybrid cloud" never count. When sources disagree, the stricter reading wins (onsite, then hybrid, then remote). Remote limits keep the posting's words: countries, regions, state lists, time zones, and distance from an office |

Languages: English, and the common pay, period and level words in Spanish, French, German, Portuguese and Italian. Japanese and Korean pay (時給, 月給, 年収, 円, 원) are read. Other text is kept and never dropped; its facts can be unknown.

## Library

| Export | What it does |
|---|---|
| `extractFacts(input: PostingInput): PostingFacts` | Every fact with evidence. Never throws: a reader that fails leaves its fact `null` and adds a line to `warnings` |
| `postingsFromBoard(json, format?)`, `fromGreenhouse`, `fromLever`, `fromAshby`, `fromWorkable`, `fromRecruitee`, `fromPersonio`, `fromJsonLd`, `detectFormat` | Board answers to `PostingInput` |
| `parsePay(text, opts)`, `payFromBoard(pays, opts)`, `parsePayFromText(text)`, `parseNumber`, `annualize` | Pay |
| `payMeetsMinimum(pay, minYearly, currency?)`, `paySortKey(pay)`, `formatPay(pay)`, `PAY_FILTER_RULE` | The one pay rule for filters, sorting and cards |
| `parseLocationText(text)`, `parsePlaces(text)`, `placesFromText(text)`, `placeFromAddress(address)`, `usFromFacts(places, regions, countries)`, `isUsLocation(text, countries?)`, `countryName(cc)` | Places and country |
| `parseWorkModel(text, fields)`, `workModelFromField(value)`, `regionsOfArea(text)` | Work model and remote area |
| `parseLevel(input)`, `readTitle(title)`, `levelsOf(level, years)`, `bucketsForYears(min, max)`, `levelFromTitle(title)`, `levelFromDescription(text)` | Seniority |
| `parseYearsRequired(text)` | Required years |
| `parseStatements(text)`, `parseEmploymentType(field, text, title)` | Sponsorship, clearance, citizenship; employment type |
| `htmlToText(html)`, `decodeEntities(s)`, `unescapeEncodedHtml(s)` | HTML to plain text. The whole text is kept |

The full signatures are in [docs/INTERFACES.md](../../docs/INTERFACES.md), section `@jobleft/parsers`.

## Known limits

- The place dictionary in this package is a compact list: US states, about 2,500 US city names, 116 countries, common regions and about 1,500 world cities. An unlisted city next to a state or country still resolves. A bare unlisted city keeps an unknown country. `@jobleft/static-data` owns the full gazetteer and the `placeId`.
- Per-unit pay (per mile, per visit, per shift) is not shown, because the contract has no such period.
- A monthly figure with no period word and no pay word is not read.
- Level words in languages other than English, Spanish, Portuguese, French and German are not read.
