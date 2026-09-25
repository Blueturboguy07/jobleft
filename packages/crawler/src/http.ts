// The only code that touches the network. It enforces, for every request:
//   * a neutral User-Agent with no personal data
//   * a deny-list of hosts this project never crawls (LinkedIn, Indeed, Glassdoor, SmartRecruiters, Workday)
//   * robots.txt (fetched once per host, RFC 9309 semantics, honours Crawl-delay)
//   * a pacer: at most 1 request per second per host (more when Crawl-delay asks for more)
//   * stop on 403 / 429: no retry, the board fails, and two in a row trip the host for the rest of the run
//   * a total request budget
//   * retry only on 5xx / network errors, max 2 retries, still through the pacer
//   * an optional host map that sends a real ATS host to a LOOPBACK mock server (tests and README demos only)

import { parseRobots, ALLOW_ALL, DISALLOW_ALL } from './robots.ts';
import type { RobotsRules } from './robots.ts';
import type { HttpGetter } from './types.ts';

/** The honest crawler identity for build and research runs. It never carries personal data or an install id. */
export const USER_AGENT = 'jobleft-build/0.1 (research build; no personal data)';
/** The robots.txt product token. A robots group for "jobleft" also matches it (prefix rule). */
export const PRODUCT_TOKEN = 'jobleft-build';

const DENY_HOST = /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com|smartrecruiters\.com|myworkdayjobs\.com|myworkdaysite\.com|workday\.com|licdn\.com)$/i;

/** Hosts a host map may point at. A mock server must run on this computer. */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])$/i;

export class HostMapError extends Error {
  constructor(message: string) { super(message); this.name = 'HostMapError'; }
}

/**
 * Checks a host map (real host -> loopback origin, e.g. {"boards-api.greenhouse.io": "http://127.0.0.1:4010"}).
 * Throws when a target is not a loopback http(s) origin or when a key is a never-crawl host.
 */
export function checkHostMap(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [host, target] of Object.entries(map)) {
    if (DENY_HOST.test(host)) throw new HostMapError(`host map may not name a never-crawl host: ${host}`);
    let u: URL;
    try { u = new URL(target); } catch { throw new HostMapError(`host map target is not a URL: ${target}`); }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !LOOPBACK_HOST.test(u.hostname)) {
      throw new HostMapError(`host map target must be a loopback http(s) origin: ${target}`);
    }
    out[host.toLowerCase()] = u.origin;
  }
  return out;
}

/** Reads JOBLEFT_HOST_MAP (a JSON object) from an environment. Empty when unset. */
export function hostMapFromEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const raw = env.JOBLEFT_HOST_MAP;
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new HostMapError('JOBLEFT_HOST_MAP is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HostMapError('JOBLEFT_HOST_MAP must be a JSON object');
  return checkHostMap(parsed as Record<string, string>);
}

export class HttpError extends Error {
  status: number;
  url: string;
  constructor(status: number, url: string, message?: string) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}
/** 403 or 429. The board stops; no retry. */
export class BlockedError extends HttpError {
  constructor(status: number, url: string) { super(status, url, `blocked: HTTP ${status} for ${url}`); this.name = 'BlockedError'; }
}
export class NotFoundError extends HttpError {
  constructor(status: number, url: string) { super(status, url, `not found: HTTP ${status} for ${url}`); this.name = 'NotFoundError'; }
}
export class RobotsError extends Error {
  url: string;
  constructor(url: string, why: string) { super(`robots.txt: ${why} for ${url}`); this.name = 'RobotsError'; this.url = url; }
}
export class DeniedHostError extends Error {
  constructor(host: string) { super(`host is on the never-crawl list: ${host}`); this.name = 'DeniedHostError'; }
}
export class BudgetError extends Error {
  constructor(n: number) { super(`request budget of ${n} reached`); this.name = 'BudgetError'; }
}
export class HostTrippedError extends Error {
  constructor(host: string) { super(`host ${host} tripped after repeated 403/429; skipped for the rest of the run`); this.name = 'HostTrippedError'; }
}

/** Reserves start times so requests to one host are at least `intervalMs` apart. */
export class Pacer {
  intervalMs: number;
  private next = new Map<string, number>();
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  constructor(intervalMs = 1000, now: () => number = () => Date.now(), sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.intervalMs = intervalMs;
    this.now = now;
    this.sleep = sleep;
  }
  /** Synchronous slot reservation, so concurrent callers queue in order. */
  async wait(host: string, extraIntervalMs = 0): Promise<void> {
    const gap = Math.max(this.intervalMs, extraIntervalMs);
    const t = this.now();
    const start = Math.max(t, this.next.get(host) ?? 0);
    this.next.set(host, start + gap);
    if (start > t) await this.sleep(start - t);
  }
}

export interface HostStats { requests: number; bytesDecoded: number; bytesWire: number; statuses: Record<string, number> }

export interface HttpOptions {
  fetchImpl?: typeof fetch;
  pacer?: Pacer;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRequests?: number;
  retries?: number;
  retryDelayMs?: number;
  respectRobots?: boolean;
  /** Real host -> loopback mock origin. Checked by `checkHostMap`. The deny-list is applied to the REAL host first. */
  hostMap?: Record<string, string>;
}

export class HttpClient implements HttpGetter {
  readonly pacer: Pacer;
  readonly stats = new Map<string, HostStats>();
  totalRequests = 0;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private maxBody: number;
  private maxRequests: number;
  private retries: number;
  private retryDelayMs: number;
  private respectRobots: boolean;
  private robots = new Map<string, Promise<RobotsRules>>();
  private blockedRun = new Map<string, number>();
  private tripped = new Set<string>();
  private hostMap: Record<string, string>;

