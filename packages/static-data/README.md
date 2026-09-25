# @jobleft/static-data

The data that ships with jobleft, and the lookups over it:

| Part | What it answers | Where the data comes from |
|---|---|---|
| H-1B sponsor data | How many certified H-1B filings a company made, when, by which legal filers | US Department of Labor (DOL) LCA disclosure files, FY2025 Q1 to FY2026 Q3 (decisions from 2024-10-01 to 2026-06-30) |
| Company names | Which names are the same company (`companyKey`, a reviewed alias table) | jobleft's own reviewed table, checked against DOL filer names, cities and FEINs |
| Places | Which place a location text names; distances; remote scope | USGS GNIS (US places) and Natural Earth (world cities) |
| Company facts | Founded, headquarters, size, industry, website, stage, leaders | Wikidata, SEC EDGAR and GLEIF, read on demand and kept per company |
| Dataset releases | Newer sponsor or place data without a new app version | Signed release manifests; a bad release changes nothing |

Sponsor and place lookups work with the network off. Nothing is uploaded.

All commands below run from the repository root with Node 24 or newer. There is nothing to install for this package.
Every command also takes `--json` for the full answer. Commands use the data folder `$JOBLEFT_HOME` (default
`~/Library/Application Support/jobleft` on macOS). For tests, set a scratch folder first:

```sh
export JOBLEFT_HOME=/private/tmp/jl-try
```

---

## 1. H-1B sponsor lookup

```sh
node packages/static-data/src/cli.ts h1b "Stripe, Inc."
node packages/static-data/src/cli.ts h1b "Stripe" --title "Software Engineer"     # adds the share for similar roles
node packages/static-data/src/cli.ts h1b "Baltimore Orioles"
node packages/static-data/src/cli.ts h1b "Amazon Web Services" --json
```

What you see for Stripe (abridged):

```
Stripe, Inc.  ->  company key "stripe"
Status: found. Tag: "H-1B sponsor likely" (likely)
  513 certified H-1B filings from Oct 1, 2024 to Jun 30, 2026 (data through Jun 30, 2026)
  Newest 12 months of the data (Jul 1, 2025 to Jun 30, 2026): 294
  By US federal fiscal year (Oct 1 to Sep 30): FY2025 271; FY2026 242 (partial year: data ends before Sep 30)
  Similar roles (Computer and Mathematical occupations (SOC 15)): 80% of these filings
  Legal filers behind these numbers (EMPLOYER_NAME and FEIN in the public file):
       311  Stripe, Inc.  [FEIN 27-0465600]  South San Francisco, CA
            per file: FY2025_Q1 62, FY2025_Q2 36, FY2025_Q3 121, FY2025_Q4 52, FY2026_Q3 40
       202  Stripe, LLC  [FEIN 27-0465600]  South San Francisco, CA
            per file: FY2026_Q3 202
  Source: US Department of Labor, Office of Foreign Labor Certification, LCA disclosure data (...)
  Note: Based on 513 certified H-1B filings ... Past filings are not a promise of visa sponsorship for this role.
```

For a name that is not in the data you see `Status: unknown. Not found as an employer in the H-1B filing data for
Oct 1, 2024 to Jun 30, 2026. Sponsorship is unknown, not ruled out.` The answer is `found` or `unknown`. There is no
"no" value anywhere, and a missing or damaged data file also gives `unknown` (with a warning), never "no".

### 1.1 What is counted

| Rule | Detail |
|---|---|
| Rows | `CASE_STATUS` exactly `Certified` and `VISA_CLASS` exactly `H-1B`. `Certified - Withdrawn`, `Withdrawn`, `Denied`, E-3 and H-1B1 rows never count |
| Filer entity | One exact `EMPLOYER_NAME` text plus its `EMPLOYER_FEIN`. The answer lists every entity with its count per file, so any number can be checked in the public file |
| Window | All rows of the five official files: FY2025 Q1, Q2, Q3, Q4 and FY2026 Q3 (DOL publishes FY2026 Q1 to Q3 as one file). Decisions from 2024-10-01 to 2026-06-30. No case number appears in two files |
| Years | US federal fiscal years (Oct 1 to Sep 30), always labelled `fiscal`. FY2026 is marked partial because the data ends on Jun 30 |
| Status | `likely` needs 10 or more filings in the window, 3 or more in the newest 12 months, and 1 or more for a new hire or a transfer. Anything less is `some_history` ("Some H-1B history") |
| Client sites | Only the employer columns name a filer. A company that appears only in `SECONDARY_ENTITY_BUSINESS_NAME` (the client site of a staffing firm) is never matched |
| Role share | With `--title`, the job title maps to a 2018 SOC major group through a title table built from the filings (at least 60% of at least 5 filings agree), else plain keyword rules; the share is the filer's filings in that group |

