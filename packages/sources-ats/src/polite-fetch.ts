// A fetch wrapper the CLI passes to the crawler's HttpClient as `fetchImpl`. It adds these rules on top of the client's
// own (User-Agent, pacer, robots.txt, never-crawl list, no redirects):
//   1. One pace per host, kept here as well: at least `minGapMs` (1 s, plus a 100 ms margin) between the SENDING of any two requests to
//      one host, or the robots.txt Crawl-delay when that is longer. Slots are reserved before any waiting, so queued
//      requests leave one after the other, also right after a Retry-After wait (the crawler's pacer counts from the
//      time it handed the request over, not from the time the request left).
//   2. Retry-After: after a 429 or 503 that carries Retry-After, no request goes to that host until the time has
//      passed. A wait up to `maxWaitMs` is slept; a longer one fails the request at once (the board waits for a
//      later run) instead of holding the whole crawl.
//   3. Crawl-delay: read from each robots.txt answer that passes through. A delay longer than `maxWaitMs` fails the
//      request at once with that reason; a shorter one is slept.
//   4. Never-contact hosts: a request to LinkedIn, Indeed, Glassdoor, SmartRecruiters, Workday, iCIMS, Oracle, UKG or
//      Taleo is refused before it leaves, even if some code asked for it.
//   5. The waiting never counts against the caller's request timeout: after a wait the request gets a fresh timeout.
//   6. The body is read here with a size limit while it streams, so an endless answer stops at the limit (memory
//      never holds more than the limit). A body that declares Latin-1 or another charset is turned into UTF-8.
//   7. A robots.txt that could not be read (no connection, HTTP 5xx) is remembered with its true reason, so the
//      report does not say "robots.txt disallows this feed" (see `robotsProblemFor`).
// It can also report every request (time, host, status) to a log callback. It never adds or changes a header.

import { HttpError, parseRobots, PRODUCT_TOKEN } from '@jobleft/crawler';
import { neverContactHost } from './detect.ts';

export interface PoliteFetchOptions {
  fetchImpl?: typeof fetch;
  /** Longest Retry-After or Crawl-delay wait that is slept. Longer waits fail the request at once. Default 60 s. */
  maxWaitMs?: number;
  /** Least time between the sending of two requests to one host. Default 1000 ms. */
  minGapMs?: number;
  /** Added to every gap, so timer and network jitter never brings two requests less than the gap apart at the host. Default 100 ms. */
  marginMs?: number;
  /** Longest body that is read. Default 64 MiB (the crawler's own limit). */
  maxBodyBytes?: number;
  /** Timeout given to a request after it has waited. Set it to the HttpClient's timeoutMs. Default 20 s (the crawler's default). */
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** `at` is when the answer came back; `sentAtMs` is when the request left (epoch ms; absent when it was refused before leaving). */
  onRequest?: (e: { at: string; url: string; host: string; status: number | null; waitedMs: number; error?: string; sentAtMs?: number }) => void;
}

class RetryAfterError extends Error {
  constructor(host: string, seconds: number) {
    super(`blocked: HTTP 429 (Retry-After asks for ${seconds} s more on ${host})`);
    this.name = 'RetryAfterError';
  }
}
class CrawlDelayError extends Error {
  constructor(host: string, seconds: number, maxSeconds: number) {
    super(`robots.txt on ${host} asks for ${seconds} s between requests (Crawl-delay), longer than the ${maxSeconds} s jobleft waits`);
    this.name = 'CrawlDelayError';
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

// robots.txt problems by host, as politeFetch saw them. The crawler treats an unreadable robots.txt as "disallow all"
// (RFC 9309) and reports "path is disallowed"; the report asks here for the real reason.
const robotsProblems = new Map<string, string>();

/** The true reason a host's robots.txt could not be read, from a URL or host, or null. */
export function robotsProblemFor(urlOrHost: string): string | null {
  let host = urlOrHost;
  try { host = new URL(urlOrHost).host; } catch { /* already a host */ }
  return robotsProblems.get(host.toLowerCase()) ?? null;
}
export function resetRobotsProblems(): void { robotsProblems.clear(); }

function isTimeout(reason: unknown): boolean {
  return !!reason && typeof reason === 'object' && (reason as { name?: string }).name === 'TimeoutError';
}

/** The request's signal after a wait: the caller's own time-out already ran during the wait, so it gets a fresh one. */
function signalAfterWait(orig: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const fresh = AbortSignal.timeout(timeoutMs);
  if (!orig) return fresh;
  if (orig.aborted && !isTimeout(orig.reason)) return orig; // the caller cancelled: keep that
  const external = new AbortController();
  orig.addEventListener('abort', () => { if (!isTimeout(orig.reason)) external.abort(orig.reason); }, { once: true });
  return AbortSignal.any([fresh, external.signal]);
}

/**
 * The crawler decodes every answer as UTF-8. A feed that says it is Latin-1 (Content-Type charset, or the XML
 * declaration) is turned into UTF-8 here, so "Zürich" is not read as "Z\uFFFDrich". UTF-8 and unknown labels pass unchanged.
 */
function toUtf8(body: Uint8Array, contentType: string | null): Uint8Array {
  let label = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  if (!label) label = /^\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(new TextDecoder('latin1').decode(body.subarray(0, 200)))?.[1];
  if (!label || /^utf-?8$/i.test(label)) return body;
  try {
    return new TextEncoder().encode(new TextDecoder(label).decode(body));
  } catch { return body; }
}

/** Reads the body up to `limit` bytes while it streams. Throws an HttpError (no retry) as soon as the limit is passed. */
async function limitBody(res: Response, url: string, limit: number): Promise<Response> {
  const declared = parseInt(res.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpError(res.status, url, `body too large: ${declared}`);
  }
  if (!res.body) return res;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(res.status, url, `body too large: over ${limit}`);
    }
    chunks.push(value);
  }
  let body: Uint8Array = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { body.set(c, at); at += c.byteLength; }
  body = toUtf8(body, res.headers.get('content-type'));
  return new Response(total === 0 ? null : (body as unknown as ConstructorParameters<typeof Response>[0]), { status: res.status, statusText: res.statusText, headers: res.headers });
}

