# Web search (SearXNG)

jobleft can search the whole web for jobs, not only the job boards you follow. It searches through your own [SearXNG](https://docs.searxng.org), a free search engine you run on your computer that asks other search engines for you. No account or key is needed.

## What you get

- **Jobs > Web jobs**: type what you are looking for and where. The results come from every kind of site: employers' own career pages, government and local job sites. Job boards jobleft already reads (Greenhouse, Lever, Ashby, Workable, Recruitee, Personio, Teamtailor, Gem) are left out: follow those in Settings > Job sources.
- **Each result is checked.** jobleft reads each result once, in the background, and labels it: a job posting and where it is, probably a job posting, closed, a list of jobs, or not a job. The job postings are also job cards, with your match, the details and Apply.
- **Tabs.** A result opens in a tab next to the results (Ctrl-click or a middle click opens it behind). A job posting jobleft read shows as the job: like it, mark it applied, add notes and reminders. A page it could not read shows what the search engine found, with Like and Mark as applied: jobleft keeps it as a job made from the result and its link. Open page shows the live page in a jobleft window of its own; Open in your browser uses your browser.
- **Only in your country.** The place you type sets the country; "Only in ..." hides jobs elsewhere.
- **Also search on.** The same search on LinkedIn, Indeed, Glassdoor and Google's job search, as links for your browser.
- **Widen with AI.** With an AI provider set up, your AI suggests other titles for the same job, in the languages postings in your place use, and jobleft searches those too.
- **Saved searches.** Save a search and jobleft runs it every day or every 12 hours while it runs, and tells you about new job postings.
- **The assistant** can search the web too ("find SOC analyst jobs in Utrecht", "what does a data analyst earn in Berlin?") and shows each step as it works.

## Set up SearXNG

With Docker. Make a folder with these two files:

`docker-compose.yml`

```yaml
services:
  searxng:
    image: docker.io/searxng/searxng:latest
    container_name: searxng
    restart: unless-stopped
    ports:
      - "127.0.0.1:8888:8080"   # this computer only
    volumes:
      - ./config:/etc/searxng:rw
    environment:
      - SEARXNG_BASE_URL=http://127.0.0.1:8888/
```

`config/settings.yml` (put your own random text in `secret_key`, for example from `openssl rand -hex 32`)

```yaml
use_default_settings: true
server:
  secret_key: "change-me"
  limiter: false          # only you use it
  public_instance: false
search:
  formats: [html, json]   # jobleft reads json
engines:                  # these give the best job results (tested October 2026)
  - name: resulthunter
    disabled: false
  - name: yahoo
    disabled: false
  - name: privacywall
    disabled: false
  - name: google cse
    disabled: false
  - name: google
    disabled: true
  - name: bing
    disabled: true
```

Then start it with `docker compose up -d` in that folder, and in jobleft open **Settings > Web search**, enter `http://127.0.0.1:8888`, and choose **Test**, then **Save**. Test tells you if SearXNG answers in JSON and which engines keep to the searches jobleft sends.

Search engines limit how often a program may ask. SearXNG pauses an engine that refuses it for a while; the results line in Web jobs names an engine that is not answering. Normal use stays far below these limits: a search sends six to eight requests, and the same search again within 30 minutes asks nothing.

## What is sent where

- Your search words and the place go to your SearXNG only. SearXNG asks the search engines, without your name or address.
- jobleft reads a result page once, in the background, only if the site allows programs (robots.txt), at most one request a second per site, with its own name as the user agent.
- jobleft never opens LinkedIn, Indeed, Glassdoor or Workday pages, even when a search finds them. You open them in your browser.
- Liking or tracking a page jobleft could not read keeps only what the search engine returned (title, link, short text). Nothing is sent to the site for that.
- Open page is you browsing: the site gets what any browser sends, as when you open it in your browser. That window has no access to jobleft, and it does not open LinkedIn, Indeed, Glassdoor, Workday or addresses on your own network.
- With Widen with AI, only your search words and the country go to your AI provider.
