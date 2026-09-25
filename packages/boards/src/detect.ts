// What a pasted link says about the board behind it. Pure string work: nothing here sends a request.
//
// detectBoardFromUrl() recognises every link shape of the six crawlable providers (board home page, single job page,
// embed link, API link, regional host, upper-case letters, tracking parameters, trailing slash), the forbidden hosts,
// the providers jobleft recognises but cannot read, and job search sites. Anything else is a "page" that may embed
// a board; src/discover.ts fetches it (politely) and looks inside.

import type { CrawlAtsId } from '@jobleft/contracts';
import { forbiddenProvider, jobSite, unsupportedProvider } from './hosts.ts';

export const PROVIDER_NAMES: Readonly<Record<CrawlAtsId, string>> = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workable: 'Workable', recruitee: 'Recruitee', personio: 'Personio',
};

/** One board named by a link. `jobId` is set when the link is a single job (the board is still the answer). */
export interface LinkBoard {
  ats: CrawlAtsId;
  /** The board token, lower case. */
  board: string;
  /** "eu" for the EU hosts of Greenhouse and Lever; null otherwise. */
  region: string | null;
  jobId: string | null;
  /** Which link shape named it (for messages and tests). */
  shape: 'board' | 'job' | 'embed' | 'api' | 'apply';
}

export type UrlDetection =
  | { kind: 'not_a_link'; input: string }
  | { kind: 'forbidden'; url: URL; provider: string }
  | { kind: 'board'; url: URL; found: LinkBoard }
  | { kind: 'provider_home'; url: URL; ats: CrawlAtsId; why: string }
  | { kind: 'unsupported'; url: URL; provider: string }
  | { kind: 'job_site'; url: URL; provider: string }
  /** Any other web page: it may embed a board. Hints come from the link itself (gh_jid, ashby_jid). */
  | { kind: 'page'; url: URL; hints: { ghJid: string | null; ashbyJid: string | null } };

const TOKEN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const ASHBY_NAME = /^[a-z0-9][a-z0-9._ -]{0,99}$/;

function tokenOf(seg: string | undefined, re = TOKEN): string | null {
  if (!seg) return null;
  let s: string;
  try { s = decodeURIComponent(seg); } catch { return null; }
  s = s.trim().toLowerCase();
  return re.test(s) ? s : null;
}

/**
 * Turns what a person pasted into a URL, or null when it is not a web link.
 * Accepts "careers.acme.com/jobs" (no scheme) and "<https://...>"; refuses javascript:, mailto:, file: and plain words.
 */
