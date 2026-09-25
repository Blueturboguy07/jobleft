// ATS detection from a URL. Pure string work: nothing here sends a request.
// Case, tracking parameters, fragments and trailing slashes do not change the answer.

import type { AtsId, CrawlAtsId } from '@jobleft/contracts';
import { CRAWL_ATS_IDS } from '@jobleft/contracts';
import { isPathToken, isSubdomainToken } from './util.ts';

/** What a URL says about the ATS behind it. Pure string work: it sends no request. */
export interface AtsDetection {
  ats: AtsId;
  /** The board token, when the URL names one. */
  board: string | null;
  region: string | null;
  /** The posting id, when the URL is a single job page (for example a Greenhouse gh_jid). */
  jobId: string | null;
  /** true only for CrawlAtsId families; false for workday, icims, smartrecruiters and the rest. */
  crawlable: boolean;
}

const CRAWLABLE = new Set<string>(CRAWL_ATS_IDS);

/** Sub-domains of an ATS's own domain that are product pages, never an employer's board. */
const NOT_A_BOARD = new Set([
  'www', 'app', 'api', 'apply', 'help', 'support', 'docs', 'developer', 'developers', 'status', 'blog', 'partner',
  'partners', 'jobs', 'careers', 'marketplace', 'login', 'auth', 'cdn', 'assets', 'static', 'na', 'eu', 'resources',
]);

function toUrl(input: string): URL | null {
  const t = (input ?? '').trim();
  if (!t || /\s/.test(t)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : /^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(t) ? `https://${t}` : '';
  if (!withScheme) return null;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;
    return u;
  } catch {
    return null;
  }
}

