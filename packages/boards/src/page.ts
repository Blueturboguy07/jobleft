// Finds the boards an employer's own careers page embeds. Pure string work over the page HTML: no request.
//
// A board can sit behind a plain link, an embedded frame, a script embed (Greenhouse, Ashby), an inline embed config
// (Lever's leverJobsOptions, Greenhouse boardToken, Ashby organizationHostedJobsPageName), an "Apply" button, a form,
// or a redirect (meta refresh or a script that sets location). Links that sit only in a footer, a nav bar or an aside
// are "weak": a partner's board in the footer must never win over the employer's own embed.

import type { CrawlAtsId } from '@jobleft/contracts';
import { boardId } from './ids.ts';
import { detectBoardFromUrl, type LinkBoard } from './detect.ts';

export type Evidence = 'redirect' | 'iframe' | 'script' | 'config' | 'form' | 'apply_link' | 'link';

const STRENGTH: Readonly<Record<Evidence, number>> = {
  redirect: 6, iframe: 5, script: 5, config: 5, form: 4, apply_link: 4, link: 3,
};

export interface PageBoard extends LinkBoard {
  id: string;
  evidence: Evidence;
  /** Found only inside a footer, nav bar or aside. */
  weak: boolean;
  /** The board name matches the page's own domain (careers.acme.com and board "acme"). */
  domainMatch: boolean;
}

export interface PageScan {
  /** Strongest first; weak boards are dropped when any strong one exists. */
  boards: PageBoard[];
  /** A redirect (meta refresh or a script location change) to a page that is not itself a board. */
  redirect: string | null;
  /** A redirect or embed that points at a forbidden host (the provider's name). */
  forbiddenTarget: string | null;
  /** Same-site links that look like a careers page (one more hop may find the board there). */
  careersLinks: string[];
  /** Same-host frames (a careers page that frames its own jobs page, which embeds the board). */
  frameLinks: string[];
  /** Providers the page names without a readable board (a Greenhouse app div, a Workable numeric embed, gh_jid). */
  providerHints: CrawlAtsId[];
}

const MAX_HTML = 4 * 1024 * 1024;

function decodeAttr(v: string): string {
  return v.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#x2F;|&#47;/gi, '/')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').trim();
}

function attrs(s: string): Map<string, string> {
  const m = new Map<string, string>();
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let a: RegExpExecArray | null;
  while ((a = re.exec(s))) m.set(a[1]!.toLowerCase(), decodeAttr(a[3] ?? a[4] ?? a[5] ?? ''));
  return m;
}

/** [start, end) ranges of footer, nav and aside elements (and divs whose class or id says footer). */
function weakZones(html: string): Array<[number, number]> {
  const zones: Array<[number, number]> = [];
  // footer, nav and aside: one pass with a stack (linear, also on hostile pages with unclosed tags).
  const re = /<(\/?)(footer|nav|aside)\b[^>]{0,2000}>/gi;
  const stack: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && zones.length < 500) {
    if (!m[1]) stack.push(m.index);
    else if (stack.length) { const start = stack.pop()!; if (stack.length === 0) zones.push([start, m.index + m[0].length]); }
  }
  if (stack.length) zones.push([stack[0]!, html.length]);
  // divs, sections and lists whose role, class or id says footer: at most 10, each balanced by a bounded scan.
  const role = /<(div|section|ul)\b[^>]{0,2000}?(?:role\s*=\s*["']contentinfo["']|(?:class|id)\s*=\s*["'][^"'>]{0,500}?\b(?:site-)?footer\b[^"'>]{0,500}["'])[^>]{0,2000}>/gi;
  let n = 0;
  while ((m = role.exec(html)) && n++ < 10) {
    const tag = m[1]!.toLowerCase();
    const tokens = new RegExp(`<(/?)${tag}\\b[^>]{0,2000}>`, 'gi');
    tokens.lastIndex = m.index + m[0].length;
    let depth = 1, end = html.length, t: RegExpExecArray | null;
    while ((t = tokens.exec(html))) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) { end = t.index + t[0].length; break; }
    }
    zones.push([m.index, end]);
  }
  return zones;
}

/** [start, end) of each script element, found with indexOf (linear). */
function scriptZones(html: string): Array<[number, number]> {
  const lower = html.toLowerCase();
  const out: Array<[number, number]> = [];
  let pos = 0;
  while (out.length < 2000) {
    const i = lower.indexOf('<script', pos);
    if (i < 0) break;
    const j = lower.indexOf('</script', i + 7);
    if (j < 0) { out.push([i, html.length]); break; }
    out.push([i, j + 9]);
    pos = j + 9;
  }
  return out;
}

