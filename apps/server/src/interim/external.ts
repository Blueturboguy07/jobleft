// INTERIM stand-in for @jobleft/sources-other jobFromUrl / jobFromText: a job the person adds by link or by pasted
// text (the External tab). A link is read once with the crawler's polite client (User-Agent, robots.txt, the
// never-crawl list, no redirects followed). JSON-LD JobPosting first, then the page's own title and text.
// Facts the page or text does not state stay unknown.

import { createHash } from 'node:crypto';
import { htmlToText } from '@jobleft/parsers';
import { isNeverHost } from '@jobleft/extension';
import {
  DeniedHostError, HttpClient, HttpError, NotFoundError, NotJobDataError, RobotsError, arr, canonicalizeUrl, isLocalName, isPrivateAddress, mapAshby,
  mapGreenhouse, mapLever, normalizeJob, obj, str, type BoardRef, type Job as CrawledJob, type RawJob, type RawPay, type Store,
} from '@jobleft/crawler';
import { nowIso } from '@jobleft/contracts';
import { ApiFailure } from '../errors.ts';
import { NO_LINK_HOST } from './jobs.ts';

const NEVER = /(^|\.)(linkedin\.com|licdn\.com|indeed\.com|glassdoor\.com|smartrecruiters\.com|myworkdayjobs\.com|myworkdaysite\.com|workday\.com|icims\.com|taleo\.net|oraclecloud\.com|ultipro\.com|ukg\.com)$/i;

const hash16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** A job on a board jobleft reads (Greenhouse, Lever, Ashby), named by its link. */
export interface BoardJob { ats: 'greenhouse' | 'lever' | 'ashby'; board: string; id: string; region?: 'eu' }

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The board job a link points to (JL-feed-14, JL-feed-15): "boards.greenhouse.io/acme/jobs/123", the same with
 * "?gh_jid=123" or on job-boards.greenhouse.io, "jobs.lever.co/acme/<id>", "jobs.ashbyhq.com/acme/<id>". Null for
 * any other link.
 */
export function boardJobOf(link: URL): BoardJob | null {
  const host = link.hostname.toLowerCase();
  let parts: string[];
  try { parts = link.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    const board = parts[0] === 'embed' ? link.searchParams.get('for') ?? '' : parts[0] ?? '';
    const id = parts[0] === 'embed' ? link.searchParams.get('token') ?? '' : parts[1] === 'jobs' ? parts[2] ?? '' : link.searchParams.get('gh_jid') ?? '';
    return TOKEN.test(board) && /^\d{1,20}$/.test(id) ? { ats: 'greenhouse', board, id } : null;
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    const [board = '', id = ''] = parts;
    if (!TOKEN.test(board) || !UUID.test(id)) return null;
    return host === 'jobs.eu.lever.co' ? { ats: 'lever', board, id, region: 'eu' } : { ats: 'lever', board, id };
  }
  if (host === 'jobs.ashbyhq.com') {
    const [board = '', id = ''] = parts;
    return TOKEN.test(board) && UUID.test(id) ? { ats: 'ashby', board, id } : null;
  }
  return null;
}

/** Reads one board job through the board's public job API (the same one the crawler reads). */
async function readBoardJob(http: HttpClient, j: BoardJob, company: string): Promise<RawJob | null> {
  const ref: BoardRef = { ats: j.ats, board: j.board, company, ...(j.region ? { region: j.region } : {}) };
  const b = encodeURIComponent(j.board);
  if (j.ats === 'greenhouse') return mapGreenhouse(obj(await http.getJson(`https://boards-api.greenhouse.io/v1/boards/${b}/jobs/${j.id}`)), ref);
  if (j.ats === 'lever') return mapLever(obj(await http.getJson(`https://${j.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co'}/v0/postings/${b}/${j.id}`)), ref);
  const list = arr(obj(await http.getJson(`https://api.ashbyhq.com/posting-api/job-board/${b}?includeCompensation=true`)).jobs).map(obj);
  const one = list.find((x) => str(x.id) === j.id);
  return one ? mapAshby(one, ref) : null;
}

/** An address on this computer or the local network (JL-feed-13): never read, whatever the person pasted. */
export function isLocalLink(u: URL): boolean {
  const h = u.hostname.replace(/^\[|\]$/g, '');
  return isLocalName(h) || isPrivateAddress(h);
}

