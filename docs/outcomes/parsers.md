# Acceptance outcomes: parsers (level, pay, place, work model)

Area: the seniority, pay, place and work-model facts that jobleft shows for each job.
Date: 2026-09-25.
This file says what a user or a stranger must be able to see. It does not say how to build it.

## Scope

| Fact | What a user can see |
|---|---|
| Seniority | One or more of: Intern/New Grad, Entry Level, Mid Level, Senior Level, Lead/Staff, Director/Executive. Or "unknown". Also the required years ("3+ years") when the posting asks for them |
| Pay | A minimum, a maximum or both, with a period (year, hour, and so on) and a currency. Or "unknown" |
| Place | One or more places where the work is (city, state or region, country). Or "unknown" |
| Work model | Onsite, Hybrid or Remote, with any area limit the posting sets (for example "US only"). Or "unknown" |

Every outcome applies to crawled jobs and to jobs that the user adds by URL or by pasted text.

## Test material (the reviewer builds it; the builders do not see it)

| Name | What it is |
|---|---|
| Labelled set | At least 300 real postings from the product's own crawl of approved public job boards. At least 40% are non-tech (for example nursing, retail, warehouse, trades, sales, finance, teaching, government). At least 20% state pay. At least 10% state hourly pay. A person who did not build the parsers labels the four facts from the posting text only, and tags each posting as tech or non-tech |
| Trap set | Short made-up postings, one or more for each adversarial angle in this file. The reviewer serves them from a local mock job board in a public job-board format that the product supports, or pastes them into the add-a-job feature |

How to feed a posting in: point the product at the local mock board with the commands in the package README, or use the add-a-job feature.
How to read the facts: the job endpoints in `docs/INTERFACES.md`, the job card, and the job detail view (screenshots).

## Outcomes

### O1 (MUST) Each fact is a real value or "unknown", never a default

For every job, each of the four facts is a value that the posting supports, or it is clearly unknown. The product never fills a missing fact with a default value.

- **Observe:** Feed trap postings that state none of the four facts. Through the job endpoint, each fact reads as unknown, and "unknown" is different from every real value. On the job card and the detail view, no pay, level, place or work model appears for these jobs (a card may leave the slot empty). On the labelled set, of the facts that the labeller marks "not stated", at least 97% show as unknown.
- **Adversarial angles:**
  1. A job with no pay shows "$0" or an empty range such as "$ - $".
  2. A missing work model shows as "Onsite", or a missing level shows as "Mid Level".
  3. A missing place shows as "United States".
  4. The product meets the other outcomes by marking almost everything "unknown" (the coverage floors in O2, O5 and O7 catch this).

### O2 (MUST) Shown pay matches the pay the posting states

When a posting states pay, the product shows the same minimum, maximum, period and currency. If the product converts a period (for example hourly to yearly), it says so next to the figure.

- **Observe:** On the labelled set, of the jobs where the product shows pay, at least 98% agree with the label on minimum, maximum, period and currency (yearly figures within $1K, hourly figures within $0.50). Of the postings that the labeller marks with pay, the product shows pay for at least 90%. Compare 20 job-card screenshots with the same labels. On the trap set, 0 failures on the angles below.
- **Adversarial angles:**
  1. "$25 - $32 per hour" shows as "$25K/yr - $32K/yr" or as "$25/yr - $32/yr".
  2. "€60.000" (a dot as the thousands mark) shows as 60, or shows in dollars. "120-150k" loses the "k".
  3. "Up to $150,000" becomes a range with an invented minimum, or a single figure "$85,000" becomes a range.
  4. A posting with a different range for each city shows a range that no tier in the posting states, and gives no hint of the tiers.

### O3 (MUST) Never invent pay

The product shows pay for a job only when the posting, or the job board's own pay field for that posting, states it. It never presents an estimate, another job's pay, or public wage records as the pay of this job.

- **Observe:** For trap postings with no pay, and for labelled postings that the labeller marks "no pay", the job endpoint and the job card show no pay. 0 exceptions. If the product shows a pay estimate anywhere, the estimate carries the word "estimate" and its source, and the job endpoint keeps it apart from stated pay.
- **Adversarial angles:**
  1. "Competitive salary" or "top-of-market pay" becomes a number.
  2. Pay from another job at the same company fills the gap.
  3. Public wage records for the employer appear as this job's range.
  4. An AI summary or "why you fit" text states a pay figure that the posting does not hold.

### O4 (MUST) Never read unrelated numbers as pay

Numbers that are not this job's pay never show as its pay. These include bonuses, stipends, 401(k) match, tuition aid, company revenue or funding, head counts, years, ZIP codes, phone numbers and job IDs.

