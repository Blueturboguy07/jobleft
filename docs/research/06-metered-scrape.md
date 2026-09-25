# 06 - Metered scrape and search for jobleft (publik API resale research)

Status: COMPLETE (research only; no code changed). Date: 2026-09-24.
Method: public pages only, read with WebFetch, WebSearch and `gh` on 2026-09-24. No account. No login. No purchase. No provider API call. No personal data in any request.
Rule: every number, term and quote has the URL of a page I fetched. Anything I could not fetch is marked UNVERIFIED. Every quote is 15 words or fewer.
Source files read first: `~/publik-api-research/CONTRACT.md` (sections 1 to 5 and 13, plus 3.4, 4 and 12) and the top of `~/publik-api-research/STATE.md`. I also read `lib/publik-api/pricing/sheet.ts`, `price.ts` and migrations 0034 and 0046 in `~/publik` so the design uses the real names.

## Summary

| Question | Answer |
|---|---|
| Best upstream | Parallel (Search and Extract). Second: Tavily, as failover. Both are pay-as-you-go. Neither has a plan fee |
| Does resale pass? | Two providers allow it inside your own app, if publik flows their terms down: Tavily (AUP "Downstream Users") and Parallel (Customer Terms "End Customers"). No provider allows an open, raw pass-through with no conditions |
| Forbidden | Brave, Zyte, Firecrawl, ScrapingBee, Vercel AI Gateway |
| Need written approval | Exa (it has a partner program), Bright Data (it has a partner program), Scrapfly |
| "OpenRouter for scraping"? | No. OpenRouter and Vercel sell search only inside a chat call. ScrapeOps has a monthly fee. The others are too young or unreadable |
| Proposed prices | $5.00 per 1,000 searches. $2.00 per 1,000 plain pages. $4.00 per 1,000 JS pages |
| Margin on Parallel | 77% on search. 44% on plain pages. 72% on JS pages. These use a 12.3% top-up allowance. Half the spread goes to the app builder |
| Float | $20 at Parallel. $0 prepaid at Tavily. Fixed monthly cost: $0 |
| Gates before launch | An email to each vendor. A 30-URL live proof. The counsel read in PLAN gate G1. The founder sets the prices |
| Side finding | OpenRouter Terms 7(4) bars "reselling API access to Models". publik memo R26 rated it RED. The chat epoch already uses OpenRouter |

## Section index

- Part A: Provider survey (task 1)
- Part B: Resale terms (task 2)
- Part C: Acceptable use, robots.txt, legal responsibility (task 3)
- Part D: Aggregators, "OpenRouter for scraping" (task 4)
- Part E: Design for publik (task 5)
- Part F: Abuse controls (task 6)
- Part G: The float (task 7)
- Part H: Fallbacks (task 8)
- Part I: Recommendation (task 9)
- Final table

---

# Part A. Provider survey

## A.1 First-pass pricing notes (fetched 2026-09-24; gaps are filled in A.2 below as I retry)

### Firecrawl - https://www.firecrawl.dev/pricing
- Plans (annual billing shown): Free $0 (1,000 credits a month), Hobby $16 (5,000), Standard $83 (100,000), Growth $333 (500,000), Scale $599 (1,000,000), Enterprise custom.
- Unit: "1 credit = 1 page on a basic scrape, crawl, or map." Search: 2 credits per 10 results. JSON, Question and Highlight formats add 4 credits a page. Interact: 2 credits per browser minute.
- Extra credits: "We add credits in 5 USD increments, up to a monthly limit you set." A $5 block buys 1,000 credits on Hobby, 2,000 on Standard, 2,500 on Growth, 5,000 on Scale. So this is a top-up on a PAID plan, not a stand-alone pay-as-you-go.
- Expiry: Hobby, Standard, Growth have no rollover. Bought credits "stay on your account until you use them" but "expire if you cancel."
- Rate limits per minute on /scrape, /map, /search: Free 10, Hobby 100, Standard 500, Growth 5,000, Scale 10,000.
- PAYG with no monthly minimum: NO (a plan is needed).

### Apify - https://apify.com/pricing
- Plans: Free $0 (with $5 of monthly usage), Starter $19, Scale $199, Business $999.
- Compute unit: $0.20 on Free and Starter, $0.16 on Scale, $0.13 on Business. Residential proxy $8 per GB on Free and Starter.
- Expiry quote: "they expire at the end of the billing cycle."
- Store Actors: "Pay per event" or "Pay per usage" models.
- PAYG with no monthly minimum: NO on the pricing page (free plan gives $5 a month; all paid tiers have a fee). Free plan can still run Actors inside the $5.
- Minimum top-up and API rate limits: not on this page (UNVERIFIED here; see A.2).

