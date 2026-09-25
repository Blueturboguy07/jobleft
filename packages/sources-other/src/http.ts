// FeedClient: the only code in this package that sends a request. For every request it enforces:
//   * an allow-list: a feed reaches only its own hosts (sources-other O11); anything else is refused before sending
//   * the never-crawl list (LinkedIn, Indeed, Glassdoor, SmartRecruiters, Workday, iCIMS, Oracle, UKG, Taleo)
//   * JOBLEFT_OFFLINE=1: nothing is sent at all
//   * robots.txt per host (RFC 9309 via the crawler's parser): 5xx or network failure = disallow for the run
//   * a pacer shared by every feed and every process: at least 1 second between requests to one host, more when
//     Crawl-delay asks (DbPacer keeps the slots in SQLite, so two app processes cannot double the rate)
//   * a request budget for the run (the source's daily limit); robots.txt and retries count
//   * the fixed jobleft User-Agent (only USAJOBS may replace it with the registered email, on its own host)
//   * no redirects: a 3xx is an error, never followed (a redirect cannot lead to a forbidden host)
//   * a timeout per request, so a source that never answers cannot hold the refresh
//   * redaction: error texts carry the host and path only, never a query string, a key or an email
// A host map (JOBLEFT_HOST_MAP, loopback targets only) sends a real host to a local stand-in for tests.

import type { DatabaseSync } from 'node:sqlite';
import { ALLOW_ALL, DISALLOW_ALL, PRODUCT_TOKEN, USER_AGENT, checkHostMap, parseRobots } from '@jobleft/crawler';
import type { RobotsRules } from '@jobleft/crawler';
import type { FeedHttp, FeedRequestOptions, FeedResponse } from './types.ts';

/** Hosts jobleft never contacts, also as redirect targets (docs/INTERFACES.md section 10). */
export const NEVER_CRAWL = /(^|\.)(linkedin\.com|licdn\.com|indeed\.com|glassdoor\.com|smartrecruiters\.com|myworkdayjobs\.com|myworkdaysite\.com|workday\.com|icims\.com|oraclecloud\.com|taleo\.net|ultipro\.com|ukg\.com|ukg\.net)$/i;

export type FeedErrorCode =
  | 'offline' | 'forbidden_host' | 'never_crawl' | 'robots' | 'timeout' | 'network' | 'http' | 'key_refused'
  | 'blocked' | 'rate_limited' | 'redirect' | 'budget' | 'too_large' | 'not_json' | 'web_page' | 'cut_off'
  | 'shape' | 'cancelled' | 'not_found';

/** Every feed failure, with a short plain reason that never holds a key, an email or a query string. */
export class FeedError extends Error {
  readonly code: FeedErrorCode;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  constructor(code: FeedErrorCode, message: string, opts: { status?: number | null; retryAfterSeconds?: number | null } = {}) {
    super(message);
    this.name = 'FeedError';
    this.code = code;
    this.status = opts.status ?? null;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
  }
}

/** A feed answer whose shape changed (renamed fields, a missing list, rows without titles). */
export function shapeError(detail: string): FeedError {
  return new FeedError('shape', `the data format changed: ${detail}`);
}

/**
 * The smallest gap between two requests to one host. 1 second is the rule; the extra 100 ms absorbs connection setup
 * and timer jitter, so the gap a server observes is never under 1 second either.
 */
export const MIN_GAP_MS = 1100;

/** Spaces requests to one host. Pacing uses real time, never the app clock. */
export interface HostPacer {
  wait(host: string, gapMs: number, signal?: AbortSignal): Promise<void>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new FeedError('cancelled', 'the refresh was cancelled')); };
    if (signal?.aborted) { clearTimeout(t); reject(new FeedError('cancelled', 'the refresh was cancelled')); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** In-process pacer (tests, one-off tools). */
export class MemoryPacer implements HostPacer {
  private next = new Map<string, number>();
  async wait(host: string, gapMs: number, signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, start + Math.max(MIN_GAP_MS, gapMs));
    await sleep(start - now, signal);
  }
}

/**
 * Pacer whose slots live in SQLite (`source_host_slots`), so every process that opens the same data folder shares
 * them: two windows or a CLI next to the app still send at most 1 request a second to a host.
 */