function segments(u: URL): string[] {
  return u.pathname.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

function param(u: URL, name: string): string | null {
  for (const [k, v] of u.searchParams) if (k.toLowerCase() === name && v.trim()) return v.trim();
  return null;
}

function det(ats: AtsId, board: string | null, region: string | null, jobId: string | null): AtsDetection {
  const b = board && board.trim() ? board.trim().toLowerCase() : null;
  return { ats, board: b, region, jobId: jobId && jobId.trim() ? jobId.trim() : null, crawlable: CRAWLABLE.has(ats) };
}

/** A path board for crawlable families must be a plain slug; anything else is "no board named". */
function slugOrNull(s: string | undefined): string | null {
  return s && isPathToken(s) ? s : null;
}

function subOf(host: string, domain: string): string | null {
  if (!host.endsWith(`.${domain}`)) return null;
  const sub = host.slice(0, -(domain.length + 1));
  if (!sub || sub.includes('.')) return null;
  return sub;
}

/** Recognises board and job URLs of known ATS families (case, tracking parameters and trailing slashes ignored). */
export function detectAts(url: string): AtsDetection | null {
  const u = toUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const seg = segments(u);
  const s0 = seg[0]?.toLowerCase();

  // ---- Greenhouse
  const gh = /^(boards|job-boards|boards-api)(\.eu)?\.greenhouse\.io$/.exec(host);
  if (gh) {
    const region = gh[2] ? 'eu' : null;
    const ghJid = param(u, 'gh_jid') ?? param(u, 'token');
    if (s0 === 'embed') return det('greenhouse', slugOrNull(param(u, 'for') ?? undefined), region, ghJid);
    if (gh[1] === 'boards-api') {
      // /v1/boards/{board}/jobs/{id}
      const i = seg.indexOf('boards');
      const board = i >= 0 ? slugOrNull(seg[i + 1]) : null;
      const jobId = i >= 0 && seg[i + 2] === 'jobs' && /^\d+$/.test(seg[i + 3] ?? '') ? seg[i + 3] : null;
      return det('greenhouse', board, region, jobId);
    }
    const board = slugOrNull(seg[0]);
    const jobId = seg[1] === 'jobs' && /^\d+$/.test(seg[2] ?? '') ? seg[2] : ghJid;
    return det('greenhouse', board, region, jobId);
  }
  // A company-hosted page of a Greenhouse board (careers.acme.com/jobs?gh_jid=123): the job is known, the board is not.
  const anyGhJid = param(u, 'gh_jid');

  // ---- Lever
  const lv = /^(jobs|api)(\.eu)?\.lever\.co$/.exec(host);
  if (lv) {
    const region = lv[2] ? 'eu' : null;
    if (lv[1] === 'api') {
      const i = seg.indexOf('postings');
      return det('lever', i >= 0 ? slugOrNull(seg[i + 1]) : null, region, i >= 0 ? seg[i + 2] ?? null : null);
    }
    const jobId = seg[1] && /^[0-9a-f-]{8,}$/i.test(seg[1]) ? seg[1] : null;
    return det('lever', slugOrNull(seg[0]), region, jobId);
  }

  // ---- Ashby
  if (host === 'jobs.ashbyhq.com') {
    const jobId = seg[1] && /^[0-9a-f-]{8,}$/i.test(seg[1]) ? seg[1] : null;
    return det('ashby', slugOrNull(seg[0]), null, jobId);
  }
  if (host === 'api.ashbyhq.com') {
    const i = seg.indexOf('job-board');
    return det('ashby', i >= 0 ? slugOrNull(seg[i + 1]) : null, null, null);
  }
  const ashbyJid = param(u, 'ashby_jid');

  // ---- Workable
  if (host === 'apply.workable.com') {
    if (s0 === 'j') return det('workable', null, null, seg[1] ?? null); // short job link: the board is not named
    if (s0 === 'api') {
      const i = seg.indexOf('accounts');
      const board = i >= 0 ? slugOrNull(seg[i + 1]) : null;
      const j = seg.indexOf('jobs');
      return det('workable', board, null, j >= 0 ? seg[j + 1] ?? null : null);
    }
    const jobId = seg[1] === 'j' ? seg[2] ?? null : null;
    return det('workable', slugOrNull(seg[0]), null, jobId);
  }
  if (host === 'workable.com' && s0 === 'api') {
    const i = seg.indexOf('accounts');
    return det('workable', i >= 0 ? slugOrNull(seg[i + 1]) : null, null, null);
  }
  if (host === 'jobs.workable.com') return det('workable', null, null, null); // Workable's own job search, not one board
  const wkSub = subOf(host, 'workable.com');
  if (wkSub && !NOT_A_BOARD.has(wkSub)) {
    const jobId = seg[0] === 'jobs' || seg[0] === 'j' ? seg[1] ?? null : null;
    return det('workable', isSubdomainToken(wkSub) ? wkSub : null, null, jobId);
  }

  // ---- Recruitee
  const rc = subOf(host, 'recruitee.com');
  if (rc && !NOT_A_BOARD.has(rc)) {
    const jobId = seg[0] === 'o' ? seg[1] ?? null : null;
    return det('recruitee', isSubdomainToken(rc) ? rc : null, null, jobId);
  }

  // ---- Personio (.de and .com)
  const pe = /^([^.]+)\.jobs\.personio\.(de|com)$/.exec(host);
  if (pe && !NOT_A_BOARD.has(pe[1])) {
    const jobId = seg[0] === 'job' && seg[1] ? seg[1] : null;
    return det('personio', isSubdomainToken(pe[1]) ? pe[1] : null, pe[2] === 'com' ? 'com' : null, jobId);
  }

  // ---- Teamtailor (and its North America host)
  const tt = /^([^.]+)\.(na\.)?teamtailor\.com$/.exec(host);
  if (tt && !NOT_A_BOARD.has(tt[1])) {
    const m = seg[0] === 'jobs' && seg[1] ? /^(\d+)/.exec(seg[1]) : null;
    return det('teamtailor', isSubdomainToken(tt[1]) ? tt[1] : null, tt[2] ? 'na' : null, m ? m[1] : null);
  }

  // ---- Gem
  if (host === 'jobs.gem.com') {
    return det('gem', slugOrNull(seg[0]), null, seg[1] ?? null);
  }
  if (host === 'api.gem.com') {
    const i = seg.indexOf('v0');
    const board = seg[0] === 'job_board' && i >= 0 ? slugOrNull(seg[i + 1]) : null;
    const j = seg.indexOf('job_posts');
    return det('gem', board, null, j >= 0 ? seg[j + 1] ?? null : null);
  }

  // ---- Recognised, never or not crawled (no request is ever sent to these)
  if (host === 'smartrecruiters.com' || host.endsWith('.smartrecruiters.com')) {
    if (host.startsWith('api.')) {
      const i = seg.indexOf('companies');
      return det('smartrecruiters', i >= 0 ? seg[i + 1] ?? null : null, null, null);
    }
    const jid = seg[1] ? /^(\d+)/.exec(seg[1]) : null;
    return det('smartrecruiters', seg[0] ?? null, null, jid ? jid[1] : null);
  }
  const wd = /^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
  if (wd) {
    const last = seg[seg.length - 1] ?? '';
    const jid = seg.includes('job') ? /_([A-Za-z0-9-]+)$/.exec(last) : null;
    return det('workday', wd[1], wd[2], jid ? jid[1] : null);
  }
  if (host.endsWith('myworkdayjobs.com') || host.endsWith('myworkdaysite.com') || host === 'workday.com' || host.endsWith('.workday.com')) {
    const i = seg.indexOf('recruiting');
    return det('workday', i >= 0 ? seg[i + 1] ?? null : null, null, null);
  }
  const ic = /^(?:careers-)?([^.]+)\.icims\.com$/.exec(host);
  if (ic) {
    const i = seg.indexOf('jobs');
    return det('icims', ic[1] === 'www' ? null : ic[1], null, i >= 0 && /^\d+$/.test(seg[i + 1] ?? '') ? seg[i + 1] : null);
  }
  if (host.endsWith('.taleo.net')) return det('taleo', host.split('.')[0], null, param(u, 'job'));
  if (host.endsWith('.oraclecloud.com') && /candidateexperience|hcmui/i.test(u.pathname)) {
    const i = seg.findIndex((s) => s.toLowerCase() === 'job');
    return det('oracle', host.split('.')[0], null, i >= 0 ? seg[i + 1] ?? null : null);
  }
  if (host.endsWith('ultipro.com') || host.endsWith('.ukg.net') || host.endsWith('.ukg.com')) {
    return det('ukg', seg[0] ?? null, null, param(u, 'opportunityid'));
  }
  if (host === 'jobs.jobvite.com' || host === 'app.jobvite.com' || host.endsWith('.jobvite.com')) {
    const i = seg.indexOf('job');
    return det('jobvite', host === 'jobs.jobvite.com' ? seg[0] ?? null : param(u, 'c'), null, i >= 0 ? seg[i + 1] ?? null : null);
  }
  const bh = subOf(host, 'bamboohr.com');
  if (bh && !NOT_A_BOARD.has(bh)) {
    const i = seg.indexOf('careers');
    return det('bamboohr', bh, null, i >= 0 && /^\d+$/.test(seg[i + 1] ?? '') ? seg[i + 1] : param(u, 'id'));
  }
  const bz = subOf(host, 'breezy.hr');
  if (bz && !NOT_A_BOARD.has(bz)) {
    const jid = seg[0] === 'p' && seg[1] ? /^([0-9a-f]+)/i.exec(seg[1]) : null;
    return det('breezy', bz, null, jid ? jid[1] : null);
  }
  const jz = subOf(host, 'applytojob.com');
  if (jz && !NOT_A_BOARD.has(jz)) return det('jazzhr', jz, null, seg[0] === 'apply' ? seg[1] ?? null : null);
  if (host === 'ats.rippling.com') return det('rippling', seg[0] ?? null, null, seg[1] === 'jobs' ? seg[2] ?? null : null);
  if (host === 'api.rippling.com' && seg.includes('board')) {
    const i = seg.indexOf('board');
    return det('rippling', seg[i + 1] ?? null, null, null);
  }

  // ---- A company-hosted page that carries an ATS job id
  if (anyGhJid) return det('greenhouse', null, null, anyGhJid);
  if (ashbyJid) return det('ashby', null, null, ashbyJid);
  return null;
}

/** Hosts jobleft never contacts, whatever the path (docs/INTERFACES.md section 10). */
const NEVER_HOSTS: Array<{ re: RegExp; name: string; why: string }> = [
  { re: /(^|\.)linkedin\.com$|(^|\.)licdn\.com$/, name: 'LinkedIn', why: 'its terms forbid automated access' },
  { re: /(^|\.)indeed\.[a-z.]+$/, name: 'Indeed', why: 'the plan never allows it' },
  { re: /(^|\.)glassdoor\.[a-z.]+$/, name: 'Glassdoor', why: 'the plan never allows it' },
  { re: /(^|\.)smartrecruiters\.com$/, name: 'SmartRecruiters', why: 'its robots.txt disallows all crawlers' },
  { re: /(^|\.)(myworkdayjobs|myworkdaysite|workday)\.com$/, name: 'Workday', why: 'the owner has not approved it' },
  { re: /(^|\.)icims\.com$/, name: 'iCIMS', why: 'the owner has not approved it' },
  { re: /(^|\.)taleo\.net$/, name: 'Taleo', why: 'the owner has not approved it' },
  { re: /(^|\.)oraclecloud\.com$/, name: 'Oracle', why: 'the owner has not approved it' },
  { re: /(^|\.)(ultipro|ukg)\.(com|net)$/, name: 'UKG', why: 'the owner has not approved it' },
];

/** The never-contact rule for one host name (lower case, no port). null when the host is not on the list. */
export function neverContactHost(hostname: string): { name: string; why: string } | null {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  for (const n of NEVER_HOSTS) if (n.re.test(h)) return { name: n.name, why: n.why };
  return null;
}

export type UrlVerdict = 'crawlable' | 'job_link_without_board' | 'not_crawled' | 'never' | 'unknown' | 'invalid';

export interface UrlClassification {
  verdict: UrlVerdict;
  detection: AtsDetection | null;
  /** One plain sentence for the person who pasted the link. */
  message: string;
}

const NAMES: Record<string, string> = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workable: 'Workable', recruitee: 'Recruitee',
  personio: 'Personio', teamtailor: 'Teamtailor', gem: 'Gem', workday: 'Workday', icims: 'iCIMS',
  smartrecruiters: 'SmartRecruiters', oracle: 'Oracle', ukg: 'UKG', taleo: 'Taleo', jobvite: 'Jobvite',
  bamboohr: 'BambooHR', breezy: 'Breezy HR', jazzhr: 'JazzHR', rippling: 'Rippling', other: 'another system',
};
export function atsName(ats: string): string { return NAMES[ats] ?? ats; }

