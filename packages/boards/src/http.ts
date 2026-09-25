// The polite network layer for every board action. It wraps the crawler's HttpClient (User-Agent, robots.txt,
// never-crawl list, retries) and adds what the boards lane needs on top:
//
//   * SqlitePacer: the request schedule per host lives in the database (table host_pacing), so pastes, refreshes
//     and several jobleft processes together still send at most 1 request per second to a host;
//   * Retry-After: a 429 or 503 with a wait time pushes the host's next slot back by at least that time;
//   * a second forbidden-host check inside fetch itself (iCIMS, Oracle, UKG, Taleo are not on the crawler's list);
//   * redirects are never followed automatically; their Location is recorded so the resolver can check the target
//     (forbidden host? a board?) before it decides to send anything there;
//   * JOBLEFT_OFFLINE=1: no request at all.

import { DatabaseSync } from 'node:sqlite';
import { HttpClient, Pacer, USER_AGENT } from '@jobleft/crawler';
import { forbiddenProvider } from './hosts.ts';

export class OfflineError extends Error {
  constructor() { super('offline: JOBLEFT_OFFLINE=1, no request sent'); this.name = 'OfflineError'; }
}
export class ForbiddenHostError extends Error {
  host: string; provider: string;
  constructor(host: string, provider: string) { super(`host is on the forbidden list (${provider}): ${host}`); this.name = 'ForbiddenHostError'; this.host = host; this.provider = provider; }
}
export class HostBusyError extends Error {
  host: string; until: number;
  constructor(host: string, until: number) {
    super(`host ${host} asked jobleft to wait until ${new Date(until).toISOString()}`);
    this.name = 'HostBusyError'; this.host = host; this.until = until;
  }
}

/** A pacer that also honours "busy until" times (Retry-After). In memory: one process only. */
export class BusyPacer extends Pacer {
  protected busy = new Map<string, number>();
  maxWaitMs: number;
  constructor(intervalMs = 1000, maxWaitMs = 5 * 60_000) { super(intervalMs); this.maxWaitMs = maxWaitMs; }
  markBusy(host: string, untilMs: number): void { this.busy.set(host, Math.max(this.busy.get(host) ?? 0, untilMs)); }
  busyUntil(host: string): number { return this.busy.get(host) ?? 0; }
  override async wait(host: string, extraIntervalMs = 0): Promise<void> {
    const until = this.busyUntil(host);
    const t = Date.now();
    if (until - t > this.maxWaitMs) throw new HostBusyError(host, until);
    if (until > t) await new Promise((r) => setTimeout(r, until - t));
    await super.wait(host, extraIntervalMs);
  }
}

/**
 * The request schedule per host, kept in the database so every jobleft process shares it. Each reservation is one
 * short IMMEDIATE transaction on its own connection. Pacing uses real time, never the test clock.
 */