export function parseLink(input: string): URL | null {
  let s = input.trim().replace(/^[<"'(\[]+/, '').replace(/[>"')\].,;]+$/, '').trim();
  if (!s || /\s/.test(s) || s.length > 4096) return null;
  if (s.startsWith('//')) s = `https:${s}`;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (scheme && !/^[\w.-]+:\d+(\/|$|\?|#)/.test(s)) {
    const sc = scheme[1]!.toLowerCase();
    if (sc !== 'http' && sc !== 'https') return null;
  } else {
    // No scheme: only accept something that looks like a host name.
    if (!/^([\w-]+\.)+[a-z]{2,}(:\d+)?([/?#]|$)/i.test(s) && !/^(localhost|127\.\d+\.\d+\.\d+)(:\d+)?([/?#]|$)/i.test(s)) return null;
    s = `${/^(localhost|127\.)/i.test(s) ? 'http' : 'https'}://${s}`;
  }
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null; // credentials in a link: never send them anywhere
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h || (!h.includes('.') && h !== 'localhost' && !h.startsWith('['))) return null;
  u.hostname = h;
  return u;
}

function segs(u: URL): string[] { return u.pathname.split('/').filter(Boolean); }

function greenhouse(u: URL, host: string): UrlDetection | null {
  if (!/(^|\.)greenhouse\.io$/.test(host)) return null;
  const region = /(^|\.)eu\.greenhouse\.io$/.test(host) ? 'eu' : null;
  const s = segs(u);
  const q = u.searchParams;
  const ghJid = q.get('gh_jid');
  if (/^(boards-api|api)(\.eu)?\.greenhouse\.io$/.test(host)) {
    // /v1/boards/{token}[/jobs[/{id}]]
    if (s[0] === 'v1' && s[1] === 'boards') {
      const board = tokenOf(s[2]);
      if (board) {
        const jobId = s[3] === 'jobs' && s[4] ? s[4] : null;
        return { kind: 'board', url: u, found: { ats: 'greenhouse', board, region, jobId, shape: 'api' } };
      }
    }
    return { kind: 'provider_home', url: u, ats: 'greenhouse', why: 'The link is a Greenhouse address with no board name in it.' };
  }
  if (/^(job-)?boards(\.eu)?\.greenhouse\.io$/.test(host)) {
    if (s[0] === 'embed') {
      const board = tokenOf(q.get('for') ?? undefined);
      if (board) {
        const jobId = q.get('token') ?? ghJid ?? null;
        return { kind: 'board', url: u, found: { ats: 'greenhouse', board, region, jobId, shape: 'embed' } };
      }
      return { kind: 'provider_home', url: u, ats: 'greenhouse', why: 'The Greenhouse embed link does not name a board (no "for=" part).' };
    }
    const reserved = new Set(['static', 'assets', 'v1', 'api', 'favicon.ico', 'robots.txt', 'sitemap.xml']);
    const board = s[0] && !reserved.has(s[0].toLowerCase()) ? tokenOf(s[0]) : null;
    if (board) {
      let jobId: string | null = ghJid;
      let shape: LinkBoard['shape'] = 'board';
      if (s[1] === 'jobs' && s[2]) { jobId = s[2]; shape = 'job'; }
      else if (ghJid) shape = 'job';
      return { kind: 'board', url: u, found: { ats: 'greenhouse', board, region, jobId, shape } };
    }
    // The old embed style: boards.greenhouse.io/?for=acme
    const forQ = tokenOf(q.get('for') ?? undefined);
    if (forQ) return { kind: 'board', url: u, found: { ats: 'greenhouse', board: forQ, region, jobId: ghJid, shape: 'embed' } };
    return { kind: 'provider_home', url: u, ats: 'greenhouse', why: 'The link is a Greenhouse address with no board name in it.' };
  }
  if (host === 'grnh.se') return null; // a short link: it redirects to the real job page (src/discover.ts follows it)
  return { kind: 'provider_home', url: u, ats: 'greenhouse', why: "This is Greenhouse's own site, not an employer's board." };
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lever(u: URL, host: string): UrlDetection | null {
  if (!/(^|\.)lever\.co$/.test(host)) return null;
  const region = /(^|\.)eu\.lever\.co$/.test(host) ? 'eu' : null;
  const s = segs(u);
  if (/^jobs(\.eu)?\.lever\.co$/.test(host)) {
    const board = tokenOf(s[0]);
    if (board) {
      const job = s[1] && UUIDISH.test(s[1]) ? s[1].toLowerCase() : null;
      const shape: LinkBoard['shape'] = job ? (s[2] === 'apply' ? 'apply' : 'job') : 'board';
      return { kind: 'board', url: u, found: { ats: 'lever', board, region, jobId: job, shape } };
    }
    return { kind: 'provider_home', url: u, ats: 'lever', why: 'The link is a Lever address with no board name in it.' };
  }
  if (/^api(\.eu)?\.lever\.co$/.test(host)) {
    if (s[0] === 'v0' && s[1] === 'postings') {
      const board = tokenOf(s[2]);
      if (board) return { kind: 'board', url: u, found: { ats: 'lever', board, region, jobId: s[3] ?? null, shape: 'api' } };
    }
    return { kind: 'provider_home', url: u, ats: 'lever', why: 'The link is a Lever address with no board name in it.' };
  }
  return { kind: 'provider_home', url: u, ats: 'lever', why: "This is Lever's own site, not an employer's board." };
}

function ashby(u: URL, host: string): UrlDetection | null {
  if (!/(^|\.)ashbyhq\.com$/.test(host)) return null;
  const s = segs(u);
  if (host === 'jobs.ashbyhq.com') {
    const board = tokenOf(s[0], ASHBY_NAME);
    if (board) {
      const job = s[1] && UUIDISH.test(s[1]) ? s[1].toLowerCase() : null;
      const shape: LinkBoard['shape'] = s[1] === 'embed' ? 'embed' : job ? (s[2] === 'application' ? 'apply' : 'job') : 'board';
      return { kind: 'board', url: u, found: { ats: 'ashby', board, region: null, jobId: job, shape } };
    }
    return { kind: 'provider_home', url: u, ats: 'ashby', why: 'The link is an Ashby address with no board name in it.' };
  }
  if (host === 'api.ashbyhq.com' && s[0] === 'posting-api' && s[1] === 'job-board') {
    const board = tokenOf(s[2], ASHBY_NAME);
    if (board) return { kind: 'board', url: u, found: { ats: 'ashby', board, region: null, jobId: null, shape: 'api' } };
  }
  return { kind: 'provider_home', url: u, ats: 'ashby', why: "This is Ashby's own site, not an employer's board." };
}

function workable(u: URL, host: string): UrlDetection | null {
  if (!/(^|\.)workable\.com$/.test(host) || host === 'jobs.workable.com') return null;
  const s = segs(u);
  if (host === 'apply.workable.com') {
    // /api/v1/widget/accounts/{slug}, /api/v3/accounts/{slug}/jobs, /{slug}/j/{shortcode}, /{slug}
    if (s[0] === 'api') {
      const i = s.indexOf('accounts');
      const board = i >= 0 ? tokenOf(s[i + 1]) : null;
      if (board) return { kind: 'board', url: u, found: { ats: 'workable', board, region: null, jobId: null, shape: 'api' } };
      return { kind: 'provider_home', url: u, ats: 'workable', why: 'The link is a Workable address with no board name in it.' };
    }
    const board = tokenOf(s[0]);
    if (board && board !== 'j') {
      const job = s[1] === 'j' && s[2] ? s[2] : null;
      return { kind: 'board', url: u, found: { ats: 'workable', board, region: null, jobId: job, shape: job ? (s[3] === 'apply' ? 'apply' : 'job') : 'board' } };
    }
    return { kind: 'provider_home', url: u, ats: 'workable', why: 'The link is a Workable address with no board name in it.' };
  }
  if (host === 'www.workable.com' || host === 'workable.com') {
    if (s[0] === 'api' && s[1] === 'accounts') {
      const board = tokenOf(s[2]);
      if (board) return { kind: 'board', url: u, found: { ats: 'workable', board, region: null, jobId: null, shape: 'api' } };
    }
    return { kind: 'provider_home', url: u, ats: 'workable', why: "This is Workable's own site, not an employer's board." };
  }
  const sub = host.slice(0, -'.workable.com'.length);
  const board = !sub.includes('.') ? tokenOf(sub) : null;
  if (board && !['www', 'apply', 'jobs', 'help', 'resources', 'api'].includes(board)) {
    const job = s[0] === 'j' && s[1] ? s[1] : null;
    return { kind: 'board', url: u, found: { ats: 'workable', board, region: null, jobId: job, shape: job ? 'job' : 'board' } };
  }
  return { kind: 'provider_home', url: u, ats: 'workable', why: "This is Workable's own site, not an employer's board." };
}

function recruitee(u: URL, host: string): UrlDetection | null {
  if (!/(^|\.)recruitee\.com$/.test(host)) return null;
  const sub = host === 'recruitee.com' ? '' : host.slice(0, -'.recruitee.com'.length);
  const board = sub && !sub.includes('.') ? tokenOf(sub) : null;
  if (board && !['www', 'app', 'api', 'careers', 'help', 'blog', 'support'].includes(board)) {
    const s = segs(u);
    const job = s[0] === 'o' && s[1] ? s[1] : null;
    const shape: LinkBoard['shape'] = s[0] === 'api' ? 'api' : job ? 'job' : 'board';
    return { kind: 'board', url: u, found: { ats: 'recruitee', board, region: null, jobId: job, shape } };
  }
  return { kind: 'provider_home', url: u, ats: 'recruitee', why: "This is Recruitee's own site, not an employer's board." };
}

function personio(u: URL, host: string): UrlDetection | null {
  if (!/(^|\.)personio\.(de|com)$/.test(host)) return null;
  const m = /^([a-z0-9-]+)\.jobs\.personio\.(de|com)$/.exec(host);
  const board = m ? tokenOf(m[1]) : null;
  if (board) {
    const s = segs(u);
    const job = s[0] === 'job' && s[1] ? s[1] : null;
    const shape: LinkBoard['shape'] = s[0] === 'xml' ? 'api' : job ? 'job' : 'board';
    return { kind: 'board', url: u, found: { ats: 'personio', board, region: null, jobId: job, shape } };
  }
  return { kind: 'provider_home', url: u, ats: 'personio', why: "This is Personio's own site, not an employer's board." };
}

/** Recognises a pasted link. Case, tracking parameters, fragments and trailing slashes never change the answer. */
export function detectBoardFromUrl(input: string): UrlDetection {
  const u = parseLink(input);
  if (!u) return { kind: 'not_a_link', input };
  const host = u.hostname;
  const bare = host.replace(/^www\./, '');
  const forbidden = forbiddenProvider(host);
  if (forbidden) return { kind: 'forbidden', url: u, provider: forbidden };
  for (const f of [greenhouse, lever, ashby, workable, recruitee, personio]) {
    const r = f(u, bare);
    if (r) return r;
  }
  const unsupported = unsupportedProvider(host);
  if (unsupported) return { kind: 'unsupported', url: u, provider: unsupported };
  const site = jobSite(host);
  if (site) return { kind: 'job_site', url: u, provider: site };
  return {
    kind: 'page', url: u,
    hints: { ghJid: u.searchParams.get('gh_jid'), ashbyJid: u.searchParams.get('ashby_jid') },
  };
}

/** The public page of a board (for people). */
export function boardPageUrl(ats: CrawlAtsId, board: string, region: string | null): string {
  const b = encodeURIComponent(board);
  switch (ats) {
    case 'greenhouse': return `https://job-boards${region === 'eu' ? '.eu' : ''}.greenhouse.io/${b}`;
    case 'lever': return `https://jobs${region === 'eu' ? '.eu' : ''}.lever.co/${b}`;
    case 'ashby': return `https://jobs.ashbyhq.com/${b}`;
    case 'workable': return `https://apply.workable.com/${b}/`;
    case 'recruitee': return `https://${b}.recruitee.com/`;
    case 'personio': return `https://${b}.jobs.personio.de/`;
  }
}

/** The public job feed of a board: the same address the crawler reads. */
export function boardApiUrl(ats: CrawlAtsId, board: string, region: string | null): string {
  const b = encodeURIComponent(board);
  switch (ats) {
    // Greenhouse EU boards have no public feed (src/sources.ts); the US address is shown for them only as a label.
    case 'greenhouse': return `https://boards-api.greenhouse.io/v1/boards/${b}/jobs?content=true`;
    case 'lever': return `https://api${region === 'eu' ? '.eu' : ''}.lever.co/v0/postings/${b}?mode=json`;
    case 'ashby': return `https://api.ashbyhq.com/posting-api/job-board/${b}?includeCompensation=true`;
    case 'workable': return `https://apply.workable.com/api/v1/widget/accounts/${b}?details=true`;
    case 'recruitee': return `https://${b}.recruitee.com/api/offers/`;
    case 'personio': return `https://${b}.jobs.personio.de/xml?language=en`;
  }
}

/** The host of a board's job feed (the pacer and the politeness rules are per host). */
export function boardApiHost(ats: CrawlAtsId, board: string, region: string | null): string {
  return new URL(boardApiUrl(ats, board, region)).host;
}
