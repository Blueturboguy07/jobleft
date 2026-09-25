// The polite HTTP client of this package's own commands (dataset builds, the company-facts CLI, the release
// updater). The app server passes its own client (the crawler's HttpClient) to CompanyFacts instead.
//
// Rules: a fixed User-Agent that carries no personal data; at most one request per second per host; robots.txt is
// read and obeyed; https only, except loopback addresses (local mock servers); JOBLEFT_HOST_MAP can send a real host
// to a loopback mock origin; JOBLEFT_OFFLINE=1 sends nothing; a request budget stops runaway loops.

/** Same value as USER_AGENT in @jobleft/crawler (static-data may not import the crawler). */
export const USER_AGENT = 'jobleft-build/0.1 (research build; no personal data)';
export const PRODUCT_TOKEN = 'jobleft-build';

export class OfflineError extends Error {
  constructor() { super('offline: JOBLEFT_OFFLINE=1 is set, so no request was sent'); this.name = 'OfflineError'; }
}
export class RobotsDeniedError extends Error {
  constructor(url: string) { super(`robots.txt of ${new URL(url).host} does not allow ${new URL(url).pathname}`); this.name = 'RobotsDeniedError'; }
}
export class HttpStatusError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  constructor(url: string, status: number, retryAfterSeconds: number | null) {
    super(`HTTP ${status} from ${new URL(url).host}${new URL(url).pathname}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** Parses JOBLEFT_HOST_MAP: {"real.host": "http://127.0.0.1:4010"}. Targets must be loopback. */
export function hostMapFromEnv(env: Record<string, string | undefined> = process.env): Map<string, URL> {
  const raw = env.JOBLEFT_HOST_MAP;
  const out = new Map<string, URL>();
  if (!raw) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('JOBLEFT_HOST_MAP is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('JOBLEFT_HOST_MAP must be a JSON object');
  for (const [host, target] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof target !== 'string') throw new Error(`JOBLEFT_HOST_MAP: the target of ${host} is not a string`);
    const u = new URL(target);
    if (!isLoopbackHost(u.hostname)) throw new Error(`JOBLEFT_HOST_MAP: ${host} must map to a loopback address, not ${u.host}`);
    out.set(host.toLowerCase(), u);
  }
  return out;
}

interface RobotsRules { allows(path: string): boolean; crawlDelayMs: number }

/** A small robots.txt reader: the group for our product token, else "*"; longest match wins; Allow wins ties. */
export function parseRobots(body: string, token: string = PRODUCT_TOKEN): RobotsRules {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }>; delay: number }> = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [], delay: 0 }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      if (field === 'disallow' && value === '') continue;
      current.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay') {
      const d = Number(value);
      if (Number.isFinite(d) && d > 0) current.delay = Math.min(d, 60) * 1000;
    }
  }
  const t = token.toLowerCase();
  const group = groups.find((g) => g.agents.some((a) => a !== '*' && t.startsWith(a))) ?? groups.find((g) => g.agents.includes('*'));
  const rules = group?.rules ?? [];
  const matches = (pattern: string, path: string): number => {
    const anchored = pattern.endsWith('$');
    const body2 = anchored ? pattern.slice(0, -1) : pattern;
    const re = new RegExp('^' + body2.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
    return re.test(path) ? pattern.length : -1;
  };
  return {
    crawlDelayMs: group?.delay ?? 0,
    allows(path: string): boolean {
      let best = -1;
      let allow = true;
      for (const r of rules) {
        const len = matches(r.path, path);
        if (len > best || (len === best && r.allow)) { if (len >= 0) { best = len; allow = r.allow; } }
      }
      return allow;
    },
  };
}

export interface PoliteFetchOptions {
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  timeoutMs?: number;
  maxRequests?: number;
  respectRobots?: boolean;
  hostMap?: Map<string, URL>;
  offline?: boolean;
  /** Called once per request that leaves the process (for logs and tests). */
  onRequest?: (info: { method: string; url: string }) => void;
}

/** Polite fetch with per-host pacing and robots.txt. One instance per process is enough. */
export class PoliteFetch {
  readonly #fetch: typeof fetch;
  readonly #interval: number;
  readonly #timeout: number;
  readonly #max: number;
  readonly #robotsOn: boolean;
  readonly #hostMap: Map<string, URL>;
  readonly #offline: boolean;
  readonly #onRequest: PoliteFetchOptions['onRequest'];
  readonly #nextAt = new Map<string, number>();
  readonly #robots = new Map<string, Promise<RobotsRules>>();
  #count = 0;

  constructor(opts: PoliteFetchOptions = {}) {
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
    this.#interval = opts.intervalMs ?? 1000;
    this.#timeout = opts.timeoutMs ?? 30_000;
    this.#max = opts.maxRequests ?? 1500;
    this.#robotsOn = opts.respectRobots ?? true;
    this.#hostMap = opts.hostMap ?? hostMapFromEnv();
    this.#offline = opts.offline ?? process.env.JOBLEFT_OFFLINE === '1';
    this.#onRequest = opts.onRequest;
  }

  get requestCount(): number { return this.#count; }

  /** The URL the request really goes to (a loopback mock when the host map names the host). */
  target(url: string): URL {
    const u = new URL(url);
    const mapped = this.#hostMap.get(u.host.toLowerCase()) ?? this.#hostMap.get(u.hostname.toLowerCase());
    if (!mapped) return u;
    return new URL(u.pathname + u.search, mapped);
  }

  async #pace(host: string, extraMs: number): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.#nextAt.get(host) ?? 0);
    this.#nextAt.set(host, at + Math.max(this.#interval, extraMs));
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }

  async #raw(method: string, target: URL, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    if (this.#offline) throw new OfflineError();
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && isLoopbackHost(target.hostname))) {
      throw new Error(`refused: ${target.protocol}//${target.host} is not https (plain http is allowed only for loopback mocks)`);
    }
    if (this.#count >= this.#max) throw new Error(`request budget of ${this.#max} used up`);
    this.#count += 1;
    this.#onRequest?.({ method, url: target.toString() });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${this.#timeout} ms`)), this.#timeout);
    const onAbort = () => ctrl.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.#fetch(target, {
        method,
        headers: { 'user-agent': USER_AGENT, ...headers },
        redirect: 'follow',
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #rules(target: URL): Promise<RobotsRules> {
    const key = target.origin;
    let p = this.#robots.get(key);
    if (!p) {
      p = (async () => {
        await this.#pace(target.host, 0);
        try {
          const res = await this.#raw('GET', new URL('/robots.txt', target), { accept: 'text/plain' });
          if (res.status >= 400 && res.status < 500) return parseRobots('');
          if (!res.ok) return parseRobots('User-agent: *\nDisallow: /');
          return parseRobots(await res.text());
        } catch (err) {
          if (err instanceof OfflineError) throw err;
          return parseRobots('User-agent: *\nDisallow: /');
        }
      })();
      this.#robots.set(key, p);
    }
    return p;
  }

  /** One polite request. Throws HttpStatusError for a non-2xx answer (the body is not read). */
  async request(url: string, init: { method?: 'GET' | 'HEAD'; accept?: string; signal?: AbortSignal } = {}): Promise<Response> {
    const target = this.target(url);
    const mapped = target.toString() !== new URL(url).toString();
    let delay = 0;
    if (this.#robotsOn && !mapped) {
      const rules = await this.#rules(target);
      if (!rules.allows(target.pathname + target.search)) throw new RobotsDeniedError(target.toString());
      delay = rules.crawlDelayMs;
    }
    await this.#pace(target.host, delay);
    const res = await this.#raw(init.method ?? 'GET', target, init.accept ? { accept: init.accept } : {}, init.signal);
    if (!res.ok) {
      const ra = res.headers.get('retry-after');
      const secs = ra && /^\d+$/.test(ra) ? Number(ra) : null;
      await res.body?.cancel().catch(() => {});
      throw new HttpStatusError(url, res.status, secs);
    }
    return res;
  }

  async text(url: string, accept = 'application/json, text/plain;q=0.9, */*;q=0.5'): Promise<string> {
    const res = await this.request(url, { accept });
    return res.text();
  }
}
