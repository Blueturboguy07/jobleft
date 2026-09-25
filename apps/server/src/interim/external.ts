// INTERIM stand-in for @jobleft/sources-other jobFromUrl / jobFromText: a job the person adds by link or by pasted
// text (the External tab). A link is read once with the crawler's polite client (User-Agent, robots.txt, the
// never-crawl list, no redirects followed). JSON-LD JobPosting first, then the page's own title and text.
// Facts the page or text does not state stay unknown.

import { createHash } from 'node:crypto';
import { htmlToText } from '@jobleft/parsers';
import { isNeverHost } from '@jobleft/extension';
import { DeniedHostError, HttpClient, HttpError, NotFoundError, RobotsError, normalizeJob, type Job as CrawledJob, type RawJob, type RawPay, type Store } from '@jobleft/crawler';
import { nowIso } from '@jobleft/contracts';
import { ApiFailure } from '../errors.ts';
import { NO_LINK_HOST } from './jobs.ts';

const NEVER = /(^|\.)(linkedin\.com|licdn\.com|indeed\.com|glassdoor\.com|smartrecruiters\.com|myworkdayjobs\.com|myworkdaysite\.com|workday\.com|icims\.com|taleo\.net|oraclecloud\.com|ultipro\.com|ukg\.com)$/i;

const hash16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function findPosting(v: unknown, depth = 0): Record<string, any> | null {
  if (!v || typeof v !== 'object' || depth > 6) return null;
  if (Array.isArray(v)) { for (const x of v) { const f = findPosting(x, depth + 1); if (f) return f; } return null; }
  const o = v as Record<string, any>;
  const t = o['@type'];
  if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) return o;
  if (o['@graph']) return findPosting(o['@graph'], depth + 1);
  return null;
}

function attr(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m ? htmlToText(m[1]!).trim() || null : null;
}

const PERIODS: Record<string, RawPay['period']> = { HOUR: 'hour', DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' };
const EMPLOYMENT: Record<string, string> = { FULL_TIME: 'full_time', PART_TIME: 'part_time', CONTRACTOR: 'contract', TEMPORARY: 'contract', INTERN: 'internship' };

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A RawJob from a page's HTML. */
export function rawFromHtml(url: string, html: string): RawJob {
  let posting: Record<string, any> | null = null;
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { posting = findPosting(JSON.parse(m[1]!.trim())); } catch { /* not JSON */ }
    if (posting) break;
  }
  const host = new URL(url).hostname;
  if (posting) {
    const org = posting.hiringOrganization;
    const company = (typeof org === 'string' ? org : typeof org?.name === 'string' ? org.name : '') || attr(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) || host;
    const locs = Array.isArray(posting.jobLocation) ? posting.jobLocation : posting.jobLocation ? [posting.jobLocation] : [];
    const places = locs.map((l: any) => [l?.address?.addressLocality, l?.address?.addressRegion, typeof l?.address?.addressCountry === 'string' ? l.address.addressCountry : l?.address?.addressCountry?.name].filter((x) => typeof x === 'string' && x.trim()).join(', ')).filter(Boolean);
    const remote = String(posting.jobLocationType ?? '').toUpperCase() === 'TELECOMMUTE';
    const et = Array.isArray(posting.employmentType) ? posting.employmentType[0] : posting.employmentType;
    const sal = posting.baseSalary?.value ?? null;
    const period = PERIODS[String(sal?.unitText ?? '').toUpperCase()];
    const min = num(sal?.minValue ?? sal?.value), max = num(sal?.maxValue);
    const currency = String(posting.baseSalary?.currency ?? '').toUpperCase();
    const posted = typeof posting.datePosted === 'string' ? statedDate(posting.datePosted) : null;
    return {
      externalId: hash16(url), url, applyUrl: '', title: htmlToText(String(posting.title ?? '')).trim(), company: htmlToText(company).trim(),
      location: places.join('; ') || (remote ? 'Remote' : ''), descriptionHtml: String(posting.description ?? ''), remote,
      workMode: remote ? 'remote' : '', countries: [], postedAt: posted, employmentType: EMPLOYMENT[String(et ?? '').toUpperCase()] ?? '',
      department: '', pay: period && /^[A-Z]{3}$/.test(currency) && (min !== null || max !== null) ? { min, max, currency, period } : null,
    };
  }
  const title = attr(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ?? attr(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? '';
  const company = attr(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ?? host;
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return {
    externalId: hash16(url), url, applyUrl: '', title, company, location: '', descriptionHtml: body.slice(0, 400_000), remote: false,
    workMode: '', countries: [], postedAt: null, employmentType: '', department: '', pay: null,
  };
}

/**
 * A date the source states. A plain date (no time) is kept at 12:00 UTC, so it is the same calendar day in every
 * US time zone and never moves by a day on display. A date-time keeps its own instant. Anything else is null.
 */
export function statedDate(v: string): string | null {
  const s = v.trim();
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (d) {
    const t = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), 12);
    const back = new Date(t);
    return back.getUTCFullYear() === Number(d[1]) && back.getUTCMonth() === Number(d[2]) - 1 && back.getUTCDate() === Number(d[3]) ? back.toISOString() : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s) && Number.isFinite(Date.parse(s))) return new Date(Date.parse(s)).toISOString();
  // A date-time with no zone states the day but not the instant: keep the day, as a plain date.
  const local = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.exec(s);
  if (local) return statedDate(local[1]!);
  return null;
}