export class DbPacer implements HostPacer {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  async wait(host: string, gapMs: number, signal?: AbortSignal): Promise<void> {
    const gap = Math.max(MIN_GAP_MS, gapMs);
    let start = 0;
    let now = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          now = Date.now();
          const row = this.db.prepare('SELECT next_at_ms FROM source_host_slots WHERE host = ?').get(host) as { next_at_ms: number } | undefined;
          start = Math.max(now, Number(row?.next_at_ms ?? 0));
          this.db.prepare('INSERT INTO source_host_slots (host, next_at_ms) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET next_at_ms = excluded.next_at_ms')
            .run(host, start + gap);
          this.db.exec('COMMIT');
        } catch (e) {
          try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
          throw e;
        }
        break;
      } catch (e) {
        // Another process holds the write lock for a moment: wait and try again.
        if (attempt < 50 && /busy|locked/i.test(String((e as Error).message))) { await sleep(20, signal); continue; }
        throw e;
      }
    }
    await sleep(start - now, signal);
  }
}

export interface FeedClientOptions {
  sourceId: string;
  /** Real hosts this source may reach. */
  allowedHosts: readonly string[];
  pacer: HostPacer;
  /** Real host -> loopback origin (JOBLEFT_HOST_MAP). Checked: loopback targets only, never-crawl hosts refused. */
  hostMap?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Per request. Default 15 s. */
  timeoutMs?: number;
  maxBodyBytes?: number;
  /** Requests this run may still send (the daily limit). Decremented before each request. */
  budget?: { remaining: number };
  /** Called once per request actually sent (for the persistent daily count). */
  onRequest?: (host: string) => void;
  /** Strings that must never appear in an error text (the key, the email). */
  secrets?: string[];
  offline?: boolean;
  signal?: AbortSignal;
  /** Hosts whose robots.txt the owner has decided to skip (empty by default; see catalog ROBOTS_EXCEPTIONS). */
  robotsExceptions?: readonly string[];
  /** Retries after a 5xx or a network error (never after a timeout, a 4xx or a block). Default 1. */
  retries?: number;
  /** robots.txt answers shared by every client of one refresh (one fetch per host per refresh). */
  robotsCache?: Map<string, Promise<RobotsRules>>;
  retryDelayMs?: number;
}

/** "remoteok.com/api" style text for errors: host and path only. */
function where(u: URL): string {
  return `${u.hostname}${u.pathname}`;
}

export class FeedClient implements FeedHttp {
  readonly sourceId: string;
  requests = 0;
  private allowed: Set<string>;
  private pacer: HostPacer;
  private hostMap: Record<string, string>;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private maxBody: number;
  private budget: { remaining: number };
  private onRequest?: (host: string) => void;
  private secrets: string[];
  private offline: boolean;
  private signal?: AbortSignal;
  private robotsExceptions: Set<string>;
  private retries: number;
  private retryDelayMs: number;
  private robots: Map<string, Promise<RobotsRules>>;

  constructor(opts: FeedClientOptions) {
    this.robots = opts.robotsCache ?? new Map();
    this.sourceId = opts.sourceId;
    this.allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
    this.pacer = opts.pacer;
    this.hostMap = checkHostMap(opts.hostMap ?? {});
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxBody = opts.maxBodyBytes ?? 32 * 1024 * 1024;
    this.budget = opts.budget ?? { remaining: Number.POSITIVE_INFINITY };
    this.onRequest = opts.onRequest;
    this.secrets = (opts.secrets ?? []).filter((s) => s && s.length >= 3);
    this.offline = opts.offline ?? false;
    this.signal = opts.signal;
    this.robotsExceptions = new Set((opts.robotsExceptions ?? []).map((h) => h.toLowerCase()));
    this.retries = opts.retries ?? 1;
    this.retryDelayMs = opts.retryDelayMs ?? 2000;
  }

