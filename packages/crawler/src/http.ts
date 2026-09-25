// The only code that touches the network. For every request it enforces:
//   * one honest identity (User-Agent) from the config; no other identifying header, no cookie, no referrer
//   * the never-crawl list (LinkedIn, Indeed, Glassdoor, SmartRecruiters) and the held-back families (Workday, iCIMS,
//     Oracle, UKG, Taleo), also as redirect targets
//   * no request to this computer or the local network, except a loopback mock server named on purpose
//   * robots.txt per host (RFC 9309), cached for 24 hours; an unreadable robots.txt means "do not crawl this host now"
//   * a pacer: requests to one host start at least 1 second apart (longer when Crawl-delay asks), across concurrent
//     boards, retries and robots.txt, and across runs when a state store is given
//   * 429 and 503 with Retry-After: the host gets no request until the time it named
//   * 403 and 429 stop the board; two in a row trip the host for the rest of the run
//   * redirects are never followed (a redirect could skip every check above)
//   * a whole-request deadline, a reply size cap (read as a stream, so a huge reply never fills memory) and a request
//     budget
//   * conditional requests (If-None-Match, If-Modified-Since) when the caller has validators; 304 = unchanged

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { productTokenOf, checkUserAgent } from './config.ts';
import { forbiddenHostOf, forbiddenReason, isLocalName, isPrivateAddress, loopbackOrigin } from './hosts.ts';
import type { ForbiddenHost } from './hosts.ts';
import { parseRobots, ALLOW_ALL, DISALLOW_ALL } from './robots.ts';
import type { RobotsRules } from './robots.ts';
import type { HttpGetter } from './types.ts';

/**
 * The research-build identity (development runs and tests). An HttpClient made without a `userAgent` option uses it.
 * The app and the CLI pass the configured identity instead (DEFAULT_USER_AGENT in config.ts: "jobleft/0.1 (contact: TBD)").
 */
export const USER_AGENT = 'jobleft-build/0.1 (research build; no personal data)';
/** The robots.txt product token of USER_AGENT. A robots group for "jobleft" also matches it (prefix rule). */
export const PRODUCT_TOKEN = 'jobleft-build';

export class HostMapError extends Error {
  constructor(message: string) { super(message); this.name = 'HostMapError'; }
}

/**
 * Checks a host map (real host -> loopback origin, e.g. {"boards-api.greenhouse.io": "http://127.0.0.1:4010"}).
 * Throws when a target is not a loopback http(s) origin or when a key is a never-crawl or held-back host.
 */