- **Observe:** Feed trap postings that hold such numbers and no pay: none shows pay. Feed trap postings that hold such numbers and also a stated pay range: each shows only the stated range. 0 exceptions on both.
- **Adversarial angles:**
  1. "$5,000 sign-on bonus" or "$2,000 learning stipend" becomes the pay.
  2. "We raised $150M" or "$10B in yearly revenue" becomes a salary.
  3. "401(k) match up to 6%", "Req 120000" or "Suite 200, 94105" becomes a figure.
  4. A pasted page carries a "similar jobs" block, and those jobs' salaries become this job's pay.

### O5 (MUST) Seniority is right for tech and non-tech titles

Each job shows the level or levels that the posting supports, or unknown. The level comes from what the posting asks for, not from one word in the title.

- **Observe:** On the labelled set, at least 85% of shown levels match the label (when the labeller accepts more than one level, any of them counts). At most 3% are wrong by two or more steps on the six-step scale. The product shows a level for at least 70% of the postings where the labeller found one. On the trap set, 0 failures on the angles below.
- **Adversarial angles:**
  1. "Senior Care Aide", "Senior Living Cook" or "Staff Nurse" becomes Senior Level or Lead/Staff.
  2. "Internal Audit Analyst" or "International Sales Rep" becomes Intern/New Grad.
  3. "Shift Manager" at a store becomes Director/Executive when nothing else in the posting supports it.
  4. Grades such as "Engineer III", "L4" or "Associate" get one fixed level at every company, even when the posting's stated years or duties say otherwise.

### O6 (SHOULD) Required years show only when the posting asks for experience

When a posting asks for years of experience, the job shows the lowest number that meets the requirement (for example "3+ years"). Years that are not an experience requirement never appear.

- **Observe:** On the labelled set, at least 90% of shown year figures match the label. On the trap set, 0 false year figures.
- **Adversarial angles:**
  1. "Must be 18 years or older" shows as "18+ years exp".
  2. "Serving customers for over 50 years" or "stock vests over 4 years" shows as a requirement.
  3. "5 years, or 3 years with a master's degree" shows "5+ years".
  4. "Preferred: 7 years" shows as the minimum when the posting requires 2.

### O7 (MUST) Place is right, and every place is kept

Each job shows the place or places where the posting says the work is. When a posting names several places, the product keeps all of them, and the card may show one place plus a count of the rest.

- **Observe:** On the labelled set, at least 95% of jobs match the label's first place at city and state level, and at least 99% at country level. The product shows a place for at least 95% of the postings where the labeller found one. For trap postings with several places, the job endpoint returns every place, and a card or detail screenshot shows the list or the count.
- **Adversarial angles:**
  1. "New York, NY; San Francisco, CA; Austin, TX" keeps only one place, with no count.
  2. Portland (Oregon or Maine) or Springfield (Missouri or Illinois) resolves to the wrong state.
  3. A head-office address in the company's standard text replaces the real work site.
  4. "Multiple locations" or "Various" becomes a made-up city.

### O8 (MUST) Never put a job in the wrong country

A job outside the United States never shows as a US job, and a US job never shows as foreign. A remote job that is limited to another country or region never shows as open to people in the US.

- **Observe:** Feed trap postings set in Canada, the UK, India and the country of Georgia, US postings set in "Paris, TX" and "London, KY", and remote postings limited to "Canada only" or "EMEA only". With the US location filter on, the foreign and foreign-limited jobs never appear, and the two US jobs do appear. Through the job endpoint, each job reads the right country or area. 0 exceptions.
- **Adversarial angles:**
  1. "Remote - Canada" shows as "United States" or as open to US residents.
  2. "Tbilisi, Georgia" becomes the US state of Georgia.
  3. "Paris, TX" becomes France, so a real US job vanishes from US results.
  4. A remote job loses its limit, for example "India only" or "must work EU hours".

### O9 (MUST) Work model is right, and remote limits stay

Each job shows Onsite, Hybrid or Remote only when the posting supports it, and a remote job keeps any limit the posting sets (country, list of states, time zone, distance from an office). When a posting says two different things, the product never shows the looser reading as certain.

- **Observe:** On the labelled set, at least 95% of shown work models match the label, and at least 97% of the jobs shown as Remote are remote by the label. On the trap set, 0 failures. Screenshot a trap job that is remote in 5 named states: the limit shows on the card or the detail view.
- **Adversarial angles:**
  1. "Remote patient monitoring", "remote sensing" or "work with remote teams" makes an onsite job Remote.
  2. The board's field says Remote, but the text says "in the office 3 days a week", and the job shows as fully Remote.
  3. "Remote, but you must live within 50 miles of Denver" loses its limit.
  4. A Hybrid job passes a "Remote only" filter.

### O10 (MUST) Non-tech jobs get the same quality as tech jobs

Postings in healthcare, retail, trades, warehouse, sales, teaching and government get facts as good as tech postings. Hourly pay, shift terms and sales pay read correctly.