### 1.2 How names match (no similarity scores)

1. A reviewed alias entry (`data/company-aliases.json`, 222 entries) maps a brand to its legal filers: `Ramp` to Ramp Business Corporation, `Notion` to Notion Labs, `OpenAI` to OpenAI OpCo, `Meta`, `Facebook` and `Instagram` to Meta Platforms, `AWS` to Amazon Web Services, `Robinhood` to Robinhood Markets (never "Robinhood Group"). Each entry states its basis.
2. Otherwise filers whose legal name has the same `companyKey`. The key removes case, accents, punctuation, "&" or "+" versus "and", a leading "The" and legal suffixes (Inc, Inc., LLC, L.L.C., Corp, Corporation, Co, Ltd, LLP, PLC, PBC, GmbH and similar). It never removes ordinary words ("Technologies", "Group", "Services", "Holdings", "Labs").
3. Otherwise filers whose trade name (`TRADE_NAME_DBA`, or a "d/b/a" part of the name) has the same key (`Carta` finds eShares, Inc.).
4. Inside one key, filings under a different FEIN in a different state are a different company and are left out (listed under "Left out"). Example: `Databricks` keeps Databricks, Inc. (San Francisco, 810) and leaves out DATA BRICKS INC (Columbia, MD, 7). When no FEIN clearly dominates, the answer is `unknown`.

There is no prefix match: `Ramp` never finds "Rampart ...", and `Baltimore Orioles`, `Silvus Technologies`,
`Lamb Insurance Services` and `Kuros Biosciences` are all `unknown`.

### 1.3 Check a number against the public DOL file

Download one official file from https://www.dol.gov/agencies/eta/foreign-labor/performance (for example
`LCA_Disclosure_Data_FY2026_Q3.xlsx`, 252 MB). Then count certified H-1B rows by employer name, with code that shares
nothing with the lookup's matching:

```sh
node packages/static-data/src/cli.ts count-lca --lca ~/Downloads/LCA_Disclosure_Data_FY2026_Q3.xlsx --contains "stripe"
```

It prints each exact `EMPLOYER_NAME` and FEIN that contains the text, with its certified H-1B rows. Add up the rows
of the filer entities that `h1b` names; the sum equals the per-file count `h1b` shows. Our build was cross-checked
file by file against an independent openpyxl parse for 28 filer entities (Stripe, NVIDIA, Airbnb, Databricks,
Palantir, AWS, Meta, Notion, Ramp, OpenAI, Robinhood): 0 differences.

### 1.4 The tag and the filter (for the UI and the store)

`h1bTagFor(statements, summary)` is the one rule for the job card tag and the H-1B filter: the post's own words win
(`sponsorship: "no"`, US citizens only or a clearance give `post_says_no`, each with its own words; `"yes"` gives
`post_says_yes`), and the filing history (`likely`) is used only when the post says nothing.
`passesH1bFilter(tag)` keeps exactly the positive tags.

---

## 2. Places

```sh
node packages/static-data/src/cli.ts place "san francisco, ca, USA"
node packages/static-data/src/cli.ts place "SF"
node packages/static-data/src/cli.ts place "Portland"
node packages/static-data/src/cli.ts place "New York, NY; Austin, TX; Remote"
node packages/static-data/src/cli.ts place "Remote (Canada)"
node packages/static-data/src/cli.ts within "Austin, TX | Round Rock, TX | Houston, TX | Austin, MN | Texas" --miles 25
```