const JOB_WORDS = /\b(?:responsibilit(?:y|ies)|qualifications?|requirements?|experience|salary|compensation|pay\s+range|benefits|job\s+description|about\s+the\s+(?:role|job|position)|what\s+you(?:'|\s+wi)ll\s+do|who\s+you\s+are|full[- ]time|part[- ]time|hiring|candidates?|apply|duties|skills)\b/gi;

/**
 * A page read without a JobPosting record is a job only when its text reads like one: some length and at least three
 * different job words ("responsibilities", "qualifications", "apply", ...). "Example Domain" is not (JL-feed-12).
 */
export function looksLikePosting(bodyText: string): boolean {
  const t = bodyText.replace(/\s+/g, ' ').trim();
  if (t.length < 300) return false;
  const words = new Set([...t.matchAll(JOB_WORDS)].map((m) => m[0].toLowerCase().replace(/\s+/g, ' ').replace(/s$/, '')));
  return words.size >= 3;
}

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

/** A RawJob from a page's HTML. `fromPosting` says whether the page carried a JobPosting record. */
export function rawFromHtml(url: string, html: string): RawJob & { fromPosting?: boolean } {
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
      fromPosting: true,
      externalId: hash16(canonicalizeUrl(url) || url), url, applyUrl: '', title: htmlToText(String(posting.title ?? '')).trim(), company: htmlToText(company).trim(),
      location: places.join('; ') || (remote ? 'Remote' : ''), descriptionHtml: String(posting.description ?? ''), remote,
      workMode: remote ? 'remote' : '', countries: [], postedAt: posted, employmentType: EMPLOYMENT[String(et ?? '').toUpperCase()] ?? '',
      department: '', pay: period && /^[A-Z]{3}$/.test(currency) && (min !== null || max !== null) ? { min, max, currency, period } : null,
    };
  }
  const title = attr(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ?? attr(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? '';
  const company = attr(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ?? host;
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return {
    externalId: hash16(canonicalizeUrl(url) || url), url, applyUrl: '', title, company, location: '', descriptionHtml: body.slice(0, 400_000), remote: false,
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

const NOT_A_NAME = /^(this|we|our|you|your|it|its|their|that|there|he|she|they|i|as|at|in|on|if|what|who|a|an|these|those|all|each|every|some|many|most|one|two)$/i;

/**
 * i-resume: the employer, only when the text says so in its own words: "<Name> is hiring / building / looking for /
 * seeking / growing / expanding ...". Anything less certain stays unknown.
 */
export function statedEmployer(lines: string[]): string | null {
  const re = /^(?:about\s+)?((?:[A-Z0-9&][\w&.'’-]*)(?:\s+(?:[A-Z0-9&][\w&.'’-]*|of|and|for|de|the)){0,4}?(?:,?\s+(?:Inc\.?|LLC|Ltd\.?|Co\.?|Corp\.?|GmbH))?)\s+(?:is|are)\s+(?:now\s+)?(?:hiring|building|looking|seeking|growing|expanding|recruiting|searching)\b/;
  for (const l of lines) {
    const m = re.exec(l);
    if (!m) continue;
    const name = m[1]!.trim();
    const words = name.split(/\s+/);
    if (NOT_A_NAME.test(words[0]!) || words.length > 5 || /^(the|of|and|for|de)$/i.test(words[words.length - 1]!)) continue;
    return name.slice(0, 120);
  }
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
  // i-resume: a first line written as "Title: ..." (or "Job title:", "Position:") is the title without its label.
  let title = [...(lines[0] ?? '').replace(/^(?:job\s+)?(?:title|position)\s*[:\-–]\s*(?=\S)/i, '')].slice(0, 200).join('');
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
  if (!company) company = statedEmployer(lines.slice(0, 12));
  const at = /^(.{3,160}?)\s+(?:at|@)\s+([A-Z0-9][\w&.,'’ -]{1,80})$/.exec(title);
  if (!company && at) { company = at[2]!.trim(); title = at[1]!.trim(); }
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');
  const id = hash16(text);
  // No apply link given: the text's own "Apply at https://..." line is the apply link (JL-tracker-12). Only a link the
  // text offers for applying, never any link it holds. The job's own address stays the no-link one (the text is not
  // a page, and two postings that share one careers link stay two jobs).
  const stated = applyUrl ? null : statedApplyLink(lines);
  return {
    externalId: id, url: applyUrl ?? `https://${NO_LINK_HOST}/job/${id}`, applyUrl: applyUrl ?? stated ?? '', title,
    company: company ?? 'Company not stated', location, descriptionHtml: escaped, remote: workMode === 'remote', workMode, countries: [],
    postedAt, employmentType, department, pay: null,
  };
}

/** The link on a line that offers it for applying ("Apply at https://...", "To apply: https://..."), or null. */
export function statedApplyLink(lines: string[]): string | null {
  for (const l of lines) {
    if (!/\bapply\b|\bapplication\b/i.test(l)) continue;
    const m = /\bhttps?:\/\/[^\s<>"'()]+/i.exec(l);
    if (!m) continue;
    const url = m[0].replace(/[.,;:!?]+$/, '');
    try { const u = new URL(url); if (u.hostname.includes('.') && !u.username && !u.password) return u.toString(); } catch { /* not a link */ }
  }
  return null;
}

export interface ExternalDeps {
  crawlStore: Store;
  hostMap: Record<string, string>;
  offline: () => boolean;
}

/** The contract id of a stored job, or null. */
function storedId(store: Store, ats: string, board: string, jobId: string): string | null {
  const r = store.db.prepare('SELECT ats, board, job_id FROM jobs WHERE lower(ats) = ? AND lower(board) = ? AND job_id = ? LIMIT 1')
    .get(ats.toLowerCase(), board.toLowerCase(), jobId) as { ats: string; board: string; job_id: string } | undefined;
  return r ? `${r.ats.toLowerCase()}:${r.board.toLowerCase()}:${r.job_id}` : null;
}

function readFailure(e: unknown, what: 'page' | 'job'): ApiFailure {
  if (e instanceof DeniedHostError) return new ApiFailure('forbidden_source', 'jobleft never reads that site, so nothing was sent to it. Paste the job text instead.');
  if (e instanceof RobotsError) return new ApiFailure('forbidden_source', 'That site asks programs not to read this page (robots.txt), so jobleft did not. Paste the job text instead.');
  if (e instanceof NotFoundError) return new ApiFailure('not_found', what === 'job' ? 'That job is not on the board (it may have closed, or the link is wrong). Check the link.' : 'That page does not exist (HTTP 404). Check the link.');
  if (e instanceof NotJobDataError) return new ApiFailure('unsupported_source', 'The job board did not answer with the job. Try again later, or paste the job text.');
  if (e instanceof HttpError && /redirect/i.test(e.message)) return new ApiFailure('unsupported_source', 'That link redirects to another page. Open it, then paste the final address or the job text.');
  if (e instanceof HttpError) return new ApiFailure('unsupported_source', `That page answered HTTP ${e.status}. Paste the job text instead.`);
  return new ApiFailure('offline', 'That page could not be reached. Check the link and that this computer is online, or paste the job text.');
}

/** Reads the link (or the text) and saves the job in the crawler's jobs table. Returns the contract job id. */
export async function addExternal(req: { url?: string; text?: string; applyUrl?: string }, d: ExternalDeps): Promise<string> {
  let raw: RawJob;
  let board: 'url' | 'text';
  if (req.url) {
    const u = new URL(req.url);
    if (NEVER.test(u.hostname) || isNeverHost(u.hostname)) throw new ApiFailure('forbidden_source', `jobleft never reads ${u.hostname}, so nothing was sent to it. Paste the job text instead.`);
    // JL-feed-13: this computer and the local network are never read (only public job pages are).
    if (isLocalLink(u)) throw new ApiFailure('forbidden_source', 'That link points to this computer or your local network. jobleft reads only public job pages, so nothing was sent. Paste the job text instead.');
    // JL-feed-14: a board job that is already stored (in the feed or added before) is that job, never a second copy.
    const bj = boardJobOf(u);
    const known = bj ? storedId(d.crawlStore, bj.ats, bj.board, bj.id) : null;
    if (known) return known;
    const canonical = canonicalizeUrl(req.url);
    const same = canonical ? d.crawlStore.db.prepare('SELECT ats, board, job_id FROM jobs WHERE canonical_url = ? ORDER BY closed_at IS NOT NULL, id LIMIT 1').get(canonical) as { ats: string; board: string; job_id: string } | undefined : undefined;
    if (same) return `${same.ats.toLowerCase()}:${same.board.toLowerCase()}:${same.job_id}`;
    if (d.offline()) throw new ApiFailure('offline', 'jobleft is set to work offline, so the link was not read. Paste the job text instead.');
    const http = new HttpClient({ hostMap: d.hostMap, timeoutMs: 10_000, retries: 0, maxRequests: 3 });
    if (bj) {
      // JL-feed-15: a board's job page redirects (boards.greenhouse.io -> job-boards.greenhouse.io); its public job
      // API answers directly, with the same facts the crawler reads.
      const row = d.crawlStore.db.prepare('SELECT company FROM boards WHERE lower(ats) = ? AND lower(board) = ?').get(bj.ats, bj.board.toLowerCase()) as { company: string | null } | undefined;
      let r: RawJob | null;
      try { r = await readBoardJob(http, bj, row?.company || ''); } catch (e) { throw readFailure(e, 'job'); }
      if (!r || !r.title) throw new ApiFailure('not_found', 'That job is not on the board (it may have closed, or the link is wrong). Check the link.');
      raw = { ...r, externalId: hash16(canonical || req.url), url: req.url, company: r.company || bj.board };
    } else {
      let html: string;
      try {
        html = await http.getText(req.url, 'text/html,application/xhtml+xml');
      } catch (e) { throw readFailure(e, 'page'); }
      const page = rawFromHtml(req.url, html);
      if (!page.title) throw new ApiFailure('unsupported_source', 'That page has no job title that jobleft can read. Paste the job text instead.');
      // JL-feed-12: a page that is not a job posting ("Example Domain") is refused in plain words.
      if (!page.fromPosting && !looksLikePosting(htmlToText(page.descriptionHtml))) {
        throw new ApiFailure('unsupported_source', 'That page does not look like a job posting: jobleft found no job details on it. Open the posting itself and paste its address, or paste the job text.');
      }
      const { fromPosting: _fp, ...rest } = page;
      raw = rest;
    }
    board = 'url';
  } else if (req.text && req.text.trim()) {
    // JL-feed-12: one short line ("hi") is not a job posting.
    if (req.text.split(/\r?\n/).filter((l) => l.trim()).length < 2) {
      throw new ApiFailure('bad_request', 'That is too short to be a job posting. Paste the whole posting: the job title on the first line, then the rest of its text.');
    }
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