  constructor(opts: HttpOptions = {}) {
    this.hostMap = checkHostMap(opts.hostMap ?? {});
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pacer = opts.pacer ?? new Pacer();
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxBody = opts.maxBodyBytes ?? 64 * 1024 * 1024;
    this.maxRequests = opts.maxRequests ?? 3000;
    this.retries = opts.retries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    this.respectRobots = opts.respectRobots ?? true;
  }

  private hostStats(host: string): HostStats {
    let s = this.stats.get(host);
    if (!s) { s = { requests: 0, bytesDecoded: 0, bytesWire: 0, statuses: {} }; this.stats.set(host, s); }
    return s;
  }

  /** Counters for one host (exact when boards on that host run in series) or for all hosts. */
  snapshot(host?: string): { requests: number; bytesDecoded: number; bytesWire: number } {
    let requests = 0, bytesDecoded = 0, bytesWire = 0;
    for (const [h, s] of this.stats) {
      if (host !== undefined && h !== host) continue;
      requests += s.requests; bytesDecoded += s.bytesDecoded; bytesWire += s.bytesWire;
    }
    return { requests, bytesDecoded, bytesWire };
  }

  isTripped(host: string): boolean { return this.tripped.has(host); }

  /** `statsHost` is the host the caller asked for (the real ATS host when a host map sends it to a mock). */
  private async rawRequest(url: string, accept: string, statsHost?: string): Promise<{ status: number; body: string; wire: number }> {
    if (this.totalRequests >= this.maxRequests) throw new BudgetError(this.maxRequests);
    this.totalRequests++;
    const host = statsHost ?? new URL(url).host;
    const st = this.hostStats(host);
    st.requests++;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept },
      redirect: 'manual', // never auto-follow: a redirect would skip the pacer, robots check and deny-list
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    st.statuses[String(res.status)] = (st.statuses[String(res.status)] ?? 0) + 1;
    const cl = parseInt(res.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(cl) && cl > this.maxBody) { await res.body?.cancel(); throw new HttpError(res.status, url, `body too large: ${cl}`); }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > this.maxBody) throw new HttpError(res.status, url, `body too large: ${buf.byteLength}`);
    st.bytesDecoded += buf.byteLength;
    st.bytesWire += Number.isFinite(cl) ? cl : buf.byteLength;
    return { status: res.status, body: new TextDecoder().decode(buf), wire: Number.isFinite(cl) ? cl : buf.byteLength };
  }

  private robotsFor(origin: string, host: string): Promise<RobotsRules> {
    if (!this.respectRobots) return Promise.resolve(ALLOW_ALL);
    let p = this.robots.get(host);
    if (!p) {
      p = (async () => {
        await this.pacer.wait(host);
        try {
          const r = await this.rawRequest(`${origin}/robots.txt`, 'text/plain');
          if (r.status >= 200 && r.status < 300) return parseRobots(r.body, PRODUCT_TOKEN);
          if (r.status >= 500) return DISALLOW_ALL; // RFC 9309: unreachable = assume disallow
          return ALLOW_ALL; // 4xx (404, 401...) = no rules published
        } catch (e) {
          if (e instanceof BudgetError) throw e;
          return DISALLOW_ALL;
        }
      })();
      this.robots.set(host, p);
    }
    return p;
  }

  /** robots.txt rules as the client saw them (for the report). */
  async robotsSummary(origin: string): Promise<{ crawlDelayMs: number }> {
    const r = await this.robotsFor(origin, new URL(origin).host);
    return { crawlDelayMs: r.crawlDelayMs };
  }

  async getText(url: string, accept = 'application/json'): Promise<string> {
    const real = new URL(url);
    if (DENY_HOST.test(real.hostname)) throw new DeniedHostError(real.hostname);
    const mapped = this.hostMap[real.host.toLowerCase()];
    if (mapped) url = mapped + real.pathname + real.search;
    const u = new URL(url);
    const host = u.host;
    if (this.tripped.has(host)) throw new HostTrippedError(host);
    const rules = await this.robotsFor(u.origin, host);
    if (!rules.allows(u.pathname + u.search)) throw new RobotsError(url, 'path is disallowed');
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs));
      await this.pacer.wait(host, rules.crawlDelayMs);
      let r: { status: number; body: string; wire: number };
      try {
        r = await this.rawRequest(url, accept, real.host);
      } catch (e) {
        if (e instanceof BudgetError || e instanceof HttpError) throw e;
        lastErr = e; // network error or timeout: transient
        continue;
      }
      if (r.status >= 200 && r.status < 300) { this.blockedRun.set(host, 0); return r.body; }
      if (r.status === 403 || r.status === 429) {
        const n = (this.blockedRun.get(host) ?? 0) + 1;
        this.blockedRun.set(host, n);
        if (n >= 2) this.tripped.add(host);
        throw new BlockedError(r.status, url);
      }
      if (r.status === 404 || r.status === 410) throw new NotFoundError(r.status, url);
      if (r.status >= 300 && r.status < 400) throw new HttpError(r.status, url, `redirect not followed: HTTP ${r.status} for ${url}`);
      if (r.status >= 500) { lastErr = new HttpError(r.status, url); continue; }
      throw new HttpError(r.status, url);
    }
    throw lastErr instanceof Error ? lastErr : new Error(`request failed: ${url}`);
  }

  async getJson(url: string): Promise<unknown> {
    const text = await this.getText(url, 'application/json');
    try { return JSON.parse(text); } catch (e) { throw new HttpError(200, url, `invalid JSON from ${url}: ${(e as Error).message}`); }
  }
}
