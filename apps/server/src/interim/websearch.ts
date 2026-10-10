// Web search through the person's own SearXNG (Settings > Web search). jobleft sends the search words to that one
// address, asks for its JSON answer, and sorts the results by what it may do with them. It opens no result page
// here: adding a job goes through add-by-link (robots.txt, the never-contact list), and following a board goes
// through the board list.
//
// SearXNG is the one local address jobleft contacts on purpose: the person typed it. Only that address is asked,
// only its /search path, with no redirect followed, a time limit and a size limit. The searches go out one at a
// time, one a second, so the engines behind SearXNG are asked politely too.

import { detectBoardFromUrl } from '@jobleft/boards';
import { canonicalizeUrl } from '@jobleft/crawler';
import { classifyUrl } from '@jobleft/sources-ats';
import type { CrawlAtsId, WebSearchBoard, WebSearchCheck, WebSearchRequest, WebSearchResponse, WebSearchResult } from '@jobleft/contracts';
import { ApiFailure } from '../errors.ts';
import { APP_VERSION } from '../version.ts';
import { NEVER, isLocalLink, storedId } from './external.ts';
import type { Store } from '@jobleft/crawler';

const USER_AGENT = `jobleft/${APP_VERSION} (+https://github.com/Blueturboguy07/jobleft; no personal data)`;
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 4 * 1024 * 1024;
const GAP_MS = 1000;
/** Results kept per search, after removing repeats. */
const MAX_RESULTS = 200;
/** A first page with this many results is followed by its second page (Yahoo answers 7 a page). */
const SECOND_PAGE_FROM = 5;

/**
 * The address to save: http(s), no user name or password, no query; a trailing "/search" or "/" is dropped. Blank
 * means off (null). Anything else is refused in plain words.
 */
export function normalizeSearxUrl(input: string | null | undefined): string | null {
  const t = (input ?? '').trim();
  if (!t) return null;
  let u: URL;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`); } catch {
    throw new ApiFailure('bad_request', 'That is not a web address. Type the address of your SearXNG, for example http://127.0.0.1:8888.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ApiFailure('bad_request', 'The SearXNG address must start with http:// or https://.');
  if (u.username || u.password) throw new ApiFailure('bad_request', 'jobleft does not keep a user name or password in the SearXNG address. Use an address without one.');
  const path = u.pathname.replace(/\/+$/, '').replace(/\/search$/i, '');
  return `${u.protocol}//${u.host}${path}`;
}

/**
 * The job sites jobleft never contacts, left out of the searches ("-site:"): their result pages are lists that only
 * open in a browser, and they crowd out the employers' own postings. Tested 2026-10-10: Yahoo through SearXNG keeps
 * to these exclusions; Google CSE answers nothing to them (so its results come from the searches without them).
 */
export const EXCLUDED_SITES = ['linkedin.com', 'indeed.com', 'glassdoor.com', 'glassdoor.nl'];

/** Hiring systems jobleft reads (Settings > Job sources follows their boards): kept for sortResult's board check. */
export const SITE_GROUPS: ReadonlyArray<readonly string[]> = [
  ['greenhouse.io', 'lever.co', 'jobs.ashbyhq.com', 'apply.workable.com'],
  ['recruitee.com', 'teamtailor.com', 'jobs.personio.de', 'jobs.personio.com'],
];

/** One search: its words, and the sites it asks for (null for a search without a site). */
export interface PlannedQuery { q: string; sites: readonly string[] | null }

/** The titles a search asks for: "SOC Analyst, Security Analyst" is either one (at most three). */
export function alternativesOf(q: string, max = 3): string[] {
  const seen = new Set<string>();
  return q.split(/\s*(?:,|;|\|| or | OF )\s*/i).map((x) => x.replace(/\s+/g, ' ').trim())
    .filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).slice(0, max);
}

/** The countries whose job postings say "vacature": Dutch words are added to the searches. */
const DUTCH = new Set(['NL', 'BE']);

