# Acceptance outcomes: static data (H-1B sponsor data, company facts, places)

Area: plan items D3 (company facts) and D4 (H-1B sponsor tag and filter), plus the city dictionary that the location filter uses.
Sources read: `docs/PLAN.md` sections 1 to 8, `jobright-research/GAPS.md`, `jobright-research/audit/05-data-supply.md` Parts 3 and 4, `jobright-research/ui/UI-SPEC.md` and `UI-SPEC-LOGGED-IN.md` (job detail Company and H1B blocks, location filter).
Date: 2026-09-25.

These outcomes say what a user or a stranger must see. They do not say how to build it.

## Terms used in this file

| Term | Meaning |
|---|---|
| Sponsor data | The H-1B employer data that ships with the app. It comes from the public US Department of Labor (DOL) Labor Condition Application (LCA) disclosure files |
| Sponsor tag | The short label on a job card and job detail that tells the user about H-1B sponsorship |
| Company facts | Founded year, headquarters, size, industry, website, funding, investors, leaders and news for a company |
| Place | The location text of a job, for example "San Francisco, CA" |
| Documented lookup | A command in the package README or an HTTP endpoint in `docs/INTERFACES.md` that returns the sponsor data, company facts or place for a given input |
| Fixture job | A test job that a stranger adds through a documented interface (for example "add a job from pasted text"), with a chosen company name, place and text |
| Fictional company | A made-up name with no public record, for example "Qxlorvane Widgets LLC" |

Rule for every test: use only the fake persona "Jordan Testwell" (jordan.testwell@example.com). Never use a real person's data.

---

## H-1B sponsor data

### O1 (MUST) A recent sponsor shows a hedged tag and the reasons

For a company that has many certified H-1B filings in about the last two years, the job card and the job detail show a sponsor tag with hedged wording (it says "likely", never "will sponsor"). The job detail shows why: the number of certified filings, the date window of those filings, the source (US Department of Labor), and a plain note that past filings do not guarantee sponsorship for this role.

Observe: Add fixture jobs for 5 frequent filers (for example Stripe, NVIDIA, Airbnb, Databricks, Palantir Technologies). Take a screenshot of each card and detail. Call the documented lookup for each name. Download the public DOL LCA disclosure file for the same window. Count the rows with status "Certified" and visa class "H-1B" for that employer. The count in the app must equal the count from the public file for the stated window.

Adversarial angles:
- The count includes Withdrawn, Denied or Certified-Withdrawn rows, so it is higher than the public file.
- The detail shows a count but no date window, so the user cannot tell if the data is old.
- The wording promises sponsorship ("sponsors H-1B for this role") instead of a hedged claim.
- A company with only one filing, or with filings only from years ago, gets the same strong wording as a company with hundreds of recent filings.

### O2 (MUST) Never say "no H-1B" because a company is missing from the data

When the sponsor data has no match for a company, the app shows no sponsor tag or says "unknown". It never shows "No H-1B", "does not sponsor", a negative marker, or a false value from the documented lookup.

Observe: Add fixture jobs for a fictional company and for 3 real small companies that do not appear in the public DOL file. Screenshot the card and detail. Call the documented lookup. The response must say unknown or not found. It must not say false or no. Search the whole UI and the lookup output for "No H-1B" and similar negative text.

Adversarial angles:
- The lookup returns a boolean, so "not found" turns into "false" and the UI prints a negative marker.
- The sponsor data fails to load (missing or corrupt file), and every company then shows as a non-sponsor.
- A negative marker from another signal (for example a clearance requirement) uses the same icon and words as "no sponsorship", so the user cannot tell them apart.

### O3 (MUST) The job post's own words win, and the app says where they came from

When the job post says that sponsorship is not available, or that US citizenship or a security clearance is required, the app shows that the post says so, even if the company has a filing history; when the post says it offers sponsorship, the app says the post states it. In both cases the user can see the sentence from the post.

Observe: Add 4 fixture jobs at a frequent filer (for example Airbnb): one with "Visa sponsorship is not available for this role", one with "US citizenship required", one with "We sponsor H-1B visas", and one with no statement. Screenshot each detail. The first two must not show the history-based positive tag as the main claim. The third must say "stated in the post". The fourth must fall back to the history (O1).