- **Observe:** Split the labelled set into tech and non-tech. For each fact, the non-tech score is at most 5 points below the tech score, and it still meets the thresholds in O2, O5, O7 and O9. On the trap set, 0 failures on the angles below.
- **Adversarial angles:**
  1. "$48/hr plus a $4/hr night differential" shows "$52/hr" or "$4/hr" as the base pay.
  2. "$60K base, $120K OTE" shows $120K as base pay with no hint.
  3. "Per diem" or "PRN" work reads as a daily pay figure, or as a yearly one.
  4. Most non-tech jobs get an unknown level, so a level filter hides nearly all of them.

### O11 (MUST) No job is lost because a fact cannot be read

A job whose facts cannot be read is still kept and still listed, with those facts marked unknown. One bad posting never stops the other jobs from the same board from appearing.

- **Observe:** Serve a mock board of 100 postings, all set in the United States. Make 20 of them hard: empty fields, odd characters, very long text, pay and place written in unusual ways, text in Spanish. After the crawl, the job endpoint returns all 100, and the unfiltered feed shows all 100. Repeat with the hard postings first in the board: the count is still 100.
- **Adversarial angles:**
  1. One pay string that cannot be read makes the whole board fail, so all of that company's jobs vanish.
  2. A job with no readable place is treated as outside the US and dropped with no notice.
  3. An error on one posting skips the rest of the batch, and no error shows anywhere.
  4. Postings that are not in English are dropped.

### O12 (MUST) Filters agree with the cards, and unknowns are visible

Filters and sorts on level, pay, place and work model use the same values that the cards show. A user who filters on one of these facts can see whether jobs with an unknown value are in or out of the results, and can change that.

- **Observe:** Set a minimum-pay filter. The product states its rule (for example in the filter's help): which end of a range it checks, and how hourly pay counts. Every card in the results obeys that rule, and the result count equals the number of cards. Load the trap jobs with unknown pay, then turn the filter on: the product shows whether they are included, and a control changes this. Repeat for level and work model.
- **Adversarial angles:**
  1. A job shown as "$88K/yr - $122K/yr" is hidden by a $100K minimum, and no stated rule explains why.
  2. "$50/hr" (about $104K a year full time) fails a $90K minimum because the filter reads 50 as a yearly figure.
  3. Jobs with unknown pay drop out of the results with no sign.
  4. Sorting by pay mixes hourly and yearly figures as if they were the same unit.

### O13 (SHOULD) Facts are stable, and they follow changes to the posting

The same posting gives the same facts every time. When the employer changes a posting, its facts change on the next refresh, and no other job changes.

- **Observe:** Crawl the mock board twice with no change: the job endpoint returns the same facts for every job. Then edit 10 mock postings (add pay, remove pay, change "Remote" to "Hybrid", add a second place) and refresh: all 10 show the new facts, and every other job shows the same facts as before.
- **Adversarial angles:**
  1. Facts for an unchanged posting change between two runs.
  2. Old pay stays after the employer removes it.
  3. A refresh keeps the old place and adds the new one as a second place.
  4. An edit to one posting changes the facts of another job with the same title.

### O14 (SHOULD) A user can see where each fact came from

For each shown fact, the user can see the words in the posting, or the board's own field, that support it. A user who doubts a fact can read the full original posting and open the employer's page for that job.

- **Observe:** Open the detail view for 10 labelled jobs. For each shown fact, the view or the job endpoint gives the supporting text, and that text holds the fact (screenshot). Each job has a working link to the employer's page for that exact job, and the full posting text is readable in the product.
- **Adversarial angles:**
  1. The "source" text for a fact does not hold that fact.
  2. The source points at the company's standard text, not at the job text.
  3. The stored posting text is cut short, so the user cannot check the fact.
  4. The link opens the employer's list of all jobs, not this job.

### O15 (MUST) Never send personal data or spend the balance to read these facts

Reading the four facts never sends the user's name, email, profile or resume anywhere, and it never spends the user's balance unless the user turned that on. With default settings, reading the facts works without the network once the posting is fetched.

- **Observe:** On a fresh install with default settings, block all network hosts except the local mock board. Crawl the trap set: the facts match a run with the network open. Record all outgoing requests with a local proxy during a crawl: the only host is the mock board. The balance before and after the crawl is the same. Search the recorded requests for the test persona's name, email and resume text: 0 matches.
- **Adversarial angles:**
  1. Each posting goes to a remote AI service by default to read its facts.
  2. A request carries the persona's name, email or resume text.
  3. A large crawl quietly spends the balance.
  4. With no network, every fact becomes unknown, and the product gives no reason.

## Pass rule

The area passes when every MUST outcome passes. A failed SHOULD outcome goes on the known-issues list with its numbers.
