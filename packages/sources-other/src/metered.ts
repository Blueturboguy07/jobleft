// The metered page fetch and web search client (paid, through publik or the person's own provider key).
// OFF until the person turns it on: every call checks `enabled()` first and sends nothing while it is false
// (ai-engine O15). Each call states its price first: a call whose price is above `maxPriceMicros` is refused.
// The publik routes do not exist yet (gate G-publik); this client speaks the planned shape to
// JOBLEFT_PUBLIK_BASE_URL (tests point it at a loopback stand-in):
//   POST <base>/fetch  { url, render_js, max_price_micros }  ->  { url, html, cost_micros }
//   POST <base>/search { query, max_price_micros }           ->  { results: [{ title, url, snippet }], cost_micros }
// Money is "balance" in dollars in every message; never "credits".

import { formatDollars } from '@jobleft/contracts';
import { NEVER_CRAWL } from './http.ts';
import { safeHttpUrl } from './text.ts';

/** Proposed publik prices per request, in micros: search $5, plain page $2, JS page $4 per 1,000 (plan spike S4). */
export const METERED_PRICES_MICROS = { search: 5_000, page: 2_000, jsPage: 4_000 } as const;

export type MeteredErrorCode = 'off' | 'price_cap' | 'no_key' | 'insufficient_balance' | 'forbidden_source' | 'provider_error' | 'provider_timeout' | 'bad_answer';

export class MeteredFetchError extends Error {
  readonly code: MeteredErrorCode;
  readonly link: string | null;
  constructor(code: MeteredErrorCode, message: string, link: string | null = null) {
    super(message);
    this.name = 'MeteredFetchError';
    this.code = code;
    this.link = link;
  }
}

/** Paid page fetch and web search. Each call states its price first; nothing runs while `enabled` is false. */
export interface MeteredFetchClient {
  readonly enabled: boolean;
  /** Prices per request in micros (publik list: search, plain page, JS page). */
  prices(): { search: number; page: number; jsPage: number };
  fetchPage(url: string, opts: { js: boolean; maxPriceMicros: number; signal?: AbortSignal }): Promise<{ url: string; html: string; costMicros: number }>;
  search(query: string, opts: { maxPriceMicros: number; signal?: AbortSignal }): Promise<{ results: Array<{ title: string; url: string; snippet: string }>; costMicros: number }>;
}

function per1000(micros: number): string {
  return `${formatDollars(micros * 1000)} per 1,000`;
}

/** The metered client. It refuses every call until the person turns metered fetch on (ai-engine O15). */
export function createMeteredFetchClient(opts: {
  enabled: () => boolean;
  baseUrl: string;
  key: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): MeteredFetchClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 60_000;

  async function call(path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const key = (await opts.key())?.trim();
    if (!key) throw new MeteredFetchError('no_key', 'Paid fetch needs publik or your own provider key. Connect one in Settings first.');
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      const name = (e as Error)?.name ?? '';
      if (name === 'TimeoutError') throw new MeteredFetchError('provider_timeout', `The paid fetch service did not answer within ${Math.round(timeoutMs / 1000)} seconds. Nothing was charged for this call by jobleft.`);
      throw new MeteredFetchError('provider_error', 'Could not reach the paid fetch service.');
    }
    const text = await res.text().catch(() => '');
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* handled below */ }
    if (res.status === 402) {
      const link = typeof (data.error as Record<string, unknown> | undefined)?.link === 'string' ? (data.error as Record<string, string>).link! : null;
      throw new MeteredFetchError('insufficient_balance', 'Your publik balance is too low for this request. Add to your balance to continue.', link);
    }
    if (!res.ok) throw new MeteredFetchError('provider_error', `The paid fetch service answered HTTP ${res.status}.`);
    return data;
  }

  const cost = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback);

  return {
    get enabled() { return opts.enabled(); },
    prices() { return { ...METERED_PRICES_MICROS }; },
    async fetchPage(url, o) {
      const price = o.js ? METERED_PRICES_MICROS.jsPage : METERED_PRICES_MICROS.page;
      if (!opts.enabled()) {
        throw new MeteredFetchError('off', `Paid page fetch is off. It costs ${per1000(METERED_PRICES_MICROS.page)} pages (${per1000(METERED_PRICES_MICROS.jsPage)} with a browser), paid from your balance. Turn it on in Settings to use it.`);
      }
      if (price > o.maxPriceMicros) throw new MeteredFetchError('price_cap', `This page costs ${formatDollars(price)}, which is above the limit you set.`);
      const clean = safeHttpUrl(url);
      if (!clean) throw new MeteredFetchError('forbidden_source', 'That is not a web link.');
      const host = new URL(clean).hostname;
      if (NEVER_CRAWL.test(host)) throw new MeteredFetchError('forbidden_source', `jobleft never reads pages on ${host}, paid or free.`);
      const data = await call('/fetch', { url: clean, render_js: o.js, max_price_micros: o.maxPriceMicros }, o.signal);
      const html = typeof data.html === 'string' ? data.html : null;
      if (html === null) throw new MeteredFetchError('bad_answer', 'The paid fetch service sent an answer jobleft cannot use.');
      return { url: safeHttpUrl(data.url) ?? clean, html, costMicros: cost(data.cost_micros, price) };
    },
    async search(query, o) {
      const price = METERED_PRICES_MICROS.search;
      if (!opts.enabled()) throw new MeteredFetchError('off', `Paid web search is off. It costs ${per1000(price)} searches, paid from your balance. Turn it on in Settings to use it.`);
      if (price > o.maxPriceMicros) throw new MeteredFetchError('price_cap', `A search costs ${formatDollars(price)}, which is above the limit you set.`);
      const q = query.trim();
      if (!q) throw new MeteredFetchError('bad_answer', 'The search is empty.');
      const data = await call('/search', { query: q.slice(0, 500), max_price_micros: o.maxPriceMicros }, o.signal);
      const list = Array.isArray(data.results) ? data.results : null;
      if (!list) throw new MeteredFetchError('bad_answer', 'The paid search service sent an answer jobleft cannot use.');
      const results = list.map((r) => r as Record<string, unknown>)
        .map((r) => ({ title: typeof r.title === 'string' ? r.title : '', url: safeHttpUrl(r.url) ?? '', snippet: typeof r.snippet === 'string' ? r.snippet : '' }))
        .filter((r) => r.url && !NEVER_CRAWL.test(new URL(r.url).hostname));
      return { results, costMicros: cost(data.cost_micros, price) };
    },
  };
}
