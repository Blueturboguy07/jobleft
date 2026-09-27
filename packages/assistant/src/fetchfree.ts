// The FREE direct page read. It always runs before any paid route (O13). A plain GET from this computer, with:
//   * the URL checks of urlsafe.ts on the first address and on every redirect (at most 5, followed by hand);
//   * a check of the address the name resolves to (never loopback, private, link-local, CGNAT or multicast), made in
//     the connect step itself, so the address that was checked is the address that is used;
//   * robots.txt (the `*` group; a 4xx means allowed, a 5xx or no answer means disallowed);
//   * one request a second per host, the fixed jobleft User-Agent, no cookies, no custom headers;
//   * limits: 15 s, 2 MiB, text and JSON types only.
// JOBLEFT_HOST_MAP (same meaning as in the crawler) sends a public host name to a LOOPBACK mock origin, for tests.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { checkUrl, isPrivateAddress } from './urlsafe.ts';

export const USER_AGENT = 'jobleft/0.1.3 (+https://github.com/Blueturboguy07/jobleft; no personal data)';
export const FREE_FETCH_MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export type FreeReadResult =
  | { ok: true; url: string; finalUrl: string; status: number; text: string; truncated: boolean; needsRender: boolean }
  | { ok: false; code: 'unsafe' | 'robots' | 'not_found' | 'blocked' | 'too_big' | 'wrong_type' | 'unreachable' | 'timeout' | 'http_error'; message: string; status?: number; /** true when a paid read might get further */ paidMayHelp: boolean };

export interface FreeReaderOptions {
  hostMap?: Record<string, string>;
  /** Minimum gap between two requests to one host. Default 1000 ms. */
  minGapMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function hostMapFromEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const raw = env.JOBLEFT_HOST_MAP;
  if (!raw) return {};
  try {
    const m = JSON.parse(raw) as Record<string, string>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) {
      const u = new URL(v);
      if (['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) out[k.toLowerCase()] = u.origin; // loopback mocks only
    }
    return out;
  } catch { return {}; }
}

/** One request that follows no redirect. */
function getOnce(target: URL, opts: { timeoutMs: number; validateAddress: boolean }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; tooBig: boolean }> {
  return new Promise((resolve, reject) => {
    const mod = target.protocol === 'https:' ? https : http;
    const lookup = opts.validateAddress
      ? ((host: string, o: dns.LookupOptions, cb: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => {
        dns.lookup(host, { all: true }, (err, addrs) => {
          if (err) return cb(err, '', 4);
          if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
            const e = new Error('address refused') as NodeJS.ErrnoException; e.code = 'JL_PRIVATE_ADDRESS';
            return cb(e, '', 4);
          }
          if (o.all) return cb(null, addrs);
          return cb(null, addrs[0]!.address, addrs[0]!.family);
        });
      })
      : undefined;
    const req = mod.request(target, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8', 'accept-encoding': 'identity' },
      ...(lookup ? { lookup } : {}),
      timeout: opts.timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > FREE_FETCH_MAX_BYTES) { tooBig = true; res.destroy(); return; }
        chunks.push(c);
      });
      res.on('close', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), tooBig }));
      res.on('error', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), tooBig }));
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { code: 'JL_TIMEOUT' })); });
    req.on('error', reject);
    req.end();
  });
}

interface RobotsRules { allow: boolean; delayMs: number }