export function checkHostMap(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [host, target] of Object.entries(map)) {
    if (forbiddenHostOf(host)) throw new HostMapError(`host map may not name a never-crawl host: ${host}`);
    try { new URL(target); } catch { throw new HostMapError(`host map target is not a URL: ${target}`); }
    const origin = loopbackOrigin(target);
    if (!origin) throw new HostMapError(`host map target must be a loopback http(s) origin: ${target}`);
    out[host.toLowerCase()] = origin;
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

// ---------------------------------------------------------------------------------------------------- errors

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
/** 403 or 429. The board stops. */
export class BlockedError extends HttpError {
  constructor(status: number, url: string) { super(status, url, `blocked: HTTP ${status} for ${url}`); this.name = 'BlockedError'; }
}
export class NotFoundError extends HttpError {
  constructor(status: number, url: string) { super(status, url, `not found: HTTP ${status} for ${url}`); this.name = 'NotFoundError'; }
}
/** 304 to a conditional request: the board has not changed since the stored reading. */
export class NotModifiedError extends HttpError {
  constructor(url: string) { super(304, url, `not modified since the last reading: ${url}`); this.name = 'NotModifiedError'; }
}
/** A 3xx answer. Never followed. `target` is where it pointed; `forbidden` is set when that is a never-crawl host. */
export class RedirectError extends HttpError {
  location: string;
  targetHost: string | null;
  forbidden: ForbiddenHost | null;
  privateTarget: boolean;
  constructor(status: number, url: string, location: string, allowHeldBack: readonly string[] = []) {
    let targetHost: string | null = null;
    try { targetHost = new URL(location, url).hostname.toLowerCase(); } catch { /* unparsable Location */ }
    const forbidden = targetHost ? forbiddenHostOf(targetHost, allowHeldBack) : null;
    const privateTarget = targetHost !== null && (isPrivateAddress(targetHost) || isLocalName(targetHost));
    super(status, url, `redirect not followed: HTTP ${status} for ${url} to ${targetHost ?? (location || '(no location)')}`);
    this.name = 'RedirectError';
    this.location = location;
    this.targetHost = targetHost;
    this.forbidden = forbidden;
    this.privateTarget = privateTarget;
  }
}
/** The reply is not job data: a web page, broken JSON or JSON without the expected job list. */
export class NotJobDataError extends HttpError {
  kind: 'web_page' | 'broken' | 'cut_off' | 'shape';
  constructor(url: string, kind: NotJobDataError['kind'], detail: string) {
    super(200, url, `not job data (${kind}) from ${url}: ${detail}`);
    this.name = 'NotJobDataError';
    this.kind = kind;
  }
}
export class TooLargeError extends HttpError {
  limit: number;
  constructor(status: number, url: string, limit: number) { super(status, url, `reply larger than ${Math.round(limit / 1048576)} MB from ${url}`); this.name = 'TooLargeError'; this.limit = limit; }
}
export class RequestTimeoutError extends Error {
  url: string;
  ms: number;
  constructor(url: string, ms: number) { super(`no complete reply within ${Math.round(ms / 1000)} s from ${url}`); this.name = 'RequestTimeoutError'; this.url = url; this.ms = ms; }
}
/** The connection closed before the whole reply arrived. */
export class CutOffError extends Error {
  url: string;
  constructor(url: string, detail: string) { super(`reply cut off before the end from ${url}: ${detail}`); this.name = 'CutOffError'; this.url = url; }
}
/** Could not connect at all (refused, reset before a reply, name not found). */
export class NetworkError extends Error {
  url: string;
  code: string;
  constructor(url: string, code: string, detail: string) { super(`could not reach ${url} (${code}): ${detail}`); this.name = 'NetworkError'; this.url = url; this.code = code; }
}
/** The caller stopped the request (the run is stopping). */
export class AbortedError extends Error {
  constructor(url: string) { super(`stopped before a reply from ${url}`); this.name = 'AbortedError'; }
}
export class RobotsError extends Error {
  url: string;
  /** true when the rules forbid the path; false when robots.txt could not be read. */
  disallowed: boolean;
  constructor(url: string, why: string, disallowed = true) { super(`robots.txt: ${why} for ${url}`); this.name = 'RobotsError'; this.url = url; this.disallowed = disallowed; }
}
export class DeniedHostError extends Error {
  host: string;
  forbidden: ForbiddenHost | null;
  constructor(host: string, forbidden: ForbiddenHost | null = null) {
    super(forbidden ? forbiddenReason(forbidden) : `host is on the never-crawl list: ${host}`);
    this.name = 'DeniedHostError';
    this.host = host;
    this.forbidden = forbidden;
  }
}
/** A held-back family (Workday, iCIMS, Oracle, UKG, Taleo) the owner has not turned on. */
export class HeldBackHostError extends DeniedHostError {
  constructor(host: string, forbidden: ForbiddenHost) { super(host, forbidden); this.name = 'HeldBackHostError'; }
}
/** The host is this computer or the local network. */
export class PrivateAddressError extends Error {
  host: string;
  constructor(host: string, detail: string) { super(`${host} ${detail}; jobleft does not contact this computer or the local network`); this.name = 'PrivateAddressError'; this.host = host; }
}
export class BudgetError extends Error {
  constructor(n: number) { super(`request budget of ${n} reached`); this.name = 'BudgetError'; }
}
export class HostTrippedError extends Error {
  constructor(host: string) { super(`host ${host} tripped after repeated 403/429; skipped for the rest of the run`); this.name = 'HostTrippedError'; }
}
/** The host asked jobleft to wait longer than the run waits (Retry-After, or a block from an earlier run). */
export class HostWaitError extends Error {
  host: string;
  untilMs: number;
  constructor(host: string, untilMs: number, why: string) {
    super(`host ${host} asked to wait until ${new Date(untilMs).toISOString()} (${why})`);
    this.name = 'HostWaitError';
    this.host = host;
    this.untilMs = untilMs;
  }
}

// ---------------------------------------------------------------------------------------------------- pacer

/**
 * Reserves start times so requests to one host are at least `intervalMs` apart, and holds a host back while it asked
 * to wait. Concurrent callers queue in order; a waiter that wakes into a new block waits again.
 */
export class Pacer {
  intervalMs: number;
  private next = new Map<string, number>();
  private blocked = new Map<string, number>();
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  constructor(intervalMs = 1000, now: () => number = () => Date.now(), sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.intervalMs = intervalMs;
    this.now = now;
    this.sleep = sleep;
  }
  /** The pacer's clock (real time, or a test clock). */
  clock(): number { return this.now(); }
  async wait(host: string, extraIntervalMs = 0): Promise<void> {
    const gap = Math.max(this.intervalMs, extraIntervalMs);
    for (let guard = 0; guard < 1000; guard++) {
      const t = this.now();
      const start = Math.max(t, this.next.get(host) ?? 0, this.blocked.get(host) ?? 0);
      this.next.set(host, start + gap);
      if (start > t) await this.sleep(start - t);
      if ((this.blocked.get(host) ?? 0) <= this.now()) return;
    }
  }
  /** No request to `host` starts before `untilMs` (pacer clock). */
  blockUntil(host: string, untilMs: number): void {
    this.blocked.set(host, Math.max(this.blocked.get(host) ?? 0, untilMs));
  }
  blockedUntil(host: string): number { return this.blocked.get(host) ?? 0; }
  /** Continue the spacing from a request made earlier (for example by the previous run). */
  seed(host: string, lastRequestMs: number, gapMs = this.intervalMs): void {
    this.next.set(host, Math.max(this.next.get(host) ?? 0, lastRequestMs + Math.max(this.intervalMs, gapMs)));
  }
}

// ---------------------------------------------------------------------------------------------------- state

export interface RobotsRecord {
  status: number;
  body: string | null;
  etag: string | null;
  lastModified: string | null;
  fetchedAtMs: number;
  expiresAtMs: number;
  /** Why the host may not be crawled now (robots.txt unreadable), or null. */
  problem: string | null;
}
export interface HostRecord { notBeforeMs: number | null; notBeforeReason: string | null; lastRequestMs: number | null }

/** Where the client keeps what must survive a restart: robots.txt files, host waits and last request times. */
export interface HostStateStore {
  getRobots(origin: string): RobotsRecord | null;
  putRobots(origin: string, rec: RobotsRecord): void;
  getHost(host: string): HostRecord | null;
  setHostWait(host: string, untilMs: number, reason: string): void;
  noteRequest(host: string, atMs: number): void;
}

// ---------------------------------------------------------------------------------------------------- client

export interface HostStats { requests: number; bytesDecoded: number; bytesWire: number; statuses: Record<string, number> }

export interface Validators { url: string; etag: string | null; lastModified: string | null }

export interface HttpOptions {
  fetchImpl?: typeof fetch;
  pacer?: Pacer;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRequests?: number;
  retries?: number;
  retryDelayMs?: number;
  respectRobots?: boolean;
  /** Real host -> loopback mock origin. Checked by `checkHostMap`. The never-crawl list is applied to the REAL host first. */
  hostMap?: Record<string, string>;
  /** The crawler identity. Checked by checkUserAgent. Default: USER_AGENT (research build). */
  userAgent?: string;
  robotsTimeoutMs?: number;
  /** A Retry-After up to this long is waited for inside the run. Default 120 s. */
  maxRetryAfterMs?: number;
  /** How long a host is left alone after a 429 or 503 without Retry-After. Default 60 s. */
  defaultRetryAfterMs?: number;
  /** How long a tripped host (two 403/429 in a row) is left alone after the run. Default 30 minutes. */
  tripWaitMs?: number;
  /** Families of held-back hosts the owner turned on (workday, icims, oracle, ukg, taleo). Default none. */
  allowHeldBack?: string[];
  /**
   * Resolves a host name to its addresses, to refuse names that point at this computer or the local network.
   * Default: the system resolver, unless `fetchImpl` is given (tests), in which case no lookup is made.
   */
  lookup?: ((host: string) => Promise<string[]>) | null;
  /** Persistence for robots.txt, host waits and last request times. */
  state?: HostStateStore;
}

export interface RequestOptions {
  accept?: string;
  signal?: AbortSignal;
  /** A loopback mock origin for this request (a board's `origin`). The real host is still checked first. */
  origin?: string | null;
  /** Send If-None-Match / If-Modified-Since. A 304 answer throws NotModifiedError. */
  validators?: Validators | null;
}

export interface HttpResult {
  url: string;
  status: number;
  body: string;
  contentType: string;
  etag: string | null;
  lastModified: string | null;
}

interface RawReply { status: number; body: string; headers: Headers; wire: number }

const ROBOTS_TTL_MS = 24 * 3600 * 1000;
const ROBOTS_RETRY_MS = 30 * 60 * 1000;
const ERROR_BODY_CAP = 64 * 1024;

function parseRetryAfter(v: string | null, nowMs: number): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}