function inZones(i: number, zones: Array<[number, number]>): boolean {
  for (const [a, b] of zones) if (i >= a && i < b) return true;
  return false;
}

function hostLabels(host: string): string[] {
  const generic = new Set(['www', 'careers', 'career', 'jobs', 'job', 'join', 'work', 'about', 'com', 'org', 'net', 'io', 'co', 'ai', 'app', 'de', 'uk', 'us', 'eu', 'hq']);
  return host.toLowerCase().split('.').filter((l) => l.length >= 3 && !generic.has(l));
}

function domainMatches(board: string, labels: string[]): boolean {
  const b = board.replace(/[^a-z0-9]/g, '');
  if (b.length < 3) return false;
  for (const l of labels) {
    const x = l.replace(/[^a-z0-9]/g, '');
    if (x === b || (x.length >= 4 && b.includes(x)) || (b.length >= 4 && x.includes(b))) return true;
  }
  return false;
}

function absolute(raw: string, base: URL): URL | null {
  const v = raw.trim();
  if (!v || /^(javascript|mailto|tel|data):/i.test(v) || v.startsWith('#')) return null;
  try {
    const u = new URL(v.startsWith('//') ? `https:${v}` : v, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch { return null; }
}

const ATS_URL = /(?:https?:)?\/\/([a-z0-9.-]+\.(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|recruitee\.com|personio\.(?:de|com)))(\/[^\s"'<>`)\\]*)?/gi;
const CAREERS_WORDS = /career|jobs?\b|join[-_ ]?us|openings|open[-_ ]positions|positions|vacanc|work[-_ ]with[-_ ]us|hiring/i;

/** Scans one page. `pageUrl` resolves relative links and gives the domain a board name is compared with. */
export function scanPage(htmlIn: string, pageUrl: URL): PageScan {
  const html = htmlIn.length > MAX_HTML ? htmlIn.slice(0, MAX_HTML) : htmlIn;
  const clean = html.replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length)); // keep offsets for the zone check
  const zones = weakZones(clean);
  const labels = hostLabels(pageUrl.hostname);
  const found = new Map<string, PageBoard>();
  let redirect: string | null = null;
  let forbiddenTarget: string | null = null;
  const careers = new Set<string>();
  const frames = new Set<string>();
  const hints = new Set<CrawlAtsId>();

  const add = (raw: string, evidence: Evidence, at: number): void => {
    const u = absolute(raw, pageUrl);
    if (!u) return;
    const d = detectBoardFromUrl(u.href);
    if (d.kind === 'forbidden') {
      if (evidence === 'redirect' || evidence === 'iframe' || evidence === 'script') forbiddenTarget ??= d.provider;
      return;
    }
    if (d.kind !== 'board') {
      if (evidence === 'redirect' && d.kind === 'page' && !redirect) redirect = u.href;
      return;
    }
    const f = d.found;
    const id = boardId(f.ats, f.board, f.region);
    const weak = (evidence === 'link' || evidence === 'apply_link') && inZones(at, zones);
    const cand: PageBoard = { ...f, id, evidence, weak, domainMatch: domainMatches(f.board, labels) };
    const old = found.get(id);
    if (!old) { found.set(id, cand); return; }
    // Keep the strongest evidence; a board seen anywhere outside the footer is not weak.
    if (STRENGTH[evidence] > STRENGTH[old.evidence]) { old.evidence = evidence; old.shape = f.shape; }
    old.weak = old.weak && weak;
    old.jobId ??= f.jobId;
  };

  // 1. Tags and their attributes.
  const tagRe = /<([a-z][a-z0-9-]*)\b([^>]{0,4000})>/gi;
  let t: RegExpExecArray | null;
  while ((t = tagRe.exec(clean))) {
    const name = t[1]!.toLowerCase();
    const a = attrs(t[2] ?? '');
    const at = t.index;
    if (name === 'a' || name === 'area') {
      const href = a.get('href');
      if (!href) continue;
      const close = clean.indexOf('</a', tagRe.lastIndex);
      const text = close > 0 && close - tagRe.lastIndex < 600 ? clean.slice(tagRe.lastIndex, close).replace(/<[^>]*>/g, ' ') : '';
      const apply = /\bapply\b/i.test(text) || /\bapply\b/i.test(a.get('class') ?? '') || /\bapply\b/i.test(a.get('aria-label') ?? '');
      add(href, apply ? 'apply_link' : 'link', at);
      const u = absolute(href, pageUrl);
      if (u && u.hostname === pageUrl.hostname && u.href !== pageUrl.href && (CAREERS_WORDS.test(u.pathname) || CAREERS_WORDS.test(text))) {
        if (!inZones(at, zones) || careers.size === 0) careers.add(u.origin + u.pathname + u.search);
      }
    } else if (name === 'iframe' || name === 'frame') {
      const src = a.get('src') ?? a.get('data-src');
      if (src) {
        add(src, 'iframe', at);
        const u = absolute(src, pageUrl);
        if (u && u.host === pageUrl.host && u.href !== pageUrl.href) frames.add(u.origin + u.pathname + u.search);
      }
    } else if (name === 'script') {
      const src = a.get('src');
      if (src) add(src, 'script', at);
    } else if (name === 'form') {
      const action = a.get('action');
      if (action) add(action, 'form', at);
    } else if (name === 'meta') {
      if ((a.get('http-equiv') ?? '').toLowerCase() === 'refresh') {
        const m = /url\s*=\s*['"]?([^'";]+)/i.exec(a.get('content') ?? '');
        if (m) add(m[1]!, 'redirect', at);
      }
    } else if (name === 'link') {
      const href = a.get('href');
      if (href && /canonical/i.test(a.get('rel') ?? '')) add(href, 'link', at);
    }
    // data-* attributes that carry a board address (lazy frames, custom embeds).
    for (const [k, v] of a) {
      if (k.startsWith('data-') && /^(https?:)?\/\//i.test(v)) add(v, name === 'iframe' ? 'iframe' : 'link', at);
    }
    if (name === 'div' && /grnhse_app/i.test(a.get('id') ?? '')) hints.add('greenhouse');
  }

  // 2. Addresses inside scripts and inline JSON (escaped slashes included).
  const unescaped = clean.replace(/\\\//g, '/');
  const scriptRanges = scriptZones(unescaped);
  let m: RegExpExecArray | null;
  ATS_URL.lastIndex = 0;
  while ((m = ATS_URL.exec(unescaped))) {
    const raw = m[0].startsWith('//') ? `https:${m[0]}` : m[0];
    add(raw, inZones(m.index, scriptRanges) ? 'config' : 'link', m.index);
  }

  // 3. Script redirects and embed configs.
  const loc = /(?:window\.|document\.|top\.|self\.)?location(?:\.href)?\s*(?:=|\.replace\(|\.assign\()\s*["']([^"']+)["']/gi;
  while ((m = loc.exec(unescaped))) if (inZones(m.index, scriptRanges) || /onclick/i.test(unescaped.slice(Math.max(0, m.index - 80), m.index))) add(m[1]!, inZones(m.index, scriptRanges) ? 'redirect' : 'apply_link', m.index);
  const ghToken = /\b(?:boardToken|board_token|ghBoardToken)\b\s*["']?\s*[:=]\s*["']([A-Za-z0-9._-]+)["']/g;
  while ((m = ghToken.exec(unescaped))) add(`https://boards.greenhouse.io/embed/job_board?for=${m[1]}`, 'config', m.index);
  const leverOpts = /leverJobsOptions\s*=\s*\{[^}]*?accountName\s*:\s*["']([A-Za-z0-9._-]+)["']/g;
  while ((m = leverOpts.exec(unescaped))) add(`https://jobs.lever.co/${m[1]}`, 'config', m.index);
  const ashbyOpts = /organizationHostedJobsPageName\s*["']?\s*[:=]\s*["']([A-Za-z0-9._ -]+)["']/g;
  while ((m = ashbyOpts.exec(unescaped))) add(`https://jobs.ashbyhq.com/${encodeURIComponent(m[1]!)}`, 'config', m.index);
  if (/whr_embed\s*\(/.test(unescaped)) hints.add('workable');
  if (/\bgh_jid\b|grnhse|Grnhse/.test(unescaped)) hints.add('greenhouse');
  if (/\bashby_jid\b|ashby_embed/.test(unescaped)) hints.add('ashby');
  if (/lever-jobs-container|leverJobsOptions/.test(unescaped)) hints.add('lever');

  let boards = [...found.values()];
  if (boards.some((b) => !b.weak)) boards = boards.filter((b) => !b.weak);
  boards.sort((x, y) =>
    STRENGTH[y.evidence] - STRENGTH[x.evidence] ||
    Number(y.domainMatch) - Number(x.domainMatch) ||
    (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (const b of boards) hints.delete(b.ats);
  return { boards, redirect, forbiddenTarget, careersLinks: [...careers].slice(0, 3), frameLinks: [...frames].slice(0, 2), providerHints: [...hints] };
}
