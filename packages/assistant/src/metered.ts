// The metered page fetch and web search CLIENT for the future publik routes (research 06, part E.2):
//   POST <publik>/search { query, max_results, quality, include_domains?, exclude_domains?, recency? }
//        -> { results: [{ title, url, snippet, published_at, host }] }
//   POST <publik>/fetch  { url, render: "never"|"always", format: "markdown"|"text", max_chars }
//        -> { url, final_url, target_status, content_type, content, truncated, rendered }
// (the upstreams behind those routes are Parallel, with Tavily as failover; the app never sees them).
// The routes do not exist yet (gate G-publik). This client is tested against local stand-ins only, and it sends nothing
// to a non-loopback address unless the engine's own gate lets a publik key through (JOBLEFT_PUBLIK_ALLOW_LIVE).
//
// Rules this client keeps (O13):
//   * OFF by default. Every call first asks `enabled()` and sends nothing while it is false.
//   * It never runs by itself: no timer, no retry, no loop. One call is at most one request. A failed call is never sent again.
//   * The price is stated before the call; a call above the price limit the caller gives is refused before any request.
//   * URLs are checked BEFORE the request (urlsafe.ts) and the final address again after the answer; content from a
//     blocked final host is dropped. Search results with a blocked host are dropped.
//   * A search query is a company name, a job title or a public link. Text that looks like personal data is refused.
//   * A charge is what publik reports (x-publik-charge-micros). No header means "unknown", never an estimate.
//   * Money is "balance" in dollars in every message; never "credits".

import { formatDollars } from '@jobleft/contracts';
import { dailyResetFrom, publikDailyLimitText } from '@jobleft/ai-engine';
import { checkUrl, blockedReason, looksLikeIp } from './urlsafe.ts';

/** Prices per request in micros (docs/research/06-metered-scrape.md E.3): page $2, JS page $4, search $5, deep search $8 per 1,000. */
export const METERED_PRICES = { page: 2_000, pageJs: 4_000, search: 5_000, searchDeep: 8_000 } as const;

export type MeteredKind = 'page' | 'page_js' | 'search' | 'search_deep';
export type MeteredErrorCode =
  | 'off' | 'not_connected' | 'price_cap' | 'unsafe_url' | 'unsafe_query' | 'insufficient_balance' | 'not_available' | 'refused_by_publik'
  | 'provider_error' | 'timeout' | 'cancelled' | 'bad_answer';

export class MeteredError extends Error {
  readonly code: MeteredErrorCode;
  /** At most one link (the top-up link for insufficient_balance). */
  readonly link: { label: string; url: string } | null;
  /** true = the person can use their own provider key instead (the offer the app makes when the paid route is not available). */
  readonly offerOwnKey: boolean;
  constructor(code: MeteredErrorCode, message: string, opts: { link?: { label: string; url: string } | null; offerOwnKey?: boolean } = {}) {
    super(message);
    this.name = 'MeteredError';
    this.code = code;
    this.link = opts.link ?? null;
    this.offerOwnKey = opts.offerOwnKey ?? false;
  }
}