/** English job words and how Dutch postings write them ("SOC analyst" -> "SOC analist"). */
const TO_DUTCH: Record<string, string> = {
  analyst: 'analist', analysts: 'analisten', developer: 'ontwikkelaar', developers: 'ontwikkelaars', consultant: 'adviseur',
  advisor: 'adviseur', adviser: 'adviseur', internship: 'stage', intern: 'stagiair', trainee: 'trainee', engineer: 'engineer',
  officer: 'officer', specialist: 'specialist', architect: 'architect', administrator: 'beheerder', 'system administrator': 'systeembeheerder',
  'network engineer': 'netwerkbeheerder', tester: 'tester', 'data analyst': 'data-analist', 'security analyst': 'security analist',
  'cyber security': 'cybersecurity', 'information security': 'informatiebeveiliging', 'project manager': 'projectleider', 'support': 'support',
};

/** The Dutch way of writing a job title, or null when it is the same ("Security Analyst" -> "Security Analist"). */
export function dutchTitle(title: string): string | null {
  let out = title;
  for (const [en, nl] of Object.entries(TO_DUTCH).sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`\\b${en}\\b`, 'gi'), nl);
  }
  return out.toLowerCase() === title.toLowerCase() ? null : out;
}

/**
 * The searches for one request, all on the open web: the job words (one title, or "a" OR "b"), the place, a word
 * that asks for job postings, and the big job sites left out. Three searches: in a Dutch-speaking country
 * "vacature", "job" and "werken bij"; elsewhere "job", "hiring" and "careers".
 */
export function planQueries(req: Pick<WebSearchRequest, 'q' | 'place'>, country: string | null = null, extraTitles: string[] = []): PlannedQuery[] {
  const alts = alternativesOf(req.q);
  const what = alts.length > 1 ? `(${alts.map((x) => `"${x}"`).join(' OR ')})` : (alts[0] ?? req.q.trim());
  const where = (req.place ?? '').replace(/\s+/g, ' ').trim();
  const not = EXCLUDED_SITES.map((h) => `-site:${h}`).join(' ');
  const q = (w: string, title = what) => ({ q: [title, w, where, not].filter(Boolean).join(' '), sites: null });
  if (country && DUTCH.has(country)) {
    // Dutch postings often write the title the Dutch way ("analist"): one search with that spelling.
    const nl = [...new Set(alts.map((a) => dutchTitle(a) ?? a))];
    const nlWhat = nl.length > 1 ? `(${nl.map((x) => `"${x}"`).join(' OR ')})` : nl[0] ?? what;
    return [q('vacature'), nlWhat !== what ? q('vacature', nlWhat) : q('werken bij'), q('job'), ...extra(q, 'vacature', extraTitles)];
  }
  return [...['job', 'hiring', 'careers'].map((w) => q(w)), ...extra(q, 'job', extraTitles)];
}

/**
 * The search for the titles the AI added (Widen with AI): one more search of its own, so the person's own searches
 * stay as they are (one long "a" OR "b" OR ... search makes the engines answer worse).
 */
function extra(q: (w: string, title?: string) => PlannedQuery, word: string, titles?: string[]): PlannedQuery[] {
  return titles?.length ? [q(word, `(${titles.slice(0, 5).map((x) => `"${x}"`).join(' OR ')})`)] : [];
}

/**
 * The same search on the big job sites, as plain links for the person's browser. jobleft builds the addresses and
 * never opens them itself.
 */