### Bright Data Web Unlocker - https://brightdata.com/pricing/web-unlocker
- Pay as you go: "$1.5/1K requests", "Pay only for success". Scale plan: $499 a month with 383K requests included, then $1.3 per 1K. Free tier: 5K requests a month, no credit card.
- SERP API (https://brightdata.com/pricing/serp): pay as you go "$1.5/1K requests"; Scale $499 a month; free tier 5K a month. Web Scraper API (https://brightdata.com/pricing/web-scraper): pay as you go "$1.5/1K record"; Scale $499 a month; free 5,000 records a month.
- Promo: first deposit matched dollar for dollar up to $500.
- Full browser rendering is included in all plans (no JS surcharge on this page).
- PAYG with no monthly minimum: YES on this page ("without a monthly commitment").
- Balance expiry: not on this page (UNVERIFIED).

### Zyte API - https://www.zyte.com/pricing/
- HTTP response body, pay-as-you-go: "$0.13 to $1.27" per 1,000 requests, by site difficulty tier. With a $100 commitment: $0.10 to $0.95. $200: $0.08 to $0.76. $500: $0.06 to $0.61.
- Browser rendered, pay-as-you-go: "$1.01 to $16.08" per 1,000. $100 commit: $0.75 to $12.00. $200: $0.60 to $9.60. $500: $0.48 to $7.68.
- Trial: "$5 free credit" and "No commitment or subscription, 30 days to try it out".
- PAYG with no monthly minimum: YES (a pay-as-you-go column exists). Top-up minimum and expiry: not on this page (UNVERIFIED here; see A.2).

### ScrapingBee - https://www.scrapingbee.com/#pricing
- Plans: Hobby $19 (75,000 credits), Freelance $49 (250,000), Startup $99 (1,000,000), Business $249 (3,000,000), Business+ $599 (8,000,000). Free trial: 1,000 credits, no card.
- "Pay only for successful requests." Concurrency: 25, 50, 100, 200, 400 by plan.
- No stand-alone PAYG. Credit cost per request type: not on this page (see A.2).

### Scrapfly - https://scrapfly.io/pricing
- Plans: Free $0 (1,000 credits), Discovery $30 (200,000), Pro $100 (1,000,000), Startup $250 (2,500,000), Enterprise $500 (5,500,000).
- Extra credits per 10,000: Discovery $5.00 (capped), Pro $3.50, Startup $2.00, Enterprise $1.20 (overflow, pay as you go).
- Concurrency: 5, 5, 20, 50, 100.
- Credit cost per request: "depends on the features you enable" (estimator page; see A.2).
- PAYG with no monthly minimum: NO.

### Browserbase - https://www.browserbase.com/pricing
- Plans: Free $0 (1 browser hour), Developer $20 (100 hours then $0.12 an hour), Startup $99 (500 hours then $0.10 an hour), Scale custom.
- Proxies: Developer 1 GB then $12 per GB. Startup 5 GB then $10 per GB.
- Search and Fetch API: Free plan has "1,000 Search calls" and "1,000 Fetch calls". Search "$7/1k calls". Fetch "$1/1k calls, $4/1k calls with proxies".
- Concurrency: Free 3, Developer 25, Startup 100, Scale 250+.
- PAYG with no monthly minimum: NO (Free plan or $20 plan).

### Jina - https://jina.ai/reader/
- Reader r.jina.ai: "20 RPM" without a key, "500 RPM" with a free key. Search s.jina.ai: needs a key. New keys include "10M free tokens".
- Token-priced (Reader bills on output length; Search "starting from 10,000 tokens"). Failed requests do not deduct tokens. Tokens do not expire with the key; premium tier 5,000 RPM Reader, 1,000 RPM Search.
- Per-million-token price: not on this page (see A.2).

### Exa - https://exa.ai/pricing
- Search "$7 / 1k requests". Deep search "$12 / 1k" (deep-lite and deep), "$15 / 1k" (deep-reasoning). Contents "$1 / 1k pages, per content type". Results beyond 10: "$1 / 1k results".
- "Exa is pay-as-you-go. There is no subscription and no minimum spend". Free tier: "$10 in credits" reset on the first of each month.
- PAYG with no monthly minimum: YES. Standard QPS: not on this page (see A.2).

### Brave Search API - https://api-dashboard.search.brave.com/documentation/pricing
- Search "$5.00 per 1,000 requests". Free: "$5 in credits every month". Rate limit "50 requests per second". Answers "$4.00 per 1,000 queries" plus token fees.
- Prepaid: users "buy credits upfront". No monthly minimum is stated. Enterprise offers "ZDR".
- Caching and storage rules: not on this page (see resale section).

### Tavily - https://www.tavily.com/pricing
- Free "1,000 API credits / month". Pay As You Go "$0.008 / credit". Project plan: "4,000 API credits / month" on the slider. Monthly credits reset on the first of the month.
- Per-request credit cost and rate limits: not on this page (see A.2).

### SerpApi - https://serpapi.com/pricing
- Free $0 (250 a month), Starter $25 (1,000), Developer $75 (5,000), Production $150 (15,000), Big Data $275 (30,000), Searcher $725 (100,000), Volume $1,475 (250,000), Infrastructure $2,750 (500,000).
- Throughput from 50 an hour (Free). No pay-as-you-go or one-time pack on the page. "Legal Shield" from Production up: "up to $2 million in coverage".
- Unused searches do not roll over.

### ZenRows - https://www.zenrows.com/pricing
- Free $0 (5,000 credits a month), Build $16 (45,000), Launch $57 (250,000), Growth $165 (1.2M), Scale $456 (5M).
- Credit costs: "One credit is a standard successful page." JS rendering 5 credits, premium proxy 10, both 25. Residential bandwidth 25,000 credits per GB.
- Top-ups "up to four times per billing period" on paid plans. No stand-alone pay-as-you-go.

### Serper and ScraperAPI and Oxylabs
- Serper homepage: "2,500 free queries" only; pack prices not on that page. See A.2.
- ScraperAPI pricing page: fetch returned only navigation. See A.2.
- Oxylabs pricing URL returned HTTP 404. See A.2.

## A.2 Gap-filling notes (fetched 2026-09-24)

- ScrapingBee credit costs - https://www.scrapingbee.com/documentation/#credit-cost-for-your-requests : basic request 1 credit; JS rendering 5 credits (default); premium proxy 10 credits (JS off) or 25 (JS on); stealth proxy 75 credits (JS on only); auto-mode charges only the working configuration. Credit expiry: not stated on that page (UNVERIFIED).
- ScraperAPI credit costs - https://docs.scraperapi.com/getting-started/quick-start/credits-and-requests-costs.md : normal request 1 credit; `render=true` 10 credits; `premium=true` 10; `premium+render` 25; `ultra_premium` 30; `ultra_premium+render` 75; SERP (Google, Bing) 25 credits; LinkedIn "Social Media" 30 credits. "We only charge for successful requests (200 and 404 status codes)". Expiry: not stated (UNVERIFIED). ScraperAPI's own pricing page returned only navigation. Plan prices come from a third-party page and search snippets only (Hobby $49 for 100,000 credits; Startup $149 for 1,000,000; Business $299 for 3,000,000; 7-day trial of 5,000 credits): https://scrapegraphai.com/blog/scraperapi-pricing (UNVERIFIED against the vendor page).
- Oxylabs Web Scraper API - https://oxylabs.io/products/scraper-api/web/pricing : Free trial up to 2,000 results, Micro $49 a month (98,000 results), Starter $99 (220,000), Business $999 (3,330,000), Custom+ on request. Per 1,000 results without JS: "Other sites" $1.15 down to $0.70 by tier; JS rendering $1.35 down to $0.95 per 1K; Google $1.00 to $0.50. Rate limit 10 requests a second (Free, Micro), 50 (Starter), 100 (Business). "Top-up options available" ($249 to $2,000 by plan). Failed results (5xx, 6xx) are free. Rollover: not stated (UNVERIFIED). Source for billing rules: https://developers.oxylabs.io/help-center/billing-and-payments/how-does-web-scraper-api-pricing-work
- Serper - the vendor site does not publish pack prices. https://serper.dev/ shows only "2,500 free queries". The paid ladder below comes from a third party that says serper.dev/pricing returned a 404 on 2026-07-17: https://apiserpent.com/blog/serper-pricing-credits-explained . Packs: Starter $50 for 50,000 credits ($1.00 per 1K), Standard $375 for 500,000 ($0.75), Scale $1,250 for 2,500,000 ($0.50), Ultimate $3,750 for 12,500,000 ($0.30). "Paid credits are valid for six months from purchase". 1 credit per query up to 10 results; 2 credits for 11 to 100 results. UNVERIFIED against the vendor.
- Tavily credit costs - https://docs.tavily.com/documentation/api-credits : Search basic 1 credit, advanced 2. Extract basic 1 credit per 5 URLs, advanced 2 per 5 URLs. Map 1 credit per 10 pages. Pay-as-you-go "$0.008 per credit" after the 1,000 free monthly credits. Monthly plans $30 to $500. Failed extractions free. The docs give no rate-limit numbers on this page (UNVERIFIED).
- Exa rate limits - https://exa.ai/docs/reference/rate-limits : /search 10 QPS; deep search variants 5 QPS; /contents 100 QPS. "rate limit rises to 25 QPS for 90 days" after $1,000 in credits within 30 days.
- Zyte billing detail - https://docs.zyte.com/zyte-api/pricing.html : "$5 free credit for your first billing month"; charged "only for successful responses"; spending limits "from $100 (pay-as-you-go) to $2,500"; when a limit is hit "requests return account suspension responses". Zyte pay-as-you-go looks postpaid with a spend limit, not a prepaid wallet (see A.5). Screenshots $0.002 each.
- Fetch failures recorded (3 tries or a 404 on the guessed URL): docs.apify.com/platform/billing and /platform/pricing (404), docs.zyte.com/zyte-api/usage/billing.html and /rate-limits.html (404), oxylabs.io/products/web-scraper-api/pricing (404), serper.dev/pricing (404 per the third party).

## A.3 Jina price note (fetched 2026-09-24)

- Jina's own pages do not print a per-token price. https://jina.ai/reader/ and https://jina.ai/api-dashboard/ show no dollar figure, and https://jina.ai/pricing returns 404. A third-party page dated 2026-09-01 (https://markaicode.com/pricing/jina-ai-pricing/) says Reader, Search and embeddings share one token wallet at "approximately $0.05 per 1M tokens" and that new keys get a one-time 10M-token grant. Another search snippet says $0.02 per 1M output tokens for Reader. The two do not agree. Price per token: UNVERIFIED.
- Jina Terms section 6.5 (https://jina.ai/legal/): credits roll over to the next service period "unless expressly agreed otherwise" and are "not refundable nor exchangeable". Jina's contracting party is Jina AI GmbH; the page notes data governance moved to Elastic after the October 2025 acquisition.
- Rate limits (third-party, same page): free key 100 RPM, paid key 500 RPM and 2,000,000 TPM, premium 5,000 RPM. First-party page https://jina.ai/reader/ says Reader is 20 RPM with no key, 500 RPM with a key, 5,000 RPM premium; Search 100 RPM, 1,000 RPM premium.

## A.4 Normalized survey (price per 1,000 units)

How to read it. "Derived" means I divided a plan price by its credits using the vendor's own credit costs; it is not a printed price. Plan prices are the cheapest listed unit on the page named in A.1 to A.3. A row marked UNVERIFIED rests on a third-party page or a search snippet.

| Provider | Pricing model | (a) plain fetch per 1K | (b) JS-rendered per 1K | (c) search per 1K | PAYG with no monthly minimum? | Smallest top-up | Credits expire? | Free tier | Rate limits |
|---|---|---|---|---|---|---|---|---|---|
| Firecrawl | Monthly plan; credits; PAYG blocks only on a paid plan | $3.20 (Hobby) to $0.60 (Scale), derived, 1 credit a page; extra $5 blocks $5.00 to $1.00 per 1K | Same: 1 credit ("Enhanced/stealth proxy ... Billed at the same 1 credit") | $6.40 (Hobby) to $1.20 (Scale), derived, 2 credits per 10 results | NO. "You cannot use pay-as-you-go on the free plan." | $5 increment on a paid plan (Hobby $16 a month) | Plans: no rollover; bought credits expire on cancel | 1,000 credits a month | 10 to 10,000 per minute by plan on scrape and search |
| Apify | Monthly plan plus compute units and Store Actors | Actor-dependent, UNVERIFIED; $0.20 per compute unit, residential proxy $8 per GB | Actor-dependent | Actor-dependent | NO (Free plan has $5 of monthly usage) | Not on the page | Yes, at the end of the billing cycle | $5 a month | Not on the page |
| Bright Data (Web Unlocker, SERP API, Scraper API) | PAYG or plan | $1.50 (Web Unlocker) | $1.50 (rendering included) | $1.50 (SERP API; Scraper API $1.50 per 1K records) | YES ("without a monthly commitment") | Not stated; first deposit matched up to $500 | Not stated | 5K requests a month | "Unlimited concurrency" on paid tiers |
| Zyte API | PAYG or commitment tiers, by site difficulty | $0.13 to $1.27 | $1.01 to $16.08 | No search product on the page | YES on paper ($0 a month, "$100" spend limit); billing timing UNVERIFIED (snippet: card charged monthly) | Card check of $1 (snippet, UNVERIFIED) | Trial credit not carried (snippet) | $5 credit | Not on the pages I could read |
| ScrapingBee | Monthly plan; credits | $0.25 (Hobby) to $0.07 (Business+), derived; 1 credit | $1.27 to $0.37, derived; 5 credits | Google Search API price not on the page | NO | Plan from $19 | Credits valid for the current billing cycle | 1,000 credits | 25 to 400 concurrent |
| ScraperAPI | Monthly plan; credits | $0.49 (Hobby) to $0.15 (Startup), derived; 1 credit | $4.90 to $1.49, derived; 10 credits | $12.25 to $3.73, derived; 25 credits | NO | Plan from $49 (third-party) | Not stated | 1,000 credits, 7-day trial of 5,000 | 20 to 200 threads (third-party) |
| Scrapfly | Monthly plan; credits; overflow | $0.15 (Discovery) to $0.50 overflow, derived; 1 credit | $0.90 to $3.00, derived; 1 plus 5 credits | Not on the page | NO | Plan from $30; extra $5 per 10,000 credits (Pro and up) | Not stated | 1,000 credits | 5 to 100 concurrent |
| Browserbase | Monthly plan; hours; per-call Fetch and Search | Fetch $1.00 (paid plan), $4.00 with proxies | Browser hour $0.12 (Developer); roughly $0.33 per 10-second page, derived, proxy extra ($12 per GB) | Search $7.00 | NO (Free or $20 plan) | $20 plan | Not stated | 1 browser hour, 1,000 Search and 1,000 Fetch calls | 3 to 250 concurrent |
| Jina | Prepaid tokens; Reader bills output length | Not printed; about $0.10 to $0.40, derived from a third party's $0.05 per 1M tokens (UNVERIFIED) | Same (Reader renders) | Search "starting from 10,000 tokens" a call; about $0.50, derived (UNVERIFIED) | YES (tokens) | Not stated | Credits roll over unless agreed otherwise (Terms 6.5) | 10M tokens on a new key | Reader 20 RPM without key, 500 with; Search 100 RPM |
| Exa | PAYG credits | Contents $1.00 per 1K pages | Contents $1.00 (live crawl setting; UNVERIFIED) | $7.00 (deep $12 to $15) | YES ("no subscription and no minimum spend") | Not stated; auto-recharge $5 to $10,000 | Free credits reset monthly; paid: no expiry stated | $10 a month | Search 10 QPS, contents 100 QPS; 25 QPS after $1,000 in 30 days |
| Brave Search API | Prepaid credits | No fetch product | No fetch product | $5.00 | YES (prepaid, no minimum stated) | Not stated | Search snippet: prepaid credits do not expire (UNVERIFIED) | $5 a month | 50 per second |
| Tavily | PAYG $0.008 per credit, or plans | Extract: 1 credit per 5 URLs = $1.60 | Extract advanced: 2 credits per 5 URLs = $3.20 | $8.00 basic; $16.00 advanced | YES (PAYG); charged "for every $40 of usage" | No prepay; $40 usage steps | Monthly credits reset on the 1st | 1,000 credits a month | 100 RPM dev, 1,000 RPM production (production needs a paid plan or PAYG) |
| Serper | Prepaid packs | No fetch on the pages I read | n/a | $1.00 (Starter) to $0.30 (Ultimate), third-party (UNVERIFIED) | Packs only; no subscription | $50 pack (third-party, UNVERIFIED) | 6 months (third-party) | 2,500 queries | Not stated |
| SerpApi | Monthly plan; searches | n/a | n/a | $25.00 (Starter) to $1.96 (Infrastructure) | NO | $25 plan | Unused searches do not roll over | 250 a month | From 50 an hour |
| ZenRows | Monthly plan; credits | $0.36 (Build) to $0.09 (Scale), derived; 1 credit | $1.78 to $0.46, derived; 5 credits (both JS and premium: 25 credits) | Not on the page | NO ("Free, not a trial"; top-ups on paid plans) | Plan from $16 | Free: none; paid: roll over | 5,000 credits a month | 5 to 200 concurrent |
| Oxylabs | Monthly plan; results | $1.15 to $0.70 | $1.35 to $0.95 | Google $1.00 to $0.50 | NO (plan; top-ups $249 to $2,000) | Plan from $49 | Not stated | 2,000-result trial | 10 to 100 per second |
| Parallel (extra) | PAYG per request, prepaid balance | Extract "$1 / 1,000 URLs" | Same; "JavaScript-heavy pages and PDFs" | Search $1.00 (Turbo, Fast) or $5.00 (Basic, Advanced) | YES | $0.01 to $100 per top-up by API | Not stated | $5 a month, up to $80 at signup | 600 per minute on Search and Extract |
| Spider.cloud (extra) | PAYG credits, 10,000 credits = $1 | About $0.10 (Spider's own average per scrape); "HTTP mode: $0.002-$0.01 per 100 pages" | Browser mode "$0.0035-$0.0155 per 100 pages" | About $1.00 per search (Spider's average) | YES | $1 (guide) or $25 (pricing page): the two Spider pages disagree | "they never expire" | Not on the pages | "up to 10,000 core API requests per minute" |
| DataForSEO (extra) | PAYG | On-Page price not readable | On-Page price not readable | Third party: $0.60 standard queue to $2.00 live | YES | $50 | Third party: never (UNVERIFIED) | $1 trial (third party) | Not read |
| Olostep (extra) | Packs or plans | Packs $2.00 per 1K at the $20 pack | JS included on paid tiers | Search plans from $9 for 5,000 | Packs are one-off | $20 pack | Packs "valid for 6 months" | 500 requests | Concurrency by plan |

Sources: the URLs in A.1, A.2, A.3 and B.9; Firecrawl billing https://docs.firecrawl.dev/billing ; Scrapfly billing https://scrapfly.io/docs/scrape-api/billing ; Tavily https://help.tavily.com/articles/3950309978-understanding-pay-as-you-go-and-billing-resets and https://docs.tavily.com/documentation/rate-limits ; Parallel https://docs.parallel.ai/service-api/balance/add-to-balance ; Spider https://spider.cloud/guides/pricing-and-plans/ and https://spider.cloud/pricing/ ; Exa https://exa.ai/docs/admin/billing ; Bright Data https://docs.brightdata.com/general/account/billing-and-pricing/payment ; Olostep https://www.olostep.com/pricing ; DataForSEO https://dataforseo.com/pricing and third-party pages.

## A.5 Billing mechanics for the PAYG providers (float inputs)

- Exa: card by Stripe; auto-recharge with "Recharge amount" of "$5 to $10,000", a threshold and an optional monthly maximum. Example given: "$100 recharge amount, $10 threshold, and $500 monthly maximum". Paid credits: no expiry stated. Postpaid invoicing needs Enterprise. Source: https://exa.ai/docs/admin/billing
- Parallel: prepaid balance. `POST /service/v1/balance/add` takes 1 to 10,000 cents ($0.01 to $100.00) per call and always charges the org's default card. Auto-reload exists since 2025-05-21 ("automatically adding to your balance when configured thresholds are met"). Monthly spend limits per org or per app are available (search snippet, UNVERIFIED). Sources: https://docs.parallel.ai/service-api/balance/add-to-balance ; https://docs.parallel.ai/resources/changelog
- Tavily PAYG: "Charged automatically for every $40 of usage" and credits reset on the 1st (help centre). A monthly limit toggle exists at app.tavily.com/billing. Whether it is a hard stop: not stated. So the exposure is up to $40 of unbilled usage plus the month's limit. Sources: https://help.tavily.com/articles/3950309978-understanding-pay-as-you-go-and-billing-resets ; https://help.tavily.com/articles/8280756099-how-to-set-a-limit-for-pay-as-you-go-option
- Bright Data PAYG: "your account will not be automatically recharged" unless you choose a recharge preset: the docs' example: choose $100 and you are charged $100, then charged $100 again when the balance reaches $25. Minimum deposit: not stated. Subscription fees are "non-refundable"; bonus funds are not refundable. Source: https://docs.brightdata.com/general/account/billing-and-pricing/payment
- Zyte PAYG: "$100" default spending limit, "requests return account suspension responses" at the limit. Timing of the charge is not on the pages I could read (UNVERIFIED; a search snippet says the card is charged monthly after a $1 check). Source: https://docs.zyte.com/zyte-api/pricing.html
- Spider: no auto top-up mentioned; "you buy credits, spend them on requests, and they never expire". Source: https://spider.cloud/guides/pricing-and-plans/
- OpenRouter (publik's current chat upstream, for comparison): fee "5.5% ($0.80 minimum)" by Stripe; publik measured 12.3% all-in on a $20 top-up ("$20.00 of credit for $22.46 charged", `lib/publik-api/pricing/sheet.ts` `OPENROUTER_CREDIT_FEE`).

---

# Part B. Resale terms (the critical part)

How I read these: WebFetch passes each page through a small model. I asked for exact sentences. Exa's terms came back as a PDF and I read the PDF pages myself, so the Exa quotes are exact. The Brave, Tavily, Zyte, Jina, Parallel and OpenRouter quotes came back with the same wording in two or more fetches. The other quotes come from one fetch. Re-read the primary text before you rely on any quote. I am not a lawyer. A verdict is a reading of the text, not legal advice. The plan's gate G1 (legal review) still applies.

Question for each provider: can publik buy this service pay-per-use and sell metered calls to jobleft users, and to any app that holds a publik key?

## B.1 Exa - https://exa.ai/terms  (Terms of Service, PDF, read page by page)

- 1.1: "a non-exclusive, non-transferable, non-sublicensable, worldwide, revocable right and license to use our APIs".
- 4.2(e): "resell, lease or sublicense the Services to any third party without our prior consent;"
- 4.2(f): "access, use or exploit the Services (including Output) to develop any competitive product or service;"
- 4.2(a): no "offer for sale any information ... obtained on, or through, the Services".
- 1.1 also says "We reserve the right to audit your use of our APIs".
- The terms point to a separate "Master Subscription Agreement" and "Additional Terms" for paid deals; I did not find that agreement in public (UNVERIFIED).
- Reseller or partner program: YES. https://exa.ai/partners says partners can "Resell the API, embed it in your customer deployments". Minimums, revenue share and the application process are not published; the page points to a partnerships form and mailbox.
- VERDICT: NEEDS WRITTEN APPROVAL. Resale is not banned outright. It is banned "without our prior consent"; the partner program is that consent route. A search API whose Output is part of a jobs product is also close to 4.2(f). Ask Exa for a written yes before any launch.

## B.2 Brave Search API - https://api-dashboard.search.brave.com/terms-of-service

WebFetch returned these twice with the same text (section numbers per the list it gave, 3(b)(i) to 3(b)(xv)):
- 3(b)(iii): "otherwise make available the API or Documentation to any third party" (after "rent, lease, lend, sell, distribute, publish, sublicense").
- 3(b)(xii): "redistribute, resell, or sublicense the Search Results".
- 3(b)(i): "store, cache, or create a database of Search Results, in whole or in part" except transient storage for the app.
- 3(b)(xiii): "train, re-train, fine-tune, benchmark or otherwise improve artificial intelligence models" using Search Results.
- 3(b)(x): "replicate or attempt to replace the functionality of the API" inside Customer Applications.
- Definitions: "Customer Applications" are "any applications, products or services offered by Customer that are designed to access the API". "End Users" are "all third party end users of the Customer Applications". Section 4(c) makes the Customer bind End Users to terms "substantially similar" to 3(b).
- Reseller or partner program: none found in the terms.
- VERDICT: FORBIDDEN for a pass-through `/search` that hands raw Search Results to other people's apps. It hits 3(b)(iii), 3(b)(xii) and 3(b)(x). One narrow reading is possible: jobleft is publik's own Customer Application and its users are End Users. That reading is UNCLEAR and needs Brave's written yes. The no-caching rule (3(b)(i)) also blocks any result cache on publik's side.

## B.3 Tavily - https://www.tavily.com/terms

- Section 2: the API "may not be transferred, assigned, shared, or otherwise made available to any third party" (WebFetch, two fetches). Right to use is "non-sublicensable".
- Section 3.2(ii): no "license, sublicense, resell, distribute, lease, rent, lend, transfer, assign or otherwise dispose of the Services", with this proviso: "integration of the Services in Customer Applications ... will not constitute a violation".
- "Customer Application" is Customer software, platforms or services (which may include "AI Tools"), "including third party platforms". Section 3.5 covers Customer's own end users (Customer must handle disputes with them).
- Section 3.2(v) and (vi): no access "in order to build a competitive product or service" and no "compete with Tavily".
- AUP https://www.tavily.com/acceptable-use-policy : Customer is responsible for "Downstream Users" ("any such violation shall be deemed a breach by Customer"). The AUP bars "scrape, extract, harvest, or index the Services ... by automated means".
- Partner program: https://www.tavily.com/partnerships lists four tracks: Marketplace, SI/Consultancy, Tech Partner, Accelerators. Terms and revenue share are not published. The Marketplace track "distribute[s] Tavily's API through their cloud platforms and tool catalogs".
- The AUP is the key text (fetched twice, same wording). If a Customer lets a third party use the Services, the Customer shall "impose on such Downstream Users terms and conditions that are at least as restrictive". And: "Customer shall be responsible for any acts or omissions of its Downstream Users". So Tavily's own policy expects downstream users to reach the Services through the Customer's applications. The Customer must flow the AUP down and stay liable. An earlier publik memo reached the same reading (`~/publik-api-research/memos/R17-flat-rate-sources-by-infra-line.md`, fetched 2026-09-10).
- VERDICT: ALLOWED WITH CONDITIONS. Conditions: publik flows Tavily's AUP down to its users in publik's own terms. publik stays liable for them. jobleft counts as a publik "Customer Application". The line is not a raw open pass-through for any caller. Section 2 ("may not be ... made available to any third party") pulls the other way, so ask Tavily for one written line that confirms the AUP reading. The Marketplace partner form is the formal route.

## B.4 Jina (Reader and Search) - https://jina.ai/legal/

- 4.2: Jina AI IP is licensed as "non-exclusive, non-sublicensable, non-transferable, revocable and limited right".
- 4.5(iii): no "develop applications or services that compete with the Services offered by Jina AI".
- 4.5(iv): no "use automated methods to extract information, data or result from the JINA-AI website".
- 3.6: the Customer is "liable for all activities performed using its API keys" (end users included).
- 13.2: no assignment of rights to a third party without written consent.
- The words "resell", "reseller" and "white label" are absent. No partner program found.
- VERDICT: UNCLEAR, leaning FORBIDDEN for Reader. A publik `/fetch` that returns page text is a service that competes with Jina Reader (4.5(iii)). The terms are silent on resale, so this needs a written answer from Jina or Elastic.

## B.5 Serper - https://serper.dev/terms

- The terms say Serper is "a business-to-business service and does not provide end-user (consumer) services".
- "Usage License": no copy, modify, decompile; no "register more than one account"; no "mirror the materials on any other server". API data: do not misrepresent ownership or source, do not remove copyright notices.
- Resale, sublicensing, white label, competing service: NOT ADDRESSED (WebFetch reported "Not addressed" on two fetches). Governing law: United Kingdom. Refund: within 7 days if less than 20% of credits used.
- Reseller program: none found.
- VERDICT: UNCLEAR (silent). Silence is not permission. The "no more than one account" and B2B lines suggest Serper expects a single business customer. Google's own terms sit behind Serper and Serper does not say who carries them. Get an email answer before use.

## B.6 Bright Data - https://brightdata.com/license  and  https://brightdata.com/acceptable-use-policy

- 3.7.III (Proxy Services): "reselling of the Service in whole or in part, without Bright Data's prior written authorization".
- 10.1.II: "a limited, revocable and non-transferable license (with no right to sublicense)".
- 3.7.I(v): no "operate a service that competes with the Services".
- 1.2: some services need a "Know Your Client process".
- AUP: bans "Reselling of proxies without Bright Data's prior written approval (see our partners programs)". It bans "Collection of nonpublic information (i.e data behind login)". Bright Data "proactively blocks certain web content" at its "sole and exclusive discretion".
- Partner program: https://brightdata.com/partners/solution-partner has Introducer (referral), Certified (reseller) and Premier tiers. It does not say whether a partner may resell API access to end users. A search result says the enterprise path pays 50% revenue share on referral (UNVERIFIED; I did not fetch the PartnerStack page).
- VERDICT: NEEDS WRITTEN APPROVAL. The text allows resale only with "prior written authorization". A Certified partner route exists on paper.

## B.7 Zyte API - https://www.zyte.com/terms-policies/terms-of-service/  and  https://www.zyte.com/terms-policies/acceptable-use-policy/

- AUP 1.4 (fetched twice, same text): no license, sublicense, sale, resale, rent, lease, transfer, assignment, distribution, time share or other commercial exploitation. It also bars any use that would "make the Service available to any third party, other than authorized Agents". The sentence ends with "in furtherance of your internal business purposes".
- AUP 1.5: no "process data on behalf of any third party", "unless the third party is also subject to the Terms".
- AUP 2.3 repeats 1.4 for Service Data. AUP 1.9 bars access "where You explicitly agree to terms of service prohibiting Your manner of access". AUP 1.10: no "attempt to or use the Service to scrape any data from LinkedIn's website".
- Terms of Service definition: "an individual or AI agent you authorize to use the Services as your agent". The license is "non-exclusive, non-transferable, and non-assignable". The Terms themselves do not use "resell".
- Terms responsibility line: "up to you to determine the legality of the way you use our Services".
- Partner program: none for resale. Zyte runs an affiliate program that pays a commission on referred sign-ups (search snippet at https://www.zyte.com/affiliate/, UNVERIFIED) and its "building a product" page (https://www.zyte.com/building-a-product/) mentions no reseller or OEM terms.
- VERDICT: FORBIDDEN as a pass-through. AUP 1.4 and 1.5 close the door. Only a signed enterprise agreement could open it.

## B.8 Providers that are not pay-as-you-go with no minimum (resale clauses, for completeness)

These need a plan or a subscription, so they fail the float rule in section G. I still read the resale text, because a plan-based upstream could be reached through a partner deal.

- Firecrawl - https://firecrawl.dev/terms-of-service : 5.4.3 bars "sell, distribute, or create derivative works based on the Services in any manner". Section 3 bars giving "any other person with access to this Service ... using your username, password". No white-label, reseller or competing-service clause found. 7.7: the user must "defend, indemnify, save and hold harmless Company". VERDICT: FORBIDDEN as written (5.4.3 plus the sharing rule). Firecrawl's core is open source, which is a separate route (self-hosting needs a server, which is a fixed monthly cost; see H.3).
- Apify - https://docs.apify.com/legal/general-terms-and-conditions : 5.2(iv) bars "sublicense, transfer, or assign any rights or obligations under the license ... to third parties". 5.8: "solely responsible for the legality, accuracy, quality, appropriateness, and use of all Customer Data". 11.1 makes the user liable for extraction from "unauthorized sources". Store rules are in https://docs.apify.com/legal/store-publishing-terms-and-conditions (not read; UNVERIFIED). VERDICT: UNCLEAR for pass-through resale. But Apify has a native seller route: a developer publishes an Actor to the Apify Store and users pay per event. See Part D.
- ScrapingBee - https://www.scrapingbee.com/terms-and-conditions/ : section 15 bars making the API "available to a third party". Section 8(b): credits "are valid for the current Billing Cycle; leftovers are not shifted". Section 10: "User is solely responsible that web scraping operations ... are duly authorized". VERDICT: FORBIDDEN.
- ScraperAPI - https://www.scraperapi.com/terms/ : the page text did not load (navigation only). A search result quotes a "non-transferable, non-assignable, non-sublicensable, non-exclusive license" (https://www.scraperapi.com/terms/, snippet only). There is also an affiliate program (https://www.scraperapi.com/affiliate-terms/, not read). VERDICT: UNCLEAR, leaning FORBIDDEN. UNVERIFIED (I could not read the full text).
- Scrapfly - https://scrapfly.io/terms-of-service : 13.2 bars sublicensing the APIs. It also bars use "to replicate or compete with core products or services offered by Scrapfly without written approval". 13.2 has a "Third Party Integration" case where clients bring their own API keys. It bars a "Paid service that require third party customers to create free plan". Section 10: "We assume that you use the Website Platform and Services legally and ethically". VERDICT: NEEDS WRITTEN APPROVAL. The bring-your-own-key case is allowed. This is the BYOK fallback (H.1).
- Browserbase - https://www.browserbase.com/terms-of-service : bars sharing the account ("you will not share your Browserbase User ID, account or password with anyone"). Resale, sublicensing, white label: absent. Prohibited uses: "Use any robot, spider, or other automatic device ... to access the Platform". VERDICT: UNCLEAR (silent).
- ZenRows, Oxylabs, SerpApi: legal pages could not be read (404 on the URLs I tried: zenrows.com/terms-of-service, oxylabs.io/legal/terms-of-service-scraper-api). Verdict UNVERIFIED. SerpApi's pricing page lists a "Legal Shield" ("up to $2 million in coverage") from the Production plan up (https://serpapi.com/pricing). I check what it means in Part C.

## B.9 Extra providers I found while looking for an aggregator (not on your list)

### Parallel Search and Extract - https://parallel.ai/pricing , https://docs.parallel.ai/getting-started/pricing , https://parallel.ai/customer-terms
- Price: Search $1 per 1,000 requests (Turbo, Fast modes) or $5 per 1,000 (Basic, Advanced), 10 results included, extra results $1 per 1,000. Extract "$1 / 1,000 URLs". Rate limit "600 requests / min" for Search and Extract. Free: "up to $80 at signup + $5 in free credits per month" and "up to 5,000 requests per month" free. Prepaid or postpaid and the minimum top-up: not on those pages (UNVERIFIED).
- Terms 2(c)(iv) (fetched three times): no "rent, lease, lend, sell, resell, license, sublicense, assign, distribute, publish, transfer, or otherwise make available" the Services.
- The same terms give the Customer a route in. The license includes the right to "integrate the Services into the Customer Applications". End Customers are "Customer's end customers who have been authorized by Customer", and they must have "agreed to be bound by terms and conditions at least as protective".
- Terms 2(b) (fetched twice): Output is "primarily for the use of one End Customer only" and "shall not be copied, cached, stored, or made available to other End Customers". So publik may not keep a shared cache. 2(c)(vi): no use of the Services or Output for synthetic training data or databases.
- Reseller or partner program: none found. Parallel has a startup program (up to $250 in credits, https://parallel.ai/pricing).
- VERDICT: ALLOWED WITH CONDITIONS. Conditions: publik embeds Parallel in its own apps, binds each user to terms at least as protective, and shares no output between users. An open pass-through for any caller is not covered; it needs written approval. Same pattern as Tavily. No text names a gateway, so ask in writing.

### Perplexity Search API - https://docs.perplexity.ai/docs/getting-started/pricing
- Price: Search "$5.00 per 1,000 requests", with a faster variant at "$1.00 per 1,000". Prepaid credits, minimum top-up and rate limits: not on that page (UNVERIFIED).
- Terms: https://www.perplexity.ai/hub/legal/perplexity-api-terms-of-service returned HTTP 403 and the other URL variants returned 403 or 404 (3 tries). A search snippet says the API license is "non-exclusive, non-sublicensable and non-transferable" and output may be displayed "solely within their own customer applications". VERDICT: UNVERIFIED, leaning NEEDS WRITTEN APPROVAL.

### OpenRouter (publik already buys chat here) - https://openrouter.ai/terms
- Section 7 lead-in: "BY USING THE SERVICE, YOU AGREE NOT TO:" and item (4): "reselling API access to Models or otherwise developing a competing service" (fetched twice, same text). Section 6.1 lets a user give its customers access to Models "to the extent you incorporate the Service into your own products and services".
- Section 4.2: unused credits expire "three hundred sixty-five (365) days after purchase". Section 4.1: refunds only within 24 hours. Fee on credits: "5.5% ($0.80 minimum)" by Stripe, 5% by crypto (https://openrouter.ai/docs/faq).
- SIDE FINDING for the publik chat epoch: publik's own memo R26 (2026-09-18) marked OpenRouter section 7 RED ("Never front OpenRouter", `~/publik-api-research/memos/R26-universal-key-audit.md` line 48). CONTRACT section 13 (2026-09-22) later moved the chat tiers to OpenRouter. I found no memo that resolves that clause. Section 6.1 is the argument in publik's favour. This is outside jobleft, but the same clause pattern decides the search and fetch line, so I flag it once here.

## B.10 Resale verdicts in one table

Verdict words: ALLOWED, NEEDS WRITTEN APPROVAL, FORBIDDEN, UNCLEAR. "Conditions" means the text allows it inside your own application if you flow the terms down.

| Provider | Verdict | Deciding text | Partner or reseller route |
|---|---|---|---|
| Tavily | ALLOWED, with conditions (flow down the AUP; confirm in writing because ToS section 2 says the opposite) | AUP "Downstream Users"; ToS 3.2(ii) proviso for "Customer Applications" | Marketplace, SI, Tech Partner, Accelerators (terms unpublished) |
| Parallel | ALLOWED, with conditions (embed in a Customer Application; End Customers bound to equal terms; no shared caching); an open pass-through needs approval | Customer Terms 2: "integrate the Services into the Customer Applications"; End Customers "who have agreed to be bound by terms ... at least as protective"; 2(c)(iv) bars "resell ... make available" | None found |
| Exa | NEEDS WRITTEN APPROVAL | 4.2(e) "resell, lease or sublicense the Services to any third party without our prior consent" | Yes: exa.ai/partners "Resell the API, embed it in your customer deployments" |
| Bright Data | NEEDS WRITTEN APPROVAL | License 3.7.III "prior written authorization"; AUP "prior written approval (see our partners programs)" | Solution Partner: Introducer, Certified (reseller), Premier |
| Scrapfly | NEEDS WRITTEN APPROVAL (bring-your-own-key is allowed) | ToS 13.2 | None found |
| Brave | FORBIDDEN for a pass-through | 3(b)(iii), 3(b)(xii), 3(b)(i) no caching | None found |
| Zyte | FORBIDDEN | AUP 1.4, 1.5 | Affiliate only |
| Firecrawl | FORBIDDEN | ToS 5.4.3 | None found |
| ScrapingBee | FORBIDDEN | ToS section 15 | Affiliate (footer) |
| Vercel AI Gateway | FORBIDDEN | Terms 11 | None |
| Jina | UNCLEAR, leaning FORBIDDEN | 4.5(iii) competing-service clause; resale not mentioned | Contact Elastic sales (search snippet) |
| Serper | UNCLEAR (silent) | none | None found |
| Spider.cloud | UNCLEAR (silent) | EULA: "responsible for any data you acquire through Spider and any downstream use of that data" | Sales contact only |
| DataForSEO | UNCLEAR (silent on resale; 7.1 bars competing with search engines) | ToS 7.1 | None found |
| Apify | UNCLEAR | 5.2(iv) sublicensing bar; Store terms not read | Store seller route (80% to the developer) |
| Browserbase | UNCLEAR (silent) | none | None found |
| OpenRouter (web tools) | UNCLEAR; publik's own R26 memo rates it RED | 7(4) vs 6.1 | None found |
| ScraperAPI, ZenRows, Oxylabs, SerpApi, Perplexity Search | UNVERIFIED (terms unreadable in this pass) | - | ScraperAPI affiliate only |

Providers where resale is allowed today, on the text alone: Tavily and Parallel, and only in the "embedded in your own app, terms flowed down" shape. No provider I read allows an open, anonymous, raw pass-through with no conditions.

---

# Part C. Acceptable use, robots.txt and who carries the legal risk

(Filled in below, provider by provider.)

## C.1 What the hosts themselves say (this drives the publik block list in Part F)

| Host | What its own text says | URL fetched |
|---|---|---|
| LinkedIn | User Agreement 8.2(2) bars using software, scripts, robots, crawlers or browser plugins "to scrape or copy the Services, including profiles and other data". Its robots.txt header: "automated means to access LinkedIn without the express permission of LinkedIn is strictly prohibited". | https://www.linkedin.com/legal/user-agreement ; https://www.linkedin.com/robots.txt |
| Indeed | robots.txt, for "Default rules for all unspecified bots", disallows `/job/`, `/jobs/`, `/viewjob`, `/rc/`, `/pagead/`, `/applystart` (WebFetch summary of the file). Terms A.3.5: "Use of any automation, scripting, or bots to automate the Indeed Apply process". Terms for job seekers: use is "for your personal, non-commercial purpose of seeking employment". The excerpt I could read has no separate "scraping" sentence. | https://www.indeed.com/robots.txt ; https://www.indeed.com/legal |
| Glassdoor | robots.txt for all bots disallows `/jobview/`, `/search/`, `/Jobs/*_P*.htm*` (paged lists), `/job-listing/*_IE*.htm`, `/browse/`, `/ajax/`. Terms of Use page returned HTTP 403 (3 tries with the search variant too). A search snippet quotes "You may not use any robot, spider, scraper, data mining tools ..." (UNVERIFIED). | https://www.glassdoor.com/robots.txt ; https://www.glassdoor.com/about/terms/ (403) |

All three hosts say no to bots in text. Their pages are also the ones a fetch vendor would need its strongest anti-bot tools to reach. publik must block all three by host, whatever the upstream can technically do.

## C.2 What each provider forbids, its robots.txt stance and who carries the legal risk

| Provider | Forbids (target side) | robots.txt stance | Who carries legal responsibility | URLs |
|---|---|---|---|---|
| Zyte | AUP 1.10: no "scrape any data from LinkedIn's website". 1.3: no personal data "in violation of applicable Data Protection Law". 1.9: no access where "You explicitly agree to terms of service prohibiting Your manner of access". 1.2 illegal data. 1.11 gambling, terrorism, narcotics, arms, adult, violence. Site page: "automatic login restrictions for many sites that prohibit scraping" and "KYC Checks". | AUP does not mention robots.txt. | The customer. Terms: "It is up to you to determine the legality of the way you use our Services". Zyte is data processor for personal data; "you are the sole data controller". | https://www.zyte.com/terms-policies/acceptable-use-policy/ ; https://www.zyte.com/terms-policies/terms-of-service/ ; https://www.zyte.com/data-compliance/ |
| Bright Data | AUP: no "Collection of nonpublic information (i.e data behind login)". It "proactively blocks certain web content (i.e: Adult content, Governmental websites, Harmful domains, etc.)" at its "sole and exclusive discretion". Docs: "Public web data means content accessible without logging in." KYC (License 1.2) for some services. | Docs: "Respect `robots.txt`. While not legally binding in all jurisdictions, respecting `robots.txt` signals good faith." A search snippet says the no-KYC mode blocks robots.txt-disallowed sites (UNVERIFIED). | The customer for legality; AUP bans activity "in violation of applicable law or regulations or any third party rights". Docs tell buyers to "know who you're doing business with". | https://brightdata.com/acceptable-use-policy ; https://docs.brightdata.com/concepts/ethical-web-scraping ; https://brightdata.com/license |
| Firecrawl | ToS 5.4.15: no purpose "prohibited by applicable data privacy and security laws, including the GDPR or CCPA". Site-terms violations: not addressed. Search snippets say Instagram, YouTube and TikTok return "This website is no longer supported" (UNVERIFIED, third party). | Docs: "robots.txt is respected". "Ignore the website's robots.txt rules. Enterprise only." | The customer: 7.7 "defend, indemnify, save and hold harmless Company". | https://firecrawl.dev/terms-of-service ; https://docs.firecrawl.dev/features/crawl |
| ScrapingBee | Section 6: "User's responsibility to check such potential prohibition for each website prior to scraping." | Not stated on the page I read. | The customer: section 10 "User is solely responsible that web scraping operations ... are duly authorized". | https://www.scrapingbee.com/terms-and-conditions/ |
| Scrapfly | Section 10 bans card testing, fake accounts, account takeover, bot buying. | Not stated. | The customer: "We assume that you use the Website Platform and Services legally and ethically". | https://scrapfly.io/terms-of-service |
| Apify | 6.2: use only Customer Data "that you are authorized to access" and "in compliance with all applicable laws". | Not stated on the terms page. | The customer: 5.8 "solely responsible for the legality, accuracy, quality, appropriateness, and use of all Customer Data"; 11.1 liable for extraction from "unauthorized sources". Store Actors have their own author terms (not read). | https://docs.apify.com/legal/general-terms-and-conditions |
| Jina | 4.5(iv): no "use automated methods to extract information, data or result from the JINA-AI website". 4.4: Input must not infringe "any third party intellectual property or privacy rights". | Not stated in the README. Reader is Apache-2.0 open source (https://github.com/jina-ai/reader). | The customer: 4.3 "solely responsible for such Output and its compliance with applicable law". 3.6 "liable for all activities performed using its API keys" (end users included). | https://jina.ai/legal/ |
| Tavily | AUP: no "scrape, extract, harvest, or index the Services ... by automated means"; no sensitive personal data (government IDs, health, financial credentials) without consent; no illegal, hateful or fraudulent content; no "counterfeit goods". Target-site rules: not addressed. | Docs advice (search snippet, UNVERIFIED): "respect robots.txt and site policies". | The customer, including for Downstream Users: "Customer shall be responsible for any acts or omissions of its Downstream Users". | https://www.tavily.com/acceptable-use-policy |
| Exa | ToS 4.2(l): no unlawful, defamatory, obscene or violent content; 4.2(j) no robots or scrapers on the Services; 4.2(m) no violation of "any applicable law or regulation". | The Exa crawler "ExaSearchBot" respects robots.txt and does not bypass logins, paywalls or CAPTCHAs (search snippet of https://crawler.exa.ai/, UNVERIFIED). | The customer: 7.3 indemnity for "your violation or breach of any term". Exa disclaims Output accuracy (7.1.2). | https://exa.ai/terms (PDF) |
| Brave | 3(b)(vii) no use "in a manner that violates" IP rights or law; 3(b)(xv) no use with spyware, malware, counterfeit goods, embargoed items, mass email, hate content or illegal activity. | Not relevant: an index, not a fetcher. | The customer, including End Users: 4(c) "Customer is solely responsible and liable for all acts and omissions of End Users". | https://api-dashboard.search.brave.com/terms-of-service |
| Serper | Silent on targets. | n/a (search index). | Silent. Serper says only that it is "not affiliated with or endorsed by Google". Liability capped at "fees due and payable". | https://serper.dev/terms |
| SerpApi | Not read (terms URL returned 404). Pricing page: "Legal Shield" with "up to $2 million in coverage for the scraping and parsing of search engine data", from the Production plan. | n/a | SerpApi offers to carry part of the risk on paid plans (see the pricing page). The exact conditions: UNVERIFIED. | https://serpapi.com/pricing |
| ZenRows, Oxylabs, ScraperAPI | Could not read the terms (404 or navigation only). UNVERIFIED. ScraperAPI lists LinkedIn as a "Social Media" domain at 30 credits per call (https://docs.scraperapi.com/getting-started/quick-start/credits-and-requests-costs.md), so it sells LinkedIn access. | UNVERIFIED | UNVERIFIED | - |

Reading across the table:
1. Nobody carries the target-site risk for publik. Every vendor pushes it to the customer. Because publik is the customer, publik would carry it for every jobleft user, unless publik's own terms push it down and its block list keeps the risky hosts out.
2. Only Zyte names LinkedIn in its AUP. ScraperAPI sells LinkedIn access, which is a warning about what unblocker vendors allow. The vendor allowing it does not make it safe for publik.
3. Vendors that respect robots.txt by default: Firecrawl (documented), Exa (crawler). Vendors that document robots.txt as advice only: Bright Data, Zyte (blog snippet). publik should decide its own robots.txt rule and enforce it itself (Part F).

## C.3 Search-engine scraping risk (context for Serper, SerpApi, DataForSEO)

- Google sued SerpApi on 2025-12-19 in the U.S. District Court for the Northern District of California. Google's blog says "takes content that Google licenses from others ... and then resells it for a fee". Source: https://blog.google/technology/safety-security/serpapi-lawsuit/
- A ruling followed in July 2026. Search Engine Journal reports (summary of a WebFetch) that the court dismissed Google's DMCA anti-circumvention claims; it gave Google 21 days to amend claims about Knowledge Panel items that carry copyrighted content. Source: https://www.searchenginejournal.com/court-dismisses-googles-dmca-claims-against-serpapi/583033/ . The case is not over.
- Reading for publik: an index-based search API (Brave, Exa, Tavily, Parallel) does not scrape Google. A SERP-scraping API (Serper, SerpApi, DataForSEO) does, and it "resells" Google results. That is the exact pattern Google is suing over. Prefer the index-based APIs for `/search`.
- DataForSEO Terms 7.1 (https://dataforseo.com/terms-of-service): SERP data "shall not be used to compete with or adversely affect the business interests".

---

# Part D. Is there an "OpenRouter for scraping and search"?

Short answer: NO. I found no service that has all three of these: (1) one prepaid balance, (2) routing to several fetch or search vendors, and (3) terms that permit resale on top. What exists is below.

| Candidate | What it is | One prepaid balance? | Several upstreams? | Resale permitted? | Fixed cost? | Sources |
|---|---|---|---|---|---|---|
| OpenRouter web tools | `openrouter:web_search` and `openrouter:web_fetch` server tools inside a chat call. Engines: Exa $0.007 per request, Parallel $0.001 (Turbo, Fast) or $0.005 (Basic, Advanced), Perplexity $0.005, up to 10 results; extra results $0.001 each. Fetch: OpenRouter's own direct fetch is free (up to 50 per request); Exa and Parallel $0.001 per page; Firecrawl uses the caller's own account. Model tokens are billed on top. The OpenRouter blog page says Exa is $0.005; the docs page says $0.007. | Yes (OpenRouter credits, 5.5% fee) | Yes (Exa, Parallel, Perplexity, Firecrawl BYOK) | Section 7(4) bars "reselling API access to Models"; 6.1 lets you build products on it. Not a clean yes | $0 | https://openrouter.ai/docs/guides/features/plugins/web-search ; https://openrouter.ai/tool/web-fetch ; https://openrouter.ai/terms |
| Vercel AI Gateway web tools | `vercel:exa_search`, `vercel:parallel_search`, `vercel:perplexity_search`, `vercel:tako_search` as server tools in a chat call. Exa $7 per 1,000; Parallel $5 per 1,000; Perplexity $5 per 1,000. "No markup and no platform fee on tokens." | Yes (AI Gateway Credits, auto top-up) | Yes | NO: Terms section 11 (effective 2026-06-01) bars "otherwise commercially exploit or make the Services available to any third party" | $0 | https://vercel.com/docs/ai-gateway/models-and-providers/web-search ; https://vercel.com/docs/ai-gateway/pricing ; https://vercel.com/legal/terms |
| RapidAPI (Nokia API Hub) | A marketplace. One account and key across many third-party API providers. Rapid keeps a "flat 25% marketplace fee". Bills by subscription and overage. | Not stated as prepaid | Yes, but each API has its own provider terms | Terms page did not load. UNVERIFIED | Per API | https://docs.rapidapi.com/docs/payouts-and-finance ; https://rapidapi.com/page/terms (no text returned) |
| Apify Store | A marketplace of Actors. Developers get "80% of the fees paid by Users for your Actor, minus Platform usage costs" (Store Publishing Terms 10.2.1). Pay-per-event or pay-per-usage pricing. | Yes (Apify balance) but paid plans or the $5 free plan | Yes | The route is to be a seller on Apify, not to resell Apify to your own users | Free plan $0; PAYG has no plan | https://docs.apify.com/legal/store-publishing-terms-and-conditions ; https://apify.com/pricing |
| ScrapeOps Proxy Aggregator | "an all-in-one proxy API that gives you access to 20+ smart proxy APIs" (ScraperAPI, Zyte, ScrapingBee, Oxylabs, Bright Data and others). Picks the best per domain. | Credits on a plan | Yes | Terms 404. UNVERIFIED | NO: from $9 a month (25,000 credits) | https://scrapeops.io/proxy-api-aggregator/ |
| apifare (apipay) | A young prepaid connector: "one key, 4,900+ tools", 1 credit = $0.01, bring-your-own-key calls cost 0.1 credit. Says "not a key-pool / resale layer" and sells search through resold DataForSEO. | Yes | Yes (unnamed) | Terms not disclosed. UNVERIFIED | Unknown | https://glama.ai/mcp/connectors/io.github.iamalanlui/apipay ; the GitHub issue page returned 404 |
| x402 pay-per-call APIs | HTTP 402 plus a USDC payment per call, no account. Exa supports it on /search ($0.007) and /contents ($0.001 per page) with a wallet on Base or Solana; "10 per second per wallet". Small vendors sell scraping at $0.001 to $0.01 per call (search snippets of dev.to posts, UNVERIFIED). | Wallet balance in USDC | Per vendor | Same vendor terms; Exa's terms still bar resale without consent | $0 | https://exa.ai/docs/reference/x402-guide |

What this means:
1. The two routers that publik can already use (OpenRouter and Vercel) sell search and fetch only inside a chat call. Vercel forbids resale. OpenRouter forbids "reselling API access to Models". They suit a search feature that also needs a model answer. They do not give publik a plain `/search` or `/fetch`.
2. The real aggregators (ScrapeOps, apifare, RapidAPI) are either a monthly subscription, too young to trust, or a marketplace whose terms I could not read.
3. So publik has to buy from a single upstream and get its consent, as it did for OpenRouter. The float and the resale decision are per upstream.

---

# Part E. Design for publik

## E.1 Design rule: product-shaped and first-party only

The two friendliest texts are the Tavily AUP and the Parallel Customer Terms. Both let a Customer put the service inside "Customer Applications" used by "End Customers" or "Downstream Users". Both make the Customer liable for those users. Brave, Zyte, Firecrawl and Vercel bar an open pass-through. publik's own memos found the same split for Deepgram and fal (R28 quotes Deepgram: "you may integrate our Services into your own platform ..."), and R11 section 5 quotes Stripe's restricted list: "sale or resale of a service without added benefit to the buyer". I did not re-fetch those two memo quotes; they sit in `~/publik-api-research/memos/R28-image-video-audio-upstreams.md` and `R11-legal-compliance-platform-side.md`. So the new routes follow four rules:

1. They are granted per app token (new column `publik_app_tokens.allowed_routes`), not to every key. jobleft is the first app. That makes jobleft a publik "Customer Application" and its users "End Customers".
2. They are shaped for the job (block list, robots.txt check, clean output, host politeness), so publik adds benefit and is not a bare proxy.
3. publik never caches or stores fetched content and never shares one user's output with another user (Parallel Terms 2(b); Brave 3(b)(i)).
4. publik's developer terms flow down the upstream conditions (no LinkedIn, no personal data, no re-sale of output, user liable for misuse).

## E.2 Routes (added to CONTRACT section 3.1)

| Route | Body (JSON) | Reply |
|---|---|---|
| `POST /api/v1/search` | `query` (string, at most 400 chars), `max_results` (1 to 10), `quality` (`fast` default or `deep`), `include_domains`, `exclude_domains`, `recency` (`day`, `week`, `month`, `year`) | `results[]` of `title`, `url`, `snippet`, `published_at`, `host`; `units: 1` |
| `POST /api/v1/fetch` | `url` (https only), `render` (`never` default or `always`), `format` (`markdown` default or `text`), `max_chars` (default 100,000, max 250,000) | `url`, `final_url`, `target_status`, `content_type`, `content`, `truncated`, `rendered`; `units: 1` |
| Later: `POST /api/v1/jobs/page` | `url` | A normalized `JobPosting` (schema.org JSON-LD first, model extraction second). Priced as one page plus the chat tokens. This is the most "product-shaped" line and the safest for the resale clauses |
| Later: `POST /api/v1/company/lookup` | `name`, `domain` | Search plus fetch plus one chat call, sold as one price. jobleft's company panel needs exactly this (PLAN D3) |

The serve pipeline is the CONTRACT one (resolve key, `limitHits`, daily cap, reserve, forward, settle in `after()`), with one new step in front of reserve: the policy gate (Part F). A request that the gate refuses takes no hold and costs $0.

## E.3 New unit types and price-sheet rows

`unit_type` today is `token | audio_minute | character | image | infra_event` (migration 0034 widened it). Add: `page`, `page_js`, `search`. Both `publik_price_sheet.unit_type` and `publik_usage_events.unit_type` need the check widened, and `publik_price_sheet.provider` needs the new upstream names (migration 0046 is the template: drop the check, add it back wider). Take the next free `publik_pricing_epochs.id` (epoch 6 is the latest I can see in `supabase/migrations/0046_publik_api_openrouter_epoch.sql`).

Charge rows (provider `publik`, `price_factor` 1.0, so `list_micros == charge_micros` as in CONTRACT section 13):

| slug | unit_type | unit_micros | Published price | What it buys |
|---|---|---|---|---|
| `publik-fetch` | `page` | 2,000 | $2.00 per 1,000 pages ($0.002 each) | one page, no browser |
| `publik-fetch-js` | `page_js` | 4,000 | $4.00 per 1,000 pages ($0.004 each) | one page rendered in a browser |
| `publik-search` | `search` | 5,000 (`fast`); 8,000 (`deep`) via `unitMicrosByQuality` | $5.00 per 1,000 searches ($0.005 each); deep $8.00 | one query, up to 10 results |

Supply rows (provider = upstream name, same epoch; the audit copy, like `OPENROUTER_SUPPLY_SHEET`):

| slug | provider | unit_type | unit_micros | Source of the number |
|---|---|---|---|---|
| `extract` | `parallel` | `page` and `page_js` | 1,000 | "$1 / 1,000 URLs", https://docs.parallel.ai/getting-started/pricing |
| `search.fast` | `parallel` | `search` | 1,000 | "Turbo/Fast: $1 / 1,000 requests" |
| `search.deep` | `parallel` | `search` | 5,000 | "Basic/Advanced: $5 / 1,000 requests" |
| `search` | `tavily` (failover) | `search` | 8,000 | PAYG "$0.008 / credit", 1 credit per basic search |
| `extract` | `tavily` (failover) | `page` | 1,600 | 1 credit per 5 URLs |
| `extract.advanced` | `tavily` (failover) | `page_js` | 3,200 | 2 credits per 5 URLs |

Why two fetch rows when Parallel prices one Extract flat: most other vendors charge 5 to 10 times more for a rendered page (ScrapingBee 5x, ZenRows 5x, ScraperAPI 10x, Scrapfly +5 credits; A.4). Two rows let publik add a cheap plain-fetch upstream (Spider, once it answers in writing) or an unblocker (Bright Data, once it approves) without changing any app's price sheet.

Code that changes: `UnitType` in `lib/publik-api/pricing/sheet.ts`; `priceUnits()` in `lib/publik-api/pricing/price.ts` needs a `supplyRow` option so `supplyCostMicros = units x supplyRow.unitMicros x (1 + fee)`, and `supplyFee()` must read a per-provider fee table instead of the single `OPENROUTER_CREDIT_FEE`. New adapters `lib/publik-api/upstream/parallel.ts` and `tavily.ts` next to `openrouter.ts`. New guard in `lib/publik-api/copy-guard.test.ts`: the strings "Parallel", "Tavily", "Spider", "Brave", "Exa" and "credits" stay out of the user-facing copy.

## E.4 Reserve and settle

- Reserve: fixed price, so the hold is exact: `hold = units x charge`. One unit for every call. No estimate, no over-hold. TTL is the CONTRACT's 5 minutes; the fetch route sets `maxDuration = 120` (Parallel says live extraction can take "60-90 seconds").
- Settle, delivered: a 2xx with content (fetch), or a completed search. A search with 0 results still counts, because the upstream billed the query. Charge the unit price. Write `supply_cost_micros`, `builder_share_micros`, `provider`, `unit_type` and `units = 1`.
- Settle, refused: policy gate refusal happens before reserve, so no row and no charge.
- Settle, upstream fault (5xx, timeout, network): charge 0, answer 502 or 504, release the hold, log `SUPPLY FAULT`. Same rule as CONTRACT: "upstream 5xx settles as failure with zero charge".
- Settle, target fault (the target host answered 4xx or 5xx, or the body was empty): answer 200 with `target_status` and `fetched: false`. Charge 0. The vendor may still bill publik. A per-key cap on zero-charge fetches (20% of the last 100) closes that gap.
- A client disconnect never cancels the upstream call and never skips settlement (CONTRACT section 3.1).
- Failover guard: if the failover upstream's supply cost is above the charge (Tavily search, 8,984 micros against 5,000), the gateway counts the loss in a daily counter. Above a daily cap of $2.00 it answers 503 with `Retry-After` instead of failing over. Log `SUPPLY FALLBACK`, as the chat path already does.

## E.5 Headers and errors

Every metered call keeps the CONTRACT section 1 headers (`x-publik-balance`, `x-publik-week-used`, `x-publik-charge-micros`, and so on). New or changed:

| Header | Value |
|---|---|
| `x-publik-model` | `publik-fetch`, `publik-fetch-js` or `publik-search` (never the vendor) |
| `x-publik-unit-type` | `page`, `page_js` or `search` |
| `x-publik-units` | `1` |
| `x-publik-host` | the target host of a fetch (no path, no query) |

Errors (all with `x-should-retry: false` where CONTRACT section 11 says so):

| Status | `error.type` | When |
|---|---|---|
| 400 | `url_not_allowed` | scheme, port, credentials in the URL, IP literal, or private address (Part F) |
| 403 | `host_blocked` | host or its parent domain is on the block list |
| 403 | `robots_disallowed` | the target's robots.txt disallows the path for publik's agent |
| 402 | `insufficient_credit` | as CONTRACT section 1 |
| 429 | `rate_limit_exceeded`, `host_rate_limited`, `daily_cap_reached` | with `Retry-After` |
| 403 | `route_not_enabled` | the app token does not list `fetch` or `search` |
| 502, 504 | `upstream_failed`, `upstream_timeout` | zero charge |
| 503 | `gateway_unavailable` | fail closed, as CONTRACT |

## E.6 Per-key caps

| Cap | Value | Why |
|---|---|---|
| Rate per key | fetch 20 a minute, search 30 a minute (Redis `limitHits`) | CONTRACT already has 60 a minute across routes; these are per-route |
| In flight per key | 3 | slow live fetches |
| Rate per target host, all keys together | 30 a minute, 1 in flight | politeness; one host cannot be hit by many users at once |
| Units per key per day | anonymous 25; claimed 500; user-raisable to 2,000; hard ceiling 5,000 | on top of the dollar caps in CONTRACT section 5 |
| Units per app token per day | 20,000, alert at 60% | same shape as the mint caps in CONTRACT section 3.2 |
| Dollar daily cap | unchanged: anonymous $0.25, claimed $0.92 to $2.00 | $0.25 buys 125 pages or 50 searches at the prices above |
| Body size in | 4 KB | requests are tiny |
| Content size out | `max_chars` default 100,000, hard 250,000 | keeps replies small. CONTRACT section 1 cites a 4.5 MB body limit for requests; I did not check the response side |
| Time | 20 s default; 90 s hard | upstream Extract latency |

## E.7 How `builder_share_micros` works here

Exactly the OpenRouter-epoch rule in CONTRACT section 13 and `lib/publik-api/pricing/price.ts` (`BUILDER_SPREAD_SHARE = 0.5`):

`builder_share_micros = floor(max(0, charge_micros - supply_cost_micros) / 2)` when the key is attributed to an app, else 0.

Example: one `publik-search` call on the primary upstream, with a 12.3% top-up allowance. Charge 5,000. Supply 1,000 x 1.123 = 1,123. Spread 3,877. Builder share floor(3,877 / 2) = 1,938. publik keeps 1,939. So the builder of jobleft earns about $1.94 per 1,000 searches. A failover call with a negative spread pays the builder 0 and publik carries the loss.

## E.8 Margin, by the OpenRouter-epoch method

Method: supply cost = the vendor's unit price x (1 + the cost of putting cash into that vendor); charge = publik's published price; margin = (charge - supply) / charge. For OpenRouter publik measured 12.3% (`OPENROUTER_CREDIT_FEE`: $20.00 of credit for $22.46 charged). For Parallel, Tavily and Spider I found no published top-up fee. Their pages say only that a card is charged (Parallel: "The default payment method configured on the org's Stripe customer is always used"). So I use 12.3% as a stand-in for card fee plus tax, and 0% and 3% as the sensitivity. Re-measure on the first top-up, as publik did for OpenRouter. Vendor free credits (Parallel: $5 a month, up to $80 at signup) are not counted.

Arithmetic (micro-dollars per call; per 1,000 = x 1,000 / 1,000,000 dollars):

| Line | Charge per 1K | Upstream (supply per 1K) | Margin at 0% fee | at 3% | at 12.3% | Builder share per 1K at 12.3% |
|---|---|---|---|---|---|---|
| `search` fast | $5.00 | Parallel Fast $1.00 | 80.0% | 79.4% | 77.5% | $1.94 |
| `search` deep | $8.00 | Parallel Basic/Advanced $5.00 | 37.5% | 35.6% | 29.8% | $1.19 |
| `page` | $2.00 | Parallel Extract $1.00 | 50.0% | 48.5% | 43.9% | $0.44 |
| `page` | $2.00 | Tavily extract $1.60 (failover) | 20.0% | 17.6% | 10.2% | $0.10 |
| `page` | $2.00 | Spider about $0.10 to $0.155 (its own average; needs written OK) | 92% to 95% | 92% to 95% | 91% to 94% | about $0.92 |
| `page_js` | $4.00 | Parallel Extract $1.00 | 75.0% | 74.2% | 71.9% | $1.44 |
| `page_js` | $4.00 | Tavily extract advanced $3.20 (failover) | 20.0% | 17.6% | 10.2% | $0.20 |
| `page_js` | $4.00 | Bright Data Web Unlocker $1.50 (needs approval) | 62.5% | 61.4% | 57.9% | $1.16 |
| `search` fast | $5.00 | Tavily $8.00 (failover) | -60.0% | -64.8% | -79.7% | $0 (loss $3.98 per 1K) |
| `search` fast | $5.00 | Exa $7.00 | -40.0% | -44.2% | -57.2% | $0 |

Reading it: at $5.00, $2.00 and $4.00 per 1,000, publik keeps 77%, 44% and 72% on the recommended upstream. The search price is at or below Brave ($5.00), Exa ($7.00) and Tavily ($8.00) per 1,000 searches. So users do not pay more than going direct. The only losing cases are search failover to Tavily or Exa; the failover guard in E.4 caps them. The prices are a proposal for the founder to set, not a decision.

Volume check. Assume 1,000 jobleft users, each making 20 searches and 30 fetches a month. That is 20,000 searches ($100 charged, about $22 supply) and 30,000 pages ($60 to $120 charged, about $34 supply). These volumes are my illustration, not a measurement.

## E.9 Copy

Follow CONTRACT sections 1 and 13: dollars, never "credits", never a vendor name. Suggested line for `/developers` and the jobleft balance card: "Web search and page fetch are run by a provider that charges per use. publik charges a fixed, published price for each. The price is above what publik pays. The difference keeps publik running and pays the app's developer. Every call is on your dashboard." Add the flow-down sentences (no personal data, no login-protected pages, no LinkedIn, Indeed or Glassdoor, no re-sale of results) to the `/developers` terms.

---

# Part F. Abuse controls publik needs

Every vendor in Part C puts the target-site risk on the customer. publik is the customer. These controls are what keep that risk small. They run in the policy gate that sits in front of reserve (E.2), so a refused request costs nothing.

## F.1 Block list (default deny)

Match on the registered domain and every subdomain, on the first URL and on every redirect target (`final_url` from the upstream). If the final host is blocked, drop the content and charge 0.

| Group | Hosts to block | Why (fetched source) |
|---|---|---|
| Terms-banned job and career networks | `linkedin.com` (and `licdn.com`, `lnkd.in`), `indeed.*` (every country domain), `glassdoor.*`, `ziprecruiter.com` | LinkedIn User Agreement 8.2(2) "scrape or copy the Services"; LinkedIn robots.txt "strictly prohibited"; Indeed robots.txt disallows `/jobs/`, `/viewjob`, `/rc/`; Glassdoor robots.txt disallows `/jobview/`, `/search/`, paged `/Jobs/`; ZipRecruiter robots.txt for `*` is "Disallow: /" with only `/llms.txt` allowed; Zyte AUP 1.10 names LinkedIn |
| Login-walled social networks | `facebook.com`, `instagram.com`, `tiktok.com`, `x.com`, `twitter.com` | Zyte AUP 1.9 "terms of service prohibiting Your manner of access"; Bright Data AUP "data behind login". I did not fetch each site's own terms (UNVERIFIED) |
| Search engine result pages | `google.*/search`, `bing.com/search`, `duckduckgo.com`, `search.yahoo.com` | Google v. SerpApi (C.3): scraping and reselling results is what Google is suing over |
| Other job boards to review before any allow | `monster.*`, `careerbuilder.*`, `simplyhired.*`, `dice.com`, `wellfound.com`, `handshake` sites | Not fetched. UNVERIFIED. Default deny until each robots.txt and terms page is read |
| Everything a vendor's own AUP bans | gambling, adult, terrorism, narcotics, arms, violence | Zyte AUP 1.11; Bright Data AUP "blocks certain web content" |

Storage: a table `publik_blocked_hosts(domain, reason, source_url, added_at)` plus a code constant as the floor, so an empty table never opens the gate. Add a public "block my site" contact and honour a request within one working day.

Search results: drop any result whose host is blocked before it is returned, and refuse a query that uses `site:` on a blocked host. That keeps the search route from pointing users at pages the fetch route will refuse.

Personal data and login: the fetch route takes no cookies, no `Authorization` header and no custom headers, so it cannot reach a login-protected page. If the final URL or status shows a login wall (401, 403, or a redirect to a path containing `login`, `signin` or `auth`), charge 0 and answer `fetched: false`. Refuse path shapes that point at a person's profile (`/in/`, `/profile/`, `/people/`) on any host. The company-lookup route takes a company, never a person.

## F.2 Private-address protection (SSRF)

The upstream vendor makes the fetch, but publik still does three things itself: it parses the URL, it fetches robots.txt, and a hostile caller could use publik to probe someone else's network. The OWASP cheat sheet says to "Match the host against an allowlist, and build the request yourself", calls denylists "bypass-prone", and lists the ranges to block (https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html). An open fetch cannot use an allowlist, so publik uses strict parsing plus a resolved-address check:

1. `https` only. Ports 443 only (80 allowed only to upgrade). No credentials in the URL (`user:pass@`). At most 2,048 characters.
2. Reject IP literals in any form (decimal, octal, hex, IPv4-mapped IPv6). Reject `localhost`, single-label names, `.local`, `.internal`, `.lan`, `.corp`.
3. Resolve A and AAAA at publik. Reject if any address is loopback (`127.0.0.0/8`, `::1`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`), link-local (`169.254.0.0/16` including the metadata address `169.254.169.254`, `fe80::/10`), carrier-grade NAT (`100.64.0.0/10`), multicast (`224.0.0.0/4`, `ff00::/8`) or unspecified (`0.0.0.0/8`). "Treat parser disagreement as a rejection."
4. publik's own robots.txt fetch connects to the address it validated (no second lookup), follows at most 5 redirects, re-validates each hop, and has a 5-second timeout and a 500 KiB cap.
5. DNS rebinding: the upstream resolves again, so step 3 is best effort on that leg. Keep the block on the returned `final_url`, and prefer upstreams that refuse internal targets themselves (UNVERIFIED for Parallel and Tavily; test with a harmless private-IP URL against your own account before launch).
6. Optional strict mode for anonymous keys (not yet claimed). Allow only these hosts: known ATS hosts, hosts that a search with the same key returned in the last hour, and hosts on the jobs manifest.

## F.3 Size and time caps

See E.6. Also: accept only `text/html`, `application/xhtml+xml`, `text/plain`, `application/json`, `application/xml` and `application/pdf` (up to 10 MB at the upstream); refuse images, audio, video and archives. Follow at most 5 redirects. 20 s default and 90 s hard timeout. Content out at most 250,000 characters.

## F.4 No storage and no logging of page content

- Never write `content`, `snippet`, query text or a full URL (path or query string) to a table, a log or a cache. Log the target registered domain, status, bytes, unit type, latency, outcome, provider and the micro-dollar amounts. For search log only `query_len`.
- No shared cache of any kind. Parallel Terms 2(b): Customer Output "shall not be copied, cached, stored, or made available to other End Customers". Brave 3(b)(i) bars any "database of Search Results". `Cache-Control: no-store` (CONTRACT section 1) stays.
- Keep the CONTRACT idempotency rule: a 24-hour fingerprint, an HMAC of key id, route and canonical body under a server secret. No plaintext body.
- Tell users in `/developers#data` that the provider has its own retention rules (CONTRACT section 6 uses the same hedge for chat). Prefer a zero-retention option where an upstream sells one (Brave lists "ZDR" for Enterprise; I found none for Parallel or Tavily; UNVERIFIED).
- App rule for jobleft: put only company names, job titles and public URLs in search and fetch requests. Never put resume text, a name or an email in a query. This matches the plan rule "no personal data in any request".

## F.5 robots.txt handling

RFC 9309 (https://www.rfc-editor.org/rfc/rfc9309.html) gives the rules. publik applies them before it calls the upstream:

- Fetch `/robots.txt` from the target's own origin, cache it per host for at most 24 hours ("SHOULD NOT use the cached version for more than 24 hours"). This is the only thing publik caches.
- Status 4xx: "the crawler MAY access any resources", so allow. Status 5xx or unreachable: "the crawler MUST assume complete disallow", so refuse with `robots_disallowed` (and a retry hint).
- Apply the `*` group. The upstream's own crawler token is not publik's to claim. If the `*` group disallows the path, refuse. Read `Crawl-delay` and use it as the minimum gap for that host (Lever asks for 1 second, per the data-supply audit).
- Parse at least 500 KiB ("The parsing limit MUST be at least 500 kibibytes").
- RFC 9309 also says "These rules are not a form of access authorization." So robots.txt is one gate. The block list (F.1) covers hosts whose terms ban bots even when robots.txt is silent (the LinkedIn robots.txt header says "without the express permission of LinkedIn is strictly prohibited").
- Do not honour robots.txt by pretending to be a browser. Vendors that impersonate browsers make robots.txt meaningless; Firecrawl documents "robots.txt is respected" and Exa's crawler respects it (C.2). Prefer such upstreams.

## F.6 Other abuse controls

- Distinct-host limit: more than 30 distinct hosts a minute from one key is scanning; answer 429 and flag the key (`revoke_reason = 'abuse'` exists in CONTRACT section 4).
- Zero-charge ratio: more than 20% of the last 100 fetches ending in `fetched: false` slows the key to 5 a minute.
- Per app token: daily unit cap with an alert at 60%.
- Kill switch `PUBLIK_API_SCRAPE_ENABLED` (default 1; 0 answers 503), like the reservation kill switch in CONTRACT section 8.
- Nightly price and terms check: diff the upstream pricing pages against the supply rows and log `SUPPLY DRIFT` (same job as `price-check` in CONTRACT section 3.4). Also diff the vendor's terms page hash and alert on change, because the resale clause is the whole business case.

---

# Part G. The float

The float is the money publik must have at each upstream before the first user call, plus what stays stranded if publik leaves that upstream. Users prepay publik first (packs of $20, $50, $100 per CONTRACT section 0), so the float only bridges the time between a user's spend and publik's next top-up.

| Upstream | Minimum to start | How it recharges | Stranded if dropped | Suggested float |
|---|---|---|---|---|
| Parallel (primary) | $0. Every eligible org with a card on file gets "$5 in free credits each month" (changelog 2025-07-15), and up to $80 at signup (pricing page). A paid top-up is $0.01 to $100.00 per call by API | Prepaid balance. "Auto-reload ... automatically adding to your balance when configured thresholds are met" (changelog 2025-05-21). The threshold and amount settings are not published (UNVERIFIED). A top-up by API always uses the org's default card | Customer Terms 6(b): payments are "non-cancellable and non-refundable" unless an order says otherwise (WebFetch summary), so assume it is lost | $20 first top-up (20,000 searches or 20,000 pages at $1.00 per 1,000). Auto-reload at $5 left, in $20 steps, with a $200 monthly cap |
| Tavily (failover) | $0 prepaid. PAYG is card-billed: "Charged automatically for every $40 of usage" | A monthly usage limit can be set at app.tavily.com/billing; whether it is a hard stop is not stated | Nothing prepaid, so nothing stranded; exposure is up to $40 of unbilled usage plus the month's limit | $0 float. Set the monthly limit to $25 |
| Spider (optional, plain pages) | $1 (guide) or $25 (pricing page); the two Spider pages disagree | No auto top-up mentioned; credits "never expire" | Small | $25, only after Spider answers on resale |
| Bright Data (optional, hard pages) | Not stated. First deposit matched dollar for dollar up to $500 (a promotion; bonus funds are not refundable) | Preset recharge amounts; the docs' example is $100 and a recharge at a $25 balance | Subscription fees "non-refundable"; deposit refund policy not stated | Do not open until it approves resale in writing |
| Exa (optional) | Not stated | Auto-recharge $5 to $10,000 per trigger, with a threshold and a monthly maximum | No expiry stated; free credits never refunded | Do not open until it approves resale in writing |
| OpenRouter (already open) | Already funded for chat | Auto top-up is on the founder's checklist in STATE.md; I did not confirm that it is on | Credits expire after 365 days | No change. Its web tools are not part of this design |

So the smallest workable start is $20 at one upstream, and $0 more at the failover. With a $20 first top-up publik carries a supply exposure of roughly $20 to $45 in the worst case (Parallel $20, Tavily up to $25 of limit).

Each vendor's top-up can carry sales tax or a card fee. The margin model in E.8 allows 12.3% (the OpenRouter measurement). Record the first real receipt from each vendor and update the fee table. publik does not carry the card fee on what users pay: CONTRACT section 0 grosses every user price up so "the usage amount is what is left after Stripe".

Alarm: add a health cron beside `/api/cron/publik-api/openrouter-health`. It sums `supply_cost` per provider from the ledger and subtracts the operator's recorded top-ups. It logs `LOW SUPPLY` under $5. It logs `KEY TROUBLE` on a 401, 402 or 403 from the vendor. Do this because Parallel's read-balance endpoint is not in the docs I read (UNVERIFIED).

---

# Part H. Fallbacks

## H.1 The user pastes their own key (BYOK)

The user becomes the vendor's customer, calls go from the laptop straight to the vendor, and publik is not in the path. No resale question, no metering, $0 to publik. This mirrors the AI engine's "own key" option in `docs/PLAN.md` section 2. Rules: keep the key in the macOS Keychain; never ship a shared key in the app; show the vendor's own terms link next to the key box.

| Provider | What the free tier gives a job seeker | Source |
|---|---|---|
| Parallel | "up to $80 at signup + $5 in free credits per month"; "5,000 requests per month" free | https://parallel.ai/pricing |
| Tavily | 1,000 credits a month, no card | https://www.tavily.com/pricing |
| Exa | "$10 in credits (around 1,400 searches)" a month | https://exa.ai/pricing |
| Brave Search | "$5 in credits every month" (about 1,000 searches) | https://api-dashboard.search.brave.com/documentation/pricing |
| Jina | "10M free tokens" on a new key | https://jina.ai/reader/ |
| Firecrawl | 1,000 credits a month on the Free plan | https://www.firecrawl.dev/pricing |
| Serper | 2,500 free queries, once | https://serper.dev/ |
| Bright Data Web Unlocker | 5K requests a month, no card | https://brightdata.com/pricing/web-unlocker |
| Zyte | $5 credit, no commitment | https://www.zyte.com/pricing/ |
| Scrapfly | 1,000 credits; its terms name bring-your-own-key as a "Third Party Integration" (13.2) | https://scrapfly.io/pricing ; https://scrapfly.io/terms-of-service |

Job-search volume should fit these tiers. My illustration, not a measurement: a user who checks 30 companies a month needs about 30 searches and 60 pages.

## H.2 No upstream at all: what works with plain HTTP from the laptop

Works, with no vendor and $0:

| Task | How | Evidence |
|---|---|---|
| Read jobs from Greenhouse boards | `GET boards-api.greenhouse.io/v1/boards/{token}/jobs` | Greenhouse docs: "Job Board data is publicly available, so authentication is not required for any GET endpoints." https://docs.greenhouse.io/job-board.html |
| Read jobs from Lever | `GET api.lever.co/v0/postings/{site}` | Lever docs: "These jobs may be scraped by third parties." https://github.com/lever/postings-api |
| Read jobs from Ashby | `GET api.ashbyhq.com/posting-api/job-board/{name}` | https://developers.ashbyhq.com/docs/public-job-posting-api (the page does not state an auth rule; the data-supply audit tested it keyless) |
| Workable, Recruitee, Personio feeds | Public JSON or XML | `~/jobright-research/audit/05-data-supply.md` (I did not re-fetch these) |
| Workday CXS, iCIMS sitemaps | Undocumented POST or sitemap plus HTML | Same audit; PLAN section 6 says ask before any Workday crawl |
| Server-rendered career pages | Plain GET plus schema.org `JobPosting` JSON-LD parse, after the host's robots.txt | Same audit |
| Guess a company's board | Try `{slug}` on the Greenhouse, Lever and Ashby hosts | Plain GET; no search needed |
| Company facts for well-known firms | Wikidata, SEC, GLEIF public APIs | PLAN D3: about 80% of famous firms, 20% to 35% of small ones |
| Add-a-job-by-URL | Plain GET plus JSON-LD; local render if empty | Local render is possible: Tauri lets an app create a webview window for an external URL, but the docs I read do not show the hidden-window flag or script evaluation (UNVERIFIED), and it needs the `core:webview:allow-create-webview-window` permission (https://v2.tauri.app/reference/javascript/api/namespacewebviewwindow/). Prove it in a spike |

Does not work without an upstream:

| Task | Why |
|---|---|
| Web search ("find this company's careers page", "who else hires X") | No keyless search index API exists in this survey. Scraping a search engine's result pages is what Google sued SerpApi over (C.3) |
| Company funding, investors, leaders and news beyond Wikidata, SEC and GLEIF | Needs search plus reading pages, then a model call (PLAN D3 budgets about $0.03 a company) |
| Pages behind bot protection (challenge pages, blocked datacenter and repeat-request patterns) | A laptop on a home IP passes some but not all; no honest local fix |
| JS-only career sites at scale (hundreds of companies) | Local render is slow and heavy on battery; run these in the hosted jobs service, not in metered per-user calls |
| LinkedIn, Indeed, Glassdoor, ZipRecruiter | Refused for every path; see F.1 |
| SmartRecruiters | Its robots.txt disallows generic crawlers (audit), so an upstream would not help either |

Consequence: the hosted jobs service (PLAN phase 1) already covers the bulk. The metered `search` and `fetch` lines serve the long tail only: a user-added company, a URL the local render cannot read, and enrichment. Expect a small line. My illustration is 20 searches and 30 pages per user per month. That is about $0.16 to $0.22 a month charged per user at the prices in E.8. It is not measured.

## H.3 Open-source engines (no vendor, no resale question)

Licences below come from `gh repo view` on 2026-09-24.

| Engine | Licence | Fit |
|---|---|---|
| Crawl4AI (`unclecode/crawl4ai`) | Apache-2.0 | An LLM-friendly crawler with a browser. Pushed 2026-09-23. It can run on the laptop as a helper for JS pages. Not tested |
| Jina Reader (`jina-ai/reader`) | Apache-2.0 | The README gives a Docker image `ghcr.io/jina-ai/reader:oss`. Last push 2026-05-22. Needs Docker or a server |
| Firecrawl (`firecrawl/firecrawl`) | AGPL-3.0 | Read the AGPL before anyone hosts a copy for other people |
| Spider (`spider-rs/spider`) | MIT | A Rust crawler library |
| SearXNG (`searxng/searxng`) | AGPL-3.0 | A metasearch engine. It queries other engines' result pages, so it has the same target-terms risk as SERP scraping (C.3). Results depend on engines that may block it (UNVERIFIED) |

Rule: publik does not host any of these for users. Hosting adds a server (a fixed monthly cost) and moves the target-site risk to publik. On the user's laptop they cost publik $0 and the user carries the risk.

---

# Part I. Recommendation

## I.1 Upstreams

1. **Parallel (Search and Extract), primary.** Reasons: prepaid balance with $0.01 to $100 top-ups; $1.00 per 1,000 for Extract and for Fast search; Extract "converts any public URL into clean markdown, including JavaScript-heavy pages and PDFs"; 600 requests a minute; terms that name "Customer Applications" and "End Customers" with a flow-down. It is the cheapest line that also passes the resale text.
2. **Tavily (Search and Extract), failover and legal reference.** Reasons: the only AUP that plainly expects "Downstream Users"; PAYG needs no prepay and no plan; 1,000 free credits a month. It costs 8x more per search, so it is a failover behind the guard in E.4, not the default.
3. Optional later, each only after a written yes. **Spider** for cheap plain pages: about $0.10 per 1,000 by its own figures, and its terms are silent. **Bright Data Web Unlocker** for hard pages: $1.50 per 1,000, and resale needs "prior written authorization". **Exa** for company search: a partner program exists.

Not recommended: Brave, Zyte, Firecrawl, ScrapingBee, Vercel AI Gateway (terms forbid the resale), the SERP-scraping vendors for search (Google litigation), and every subscription-only vendor (fails the $0 rule).

## I.2 Go or no-go on resale

CONDITIONAL GO, in this shape only: a first-party, product-shaped line for jobleft (and later other publik apps by token), with the four rules in E.1. The gates, in order:

1. One email each to Parallel and Tavily. The question: may publik meter your Search and Extract to the end users of its own apps, with your terms flowed down, under one publik key? Keep the written answer. Their texts point to yes; neither text names a gateway.
2. A live proof against 30 real career pages and 30 searches. Use the free monthly credit (Parallel needs a card on file; it needs no purchase). Include the private-address and blocked-host checks in Part F. I did not run one, by rule.
3. The counsel read already required by PLAN gate G1.
4. Then the founder sets the three prices in E.3. The prices in E.3 and E.8 are my proposal.

NO-GO: an open, anonymous pass-through for any app or caller; any use of Brave, Zyte, Firecrawl, ScrapingBee or Vercel AI Gateway as the supply; any LinkedIn, Indeed, Glassdoor or ZipRecruiter access.

## I.3 Fixed monthly cost

$0. Parallel and Tavily are PAYG with no plan. No server. The routes run in the existing `app/api/v1` Vercel project. Do not buy any plan tier: Tavily Project is $30 a month and Parallel needs none. The existing Vercel and Supabase plans are already paid for other reasons, and nothing here raises them. One check is open. The files I read do not state publik's Vercel plan tier. A 90-second fetch uses function time. Check the plan's function limits.

## I.4 Main risks

1. **Resale text.** Neither Parallel nor Tavily names a gateway. Raw pass-through is banned in both; the "Customer Application" reading is mine. Get the email first.
2. **A young vendor.** Parallel's public docs are recent (changelog entries run from 2025), Extract latency is "60-90 seconds" for live pages, quality on job pages is unmeasured, and payments are non-refundable. Keep the float at $20.
3. **publik carries target-site liability.** Every vendor pushes it to the customer (C.2). The block list, robots check and flow-down terms reduce it; they do not remove it.
4. **No caching.** Parallel bars sharing output between End Customers and Brave bars any store. That limits how much publik can save on repeat calls.
5. **Failover loss.** Search failover to Tavily loses about $3.98 per 1,000 at the proposed price; the guard caps it.
6. **Price drift.** Parallel's prices and modes are recent and named two ways on its own pages ("Turbo, Fast, Basic, Advanced" on the pricing page; "advanced, fast, turbo" in the Search docs). The nightly diff in F.6 watches this.
7. **Terms drift.** The resale clause is the whole case; hash and diff the terms pages.
8. **OpenRouter section 7(4).** The chat epoch already sits on a clause that publik's R26 memo rated RED. The same email-first approach would settle it. This is a side finding, outside jobleft.
9. **Stripe.** publik's R11 memo quotes Stripe's restricted "no-value-added" resale category. Product-shaped routes and the company-lookup route are the answer.
10. **Small revenue.** The line is small (H.2). Build it after the jobs service, not before, unless onboarding needs company discovery.

## I.5 What I could not verify (all marked UNVERIFIED above)

- Legal text I could not read: Perplexity API terms (403). ScraperAPI terms (navigation only). Oxylabs, ZenRows and SerpApi terms (404). Glassdoor terms (403). RapidAPI terms (no text returned). ScrapeOps and Olostep terms (404). Exa's Master Subscription Agreement (not public in my pass).
- Prices on third-party pages only: Serper packs, Jina per-token price, ScraperAPI plan prices, DataForSEO SERP price.
- Conflicts left open: Spider minimum top-up ($1 vs $25), Exa and Brave minimum top-up (not stated), Zyte billing timing, Parallel auto-reload settings and read-balance API.
- Vendor behaviour I did not test: private-address refusal, blocked-site behaviour, live latency, success rate on career pages. No provider API was called.
- WebFetch passes each page through a small model. The Exa PDF I read myself; the other quotes were requested verbatim and the key ones repeated. Re-read the primary texts at the legal review.

---

# Final table

| Provider | PAYG, no minimum? | Price per 1K plain fetches | Price per 1K JS pages | Price per 1K searches | Smallest top-up | Resale verdict | Notes |
|---|---|---|---|---|---|---|---|
| Firecrawl | NO: PAYG needs a paid plan ("cannot use pay-as-you-go on the free plan") | $3.20 to $0.60 (derived from plan price, 1 credit a page) | same (stealth "billed at the same 1 credit") | $6.40 to $1.20 (derived, 2 credits a search) | $5 block on a paid plan (Hobby $16 a month) | FORBIDDEN (ToS 5.4.3) | Respects robots.txt by default; open source core |
| Apify | NO ($5 a month free; paid plans) | Actor-dependent (UNVERIFIED) | Actor-dependent | Actor-dependent | Not stated | UNCLEAR | Credits expire each cycle; Store pays developers 80% |
| Bright Data (Web Unlocker, SERP API) | YES | $1.50 | $1.50 (rendering included) | $1.50 (SERP API) | Not stated; first deposit matched to $500 | NEEDS WRITTEN APPROVAL | Solution Partner program; KYC for some services; data behind login banned; the SERP API scrapes Google (C.3) |
| Zyte API | YES on paper; $100 default spend limit; billing timing UNVERIFIED | $0.13 to $1.27 | $1.01 to $16.08 | none | $1 card check (UNVERIFIED) | FORBIDDEN (AUP 1.4, 1.5) | AUP 1.10 bans LinkedIn; affiliate program only |
| ScrapingBee | NO | $0.25 to $0.07 (derived) | $1.27 to $0.37 (derived) | not on page | Plan from $19 | FORBIDDEN (ToS 15) | Credits valid for the billing cycle |
| ScraperAPI | NO | $0.49 to $0.15 (derived; plan prices third-party) | $4.90 to $1.49 (derived) | $12.25 to $3.73 (Google, 25 credits) | Plan from $49 (third-party) | UNVERIFIED (leans FORBIDDEN) | Sells LinkedIn access at 30 credits a call |
| Scrapfly | NO | $0.15 to $0.50 (derived) | $0.90 to $3.00 (derived) | not on page | Plan from $30 | NEEDS WRITTEN APPROVAL | Terms 13.2 allow bring-your-own-key |
| Browserbase | NO (Free or $20 plan) | Fetch $1.00 (paid plan) | about $0.33 a page from $0.12 a browser hour (derived) | Search $7.00 | $20 plan | UNCLEAR (silent) | 1,000 free Search and Fetch calls |
| Jina Reader and Search | YES (tokens) | about $0.10 to $0.40 (derived, UNVERIFIED) | same | about $0.50 (derived, UNVERIFIED) | Not stated | UNCLEAR, leans FORBIDDEN (4.5(iii)) | Reader is Apache-2.0 open source; 10M free tokens |
| Exa | YES | $1.00 (contents) | $1.00 (UNVERIFIED) | $7.00 | Not stated; auto-recharge $5 to $10,000 | NEEDS WRITTEN APPROVAL (4.2(e)) | Partner program: "Resell the API"; x402 wallet option; 10 QPS |
| Brave Search API | YES (prepaid) | n/a | n/a | $5.00 | Not stated | FORBIDDEN (3(b)(iii), (xii)) | No caching, no AI use of results; 50 per second |
| Tavily | YES ("Charged automatically for every $40 of usage") | $1.60 (extract, 1 credit per 5 URLs) | $3.20 (advanced extract) | $8.00 | none prepaid | ALLOWED WITH CONDITIONS (AUP Downstream Users) | Flow down the AUP; ToS section 2 conflicts; Marketplace partner track |
| Serper | Packs only (no plan) | n/a | n/a | $1.00 to $0.30 (third-party) | $50 pack (third-party) | UNCLEAR (silent) | Google SERP scraper; pack prices not on vendor site |
| SerpApi | NO | n/a | n/a | $25.00 to $1.96 | $25 plan | UNVERIFIED | Google sued it 2025-12-19; claims dismissed with leave to amend in July 2026 |
| ZenRows | NO | $0.36 to $0.09 (derived) | $1.78 to $0.46 (derived) | not on page | Plan from $16 | UNVERIFIED | Free plan 5,000 credits a month |
| Oxylabs | NO | $1.15 to $0.70 | $1.35 to $0.95 | $1.00 to $0.50 (Google) | Plan from $49 | UNVERIFIED | Top-ups $249 to $2,000 on a plan |
| Parallel (extra) | YES | $1.00 (Extract) | $1.00 (handles JS and PDFs) | $1.00 (Fast) or $5.00 | $0.01 by API | ALLOWED WITH CONDITIONS (End Customers, flow-down) | Recommended primary; no shared caching; 600 per minute |
| Spider.cloud (extra) | YES | about $0.10 (own average) | about $0.16 (own figures) | about $1.00 | $1 or $25 (pages disagree) | UNCLEAR (silent) | Credits never expire; optional cheap plain fetch |
| DataForSEO (extra) | YES | n/a | n/a | $0.60 to $2.00 (third-party) | $50 | UNCLEAR (7.1 no competing with search engines) | Google SERP scraper risk |
| Olostep (extra) | Packs | $2.00 (10K credits for $20) | included | from $9 for 5,000 | $20 pack | UNVERIFIED (terms 404) | Packs valid 6 months |
| Perplexity Search (extra) | Prepaid (UNVERIFIED) | n/a | n/a | $5.00 | Not stated | UNVERIFIED (terms 403) | Fast variant $1.00 |
| OpenRouter web tools (aggregator) | YES (credits) | free direct fetch, or $1.00 (Exa, Parallel) plus model tokens | same | $5.00 to $7.00 plus model tokens | Fee 5.5% ($0.80 minimum) | UNCLEAR (7(4); R26 says RED) | Bundled in a chat call; not a plain API |
| Vercel AI Gateway web tools (aggregator) | YES (credits) | n/a | n/a | $5.00 to $7.00 plus model tokens | Not stated | FORBIDDEN (Terms 11) | Bundled in a chat call |