/** The `*` group of a robots.txt: the longest matching rule wins; Allow wins a tie. */
export function robotsAllows(text: string, path: string): RobotsRules {
  const rules: Array<{ allow: boolean; path: string }> = [];
  let agents: string[] = [];
  let inRules = false;
  let applies = false;
  let delay = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === 'user-agent') {
      if (inRules) { agents = []; inRules = false; }
      agents.push(val.toLowerCase());
      applies = agents.includes('*');
    } else if (key === 'allow' || key === 'disallow' || key === 'crawl-delay') {
      inRules = true;
      if (!applies) continue;
      if (key === 'crawl-delay') {
        const d = Number(val);
        if (Number.isFinite(d) && d > 0) delay = Math.min(d, 10) * 1000;
      } else if (val) rules.push({ allow: key === 'allow', path: val });
    }
  }
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    const pat = r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
    if (!new RegExp('^' + pat).test(path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return { allow: best ? best.allow : true, delayMs: delay };
}

export function htmlToText(html: string): string {
  let t = html.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '; });
  return t.split('\n').map((l) => l.replace(/[ \t\f\v]+/g, ' ').trim()).filter(Boolean).join('\n');
}

export function createFreeReader(options: FreeReaderOptions = {}) {
  const hostMap = options.hostMap ?? hostMapFromEnv();
  const minGap = options.minGapMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const lastAt = new Map<string, number>();
  const robots = new Map<string, { at: number; text: string | null }>();

  async function pace(host: string, extraGap = 0): Promise<void> {
    const gap = Math.max(minGap, extraGap);
    const wait = (lastAt.get(host) ?? 0) + gap - now();
    if (wait > 0) await sleep(wait);
    lastAt.set(host, now());
  }

  function destination(u: URL): { target: URL; mapped: boolean } {
    const origin = hostMap[u.hostname.toLowerCase()];
    if (!origin) return { target: u, mapped: false };
    return { target: new URL(u.pathname + u.search, origin), mapped: true };
  }

  async function robotsFor(u: URL): Promise<string | null> {
    const key = u.host;
    const hit = robots.get(key);
    if (hit && now() - hit.at < 10 * 60_000) return hit.text;
    const { target, mapped } = destination(new URL('/robots.txt', u.origin));
    await pace(u.hostname);
    let text: string | null;
    try {
      const r = await getOnce(target, { timeoutMs: 5000, validateAddress: !mapped });
      if (r.status >= 200 && r.status < 300) text = r.body.toString('utf8', 0, 500 * 1024);
      else if (r.status >= 400 && r.status < 500) text = ''; // no robots.txt: allowed
      else text = null; // 5xx: assume disallow
    } catch { text = null; }
    robots.set(key, { at: now(), text });
    return text;
  }

  return {
    async read(input: string, opts: { maxChars?: number } = {}): Promise<FreeReadResult> {
      const maxChars = opts.maxChars ?? 100_000;
      let current = input;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const chk = checkUrl(current, { allowHttp: true });
        if (!chk.ok) return { ok: false, code: chk.code === 'blocked_host' ? 'blocked' : 'unsafe', message: chk.message, paidMayHelp: false };
        const u = chk.url;
        const rb = await robotsFor(u);
        if (rb === null) return { ok: false, code: 'robots', message: `${u.hostname} could not confirm that reading this page is allowed (its robots.txt did not answer), so jobleft did not read it.`, paidMayHelp: false };
        const rules = robotsAllows(rb, u.pathname + u.search);
        if (!rules.allow) return { ok: false, code: 'robots', message: `${u.hostname} asks programs not to read this page (robots.txt), so jobleft did not read it.`, paidMayHelp: false };
        await pace(u.hostname, rules.delayMs);
        const { target, mapped } = destination(u);
        let r;
        try {
          r = await getOnce(target, { timeoutMs, validateAddress: !mapped });
        } catch (e) {
          const code = (e as NodeJS.ErrnoException)?.code;
          if (code === 'JL_PRIVATE_ADDRESS') return { ok: false, code: 'unsafe', message: `${u.hostname} points to this computer or a private network, so jobleft did not read it.`, paidMayHelp: false };
          if (code === 'JL_TIMEOUT' || code === 'ETIMEDOUT') return { ok: false, code: 'timeout', message: `${u.hostname} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, paidMayHelp: true };
          return { ok: false, code: 'unreachable', message: `${u.hostname} could not be reached.`, paidMayHelp: true };
        }
        if (r.status >= 300 && r.status < 400 && r.headers.location) {
          try { current = new URL(String(r.headers.location), u).toString(); } catch { return { ok: false, code: 'http_error', message: 'The page sent a broken redirect.', paidMayHelp: false }; }
          continue;
        }
        if (r.tooBig) return { ok: false, code: 'too_big', message: 'The page is too large to read.', paidMayHelp: false };
        if (r.status === 404 || r.status === 410) return { ok: false, code: 'not_found', message: 'The page does not exist any more (HTTP ' + r.status + ').', status: r.status, paidMayHelp: false };
        if (r.status === 401 || r.status === 403 || r.status === 429 || r.status === 451) return { ok: false, code: 'http_error', message: `The site refused a plain request (HTTP ${r.status}).`, status: r.status, paidMayHelp: true };
        if (r.status < 200 || r.status >= 300) return { ok: false, code: 'http_error', message: `The site answered HTTP ${r.status}.`, status: r.status, paidMayHelp: r.status >= 500 };
        const type = String(r.headers['content-type'] ?? '').toLowerCase();
        if (type && !/^(text\/|application\/(xhtml\+xml|json|xml))/.test(type)) return { ok: false, code: 'wrong_type', message: 'The page is not text or a web page.', paidMayHelp: false };
        const raw = r.body.toString('utf8');
        const text = /html|xml/.test(type) || /^\s*</.test(raw) ? htmlToText(raw) : raw.trim();
        const truncated = text.length > maxChars;
        const shell = /id=["'](root|__next|app)["']|__NEXT_DATA__|enable javascript|requires javascript/i.test(raw);
        const needsRender = text.length < 120 || (text.length < 500 && shell);
        return { ok: true, url: input, finalUrl: u.toString(), status: r.status, text: truncated ? text.slice(0, maxChars) : text, truncated, needsRender };
      }
      return { ok: false, code: 'http_error', message: 'The page redirected too many times.', paidMayHelp: false };
    },
  };
}

export type FreeReader = ReturnType<typeof createFreeReader>;