export function politeFetch(opts: PoliteFetchOptions = {}): typeof fetch {
  const base = opts.fetchImpl ?? fetch;
  const maxWait = opts.maxWaitMs ?? 60_000;
  const minGap = opts.minGapMs ?? 1000;
  const margin = opts.marginMs ?? 100;
  const maxBody = opts.maxBodyBytes ?? 64 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const notBefore = new Map<string, number>();
  const crawlDelay = new Map<string, number>();
  const nextFree = new Map<string, number>();
  // The latest moment at which the host is known to have seen a request from us: the send, then the answer's arrival.
  const lastMark = new Map<string, number>();
  const gapOf = (host: string): number => Math.max(minGap, crawlDelay.get(host) ?? 0) + margin;

  /** Reserves the next send time for a host, at once (so concurrent callers queue in order). */
  const reserve = (host: string): number => {
    const start = Math.max(now(), notBefore.get(host) ?? 0, nextFree.get(host) ?? 0);
    nextFree.set(host, start + gapOf(host));
    return start;
  };

  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    const host = u.host.toLowerCase();
    const isRobots = u.pathname === '/robots.txt';
    const never = neverContactHost(u.hostname);
    if (never) {
      opts.onRequest?.({ at: new Date(now()).toISOString(), url, host, status: null, waitedMs: 0, error: 'refused: never-contact host' });
      throw new NeverHostError(u.hostname, never.name);
    }
    const t0 = now();
    const delay = crawlDelay.get(host) ?? 0;
    if (delay > maxWait && !isRobots) {
      opts.onRequest?.({ at: new Date(t0).toISOString(), url, host, status: null, waitedMs: 0, error: 'refused: Crawl-delay too long' });
      throw new CrawlDelayError(host, Math.ceil(delay / 1000), Math.floor(maxWait / 1000));
    }
    const hold = (notBefore.get(host) ?? 0) - t0;
    if (hold > maxWait) {
      opts.onRequest?.({ at: new Date(t0).toISOString(), url, host, status: null, waitedMs: 0, error: 'refused: Retry-After not over' });
      throw new RetryAfterError(host, Math.ceil(hold / 1000));
    }

    let start = reserve(host);
    let waited = 0;
    for (;;) {
      const t = now();
      // The slot is a place in the queue; the real rule is measured from what the host last saw, so a timer that woke
      // late, or a slow connection set-up, never brings two requests closer than the gap.
      const earliest = Math.max(start, (lastMark.get(host) ?? -Infinity) + gapOf(host));
      if (earliest > t) { await sleep(earliest - t); waited += earliest - t; continue; } // a timer may fire a little early: check again
      // A 429 that came back while this request slept moves the earliest time: take a new slot after it.
      if ((notBefore.get(host) ?? 0) > start) { start = reserve(host); continue; }
      break;
    }
    const sentAtMs = now();
    lastMark.set(host, sentAtMs);

    let callInit = init;
    if (waited > 0) callInit = { ...init, signal: signalAfterWait(init?.signal, timeoutMs) };
    try {
      let res = await base(input, callInit);
      lastMark.set(host, now());
      res = await limitBody(res, url, maxBody);
      if (isRobots) {
        if (res.status >= 200 && res.status < 300) {
          robotsProblems.delete(host);
          try {
            const rules = parseRobots(await res.clone().text(), PRODUCT_TOKEN);
            if (rules.crawlDelayMs > 0) {
              crawlDelay.set(host, rules.crawlDelayMs);
              // The delay counts from the robots.txt request itself, so the next request waits for it too.
              nextFree.set(host, Math.max(nextFree.get(host) ?? 0, start + rules.crawlDelayMs + margin));
            } else crawlDelay.delete(host);
          } catch { /* an unreadable robots.txt changes nothing here; the crawler decides what it means */ }
        } else if (res.status >= 500) {
          robotsProblems.set(host, `robots.txt could not be read (HTTP ${res.status}), and the rules say an unreadable robots.txt means "do not crawl", so nothing was requested`);
        } else {
          robotsProblems.delete(host);
        }
      }
      if (res.status === 429 || res.status === 503) {
        const ms = retryAfterMs(res.headers.get('retry-after'), now());
        if (ms !== null) notBefore.set(host, Math.max(notBefore.get(host) ?? 0, now() + ms));
      }
      opts.onRequest?.({ at: new Date(now()).toISOString(), url, host, status: res.status, waitedMs: waited, sentAtMs });
      return res;
    } catch (e) {
      lastMark.set(host, now());
      if (isRobots && !(e instanceof HttpError)) {
        robotsProblems.set(host, `could not connect to ${host} to read robots.txt, so nothing was requested (an unreadable robots.txt means "do not crawl")`);
      }
      opts.onRequest?.({ at: new Date(now()).toISOString(), url, host, status: null, waitedMs: waited, error: e instanceof Error ? e.name : String(e), sentAtMs });
      throw e;
    }
  };
  return wrapped as typeof fetch;
}