| Input | Result |
|---|---|
| `San Francisco, CA`, `San Francisco, California`, `san francisco, ca, USA`, `SF` | one place, `gnis:277593` |
| `New York, NY`, `New York City`, `NYC`, `New York, New York, United States` | one place, `gnis:975772` |
| `St. Louis, MO`, `Saint Louis, Missouri` | one place, `gnis:765765` |
| `Portland, OR` / `Portland, ME`, `Columbus, OH` / `Columbus, GA` | different places |
| `Portland`, `Columbus`, `Washington`, `Georgia` | nothing resolved; the candidates are listed as "could also mean" |
| `Tbilisi, Georgia` | Tbilisi, GE |
| `Remote - US`, `Anywhere in the US`, `United States` | `notACity: true`, country US; remote scope US |
| `Remote (Canada)` | `notACity: true`, remote scope CA (not US) |
| `Building 7, Campus West` | nothing resolved; shown as written |
| `within ... --miles 25` of Austin, TX | Round Rock IN (17.1 miles); Houston, Austin MN and a state OUT |

The rules are exact: normalization (case, accents, "St." / "Saint", "Ft." / "Fort", a trailing country), the state or
country the text gives, then a city's rank (incorporated city first) and population. A name with no state resolves
only when one candidate clearly dominates (for example `Austin`); otherwise nothing is resolved and the candidates
are listed. A state or country alone has no coordinates, so it never matches a distance filter.

---

## 3. Company facts

```sh
node packages/static-data/src/cli.ts company "NVIDIA" --refresh
node packages/static-data/src/cli.ts company "NVIDIA"                  # kept facts, no request
node packages/static-data/src/cli.ts company "Qxlorvane Widgets LLC" --refresh
```

Every fact line shows the value, the source name, a link that states it, and when jobleft read it. Fields no source
states print `not found`. The last line says how many requests the command sent.

| Rule | Detail |
|---|---|
| Sources | Wikidata (by a reviewed item id in `data/company-identifiers.json`; its search API is closed to automated clients by robots.txt), SEC EDGAR (by the CIK Wikidata names; the SEC record's EIN must equal a DOL FEIN of the company, or its name must match), GLEIF (by LEI, or by the exact legal filer name in the filer's state), and the company's own DOL filings (employer address, NAICS sector) as a last resort |
| Identity | A source's record is used only when it names the same company; otherwise its status is `not_same_company` and nothing from it is shown |
| Never invented | Funding, investors and news have no free source; they stay empty unless a paid lookup finds them with a quote that states them |
| Kept | Facts are kept per company (all names of one alias entry share one record) in `$JOBLEFT_HOME/data/jobleft.db`, table `company_facts`, for 30 days. `--refresh` sends requests only when they expired; `--force` re-reads; `--expire` expires all kept facts |
| Failures | A refresh that fails keeps the old facts and shows `Last error: ...`; it tries again after an hour, not on every open |
| Paid | Only with `--allow-paid` and a search endpoint (`--search-url`), within `--max-price-micros`. The cost prints as dollars "from your balance" |
| Privacy | Requests carry only what names the company: a Wikidata id, a CIK, a legal name, or the company name in a search query |

### 3.1 Test with the mock sources (no real network)

Terminal 1:

```sh
node packages/static-data/src/cli.ts mock-facts --scenario other-company --log /private/tmp/jl-mock-facts.log
```

Terminal 2:

```sh
export JOBLEFT_HOME=/private/tmp/jl-facts
export JOBLEFT_HOST_MAP='{"www.wikidata.org":"http://127.0.0.1:4780","data.sec.gov":"http://127.0.0.1:4780","api.gleif.org":"http://127.0.0.1:4780"}'
S=http://127.0.0.1:4780/search
node packages/static-data/src/cli.ts company "Notion" --refresh --allow-paid --search-url $S            # 1st job
node packages/static-data/src/cli.ts company "Notion" --refresh --allow-paid --search-url $S            # 2nd job: 0 requests
node packages/static-data/src/cli.ts company "Notion Labs, Inc." --refresh --allow-paid --search-url $S # 3rd job: 0 requests
curl -s http://127.0.0.1:4780/balance                                  # {"balanceMicros":990000,"balance":"$0.99"}: fell once
JOBLEFT_CLOCK_OFFSET=31d node packages/static-data/src/cli.ts company "Notion" --refresh             # expired: new requests
cat /private/tmp/jl-mock-facts.log                                     # every request, with its query
```