const WORK_MODES: Record<string, RawJob['workMode']> = { remote: 'remote', hybrid: 'hybrid', 'on-site': 'onsite', onsite: 'onsite', 'on site': 'onsite', 'in office': 'onsite', 'in-office': 'onsite' };
const TEXT_EMPLOYMENT: Array<[RegExp, string]> = [[/^full[- ]?time$/i, 'full_time'], [/^part[- ]?time$/i, 'part_time'], [/^(contract|contractor|temporary|temp)$/i, 'contract'], [/^(intern|internship)$/i, 'internship']];

/**
 * A RawJob from pasted text. The first line is the title; a "Company:" line or "Title at Company" names the employer.
 * Only LABELLED lines give facts ("Location:", "Workplace:", "Employment type:", "Department:", "Posted:"), plus a
 * line that is only "Remote", "Hybrid" or "On-site". Pay comes from the text through the crawler's own pay parser.
 * Nothing is guessed: a fact the text does not label stays unknown.
 */
export function rawFromText(text: string, applyUrl: string | null): RawJob {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let title = [...(lines[0] ?? '')].slice(0, 200).join('');
  let company: string | null = null;
  let location = '';
  let workMode: RawJob['workMode'] = '';
  let employmentType = '';
  let department = '';
  let postedAt: string | null = null;
  for (const l of lines.slice(1, 40)) {
    const m = /^([A-Za-z][A-Za-z ]{1,24}?)\s*[:\-–]\s*(.{1,200})$/.exec(l);
    const whole = WORK_MODES[l.toLowerCase().replace(/[.!]$/, '')];
    if (whole && !workMode) { workMode = whole; continue; }
    if (!m) continue;
    const label = m[1]!.trim().toLowerCase();
    const value = m[2]!.trim();
    if (!company && /^(company|employer|organization|organisation)$/.test(label)) company = value.slice(0, 120);
    else if (!location && /^(location|locations|job location|office|city)$/.test(label)) location = value;
    else if (!workMode && /^(workplace|workplace type|work model|work mode|work type|remote)$/.test(label)) {
      const k = value.toLowerCase().replace(/[.!]$/, '');
      workMode = WORK_MODES[k] ?? (label === 'remote' && /^(yes|true)$/i.test(value) ? 'remote' : '');
    } else if (!employmentType && /^(employment type|job type|type|schedule)$/.test(label)) {
      employmentType = TEXT_EMPLOYMENT.find(([re]) => re.test(value))?.[1] ?? '';
    } else if (!department && /^(department|team)$/.test(label)) department = value.slice(0, 120);
    else if (!postedAt && /^(posted|date posted|posted on|posting date)$/.test(label)) postedAt = statedDate(value);
  }
  const at = /^(.{3,160}?)\s+(?:at|@)\s+([A-Z0-9][\w&.,'’ -]{1,80})$/.exec(title);
  if (!company && at) { company = at[2]!.trim(); title = at[1]!.trim(); }
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');
  const id = hash16(text);
  return {
    externalId: id, url: applyUrl ?? `https://${NO_LINK_HOST}/job/${id}`, applyUrl: applyUrl ?? '', title,
    company: company ?? 'Company not stated', location, descriptionHtml: escaped, remote: workMode === 'remote', workMode, countries: [],
    postedAt, employmentType, department, pay: null,
  };
}

export interface ExternalDeps {
  crawlStore: Store;
  hostMap: Record<string, string>;
  offline: () => boolean;
}

/** Reads the link (or the text) and saves the job in the crawler's jobs table. Returns the contract job id. */
export async function addExternal(req: { url?: string; text?: string; applyUrl?: string }, d: ExternalDeps): Promise<string> {
  let raw: RawJob;
  let board: 'url' | 'text';
  if (req.url) {
    const u = new URL(req.url);
    if (NEVER.test(u.hostname) || isNeverHost(u.hostname)) throw new ApiFailure('forbidden_source', `jobleft never reads ${u.hostname}, so nothing was sent to it. Paste the job text instead.`);
    if (d.offline()) throw new ApiFailure('offline', 'jobleft is set to work offline, so the link was not read. Paste the job text instead.');
    // A page on THIS computer (a test form, a mock board) is read only because the person named it on purpose; the
    // crawler client refuses any other local address. It never reaches another machine.
    const hostMap = /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname) && (u.protocol === 'http:' || u.protocol === 'https:') ? { ...d.hostMap, [u.host.toLowerCase()]: u.origin } : d.hostMap;
    const http = new HttpClient({ hostMap, timeoutMs: 10_000, retries: 0, maxRequests: 3 });
    let html: string;
    try {
      html = await http.getText(req.url, 'text/html,application/xhtml+xml');
    } catch (e) {
      if (e instanceof DeniedHostError) throw new ApiFailure('forbidden_source', 'jobleft never reads that site, so nothing was sent to it. Paste the job text instead.');
      if (e instanceof RobotsError) throw new ApiFailure('forbidden_source', 'That site asks programs not to read this page (robots.txt), so jobleft did not. Paste the job text instead.');
      if (e instanceof NotFoundError) throw new ApiFailure('not_found', 'That page does not exist (HTTP 404). Check the link.');
      if (e instanceof HttpError && /redirect/i.test(e.message)) throw new ApiFailure('unsupported_source', 'That link redirects to another page. Open it, then paste the final address or the job text.');
      if (e instanceof HttpError) throw new ApiFailure('unsupported_source', `That page answered HTTP ${e.status}. Paste the job text instead.`);
      throw new ApiFailure('offline', 'That page could not be reached. Check the link and that this computer is online, or paste the job text.');
    }
    raw = rawFromHtml(req.url, html);
    if (!raw.title) throw new ApiFailure('unsupported_source', 'That page has no job title that jobleft can read. Paste the job text instead.');
    board = 'url';
  } else if (req.text && req.text.trim()) {
    raw = rawFromText(req.text, req.applyUrl ?? null);
    if (!raw.title) throw new ApiFailure('bad_request', 'The pasted text is empty.');
    board = 'text';
  } else {
    throw new ApiFailure('bad_request', 'Give a job link (url) or the job text (text).');
  }
  const job = normalizeJob({ ats: 'external' as never, board, company: raw.company || 'Company not stated' }, raw) as CrawledJob | null;
  if (!job) throw new ApiFailure('unsupported_source', 'jobleft could not read a job from that. Paste the job text instead.');
  const res = d.crawlStore.transaction(() => d.crawlStore.upsertJob(job, nowIso()));
  if (res.status === 'dupUrl') {
    const owner = d.crawlStore.db.prepare('SELECT ats, board, job_id FROM jobs WHERE canonical_url = ?').get(job.canonicalUrl) as { ats: string; board: string; job_id: string } | undefined;
    if (owner) return `${owner.ats.toLowerCase()}:${owner.board.toLowerCase()}:${owner.job_id}`;
  }
  return `external:${board}:${job.jobId}`;
}