export class SqlitePacer extends BusyPacer {
  private db: DatabaseSync;
  constructor(dbPath: string, intervalMs = 1000, maxWaitMs = 5 * 60_000) {
    super(intervalMs, maxWaitMs);
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS host_pacing (host TEXT PRIMARY KEY, next_at INTEGER NOT NULL DEFAULT 0, busy_until INTEGER NOT NULL DEFAULT 0)`);
  }
  close(): void { try { this.db.close(); } catch { /* already closed */ } }
  override markBusy(host: string, untilMs: number): void {
    this.db.prepare(`INSERT INTO host_pacing (host, next_at, busy_until) VALUES (?, 0, ?)
      ON CONFLICT(host) DO UPDATE SET busy_until = max(busy_until, excluded.busy_until)`).run(host, Math.round(untilMs));
  }
  override busyUntil(host: string): number {
    const r = this.db.prepare('SELECT busy_until FROM host_pacing WHERE host = ?').get(host) as { busy_until: number } | undefined;
    return Number(r?.busy_until ?? 0);
  }
  override async wait(host: string, extraIntervalMs = 0): Promise<void> {
    const gap = Math.max(this.intervalMs, extraIntervalMs);
    let start = 0, t = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const r = this.db.prepare('SELECT next_at, busy_until FROM host_pacing WHERE host = ?').get(host) as { next_at: number; busy_until: number } | undefined;
          t = Date.now();
          const busy = Number(r?.busy_until ?? 0);
          if (busy - t > this.maxWaitMs) { this.db.exec('ROLLBACK'); throw new HostBusyError(host, busy); }
          start = Math.max(t, Number(r?.next_at ?? 0), busy);
          this.db.prepare(`INSERT INTO host_pacing (host, next_at, busy_until) VALUES (?, ?, 0)
            ON CONFLICT(host) DO UPDATE SET next_at = excluded.next_at`).run(host, start + gap);
          this.db.exec('COMMIT');
        } catch (e) {
          try { this.db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
          throw e;
        }
        break;
      } catch (e) {
        if (e instanceof HostBusyError) throw e;
        if (attempt >= 50) throw e;
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
      }
    }
    if (start > t) await new Promise((r) => setTimeout(r, start - t));
  }
}

/** Where 3xx answers pointed (request URL -> Location), for the resolver. */
export class RedirectLog {
  private m = new Map<string, string>();
  set(url: string, location: string): void {
    this.m.set(url, location);
    if (this.m.size > 500) this.m.delete(this.m.keys().next().value!);
  }
  get(url: string): string | undefined { return this.m.get(url); }
}

/** What a client made by createBoardHttp saw: redirect targets and the robots.txt fetch outcome per host. */
export interface BoardHttpState {
  redirects: RedirectLog;
  /** Per requested host (after the host map): the robots.txt answer, or the network error that stopped it. */
  robots: Map<string, { status: number | null; error: string | null }>;
  pacer: BusyPacer;
}

const STATE = new WeakMap<HttpClient, BoardHttpState>();
/** The state of a client made by createBoardHttp (undefined for other clients). */
export function httpStateFor(http: HttpClient): BoardHttpState | undefined { return STATE.get(http); }
/** The redirect log of a client made by createBoardHttp (undefined for other clients). */
export function redirectLogFor(http: HttpClient): RedirectLog | undefined { return STATE.get(http)?.redirects; }

/** A short code for a network failure: ENOTFOUND, ECONNREFUSED, TIMEOUT, ... */
export function networkCode(e: unknown): string {
  const err = e as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  if (err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError') return 'TIMEOUT';
  if (err?.name === 'AbortError') return 'TIMEOUT';
  return String(err?.cause?.code ?? err?.code ?? err?.name ?? 'NETWORK');
}

function retryAfterMs(v: string | null, now: number): number | null {
  if (!v) return null;
  const s = Number(v.trim());
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - now) : null;
}

export interface BoardHttpOptions {
  /** The pacer every client shares (SqlitePacer for the app and the CLI, BusyPacer in tests). */
  pacer: BusyPacer;
  hostMap?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRequests?: number;
  /** Largest reply read (default 32 MiB; a bigger board list or page is refused, never read into memory whole). */
  maxBodyBytes?: number;
  retries?: number;
  retryDelayMs?: number;
  /** JOBLEFT_OFFLINE: when this returns true, no request is sent. */
  offline?: () => boolean;
  /** Called once per request actually sent (host and status only; no personal data). */
  onRequest?: (info: { host: string; status: number; url: string }) => void;
}

/** A polite HttpClient for board work. Every client made here shares the pacer, so the per-host limit holds. */
export function createBoardHttp(opts: BoardHttpOptions): HttpClient {
  const base = opts.fetchImpl ?? fetch;
  const log = new RedirectLog();
  const robots = new Map<string, { status: number | null; error: string | null }>();
  const reverse = new Map<string, string>();
  for (const [real, origin] of Object.entries(opts.hostMap ?? {})) { try { reverse.set(new URL(origin).host, real.toLowerCase()); } catch { /* checked by the client */ } }
  const wrapped: typeof fetch = async (input, init) => {
    if (opts.offline?.()) throw new OfflineError();
    const url = new URL(String(input instanceof Request ? input.url : input));
    const forbidden = forbiddenProvider(url.hostname);
    if (forbidden) throw new ForbiddenHostError(url.hostname, forbidden);
    const headers = new Headers(init?.headers);
    headers.set('user-agent', USER_AGENT);
    const isRobots = url.pathname === '/robots.txt';
    let res: Response;
    try {
      res = await base(url.href, { ...init, headers, redirect: 'manual', referrerPolicy: 'no-referrer' });
    } catch (e) {
      if (isRobots) { const v = { status: null, error: networkCode(e) }; robots.set(url.host, v); const real = reverse.get(url.host); if (real) robots.set(real, v); }
      throw e;
    }
    if (isRobots) { const v = { status: res.status, error: null }; robots.set(url.host, v); const real = reverse.get(url.host); if (real) robots.set(real, v); }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc) log.set(url.href, loc);
    }
    if (res.status === 429 || res.status === 503) {
      const wait = retryAfterMs(res.headers.get('retry-after'), Date.now());
      if (wait !== null) {
        opts.pacer.markBusy(url.host, Date.now() + wait);
        // Under a host map, remember it for the real host name too (the scheduler plans by real host names).
        const real = reverse.get(url.host);
        if (real) opts.pacer.markBusy(real, Date.now() + wait);
      }
    }
    opts.onRequest?.({ host: url.host, status: res.status, url: url.href });
    return res;
  };
  const http = new HttpClient({
    fetchImpl: wrapped,
    pacer: opts.pacer,
    hostMap: opts.hostMap ?? {},
    timeoutMs: opts.timeoutMs ?? 15_000,
    maxRequests: opts.maxRequests ?? 20_000,
    maxBodyBytes: opts.maxBodyBytes ?? 32 * 1024 * 1024,
    retries: opts.retries ?? 1,
    retryDelayMs: opts.retryDelayMs ?? 500,
  });
  STATE.set(http, { redirects: log, robots, pacer: opts.pacer });
  return http;
}

/** Truthy JOBLEFT_OFFLINE. */
export function offlineFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.JOBLEFT_OFFLINE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}