With `--scenario other-company` the search results describe a different "Notion" (a bakery in Austria, a mining firm
in Australia): the company block shows no funding, stage or news, and the paid line says the proposed facts were left
out. With `--scenario empty` nothing is found. With `--scenario match` a result that names the company and its city
gives funding and stage with the quote's link. Restart the mock with `--fail` and refresh with
`JOBLEFT_CLOCK_OFFSET=62d`: the old facts stay and `Last error` explains the failure. The mock serves recorded,
trimmed answers for NVIDIA, Stripe and Notion (`test/fixtures/facts`).

---

## 4. Dataset list and updates

```sh
node packages/static-data/src/cli.ts datasets
```

It lists every shipped dataset with its version, data date, size, licence, attribution and source, then the live
fact sources (Wikidata, SEC, GLEIF). A failed update shows `LAST UPDATE ERROR: ...` under the dataset.

### 4.1 Update from a release, and prove a bad release changes nothing

A release is installed only when all of these hold: the address is https (plain http only on 127.0.0.1 or localhost);
the manifest signature verifies with a key in `data/release-keys.json`; the release's sequence number is higher than
the data in use (a downgrade is refused); the file has exactly the size and sha256 the signed manifest states; and the
file parses and agrees with the manifest. The file is written under a temporary name, synced and renamed, then
`$JOBLEFT_HOME/datasets/active.json` is replaced the same way. An installed file that is later damaged is noticed at
load time and the shipped copy is used instead, with a warning.

The project has no public release location or production key yet. The mock release server serves a **synthetic test
release** (one made-up quarter, FY2026 Q4, marked "TEST RELEASE (synthetic data)") signed with a test key that jobleft
trusts only on 127.0.0.1.

Terminal 1 (restart it for each mode):

```sh
node packages/static-data/src/cli.ts mock-release --mode valid        # or: truncated | tampered | badsig | older
```

Terminal 2:

```sh
export JOBLEFT_HOME=/private/tmp/jl-update
node packages/static-data/src/cli.ts h1b Stripe | sed -n 3p          # 513 filings, data through Jun 30, 2026
node packages/static-data/src/cli.ts update --manifest http://127.0.0.1:4777/manifest.json
node packages/static-data/src/cli.ts h1b Stripe | sed -n 3p
node packages/static-data/src/cli.ts datasets | head -7
```

| Mode | `update` prints | After it |
|---|---|---|
| `truncated` | `FAILED ... the download stopped after 1,902,044 of 3,804,089 bytes. The data in use has not changed.` | Same date and counts; error listed |
| `tampered` | `REFUSED ... does not match the sha256 in the signed manifest (changed bytes)` | Same |
| `badsig` | `FAILED ... the release signature does not verify` | Same |
| `older` | `REFUSED ... is older than the data in use ...; a downgrade is never installed` | Same |
| `valid` | `INSTALLED Installed h1b-lca FY2026Q4-TEST-VALID (data through 2026-09-30).` | Stripe 596 filings through Sep 30, 2026; the source says TEST RELEASE |

`update` exits 1 when a release was refused or failed. The modes use different sequence numbers, so they can run in
any order. To go back to the shipped data, delete `$JOBLEFT_HOME/datasets`.

---

## 5. Rebuild the shipped data from the official sources

The shipped files are in `packages/static-data/dist/` (`h1b-lca.json.gz` 3.6 MB, `places.json.gz` 3.1 MB,
`datasets.json`, and build reports in `dist/reports/`). A rebuild with the same inputs and the same
`SOURCE_DATE_EPOCH` gives the same bytes.

```sh
export SOURCE_DATE_EPOCH=1790294400          # 2026-09-25T00:00:00Z, the date of the shipped build
# H-1B: downloads 5 official files (about 670 MB; checks free disk first), verifies each size and sha256, then builds (about 35 s)
node packages/static-data/src/cli.ts fetch-lca --out /private/tmp/lca
node packages/static-data/src/cli.ts build-h1b --lca /private/tmp/lca/LCA_Disclosure_Data_FY2025_Q1.xlsx \
  --lca /private/tmp/lca/LCA_Disclosure_Data_FY2025_Q2.xlsx --lca /private/tmp/lca/LCA_Disclosure_Data_FY2025_Q3.xlsx \
  --lca /private/tmp/lca/LCA_Disclosure_Data_FY2025_Q4.xlsx --lca /private/tmp/lca/LCA_Disclosure_Data_FY2026_Q3.xlsx
# Places: downloads USGS GNIS and Natural Earth (about 14 MB), then builds
node packages/static-data/src/cli.ts build-places --src /private/tmp/jl-place-src
```