export function searchLinks(req: Pick<WebSearchRequest, 'q' | 'place'>, country: string | null): Array<{ name: string; url: string }> {
  const q = alternativesOf(req.q)[0] ?? req.q.trim();
  const place = (req.place ?? '').trim();
  const e = encodeURIComponent;
  const indeedHost = country === 'NL' ? 'nl.indeed.com' : country === 'BE' ? 'be.indeed.com' : country === 'DE' ? 'de.indeed.com' : country === 'GB' ? 'uk.indeed.com' : 'www.indeed.com';
  const links = [
    { name: 'LinkedIn', url: `https://www.linkedin.com/jobs/search/?keywords=${e(q)}${place ? `&location=${e(place)}` : ''}` },
    { name: 'Indeed', url: `https://${indeedHost}/jobs?q=${e(q)}${place ? `&l=${e(place)}` : ''}` },
    { name: 'Glassdoor', url: `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${e(q)}` },
    { name: 'Google job search', url: `https://www.google.com/search?q=${e([q, place, 'jobs'].filter(Boolean).join(' '))}&ibp=htl;jobs` },
  ];
  if (country === 'NL') links.push({ name: 'Werken voor Nederland', url: `https://www.werkenvoornederland.nl/vacatures?zoekterm=${e(q)}` });
  return links;
}

/** true when the host is the site or one of its sub-domains. */
export function onSite(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === site || h.endsWith(`.${site}`);
}

const JOB_PAGE = /vacature|vacancy|vacancies|\bjobs?\b|career|werken|werkenbij|position|opening|hiring|recruit|apply|sollicit|stage|traineeship|internship|werkstudent|stelle|emploi|empleo/i;

/**
 * A page from a search without a site is kept only when its address or title reads like a job or careers page: the
 * engines also answer with encyclopedia and news pages about the words ("SOC" finds what a SOC is).
 */
export function looksLikeJobPage(url: string, title: string): boolean {
  let path = url;
  try { const u = new URL(url); path = `${u.hostname}${u.pathname}`; } catch { /* the whole text */ }
  return JOB_PAGE.test(path.replace(/[-_/.]/g, ' ')) || JOB_PAGE.test(title);
}

export interface SearxResult { url: string; title: string; content: string; engines: string[]; publishedDate: string | null }
export interface SearxAnswer { results: SearxResult[]; unresponsive: string[] }

/** A failed SearXNG request, in words the person can act on. */
export class SearxError extends Error {
  readonly kind: 'json_off' | 'rate_limited' | 'unreachable' | 'timeout' | 'http' | 'not_searxng';
  constructor(kind: SearxError['kind'], message: string) {
    super(message);
    this.name = 'SearxError';
    this.kind = kind;
  }
}

export interface SearxOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  gapMs?: number;
  timeoutMs?: number;
}

/** Answers of the last 30 minutes, so the same search again (a tab switch, a second click) asks no engine. */
const CACHE = new Map<string, { at: number; answer: SearxAnswer }>();
const CACHE_MS = 30 * 60_000;

/** One SearXNG instance. Asks one search at a time, at least `gapMs` apart. */
export class SearxClient {
  readonly base: string;
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly gapMs: number;
  private readonly timeoutMs: number;
  private last = 0;

  constructor(base: string, o: SearxOptions = {}) {
    this.base = base;
    this.f = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
    this.gapMs = o.gapMs ?? GAP_MS;
    this.timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  }

  /** `fresh`: ask SearXNG even when the last 30 minutes have this answer (the Test button). */
  async search(q: string, o: { timeRange?: WebSearchRequest['timeRange']; page?: number; signal?: AbortSignal; fresh?: boolean } = {}): Promise<SearxAnswer> {
    const key = `${this.base}\n${q}\n${o.timeRange ?? ''}\n${o.page ?? 1}`;
    const hit = o.fresh ? undefined : CACHE.get(key);
    if (hit && hit.at + CACHE_MS > this.now()) return hit.answer;
    const answer = await this.ask(q, o);
    // Only answers with results are kept: an empty one may be an engine that was refusing for a while.
    if (answer.results.length) {
      CACHE.set(key, { at: this.now(), answer });
      if (CACHE.size > 200) CACHE.delete(CACHE.keys().next().value!);
    }
    return answer;
  }