/**
 * What jobleft can do with a pasted link, in plain words. Pure string work: it sends nothing, and it never suggests
 * contacting a never-crawl host.
 */
export function classifyUrl(input: string, notCrawledReason: (ats: AtsId) => string | null = () => null): UrlClassification {
  const u = toUrl(input);
  if (!u) return { verdict: 'invalid', detection: null, message: 'This is not a web link (http or https), so jobleft cannot use it.' };
  const never = neverContactHost(u.hostname);
  const d = detectAts(input);
  if (never) {
    return {
      verdict: 'never', detection: d,
      message: `jobleft does not support ${never.name} links: ${never.why}. Nothing was sent to ${u.hostname.toLowerCase()}.`,
    };
  }
  if (!d) return { verdict: 'unknown', detection: null, message: 'jobleft does not recognise the job system behind this link, so it cannot add a board from it.' };
  if (!d.crawlable) {
    const raw = notCrawledReason(d.ats);
    const why = raw ? raw.charAt(0).toLowerCase() + raw.slice(1).replace(/\.$/, '') : null;
    return {
      verdict: 'not_crawled', detection: d,
      message: `This is a ${atsName(d.ats)} link. jobleft does not crawl ${atsName(d.ats)}${why ? `: ${why}` : ''}. Nothing was sent.`,
    };
  }
  if (!d.board) {
    return {
      verdict: 'job_link_without_board', detection: d,
      message: `This is a ${atsName(d.ats)} job link, but it does not name the employer's board. Paste the board link instead.`,
    };
  }
  return {
    verdict: 'crawlable', detection: d,
    message: `${atsName(d.ats)} board "${d.board}"${d.region ? ` (region ${d.region})` : ''}${d.jobId ? `, job ${d.jobId}` : ''}.`,
  };
}