Expected: `h1b-lca.json.gz` sha256 `534a70ca...` and `places.json.gz` sha256 `7886fa08...` (full values in
`dist/datasets.json`). The H-1B build report lists, per file, the rows, the certified H-1B rows and every status count
(for example FY2026 Q3: 437,496 rows, 392,175 certified H-1B), and the total of 931,619 certified H-1B filings in
94,974 filer entities.

GeoNames: the plan names GeoNames (CC BY 4.0) for places, but its download hosts forbid automated clients in
robots.txt, so jobleft never fetches it. A person may download `cities1000.zip`, `admin1CodesASCII.txt` and
`countryInfo.txt` from https://download.geonames.org/export/dump/ in a browser and run
`build-places --src <dir> --geonames <folder with those files>`: GeoNames then replaces Natural Earth outside the US,
and the table carries the GeoNames attribution.

---

## 6. Library interface (for other lanes)

`import { ... } from '@jobleft/static-data'`. Full signatures: `docs/INTERFACES.md`, section `@jobleft/static-data`.

| Export | What |
|---|---|
| `companyKey(name)` | The one company match key |
| `loadAliases(opts)` | `keysFor(name)`: every key of the same company (reviewed table only) |
| `loadH1bIndex(opts)` | `lookup(name, { jobTitle? })` -> `found` or `unknown` with the summary and its details; `dataset()` |
| `loadPlaceIndex(opts)` | `resolve(text)`, `distanceMiles(a, b)`, `within(placeId, miles)`, `dataset()` |
| `h1bTagFor(statements, summary)`, `passesH1bFilter(tag)` | The shared tag and filter rule |
| `CompanyFacts` | `note(name)`, `get(key)` (no request), `refresh(key, { allowPaid, maxPriceMicros?, force?, name? })`, `expireAll()` |
| `listDatasets(opts)`, `updateDatasets(opts)` | The data-sources list and the release updater |
| `createStaticDataRoutes(opts)` | Handlers for the six local API routes (`h1bLookup`, `placeLookup`, `getCompany`, `refreshCompany`, `listDatasets`, `updateDatasets`) |

`opts` is `{ dataDir: "$JOBLEFT_HOME/datasets" }`; the shipped copies are read from this package's `dist/`.

## 7. Tests

```sh
pnpm --filter @jobleft/static-data test        # 28 tests, about 12 s
pnpm --filter @jobleft/static-data typecheck
```

The tests build tiny synthetic LCA files with known counts, check the shipped data against the outcome examples, run
every mock release mode, and run the company-fact rules on recorded source answers.

## 8. Environment

| Variable | Use |
|---|---|
| `JOBLEFT_HOME` | The data folder (`datasets/`, `data/jobleft.db`) |
| `JOBLEFT_DATASET_MANIFEST_URL` | The release address (none yet; pass `--manifest` to `update`) |
| `JOBLEFT_HOST_MAP` | Send a real host to a loopback mock (JSON map; loopback targets only) |
| `JOBLEFT_OFFLINE=1` | No request at all; lookups still work |
| `JOBLEFT_NOW`, `JOBLEFT_CLOCK_OFFSET` | Move the clock (for fact expiry) |
| `SOURCE_DATE_EPOCH` | Fixed build time for reproducible builds |

## 9. Known limits

- The shipped H-1B data ends on 2026-06-30 (the newest DOL file). DOL publishes a new file each quarter.
- Past filings are not a promise: an LCA certification is not a visa approval, and H-1B rules changed after some of these filings.
- The alias table covers 222 reviewed brands. Other brands whose legal name differs are `unknown` until reviewed.
- Wikidata facts need a reviewed item id (38 companies so far). SEC's main site blocks requests whose User-Agent has no contact address; data.sec.gov answered during the build. Funding, investors and news need the paid lookup, which needs the publik metered search route (not built yet) and a model-backed extractor (a rule-based one ships).
- Places: US coverage is every GNIS populated place (174,354); world coverage is the 6,561 Natural Earth cities unless GeoNames files are supplied. US populations exist only for the 763 cities that Natural Earth lists.
- No production release key exists yet; only the loopback test key is trusted.
- The skill dictionary (`loadSkills`) and the board directory rows (`loadDirectoryRows`) are still stubs.