Adversarial angles:
- The history-based tag overrides an explicit "no sponsorship" sentence in the post.
- A company-wide boilerplate sentence (for example an equal-opportunity paragraph that mentions visas) triggers a wrong positive or negative on every job from that company.
- A negation that is far from the word "sponsor" ("We are unable, at this time, to offer visa sponsorship") is read as positive.
- The app states the post's position but does not show the sentence, so the user cannot check it.

### O4 (MUST) Name variants of the same company match the same record

The same company matches the same sponsor record when its name differs only by case, punctuation, accents, "&" or "+" versus "and", a leading "The", or a legal suffix (Inc, Inc., LLC, L.L.C., Corp, Corporation, Co, Ltd, LLP, PLC, PBC, GmbH). A brand name also matches the legal filer name when the two are known to be the same company, for example Ramp and "Ramp Business", Notion and "Notion Labs", OpenAI and "OpenAI OpCo", Meta and "Meta Platforms".

Observe: Call the documented lookup with each variant in this list and compare the records: "Stripe", "Stripe, Inc.", "STRIPE INC", "stripe inc", "Stripe LLC"; "Ramp", "Ramp Business Corporation"; "Notion", "Notion Labs, Inc."; "Meta", "Meta Platforms, Inc.". Every variant of one company must return the same record and the same count. Repeat through the UI with fixture jobs and compare screenshots.

Adversarial angles:
- "L.L.C." with periods, or a trailing comma, is not removed, so the variant is "unknown".
- The lookup is case-sensitive or accent-sensitive.
- A "doing business as" (DBA) name in the public file is ignored, so the brand name finds nothing.
- The brand "Robinhood" matches a small wrong filer ("Robinhood Group", 2 filings) instead of the real one ("Robinhood Markets", hundreds of filings).

### O5 (MUST) Never match a different company that only looks similar

Two different companies with similar names never share a sponsor record. When the app is not sure that two names are the same company, it treats the company as unknown (O2) and does not guess.

Observe: Call the documented lookup, and add fixture jobs, for each of these names: "Baltimore Orioles", "Silvus Technologies", "Lamb Insurance Services", "Kuros Biosciences". None of them may return the record of "Baltimore Aircoil", "SVS Technologies", "ABA Insurance Services" or "Aura Biosciences". Also try a short brand that is a prefix of other filers (for example "Ramp" must not match a filer named "Rampart ..."). Screenshot each result.

Adversarial angles:
- A similarity score with a threshold (even a high one) joins different companies.
- Removing common words ("Technologies", "Group", "Services", "Holdings") makes different names equal.
- A short name matches the first filer that starts with the same letters.
- An alias is added from a guess, with no confirmation, and then applies to every user.

### O6 (SHOULD) Parent, subsidiary and staffing cases are honest about whose filings they are

When a job's company is a known brand or subsidiary of a filer (for example "Amazon Web Services" and the Amazon filer entities, "Instagram" and "Meta Platforms"), the job detail names the legal filer whose numbers it shows. Filings where the company appears only as the client site of a staffing or consulting firm never count as that company's own sponsorship.

Observe: Add fixture jobs for "Amazon Web Services" and for "AWS". Screenshot the detail. It must name the filer entity or entities behind the numbers, and the total must equal the sum of those entities in the public file. Then find, in the public DOL file, a company that appears only in the secondary-entity (client site) column and never as the employer. Add a fixture job for it. It must show unknown, not a positive tag.

Adversarial angles:
- The same filing counts twice when a parent and a subsidiary both map to one company.
- A small, unrelated company inherits a large group's history because of a loose parent link.
- A staffing firm's thousands of client-site filings make every client look like a sponsor.
- The detail shows a group total but hides which legal entities it came from.

### O7 (SHOULD) The detail shows a yearly trend and the share for similar roles, and marks a partial year

For a matched company, the job detail shows certified filings per year and the share of filings in a role family similar to this job. A year that is not complete in the data is marked as partial, so a drop in that year does not look like a real decline.

Observe: Screenshot the detail for 3 frequent filers. Compare each year's count with the public DOL files for that year, and state whether the app uses fiscal years or calendar years. Check that the newest year carries a partial mark when the data ends before the year ends.