  /** Removes every secret from a text (used for every message this client produces). */
  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join('[redacted]');
    return out;
  }

  private fail(code: FeedErrorCode, message: string, opts: { status?: number | null; retryAfterSeconds?: number | null } = {}): FeedError {
    return new FeedError(code, this.redact(message), opts);
  }

  /** Checks a URL before anything is sent. Returns the real URL and the URL to request (mapped to a stand-in). */
  private resolve(url: string): { real: URL; target: URL } {
    let real: URL;
    try { real = new URL(url); } catch { throw this.fail('forbidden_host', 'refused a link that is not a valid URL'); }
    if (real.protocol !== 'https:' && real.protocol !== 'http:') throw this.fail('forbidden_host', 'refused a link that is not http(s)');
    const host = real.hostname.toLowerCase();
    if (NEVER_CRAWL.test(host)) throw this.fail('never_crawl', `refused to contact ${host}: it is on jobleft's never-crawl list`);
    if (!this.allowed.has(host)) throw this.fail('forbidden_host', `refused to contact ${host}: not an approved host for this source`);
    if (this.offline) throw this.fail('offline', 'jobleft is offline (JOBLEFT_OFFLINE=1); nothing was sent');
    const mapped = this.hostMap[real.host.toLowerCase()] ?? this.hostMap[host];
    // Stand-in mode: with a host map set, a host that has no stand-in is never contacted live (sources-other O15).
    if (!mapped && Object.keys(this.hostMap).length > 0) {
      throw this.fail('forbidden_host', `stand-in mode (JOBLEFT_HOST_MAP is set): ${host} has no stand-in, so nothing was sent`);
    }
    const target = mapped ? new URL(mapped + real.pathname + real.search) : real;
    return { real, target };
  }

  private async send(target: URL, realHost: string, headers: Record<string, string>): Promise<Response> {
    if (this.signal?.aborted) throw this.fail('cancelled', 'the refresh was cancelled');
    if (this.budget.remaining <= 0) throw this.fail('budget', "this source's request limit for the day is used up");
    this.budget.remaining--;
    this.requests++;
    this.onRequest?.(realHost);
    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (this.signal) signals.push(this.signal);
    try {
      return await this.fetchImpl(target.toString(), { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.any(signals) });
    } catch (e) {
      if (this.signal?.aborted) throw this.fail('cancelled', 'the refresh was cancelled');
      const name = (e as Error)?.name ?? '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw this.fail('timeout', `${realHost} did not answer within ${Math.round(this.timeoutMs / 1000)} seconds`);
      }
      const cause = (e as { cause?: { code?: string } })?.cause?.code;
      throw this.fail('network', `could not reach ${realHost}${cause ? ` (${cause})` : ''}`);
    }
  }

  private async readBody(res: Response, realHost: string): Promise<string> {
    const cl = parseInt(res.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(cl) && cl > this.maxBody) {
      await res.body?.cancel().catch(() => {});
      throw this.fail('too_large', `the answer from ${realHost} was larger than ${Math.round(this.maxBody / 1048576)} MB`);
    }
    let buf: ArrayBuffer;
    try {
      buf = await res.arrayBuffer();
    } catch (e) {
      const name = (e as Error)?.name ?? '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw this.fail('timeout', `${realHost} stopped sending within ${Math.round(this.timeoutMs / 1000)} seconds`);
      }
      throw this.fail('cut_off', `the answer from ${realHost} was cut off before it ended`);
    }
    if (buf.byteLength > this.maxBody) throw this.fail('too_large', `the answer from ${realHost} was larger than ${Math.round(this.maxBody / 1048576)} MB`);
    return new TextDecoder().decode(buf);
  }

  private robotsFor(target: URL, realHost: string): Promise<RobotsRules> {
    if (this.robotsExceptions.has(realHost)) return Promise.resolve(ALLOW_ALL);
    const key = target.origin;
    let p = this.robots.get(key);
    if (!p) {
      p = (async () => {
        await this.pacer.wait(realHost, MIN_GAP_MS, this.signal);
        let res: Response;
        try {
          res = await this.send(new URL('/robots.txt', target.origin), realHost, { 'user-agent': USER_AGENT, accept: 'text/plain' });
        } catch (e) {
          if (e instanceof FeedError && (e.code === 'budget' || e.code === 'cancelled' || e.code === 'offline')) throw e;
          return DISALLOW_ALL; // RFC 9309: robots.txt unreachable = assume disallow
        }
        const body = await this.readBody(res, realHost).catch(() => '');
        if (res.status >= 200 && res.status < 300) return parseRobots(body, PRODUCT_TOKEN);
        if (res.status >= 500) return DISALLOW_ALL;
        return ALLOW_ALL; // 4xx: no rules published
      })();
      this.robots.set(key, p);
      // A failure that is not about robots.txt (budget, cancel, offline) must not stick for other sources.
      p.catch(() => { if (this.robots.get(key) === p) this.robots.delete(key); });
    }
    return p;
  }

  async request(url: string, opts: FeedRequestOptions = {}): Promise<FeedResponse> {
    const { real, target } = this.resolve(url);
    const realHost = real.hostname.toLowerCase();
    const rules = await this.robotsFor(target, realHost);
    if (!rules.allows(real.pathname + real.search)) {
      throw this.fail('robots', `robots.txt on ${realHost} does not allow ${real.pathname}`);
    }
    const headers: Record<string, string> = { accept: opts.accept ?? 'application/json' };
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      const lk = k.toLowerCase();
      if (lk === 'user-agent' || lk === 'host' || lk === 'cookie') continue;
      headers[lk] = v;
    }
    headers['user-agent'] = opts.userAgent && this.allowed.has(realHost) ? opts.userAgent : USER_AGENT;
    if (opts.ifNoneMatch) headers['if-none-match'] = opts.ifNoneMatch;
    let last: FeedError | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(this.retryDelayMs, this.signal);
      await this.pacer.wait(realHost, rules.crawlDelayMs, this.signal);
      let res: Response;
      try {
        res = await this.send(target, realHost, headers);
      } catch (e) {
        if (e instanceof FeedError && e.code === 'network') { last = e; continue; }
        throw e;
      }
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      const status = res.status;
      if (status === 304) {
        await res.body?.cancel().catch(() => {});
        return { status, body: '', etag: res.headers.get('etag'), retryAfterSeconds: retryAfter };
      }
      if (status >= 200 && status < 300) {
        const body = await this.readBody(res, realHost);
        return { status, body, etag: res.headers.get('etag'), retryAfterSeconds: retryAfter };
      }
      await res.body?.cancel().catch(() => {});
      if (status >= 300 && status < 400) {
        let to = 'another address';
        try { to = new URL(res.headers.get('location') ?? '', real).hostname || to; } catch { /* keep the generic word */ }
        throw this.fail('redirect', `${where(real)} answered with a redirect to ${to}; jobleft does not follow redirects`, { status });
      }
      if (status === 401) throw this.fail('key_refused', `${realHost} refused the key (HTTP 401)`, { status });
      if (status === 403) throw this.fail('blocked', `${realHost} refused the request (HTTP 403)`, { status });
      if (status === 429) {
        throw this.fail('rate_limited', `${realHost} asked jobleft to slow down (HTTP 429)`, { status, retryAfterSeconds: retryAfter });
      }
      if (status === 404 || status === 410) throw this.fail('not_found', `${where(real)} was not found (HTTP ${status})`, { status });
      if (status >= 500) { last = this.fail('http', `${realHost} had a server error (HTTP ${status})`, { status }); continue; }
      throw this.fail('http', `${realHost} answered HTTP ${status}`, { status });
    }
    throw last ?? this.fail('network', `could not reach ${realHost}`);
  }

  async getText(url: string, accept = 'application/json'): Promise<string> {
    return (await this.request(url, { accept })).body;
  }

  async getJson(url: string): Promise<unknown> {
    const res = await this.request(url, { accept: 'application/json' });
    return parseJsonBody(res.body, new URL(url).hostname);
  }
}

/** Parses a JSON answer, telling a web page, a cut-off answer and other damage apart in plain words. */
export function parseJsonBody(body: string, host: string): unknown {
  const t = body.trimStart();
  if (t.startsWith('<')) throw new FeedError('web_page', `${host} answered with a web page instead of job data`);
  if (!t) throw new FeedError('not_json', `${host} answered with an empty body instead of job data`);
  try {
    return JSON.parse(body);
  } catch (e) {
    const msg = String((e as Error).message);
    // The parser stopped at the very end of the body: the answer was cut off, not damaged in the middle.
    const at = /position (\d+)/.exec(msg);
    const atEnd = at !== null && Number(at[1]) >= body.trimEnd().length;
    if (atEnd || /end of (json )?input|unexpected end/i.test(msg)) {
      throw new FeedError('cut_off', `the answer from ${host} was cut off before it ended`);
    }
    throw new FeedError('not_json', `${host} answered with data that is not valid JSON`);
  }
}

function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.round(n), 7 * 86400);
  const t = Date.parse(v);
  if (Number.isFinite(t)) return Math.max(0, Math.min(Math.round((t - Date.now()) / 1000), 7 * 86400));
  return null;
}