  private async ask(q: string, o: { timeRange?: WebSearchRequest['timeRange']; page?: number; signal?: AbortSignal }): Promise<SearxAnswer> {
    const wait = this.last + this.gapMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.last = this.now();
    const params = new URLSearchParams({ q, format: 'json', safesearch: '0', pageno: String(o.page ?? 1) });
    if (o.timeRange) params.set('time_range', o.timeRange);
    const url = `${this.base}/search?${params}`;
    const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.f(url, { redirect: 'manual', signal, headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
    } catch (e) {
      if ((e as Error)?.name === 'TimeoutError') throw new SearxError('timeout', `SearXNG at ${this.base} did not answer within ${Math.round(this.timeoutMs / 1000)} seconds.`);
      if ((e as Error)?.name === 'AbortError') throw e;
      throw new SearxError('unreachable', `Nothing answered at ${this.base}. Check that SearXNG is running and that the address is right.`);
    }
    if (res.status === 403) throw new SearxError('json_off', 'SearXNG refused to answer in JSON. In its settings.yml, add json under search: formats (next to html), then restart SearXNG.');
    if (res.status === 429) throw new SearxError('rate_limited', 'SearXNG asked jobleft to slow down (its limiter is on). Turn the limiter off for your own instance, or wait a minute.');
    if (res.status >= 300 && res.status < 400) throw new SearxError('not_searxng', `${this.base} answered with a redirect. Use the address SearXNG itself shows, without redirects.`);
    if (res.status !== 200) throw new SearxError('http', `SearXNG answered HTTP ${res.status}.`);
    const text = await readCapped(res, MAX_BYTES);
    let j: any;
    try { j = JSON.parse(text); } catch { throw new SearxError('not_searxng', `${this.base} did not answer like SearXNG (no JSON). Check the address.`); }
    if (!j || typeof j !== 'object' || !Array.isArray(j.results)) throw new SearxError('not_searxng', `${this.base} did not answer like SearXNG (no results list). Check the address.`);
    const results: SearxResult[] = [];
    for (const r of j.results as any[]) {
      if (!r || typeof r.url !== 'string') continue;
      const engines = Array.isArray(r.engines) ? r.engines.filter((x: unknown) => typeof x === 'string') : typeof r.engine === 'string' ? [r.engine] : [];
      results.push({
        url: r.url, title: typeof r.title === 'string' ? r.title : '', content: typeof r.content === 'string' ? r.content : '', engines,
        publishedDate: typeof r.publishedDate === 'string' ? r.publishedDate : null,
      });
    }
    const unresponsive = Array.isArray(j.unresponsive_engines)
      ? j.unresponsive_engines.map((x: unknown) => (Array.isArray(x) ? String(x[0]) : String(x))).filter(Boolean)
      : [];
    return { results, unresponsive };
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new SearxError('http', 'SearXNG answered with more data than jobleft reads for one search.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One test search, of the kind jobleft sends: does the address answer like SearXNG, in JSON, and does at least one
 * engine keep to "site:"? (Tested 2026-10-10: Bing through SearXNG ignores it; Google CSE and Yahoo keep to it.)
 */
export async function checkSearx(base: string, o: SearxOptions = {}): Promise<WebSearchCheck> {
  const client = new SearxClient(base, o);
  const sites = SITE_GROUPS[0]!;
  try {
    const a = await client.search(`software engineer (${sites.map((h) => `site:${h}`).join(' OR ')})`, { fresh: true });
    const engines = [...new Set(a.results.flatMap((r) => r.engines))].sort();
    const siteEngines = [...new Set(a.results.filter((r) => {
      try { return sites.some((site) => onSite(new URL(r.url).hostname, site)); } catch { return false; }
    }).flatMap((r) => r.engines))].sort();
    const notAnswering = a.unresponsive.length ? ` Not answering right now: ${a.unresponsive.join(', ')}.` : '';
    if (!a.results.length) {
      return {
        ok: false, engines, unresponsive: a.unresponsive, results: 0, siteEngines,
        message: a.unresponsive.length
          ? `SearXNG answered, but no search engine gave results.${notAnswering} SearXNG pauses an engine that refuses it; wait a few minutes, or turn on other engines (yahoo, google cse) in its settings.yml.`
          : 'SearXNG answered, but the test search found nothing. Check that some engines are turned on in SearXNG.',
      };
    }
    if (!siteEngines.length) {
      return {
        ok: false, engines, unresponsive: a.unresponsive, results: a.results.length, siteEngines,
        message: `SearXNG works, but the engines that answered (${engines.join(', ')}) ignore "site:", which jobleft's searches use, so the results would be pages about the words rather than jobs.${notAnswering} Turn on yahoo or google cse in SearXNG's settings.yml, or wait for the paused engines.`,
      };
    }
    return {
      ok: true, engines, unresponsive: a.unresponsive, results: a.results.length, siteEngines,
      message: `Works: ${a.results.length} results; ${siteEngines.join(', ')} kept to the job sites.${notAnswering}`,
    };
  } catch (e) {
    if (e instanceof SearxError) return { ok: false, engines: [], unresponsive: [], results: 0, siteEngines: [], message: e.message };
    throw e;
  }
}

function hostOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, '');
}

function isoOrNull(v: string | null): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const LIST_TITLE = /^\s*\d[\d.,]*\+?\s|\b\d[\d.,]*\+?\s+(?:[\w-]+\s+){0,4}(?:vacatures|jobs|banen|vacancies|openings|stellen)\b|\b(?:jobs|vacatures|banen|vacancies)\s+(?:in|voor|for)\b/i;
const LIST_PATH = /\/(?:q-|search|zoeken|vacatures\/functie\b|vacatures-|jobs-for-|[\w-]*-jobs-[\w-]*\/?$)/i;

/**
 * true for a page that lists many jobs (a job site's search page: "44 security analyst vacatures", "SOC Analyst
 * jobs in Netherlands"), not one posting. Adding it as a job would make a wrong job, so it is only opened.
 */
export function looksLikeJobList(url: string, title: string): boolean {
  if (LIST_TITLE.test(title)) return true;
  try { return LIST_PATH.test(new URL(url).pathname); } catch { return false; }
}

/** The domains of the systems jobleft reads (their own sites: help, blog, product pages). */
const VENDOR = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|recruitee\.com|personio\.(de|com)|teamtailor\.com|gem\.com)$/i;

export interface SortDeps {
  crawlStore: Store;
  /** The board in the person's list, when it is there. */
  board: (id: string) => { company: string; followed: boolean } | null;
}

/** What jobleft may do with one result, or null to drop it (not a web link, or a local address). */
export function sortResult(r: SearxResult, d: SortDeps): WebSearchResult | null {
  let u: URL;
  try { u = new URL(r.url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (isLocalLink(u)) return null;
  const c = classifyUrl(u.href);
  if (c.verdict === 'invalid') return null;
  const base = {
    url: u.href, title: r.title.trim() || hostOf(u), snippet: r.content.trim().slice(0, 600), host: hostOf(u),
    publishedAt: isoOrNull(r.publishedDate), engines: r.engines,
  };
  const none = { ats: null, board: null, region: null, boardId: null, jobId: null, note: null };
  if (c.verdict === 'never' || c.verdict === 'not_crawled' || NEVER.test(u.hostname)) {
    return { ...base, ...none, kind: 'never', note: c.verdict === 'never' || c.verdict === 'not_crawled' ? c.message : `jobleft never reads ${hostOf(u)}. Nothing was sent to it.` };
  }
  const canonical = canonicalizeUrl(u.href);
  const sameUrl = canonical
    ? d.crawlStore.db.prepare('SELECT ats, board, job_id FROM jobs WHERE canonical_url = ? ORDER BY closed_at IS NOT NULL, id LIMIT 1').get(canonical) as { ats: string; board: string; job_id: string } | undefined
    : undefined;
  const known = sameUrl ? `${sameUrl.ats.toLowerCase()}:${sameUrl.board.toLowerCase()}:${sameUrl.job_id}` : null;
  // The board list's own detector first: it knows board names that the other one refuses ("mistral.ai" on Ashby).
  const own = detectBoardFromUrl(u.href);
  // A hiring system's own site that is not an employer's board (its help pages, blog, home page): never a job.
  if (own.kind === 'provider_home' || (!(c.verdict === 'crawlable' && c.detection?.board) && own.kind !== 'board' && VENDOR.test(u.hostname))) return null;
  const det = own.kind === 'board'
    ? { ats: own.found.ats, board: own.found.board, region: own.found.region, jobId: own.found.jobId }
    : c.verdict === 'crawlable' && c.detection?.board ? { ats: c.detection.ats as CrawlAtsId, board: c.detection.board, region: c.detection.region, jobId: c.detection.jobId } : null;
  if (det) {
    const ats = det.ats;
    const board = det.board.toLowerCase();
    const region = det.region ?? null;
    const boardId = region ? `${ats}:${region.toLowerCase()}:${board}` : `${ats}:${board}`;
    const jobId = known ?? (det.jobId ? storedId(d.crawlStore, ats, board, det.jobId) : null);
    return { ...base, kind: det.jobId ? 'board_job' : 'board', ats, board, region, boardId, jobId, note: null };
  }
  return { ...base, ...none, kind: !known && looksLikeJobList(u.href, base.title) ? 'list' : 'page', jobId: known };
}

/** Runs the planned searches, then sorts, de-duplicates and counts the boards. */
export interface WebSearchOptions {
  signal?: AbortSignal;
  /** Told each search as it is sent (the assistant shows it). */
  onQuery?: (q: string) => void;
  /** The country the place names, when known. */
  country?: string | null;
  /** The words as they are, once (the assistant's question about pay, a company, a field). */
  general?: boolean;
  /** Titles the AI added: one more search of their own. */
  extraTitles?: string[];
  /**
   * The words of the titles searched for: a result whose title and text name none of them is left out (engines
   * answer long searches with pages about anything). Not for a general search.
   */
  words?: string[];
}

/**
 * Runs the planned searches, then sorts, de-duplicates and counts. Page n of results is the engines' pages 2n-1
 * and 2n: the second only for searches whose first page was full (at most six requests a page).
 */
export async function webSearchJobs(req: WebSearchRequest, client: SearxClient, d: SortDeps, o: WebSearchOptions = {}): Promise<WebSearchResponse> {
  const { signal, onQuery, general = false } = o;
  const country = o.country ?? null;
  const queries = general ? [{ q: [req.q, req.place ?? ''].join(' ').replace(/\s+/g, ' ').trim(), sites: null }] : planQueries(req, country, o.extraTitles ?? []);
  const boardUrls = new Set<string>();
  let unrelated = 0;
  const related = (r: SearxResult) => {
    if (general || !o.words?.length) return true;
    const t = `${r.title} ${r.content}`.toLowerCase();
    return o.words.some((w) => (w.length <= 3 ? new RegExp(`(^|[^\\p{L}\\p{N}])${w}($|[^\\p{L}\\p{N}])`, 'u').test(t) : t.includes(w.slice(0, Math.max(4, w.length - 2)))));
  };
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  const unresponsive = new Set<string>();
  let failed = 0;
  let firstError: SearxError | null = null;
  let fatal = false;
  const page = req.page ?? 1;
  const passes: Array<{ pq: PlannedQuery; enginePage: number }> = queries.map((pq) => ({ pq, enginePage: page * 2 - 1 }));
  for (let i = 0; i < passes.length; i++) {
    const { pq, enginePage } = passes[i]!;
    // After the first pages: the second page of each search whose first page was full.
    if (signal?.aborted) break;
    let a: SearxAnswer;
    onQuery?.(enginePage % 2 === 0 ? `${pq.q} (more)` : pq.q);
    try { a = await client.search(pq.q, { timeRange: req.timeRange, page: enginePage, signal }); } catch (e) {
      if (!(e instanceof SearxError)) throw e;
      failed++;
      firstError ??= e;
      // Nothing will work after these: stop rather than ask again.
      if (e.kind === 'unreachable' || e.kind === 'json_off' || e.kind === 'not_searxng') { fatal = true; break; }
      continue;
    }
    for (const n of a.unresponsive) unresponsive.add(n);
    // A full first page: its second page is asked after the first pages of all searches.
    if (!general && enginePage % 2 === 1 && a.results.length >= SECOND_PAGE_FROM) passes.push({ pq, enginePage: enginePage + 1 });
    for (const r of a.results) {
      const s = sortResult(r, d);
      if (!s) continue;
      if (!related(r)) { if (!seen.has(canonicalizeUrl(s.url) || s.url)) { seen.add(canonicalizeUrl(s.url) || s.url); unrelated++; } continue; }
      // Some engines ignore "site:" and answer with any page: a site search keeps only results on that site.
      if (pq.sites && !pq.sites.some((site) => onSite(new URL(s.url).hostname, site))) continue;
      // A board on a system jobleft reads is followed in Settings > Job sources, not listed here.
      if (s.kind === 'board' || s.kind === 'board_job') { boardUrls.add(canonicalizeUrl(s.url) || s.url); continue; }
      const key = canonicalizeUrl(s.url) || s.url;
      if (seen.has(key)) {
        const prev = results.find((x) => (canonicalizeUrl(x.url) || x.url) === key);
        if (prev) for (const en of s.engines) if (!prev.engines.includes(en)) prev.engines.push(en);
        continue;
      }
      seen.add(key);
      if (results.length < MAX_RESULTS) results.push(s);
    }
  }
  // No search answered: say why, instead of "found nothing".
  if (firstError && !results.length && (fatal || failed === passes.length)) {
    throw new ApiFailure(firstError.kind === 'unreachable' || firstError.kind === 'timeout' ? 'offline' : 'unsupported_source', firstError.message);
  }
  const counts = new Map<string, WebSearchBoard>();
  for (const r of results) {
    if (!r.boardId || !r.ats || !r.board) continue;
    const b = counts.get(r.boardId);
    if (b) { b.results++; continue; }
    const mine = d.board(r.boardId);
    counts.set(r.boardId, { boardId: r.boardId, ats: r.ats, board: r.board, region: r.region, company: mine?.company ?? null, results: 1, added: !!mine, followed: mine?.followed ?? false });
  }
  const order: Record<WebSearchResult['kind'], number> = { board_job: 0, page: 1, board: 2, list: 3, never: 4 };
  results.sort((a, b) => order[a.kind] - order[b.kind]);
  const boards = [...counts.values()].sort((a, b) => Number(a.added) - Number(b.added) || b.results - a.results);
  const sites = new Set(results.map((r) => r.host)).size;
  const message = !results.length
    ? unresponsive.size
      ? `The search found nothing, and some search engines did not answer (${[...unresponsive].sort().join(', ')}). SearXNG pauses an engine that refuses it; try again in a few minutes, or turn on other engines in SearXNG.`
      : 'The search found nothing. Try fewer or other words, or a wider place.'
    : `${results.length} results from ${sites} ${sites === 1 ? 'site' : 'sites'}.${unrelated ? ` ${unrelated} unrelated ${unrelated === 1 ? 'page' : 'pages'} left out.` : ''}${failed ? ` ${failed} of ${passes.length} searches failed${firstError ? ` (${firstError.message})` : ''}.` : ''}`;
  return { results, boards, queries: passes.length, failedQueries: failed, unresponsive: [...unresponsive].sort(), message, country, boardResults: boardUrls.size, searchLinks: searchLinks(req, country), ...(unrelated ? { unrelatedResults: unrelated } : {}) };
}