export interface MeteredDeps {
  /** The feature flag. OFF until the person turns it on (AiSettings.meteredFetch.enabled). */
  enabled: () => boolean;
  /** The publik gateway key and address, or null when publik is not connected. */
  gateway: () => Promise<{ key: string; baseUrl: string } | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface PageResult {
  url: string;
  finalUrl: string;
  /** false = the target site did not give a page (nothing is charged for that). */
  fetched: boolean;
  status: number | null;
  contentType: string | null;
  content: string;
  truncated: boolean;
  rendered: boolean;
  /** What publik charged, in micros; null = publik did not say. */
  costMicros: number | null;
}

export interface SearchResult {
  results: Array<{ title: string; url: string; snippet: string; publishedAt: string | null; host: string }>;
  dropped: number;
  costMicros: number | null;
}

/** "$0.005", never rounded to a cent, so a small price is not shown as $0.00. */
export function priceText(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(micros % 10_000 === 0 ? 2 : 3)}`;
}

export function quote(kind: MeteredKind): { micros: number; text: string } {
  const micros = kind === 'page' ? METERED_PRICES.page : kind === 'page_js' ? METERED_PRICES.pageJs : kind === 'search' ? METERED_PRICES.search : METERED_PRICES.searchDeep;
  const noun = kind.startsWith('search') ? 'search' : 'page';
  return { micros, text: `${priceText(micros)} for one ${noun}${kind === 'page_js' ? ' read with a browser' : ''} (${formatDollars(micros * 1000)} per 1,000), paid from your publik balance` };
}

const PERSONAL = /[\w.+-]+@[\w-]+\.[\w.-]+|\b\d{3}[-. )]{1,2}\d{3}[-. ]\d{4}\b|\b(resume|curriculum vitae)\b/i;

/** The query rule: company names, titles and public links only. Refuses personal data and long text. */
export function checkQuery(q: string): string | null {
  const t = q.trim();
  if (!t) return 'The search is empty.';
  if (t.length > 400) return 'A search can be at most 400 characters. Use a company name and a job title.';
  if (PERSONAL.test(t)) return 'A search never carries an email address, a phone number or resume text. Use a company name and a job title.';
  for (const m of t.matchAll(/site:([^\s]+)/gi)) {
    const h = m[1]!.toLowerCase();
    if (blockedReason(h) || looksLikeIp(h)) return `jobleft does not search ${h}.`;
  }
  return null;
}

function costFrom(headers: Headers, body: Record<string, unknown>): number | null {
  const h = headers.get('x-publik-charge-micros');
  if (h !== null && /^\d+$/.test(h)) return Number(h);
  const v = body.cost_micros;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

export function createMeteredClient(deps: MeteredDeps) {
  const f = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 60_000;

  const OWN_KEY_OFFER = 'You can also use your own provider key: choose it in Settings, then jobleft asks that provider directly.';

  async function guardAndCall(path: '/fetch' | '/search', body: Record<string, unknown>, price: number, maxPriceMicros: number, signal?: AbortSignal): Promise<{ data: Record<string, unknown>; costMicros: number | null }> {
    if (!deps.enabled()) {
      throw new MeteredError('off', `Paid page fetch and web search are off. A page costs ${priceText(METERED_PRICES.page)} and a search ${priceText(METERED_PRICES.search)}, paid from your publik balance. Turn them on in Settings to use them. ${OWN_KEY_OFFER}`, { offerOwnKey: true });
    }
    if (price > maxPriceMicros) throw new MeteredError('price_cap', `This costs ${priceText(price)}, which is above the limit of ${priceText(maxPriceMicros)}. Nothing was sent.`);
    const gw = await deps.gateway();
    if (!gw) throw new MeteredError('not_connected', `The paid route needs publik. Connect publik in Settings. ${OWN_KEY_OFFER}`, { offerOwnKey: true });
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    let res: Response;
    try {
      // Exactly one request. Never repeated: a second attempt could be charged a second time.
      res = await f(`${gw.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${gw.key}` },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      const name = (e as Error)?.name ?? '';
      if (name === 'TimeoutError') throw new MeteredError('timeout', `The paid route did not answer within ${Math.round(timeoutMs / 1000)} seconds. It was not tried again. ${OWN_KEY_OFFER}`, { offerOwnKey: true });
      if (name === 'AbortError') throw new MeteredError('cancelled', 'The paid request was cancelled.');
      throw new MeteredError('not_available', `The paid route could not be reached. Free features still work. ${OWN_KEY_OFFER}`, { offerOwnKey: true });
    }
    const raw = await res.text().catch(() => '');
    let data: Record<string, unknown> = {};
    try { const v = JSON.parse(raw); if (v && typeof v === 'object' && !Array.isArray(v)) data = v as Record<string, unknown>; } catch { /* handled below */ }
    if (res.status === 402) {
      const err = (data.error && typeof data.error === 'object' ? data.error : {}) as Record<string, unknown>;
      const link = typeof err.top_up_url === 'string' && /^https?:\/\//.test(err.top_up_url) ? err.top_up_url : null;
      throw new MeteredError('insufficient_balance', 'Your publik balance is too low for this request. Nothing was charged. Add to your balance, then ask again.', { link: link ? { label: 'Add money', url: link } : null });
    }
    if (res.status === 404 || res.status === 403 && String((data.error as Record<string, unknown> | undefined)?.type ?? '') === 'route_not_enabled') {
      throw new MeteredError('not_available', `The paid route is not available yet. Free features still work. ${OWN_KEY_OFFER}`, { offerOwnKey: true });
    }
    if (res.status === 400 || res.status === 403) {
      const t = String((data.error as Record<string, unknown> | undefined)?.type ?? '');
      throw new MeteredError('refused_by_publik', t === 'host_blocked' || t === 'url_not_allowed' || t === 'robots_disallowed' ? 'The paid route refused this page. Nothing was charged.' : 'The paid route refused this request. Nothing was charged.');
    }
    if (res.status === 429) {
      const err = (data.error && typeof data.error === 'object' ? data.error : {}) as Record<string, unknown>;
      if (String(err.type ?? '') === 'daily_cap_reached') {
        // The same words as every other AI step (JL-network-19).
        const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
        throw new MeteredError('not_available', publikDailyLimitText({
          capMicros: n(err.daily_cap_micros), usedMicros: n(err.spent_today_micros), resetsAt: dailyResetFrom(err.resets_at, res.headers.get('retry-after')),
          claimState: err.claim_state === 'anonymous' ? 'anonymous' : 'claimed',
        }));
      }
      throw new MeteredError('not_available', 'The paid route is busy. Nothing was charged. Try again later.');
    }
    if (res.status >= 500) throw new MeteredError('provider_error', `The paid route failed (HTTP ${res.status}). Nothing was charged. It was not tried again. ${OWN_KEY_OFFER}`, { offerOwnKey: true });
    if (!res.ok || !Object.keys(data).length) throw new MeteredError('bad_answer', 'The paid route sent an answer jobleft cannot use.');
    return { data, costMicros: costFrom(res.headers, data) };
  }

  return {
    get enabled() { return deps.enabled(); },
    prices() { return { ...METERED_PRICES }; },
    quote,

    /** Reads one page through the paid route. Call the free reader first (fetchfree.ts); this is for pages it could not read. */
    async fetchPage(input: { url: string; render?: boolean; format?: 'markdown' | 'text'; maxChars?: number; maxPriceMicros: number; signal?: AbortSignal }): Promise<PageResult> {
      const render = input.render === true;
      const price = render ? METERED_PRICES.pageJs : METERED_PRICES.page;
      // Order matters: the flag and the price limit are checked before the address is even looked at? No: an unsafe
      // address is refused first, because nothing about it may leave this computer in any case.
      const chk = checkUrl(input.url);
      if (!chk.ok) throw new MeteredError('unsafe_url', `${chk.message} Nothing was sent.`);
      const maxChars = Math.min(Math.max(1000, input.maxChars ?? 50_000), 250_000);
      const { data, costMicros } = await guardAndCall('/fetch', { url: chk.url.toString(), render: render ? 'always' : 'never', format: input.format ?? 'markdown', max_chars: maxChars }, price, input.maxPriceMicros, input.signal);
      const content0 = typeof data.content === 'string' ? data.content : typeof data.html === 'string' ? data.html : null;
      if (content0 === null && data.fetched !== false) throw new MeteredError('bad_answer', 'The paid route sent an answer jobleft cannot use.');
      const finalRaw = typeof data.final_url === 'string' ? data.final_url : typeof data.url === 'string' ? data.url : chk.url.toString();
      const fin = checkUrl(finalRaw);
      const status = typeof data.target_status === 'number' ? data.target_status : null;
      const fetched = data.fetched !== false && (status === null || (status >= 200 && status < 300)) && content0 !== null;
      // A blocked or unsafe final address (a redirect): the content is dropped.
      if (!fin.ok) return { url: chk.url.toString(), finalUrl: '', fetched: false, status, contentType: null, content: '', truncated: false, rendered: render, costMicros };
      const content = fetched ? (content0 as string).slice(0, maxChars) : '';
      return {
        url: chk.url.toString(), finalUrl: fin.url.toString(), fetched, status,
        contentType: typeof data.content_type === 'string' ? data.content_type : null,
        content, truncated: data.truncated === true || (content0 !== null && content0.length > maxChars),
        rendered: data.rendered === true || render, costMicros,
      };
    },

    /** Searches the web through the paid route. Results whose address is blocked or unsafe are dropped. */
    async search(input: { query: string; maxResults?: number; quality?: 'fast' | 'deep'; includeDomains?: string[]; excludeDomains?: string[]; recency?: 'day' | 'week' | 'month' | 'year'; maxPriceMicros: number; signal?: AbortSignal }): Promise<SearchResult> {
      const bad = checkQuery(input.query);
      if (bad) throw new MeteredError('unsafe_query', `${bad} Nothing was sent.`);
      for (const d of input.includeDomains ?? []) {
        if (blockedReason(d.toLowerCase()) || looksLikeIp(d)) throw new MeteredError('unsafe_query', `jobleft does not search ${d}. Nothing was sent.`);
      }
      const deep = input.quality === 'deep';
      const price = deep ? METERED_PRICES.searchDeep : METERED_PRICES.search;
      const body: Record<string, unknown> = { query: input.query.trim(), max_results: Math.min(Math.max(1, input.maxResults ?? 5), 10), quality: deep ? 'deep' : 'fast' };
      if (input.includeDomains?.length) body.include_domains = input.includeDomains.slice(0, 10);
      if (input.excludeDomains?.length) body.exclude_domains = input.excludeDomains.slice(0, 10);
      if (input.recency) body.recency = input.recency;
      const { data, costMicros } = await guardAndCall('/search', body, price, input.maxPriceMicros, input.signal);
      if (!Array.isArray(data.results)) throw new MeteredError('bad_answer', 'The paid route sent an answer jobleft cannot use.');
      let dropped = 0;
      const results: SearchResult['results'] = [];
      for (const r0 of data.results as unknown[]) {
        const r = (r0 && typeof r0 === 'object' ? r0 : {}) as Record<string, unknown>;
        const chk = typeof r.url === 'string' ? checkUrl(r.url) : null;
        if (!chk || !chk.ok) { dropped++; continue; }
        results.push({
          title: typeof r.title === 'string' ? r.title.slice(0, 300) : '',
          url: chk.url.toString(),
          snippet: typeof r.snippet === 'string' ? r.snippet.slice(0, 600) : '',
          publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
          host: chk.host,
        });
      }
      return { results, dropped, costMicros };
    },
  };
}

export type MeteredClient = ReturnType<typeof createMeteredClient>;