function errCode(e: unknown): string {
  const c = (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;
  return typeof c === 'string' ? c : 'ERROR';
}

export class HttpClient implements HttpGetter {
  readonly pacer: Pacer;
  readonly stats = new Map<string, HostStats>();
  readonly userAgent: string;
  readonly productToken: string;
  totalRequests = 0;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private robotsTimeoutMs: number;
  private maxBody: number;
  private maxRequests: number;
  private retries: number;
  private retryDelayMs: number;
  private respectRobots: boolean;
  private maxRetryAfterMs: number;
  private defaultRetryAfterMs: number;
  private tripWaitMs: number;
  private allowHeldBack: string[];
  private lookupImpl: ((host: string) => Promise<string[]>) | null;
  private state: HostStateStore | undefined;
  private robots = new Map<string, Promise<RobotsRules & { problem?: string | null }>>();
  private resolved = new Map<string, Promise<void>>();
  private seeded = new Set<string>();
  private blockedRun = new Map<string, number>();
  private tripped = new Set<string>();
  private hostMap: Record<string, string>;

  constructor(opts: HttpOptions = {}) {
    this.hostMap = checkHostMap(opts.hostMap ?? {});
    this.userAgent = checkUserAgent(opts.userAgent ?? USER_AGENT);
    this.productToken = productTokenOf(this.userAgent);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pacer = opts.pacer ?? new Pacer();
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.robotsTimeoutMs = opts.robotsTimeoutMs ?? Math.min(15_000, this.timeoutMs);
    this.maxBody = opts.maxBodyBytes ?? 64 * 1024 * 1024;
    this.maxRequests = opts.maxRequests ?? 3000;
    this.retries = opts.retries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    this.respectRobots = opts.respectRobots ?? true;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 120_000;
    this.defaultRetryAfterMs = opts.defaultRetryAfterMs ?? 60_000;
    this.tripWaitMs = opts.tripWaitMs ?? 30 * 60_000;
    this.allowHeldBack = [...(opts.allowHeldBack ?? [])];
    this.state = opts.state;
    if (opts.lookup !== undefined) this.lookupImpl = opts.lookup;
    else if (opts.fetchImpl) this.lookupImpl = null;
    else this.lookupImpl = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);
  }

  /** The request budget of this client (a run). */
  get budget(): number { return this.maxRequests; }
  get budgetLeft(): number { return Math.max(0, this.maxRequests - this.totalRequests); }

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

  /**
   * The host a request really goes to (after a board origin or the host map), which is the key of the pacer and of
   * the per-host queues. `hostOrUrl` is a real host name or a URL.
   */
  hostKey(hostOrUrl: string, origin?: string | null): string {
    if (origin) { const o = loopbackOrigin(origin); if (o) return new URL(o).host; }
    let host = hostOrUrl;
    if (/^https?:\/\//i.test(hostOrUrl)) { try { host = new URL(hostOrUrl).host; } catch { /* keep */ } }
    const mapped = this.hostMap[host.toLowerCase()];
    return mapped ? new URL(mapped).host : host.toLowerCase();
  }

  /** How long `host` (a hostKey) is still asked to wait, in ms (0 when free). */
  waitLeft(host: string): number {
    this.seedFromState(host);
    return Math.max(0, this.pacer.blockedUntil(host) - this.pacer.clock());
  }

  /** A per-board view of the client: board origin, conditional first request, request cap, abort signal. */
  forBoard(opts: BoardHttpOptions = {}): BoardHttp { return new BoardHttp(this, opts); }

  private seedFromState(host: string): void {
    if (!this.state || this.seeded.has(host)) return;
    this.seeded.add(host);
    const rec = this.state.getHost(host);
    if (!rec) return;
    if (rec.lastRequestMs !== null) this.pacer.seed(host, rec.lastRequestMs);
    if (rec.notBeforeMs !== null && rec.notBeforeMs > this.pacer.clock()) this.pacer.blockUntil(host, rec.notBeforeMs);
  }

  private holdHost(host: string, untilMs: number, reason: string): void {
    this.pacer.blockUntil(host, untilMs);
    this.state?.setHostWait(host, untilMs, reason);
  }

  private async rawRequest(url: string, headers: Record<string, string>, statsHost: string, paceHost: string, timeoutMs: number, signal?: AbortSignal): Promise<RawReply> {
    if (this.totalRequests >= this.maxRequests) throw new BudgetError(this.maxRequests);
    if (signal?.aborted) throw new AbortedError(url);
    this.totalRequests++;
    const st = this.hostStats(statsHost);
    st.requests++;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let res: Response | undefined;
    let failure: Error | undefined;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'manual', // never auto-follow: a redirect would skip the pacer, robots check and never-crawl list
        signal: combined,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      } as RequestInit);
    } catch (e) {
      if (signal?.aborted) failure = new AbortedError(url);
      else if (timeout.aborted) failure = new RequestTimeoutError(url, timeoutMs);
      else if (e instanceof HttpError || e instanceof BudgetError) failure = e;
      else failure = new NetworkError(url, errCode(e), (e as Error)?.message ?? String(e));
    } finally {
      this.state?.noteRequest(paceHost, this.pacer.clock());
    }
    if (failure || !res) throw failure ?? new NetworkError(url, 'ERROR', 'no reply');
    st.statuses[String(res.status)] = (st.statuses[String(res.status)] ?? 0) + 1;
    const ok = res.status >= 200 && res.status < 300;
    const cap = ok ? this.maxBody : ERROR_BODY_CAP;
    const cl = parseInt(res.headers.get('content-length') ?? '', 10);
    if (ok && Number.isFinite(cl) && cl > cap) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      throw new TooLargeError(res.status, url, cap);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > cap) {
            try { await reader.cancel(); } catch { /* ignore */ }
            if (ok) throw new TooLargeError(res.status, url, cap);
            break; // error bodies are only diagnostic: keep the first part
          }
          chunks.push(value);
        }
      }
    } catch (e) {
      if (e instanceof TooLargeError) throw e;
      if (signal?.aborted) throw new AbortedError(url);
      if (timeout.aborted) throw new RequestTimeoutError(url, timeoutMs);
      throw new CutOffError(url, (e as Error)?.message ?? String(e));
    }
    const buf = new Uint8Array(Math.min(total, cap));
    let off = 0;
    for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.byteLength, buf.byteLength - off)), off); off += c.byteLength; if (off >= buf.byteLength) break; }
    st.bytesDecoded += buf.byteLength;
    const wire = Number.isFinite(cl) ? cl : buf.byteLength;
    st.bytesWire += wire;
    return { status: res.status, body: new TextDecoder().decode(buf), headers: res.headers, wire };
  }

  private baseHeaders(accept: string): Record<string, string> {
    // Exactly these headers: the identity and what we accept. No cookie, no referrer, no id of this install.
    return { 'user-agent': this.userAgent, accept };
  }

  private robotsFor(origin: string, host: string, signal?: AbortSignal): Promise<RobotsRules & { problem?: string | null }> {
    if (!this.respectRobots) return Promise.resolve(ALLOW_ALL);
    let p = this.robots.get(origin);
    if (p) return p;
    p = (async () => {
      const now = this.pacer.clock();
      const kept = this.state?.getRobots(origin) ?? null;
      const fromRecord = (rec: RobotsRecord): RobotsRules & { problem?: string | null } => {
        if (rec.problem) return { ...DISALLOW_ALL, problem: rec.problem };
        if (rec.status >= 200 && rec.status < 300 && rec.body !== null) return parseRobots(rec.body, this.productToken);
        return ALLOW_ALL;
      };
      if (kept && kept.expiresAtMs > now) return fromRecord(kept);
      await this.pacer.wait(host);
      const headers = this.baseHeaders('text/plain');
      if (kept && !kept.problem && kept.status >= 200 && kept.status < 300) {
        if (kept.etag) headers['if-none-match'] = kept.etag;
        if (kept.lastModified) headers['if-modified-since'] = kept.lastModified;
      }
      const store = (rec: Omit<RobotsRecord, 'fetchedAtMs'>): RobotsRules & { problem?: string | null } => {
        const full = { ...rec, fetchedAtMs: this.pacer.clock() };
        this.state?.putRobots(origin, full);
        return fromRecord(full);
      };
      let r: RawReply;
      try {
        r = await this.rawRequest(`${origin}/robots.txt`, headers, host, host, this.robotsTimeoutMs, signal);
      } catch (e) {
        if (e instanceof BudgetError || e instanceof AbortedError) { this.robots.delete(origin); throw e; }
        const why = e instanceof RequestTimeoutError ? 'robots.txt did not answer in time'
          : e instanceof TooLargeError ? 'robots.txt is larger than allowed'
          : `robots.txt could not be read (${e instanceof NetworkError ? e.code : (e as Error).name})`;
        return store({ status: 0, body: null, etag: null, lastModified: null, expiresAtMs: now + ROBOTS_RETRY_MS, problem: why });
      }
      const etag = r.headers.get('etag');
      const lastModified = r.headers.get('last-modified');
      if (r.status === 304 && kept) return store({ ...kept, expiresAtMs: now + ROBOTS_TTL_MS });
      if (r.status >= 200 && r.status < 300) return store({ status: r.status, body: r.body.slice(0, 500_000), etag, lastModified, expiresAtMs: now + ROBOTS_TTL_MS, problem: null });
      if (r.status >= 300 && r.status < 400) {
        return store({ status: r.status, body: null, etag: null, lastModified: null, expiresAtMs: now + ROBOTS_RETRY_MS, problem: `robots.txt answered with a redirect (HTTP ${r.status}), which jobleft does not follow` });
      }
      if (r.status >= 500) {
        // RFC 9309: an unreachable robots.txt means "assume the whole host is disallowed".
        return store({ status: r.status, body: null, etag: null, lastModified: null, expiresAtMs: now + ROBOTS_RETRY_MS, problem: `robots.txt answered with a server error (HTTP ${r.status})` });
      }
      if (r.status === 429) {
        return store({ status: r.status, body: null, etag: null, lastModified: null, expiresAtMs: now + ROBOTS_RETRY_MS, problem: 'robots.txt answered "too many requests" (HTTP 429)' });
      }
      // Other 4xx (404, 401, 403): no rules published, so no restriction (RFC 9309 section 2.3.1.3).
      return store({ status: r.status, body: null, etag: null, lastModified: null, expiresAtMs: now + ROBOTS_TTL_MS, problem: null });
    })();
    this.robots.set(origin, p);
    return p;
  }

  /** robots.txt rules as the client saw them (for the report). */
  async robotsSummary(origin: string): Promise<{ crawlDelayMs: number }> {
    const r = await this.robotsFor(origin, new URL(origin).host);
    return { crawlDelayMs: r.crawlDelayMs };
  }

  private async checkAddress(hostname: string): Promise<void> {
    const h = hostname.replace(/^\[|\]$/g, '');
    if (isIP(h)) {
      if (isPrivateAddress(h)) throw new PrivateAddressError(h, 'is a local address');
      return;
    }
    if (isLocalName(h)) throw new PrivateAddressError(h, 'is a local name');
    const lookup = this.lookupImpl;
    if (!lookup) return;
    let p = this.resolved.get(h);
    if (!p) {
      p = (async () => {
        let addrs: string[];
        try { addrs = await lookup(h); } catch (e) {
          throw new NetworkError(`https://${h}/`, errCode(e), 'the host name does not resolve');
        }
        const bad = addrs.find((a) => isPrivateAddress(a));
        if (bad) throw new PrivateAddressError(h, `resolves to the local address ${bad}`);
      })();
      this.resolved.set(h, p);
    }
    await p;
  }

  /** One GET with every rule applied. Returns only a 2xx answer; everything else throws a typed error. */
  async fetchOk(url: string, opts: RequestOptions = {}): Promise<HttpResult> {
    const accept = opts.accept ?? 'application/json';
    let real: URL;
    try { real = new URL(url); } catch { throw new HttpError(0, url, `not a URL: ${url}`); }
    if (real.protocol !== 'http:' && real.protocol !== 'https:') throw new HttpError(0, url, `only http and https are fetched, not ${real.protocol}`);
    const forbidden = forbiddenHostOf(real.hostname, this.allowHeldBack);
    if (forbidden) throw forbidden.kind === 'held_back' ? new HeldBackHostError(real.hostname, forbidden) : new DeniedHostError(real.hostname, forbidden);
    let target = url;
    let mapped = false;
    if (opts.origin) {
      const o = loopbackOrigin(opts.origin);
      if (!o) throw new HostMapError(`a board origin must be a loopback http(s) origin (a mock server on this computer): ${opts.origin}`);
      target = o + real.pathname + real.search;
      mapped = true;
    } else {
      const m = this.hostMap[real.host.toLowerCase()];
      if (m) { target = m + real.pathname + real.search; mapped = true; }
    }
    const u = new URL(target);
    const host = u.host;
    if (!mapped) await this.checkAddress(u.hostname);
    if (this.tripped.has(host)) throw new HostTrippedError(host);
    this.seedFromState(host);
    const waitMs = this.pacer.blockedUntil(host) - this.pacer.clock();
    if (waitMs > this.maxRetryAfterMs) throw new HostWaitError(host, this.pacer.blockedUntil(host), 'it asked jobleft to slow down');
    const rules = await this.robotsFor(u.origin, host, opts.signal);
    if (rules.problem) throw new RobotsError(target, rules.problem, false);
    if (!rules.allows(u.pathname + u.search)) throw new RobotsError(target, `${u.pathname} is disallowed`, true);
    let lastErr: unknown = null;
    let waitedForRetryAfter = false;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0 && this.retryDelayMs > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
      if (opts.signal?.aborted) throw new AbortedError(target);
      await this.pacer.wait(host, rules.crawlDelayMs);
      const headers = this.baseHeaders(accept);
      const v = opts.validators;
      if (v && v.url === url) {
        if (v.etag) headers['if-none-match'] = v.etag;
        if (v.lastModified) headers['if-modified-since'] = v.lastModified;
      }
      let r: RawReply;
      try {
        r = await this.rawRequest(target, headers, real.host, host, this.timeoutMs, opts.signal);
      } catch (e) {
        if (e instanceof NetworkError || e instanceof CutOffError) { lastErr = e; continue; } // transient: retry
        throw e; // timeout, too large, budget, stopped: no retry
      }
      const s = r.status;
      if (s >= 200 && s < 300) {
        this.blockedRun.set(host, 0);
        return {
          url, status: s, body: r.body, contentType: r.headers.get('content-type') ?? '',
          etag: r.headers.get('etag'), lastModified: r.headers.get('last-modified'),
        };
      }
      if (s === 304) {
        if (v && v.url === url) throw new NotModifiedError(url);
        throw new HttpError(304, url, `unexpected 304 without a conditional request from ${url}`);
      }
      if (s >= 300 && s < 400) throw new RedirectError(s, target, r.headers.get('location') ?? '', this.allowHeldBack);
      const retryAfter = parseRetryAfter(r.headers.get('retry-after'), Date.now());
      if ((s === 429 || s === 503) && retryAfter !== null) {
        const until = this.pacer.clock() + retryAfter;
        if (retryAfter <= this.maxRetryAfterMs && !waitedForRetryAfter) {
          // The host named a short wait: honour it, then try this request once more.
          waitedForRetryAfter = true;
          this.holdHost(host, until, `HTTP ${s} with Retry-After ${Math.round(retryAfter / 1000)} s`);
          attempt--; // the wait does not use up a retry
          continue;
        }
        this.holdHost(host, until, `HTTP ${s} with Retry-After ${Math.round(retryAfter / 1000)} s`);
        if (s === 503) throw new HostWaitError(host, until, `HTTP 503 with Retry-After ${Math.round(retryAfter / 1000)} s`);
      }
      if (s === 403 || s === 429) {
        const n = (this.blockedRun.get(host) ?? 0) + 1;
        this.blockedRun.set(host, n);
        if (s === 429 && retryAfter === null) this.holdHost(host, this.pacer.clock() + this.defaultRetryAfterMs, 'HTTP 429 without Retry-After');
        if (n >= 2) {
          this.tripped.add(host);
          this.holdHost(host, this.pacer.clock() + this.tripWaitMs, `HTTP ${s} twice in a row`);
        }
        throw new BlockedError(s, url);
      }
      if (s === 404 || s === 410) throw new NotFoundError(s, url);
      if (s >= 500) { lastErr = new HttpError(s, url); continue; }
      throw new HttpError(s, url);
    }
    throw lastErr instanceof Error ? lastErr : new Error(`request failed: ${url}`);
  }

  async getText(url: string, accept = 'application/json', opts: RequestOptions = {}): Promise<string> {
    return (await this.fetchOk(url, { ...opts, accept })).body;
  }

  async getJson(url: string, opts: RequestOptions = {}): Promise<unknown> {
    const r = await this.fetchOk(url, { ...opts, accept: 'application/json' });
    return parseJobJson(r);
  }
}

