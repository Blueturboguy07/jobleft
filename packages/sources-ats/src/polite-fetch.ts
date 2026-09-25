// A fetch wrapper the CLI passes to the crawler's HttpClient as `fetchImpl`. It adds three rules on top of the client's
// own (User-Agent, pacer, robots.txt, never-crawl list, no redirects):
//   1. Retry-After: after a 429 or 503 that carries Retry-After, no request goes to that host until the time has
//      passed. A wait up to `maxWaitMs` is slept; a longer one fails the request at once (the board waits for a
//      later run) instead of holding the whole crawl.
//   2. Never-contact hosts: a request to LinkedIn, Indeed, Glassdoor, SmartRecruiters, Workday, iCIMS, Oracle, UKG or
//      Taleo is refused before it leaves, even if some code asked for it.
//   3. Crawl-delay: it reads each robots.txt answer that passes through it and keeps that delay between EVERY two
//      requests to the host, including the first request after robots.txt (the crawler's pacer applies the delay
//      only from the second feed request on).
// It can also report every request (time, host, status) to a log callback. It never adds or changes a header.

import { parseRobots, PRODUCT_TOKEN } from '@jobleft/crawler';
import { neverContactHost } from './detect.ts';

export interface PoliteFetchOptions {
  fetchImpl?: typeof fetch;
  /** Longest Retry-After wait that is slept. Longer waits fail the request at once. Default 60 s. */
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRequest?: (e: { at: string; url: string; host: string; status: number | null; waitedMs: number; error?: string }) => void;
}

class RetryAfterError extends Error {
  constructor(host: string, seconds: number) {
    super(`blocked: HTTP 429 (Retry-After asks for ${seconds} s more on ${host})`);
    this.name = 'RetryAfterError';
  }
}
class NeverHostError extends Error {
  constructor(host: string, name: string) {
    super(`host is on the never-crawl list: ${host} (${name})`);
    this.name = 'DeniedHostError';
  }
}

/** Seconds from a Retry-After header (delta seconds or an HTTP date), or null. */
export function retryAfterMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  if (Number.isFinite(t)) return Math.max(0, t - now);
  return null;
}

export function politeFetch(opts: PoliteFetchOptions = {}): typeof fetch {
  const base = opts.fetchImpl ?? fetch;
  const maxWait = opts.maxWaitMs ?? 60_000;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const notBefore = new Map<string, number>();
  const crawlDelay = new Map<string, number>();
  const lastSent = new Map<string, number>();

  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    const host = u.host.toLowerCase();
    const never = neverContactHost(u.hostname);
    if (never) {
      opts.onRequest?.({ at: new Date(now()).toISOString(), url, host, status: null, waitedMs: 0, error: 'refused: never-contact host' });
      throw new NeverHostError(u.hostname, never.name);
    }
    let waited = 0;
    const delay = crawlDelay.get(host) ?? 0;
    const last = lastSent.get(host);
    const until = Math.max(notBefore.get(host) ?? 0, delay > 0 && last !== undefined ? last + delay : 0);
    const t0 = now();
    if (until > t0) {
      const ms = until - t0;
      if (ms > maxWait && (notBefore.get(host) ?? 0) > t0) {
        opts.onRequest?.({ at: new Date(t0).toISOString(), url, host, status: null, waitedMs: 0, error: 'refused: Retry-After not over' });
        throw new RetryAfterError(host, Math.ceil(ms / 1000));
      }
      await sleep(ms);
      waited = ms;
    }
    lastSent.set(host, now());
    try {
      const res = await base(input, init);
      if (u.pathname === '/robots.txt' && res.status >= 200 && res.status < 300) {
        try {
          const rules = parseRobots(await res.clone().text(), PRODUCT_TOKEN);
          if (rules.crawlDelayMs > 0) crawlDelay.set(host, rules.crawlDelayMs);
        } catch { /* an unreadable robots.txt changes nothing here; the crawler decides what it means */ }
      }
      if (res.status === 429 || res.status === 503) {
        const ms = retryAfterMs(res.headers.get('retry-after'), now());
        if (ms !== null) notBefore.set(host, Math.max(notBefore.get(host) ?? 0, now() + ms));
      }
      opts.onRequest?.({ at: new Date(now()).toISOString(), url, host, status: res.status, waitedMs: waited });
      return res;
    } catch (e) {
      opts.onRequest?.({ at: new Date(now()).toISOString(), url, host, status: null, waitedMs: waited, error: e instanceof Error ? e.name : String(e) });
      throw e;
    }
  };
  return wrapped as typeof fetch;
}