Adversarial angles:
- Fiscal years and calendar years are mixed without a label, so the counts do not match any public total.
- The current partial year shows as a steep fall with no mark.
- The "similar roles" share uses a role family that does not fit the job (for example a sales job compared with engineering filings).

### O8 (MUST) The sponsor tag and the H-1B filter always agree

When the user turns on the H-1B sponsorship filter, the results contain every job that shows a positive sponsor tag (by history or by the post's words) and no job that does not. A job whose post says that sponsorship is not available never appears in the filtered results.

Observe: Load a fixture set of at least 50 jobs with a known mix: frequent filers, fictional companies, and posts that state yes or no. Count the jobs with a positive tag in the unfiltered list (screenshots or documented list output). Turn on the filter. The filtered count must equal that number, and the two sets of jobs must be the same.

Adversarial angles:
- The filter uses a different rule or an older copy of the sponsor data than the tag.
- The filter includes jobs whose post says "no sponsorship" because the company has history.
- Paging or a result cap hides filtered jobs, so the count looks smaller than it is.

### O9 (MUST) The data date is visible, and an update never loses the data

The app shows the date of the newest filings in the sponsor data (for example "based on filings through June 30, 2026"), and the user can get a newer sponsor data release without a new app version. If an update fails, stops halfway or is damaged, the app keeps the previous data and date and tells the user, so the sponsor data is never lost or emptied.

Observe: Read the date on the job detail or the data screen. Point the app at a local mock release server (as the README describes) and serve, in turn: a newer valid release, a release that stops halfway, and a release with changed bytes. After the valid release, the date and counts change. After each bad release, the date, the counts and the tags stay the same as before, and the app shows an error message. Take screenshots before and after each step.

Adversarial angles:
- A half-downloaded file replaces the good one, and every company becomes "unknown".
- The date label does not change after a real update, or it changes after a failed one.
- The app starts with no network, cannot fetch an update, and shows no sponsor data at all instead of the data that ships with it.
- A damaged release loads without error and shows wrong counts.

---

## Company facts

### O10 (MUST) Every company fact names its source and its date

Each company fact on the job detail (founded year, headquarters, size, industry, website, funding, investors, leaders, news) shows where it came from and when the app got it, and a fact from a web search links to a page that states that fact. The app also lists every dataset that ships with it, with that dataset's date and licence, and gives the attribution that each licence requires.

Observe: Screenshot the company block for 10 companies (5 large, 5 small). For each fact, open the source link and confirm the page states the fact. Open the data sources screen, or the documented data-sources output, and check that each shipped dataset (sponsor data, city data and any other) has a name, a date and a licence, with attribution where the licence needs it.

Adversarial angles:
- The source link is the company home page, which does not state the fact.
- A fact shows with no date, so the user cannot tell that the funding total is two years old.
- A shipped dataset needs attribution (for example a CC BY place list) and the app does not give it.
- A dataset with a non-commercial or share-alike licence ships inside the app with no note.

### O11 (MUST) Never invent a company fact

When no source states a fact, the field is empty or says "not found"; the app never fills funding, investors, valuation, leaders, headcount or founded year from a guess or from a model's memory. The app never shows the facts of a different company that has a similar name.

Observe: Add a fixture job for a fictional company. Run the app with a local mock search server that returns no results. Screenshot the company block: every fact field must be empty or "not found", and no leader names or investors may appear. Then serve mock search results that describe a different company with a similar name (for example a different "Notion" in another country and industry). The app must not show those facts for the job's company.

Adversarial angles:
- A model writes plausible investors or a CEO name when the search results are empty.
- A size bucket is guessed from the number of open jobs and shown as a fact.
- A fact from a same-name company in another country or industry is shown.
- A fact from a search snippet is changed (for example "$40M" becomes "$400M").

### O12 (MUST) Company facts are kept and reused, and paid lookups need the user's consent

The app keeps company facts and reuses them for every job at that company, with no new request, until they pass their stated freshness period, and a failed refresh keeps the old facts. A lookup that costs money never runs without the user's action or setting, and the app shows its cost in dollars from the balance.

Observe: Run the app against local mock servers that log each request, and set a test balance. Open 3 jobs at the same company in a row. The mock log must show one set of lookups, not three, and the balance must fall once. Move the clock past the freshness period (or use a documented option to expire kept facts) and open a job again: new requests appear. Make the mock server fail on that refresh: the old facts must stay on screen. Check that the cost text says dollars and "balance", never "credits".

Adversarial angles:
- Facts are kept per job, not per company, so every job at one company costs money again.
- Kept facts never expire, so an old funding stage shows forever.
- A failed refresh clears the facts that were already there.
- Paid lookups start in the background for every company in the feed, with no setting that allows it.

---

## Places

### O13 (MUST) Different spellings of one city count as the same place, and same-named cities stay apart

Different spellings of one city (abbreviations, full state names or state codes, a trailing country, case, accents, "St." or "Saint", common short names) count as the same place, so a filter for that city finds the jobs in every spelling. Cities with the same name in different states stay separate.

Observe: Add fixture jobs with these places: "San Francisco, CA", "San Francisco, California", "san francisco, ca, USA", "SF"; "New York, NY", "New York City", "NYC", "New York, New York, United States"; "St. Louis, MO", "Saint Louis, Missouri"; "Portland, OR", "Portland, ME"; "Columbus, OH", "Columbus, GA". Filter by each city and count results. Each spelling group must return all of its jobs. "Portland, OR" must not return the Maine job, and "Columbus, OH" must not return the Georgia job. Call the documented place lookup for each string and compare the outputs.

Adversarial angles:
- "Portland" with no state joins the two cities without a sign of doubt.
- "Washington" (the state) and "Washington, DC" become the same place.
- "St." is not expanded, so "St. Louis" and "Saint Louis" split.
- Case or a trailing ", USA" makes a new, separate place.

### O14 (SHOULD) Several places, remote jobs and unclear places are handled honestly

A job that lists several places matches a filter for any one of them, and text such as "Remote", "Remote - US", "Hybrid", "United States" or "Anywhere in the US" counts as a work model or a country, not as a city. A place the app cannot resolve shows as the job wrote it, never as a guessed city, and a distance filter ("within 25 miles of Austin, TX") includes near cities and leaves out far ones.

Observe: Add fixture jobs with the places "New York, NY; Austin, TX; Remote", "Remote - US", "Remote (Canada)", "Georgia", "Tbilisi, Georgia", "Round Rock, TX", "Houston, TX", "Austin, MN" and "Building 7, Campus West". Filter by Austin, TX; by remote in the US; and by 25 miles around Austin, TX. The multi-place job appears under Austin and under remote. "Remote (Canada)" does not appear as a US remote job. Round Rock appears within 25 miles; Houston and Austin, MN do not. "Building 7, Campus West" shows as written, with no invented city.

Adversarial angles:
- A job with three places keeps only the first.
- "Remote (Canada)" counts as remote in the US.
- "Georgia" alone always becomes the US state, even when the job text says Tbilisi.
- A job with only a state or a country matches a city distance filter.

---

## Privacy and offline use

### O15 (MUST) Sponsor and place lookups stay on the laptop, and no personal data leaves with company lookups

Sponsor tags, the H-1B filter and place matching work with the network off. No request that the app sends for sponsor data, company facts or places carries the user's name, email, resume, profile answers (including the work-authorization answer) or the jobs the user viewed or liked; a company-fact request carries only what identifies the company.

Observe: Fill the profile with the Jordan Testwell persona, set the sponsorship answer to "Yes", and like 3 jobs. Turn the network off, restart the app, and screenshot the feed with the H-1B filter and a city filter on: tags and filters must still work. Turn the network on, send all traffic to local mock servers that log each request, and open 5 company blocks. Search the logs for "Jordan", "Testwell", "jordan.testwell@example.com", resume text, the sponsorship answer and the liked job titles. There must be no match.

Adversarial angles:
- The sponsor data lives on a server, so the tag disappears offline.
- A company-fact search query adds the user's target role or city from the profile.
- A request header or a usage report carries a user ID or email.
- The app sends the list of all companies in the user's feed in one request, which reveals the user's search.