/** Reads a JSON reply, naming the problem when it is not JSON: a web page, a cut-off reply or broken data. */
export function parseJobJson(r: HttpResult): unknown {
  const ct = r.contentType.toLowerCase();
  const head = r.body.trimStart().slice(0, 200).toLowerCase();
  if (ct.includes('html') || head.startsWith('<!doctype') || head.startsWith('<html') || (head.startsWith('<') && !head.startsWith('<?xml'))) {
    throw new NotJobDataError(r.url, 'web_page', `the reply is a web page (${ct || 'no content type'}), not job data`);
  }
  if (r.body.trim() === '') throw new NotJobDataError(r.url, 'broken', 'the reply is empty');
  try { return JSON.parse(r.body); } catch (e) {
    const msg = (e as Error).message;
    const cut = /unexpected end|unterminated|end of (json )?input/i.test(msg);
    throw new NotJobDataError(r.url, cut ? 'cut_off' : 'broken', cut ? `the reply stops before the job data is complete (${msg})` : `the reply is not valid JSON (${msg})`);
  }
}

// ---------------------------------------------------------------------------------------------------- per board

export interface BoardHttpOptions {
  /** A loopback mock origin for every request of this board. */
  origin?: string | null;
  /** Validators of the last proven reading; sent with the FIRST request only (single-request adapters). */
  validators?: Validators | null;
  signal?: AbortSignal;
  /** Most requests this board may make (paged adapters). Default 200. */
  maxRequests?: number;
}

/** What one board's adapter sees of the network. Records the validators of its first reply. */
export class BoardHttp implements HttpGetter {
  readonly client: HttpClient;
  requests = 0;
  /** Bytes of the replies this board read. */
  bytes = 0;
  /** Validators of the first reply (for the next conditional request). */
  validators: Validators | null = null;
  private opts: BoardHttpOptions;
  constructor(client: HttpClient, opts: BoardHttpOptions = {}) {
    this.client = client;
    this.opts = opts;
  }
  private async fetch(url: string, accept: string): Promise<HttpResult> {
    const max = this.opts.maxRequests ?? 200;
    if (this.requests >= max) throw new BudgetError(max);
    this.requests++;
    const first = this.requests === 1;
    const r = await this.client.fetchOk(url, {
      accept, signal: this.opts.signal, origin: this.opts.origin ?? null, validators: first ? this.opts.validators ?? null : null,
    });
    if (first) this.validators = { url, etag: r.etag, lastModified: r.lastModified };
    this.bytes += r.body.length;
    return r;
  }
  async getText(url: string, accept = 'application/json'): Promise<string> { return (await this.fetch(url, accept)).body; }
  async getJson(url: string): Promise<unknown> { return parseJobJson(await this.fetch(url, 'application/json')); }
}
