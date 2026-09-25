// INTERIM stand-in for @jobleft/store JobStore: reads the crawler's `jobs` table (owner: crawler) as contract Jobs,
// searches it (FTS5 words + the filters this build can judge + three sorts, true totals, keyset cursors), and saves
// jobs the person adds (ats = 'external', INTERFACES decision 6).
//
// Facts are shown exactly as stored (server O13): an empty column is null, never "", 0, "Onsite" or a crawl time.
// A filter on a fact this build does not know yet (industry, company stage, years) matches nothing unless
// `includeUnknown` names it, so an unknown never passes as a match.

import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  ATS_IDS, EmploymentTypeSchema, LEVELS, experienceLevelOf, nowMs,
  type ExperienceLevel, type Job, type JobDetail, type JobFilter, type JobListItem, type JobSearchRequest,
  type JobSearchResponse, type JobSummary, type Level, type TrackerStatus,
} from '@jobleft/contracts';
import { makeJobId } from '@jobleft/store';
import { ApiFailure } from '../errors.ts';
import { companyKey } from './company-key.ts';

export interface JobRow {
  id: number;
  ats: string;
  board: string;
  job_id: string;
  canonical_url: string;
  apply_url: string;
  dedup_hash: string;
  duplicate_of: number | null;
  title: string;
  company: string;
  company_slug: string;
  location: string;
  remote: number;
  work_mode: string;
  is_us: number | null;
  level: string | null;
  level_source: string | null;
  pay_min: number | null;
  pay_max: number | null;
  pay_currency: string | null;
  pay_period: string | null;
  pay_min_annual: number | null;
  pay_max_annual: number | null;
  pay_source: string | null;
  posted_at: string | null;
  employment_type: string;
  department: string;
  description: string;
  content_hash: string;
  first_seen: string;
  last_seen: string;
  updated_at: string;
  closed_at: string | null;
  closed_reason: string | null;
  d_ats?: string | null;
  d_board?: string | null;
  d_job_id?: string | null;
}

const ATS_SET = new Set<string>(ATS_IDS);
const LEVEL_SET = new Set<string>(LEVELS);
const EMPLOYMENT_SET = new Set<string>((EmploymentTypeSchema.enum ?? []) as readonly string[]);
const CLOSED_REASONS = new Set(['unseen', 'board_empty', 'source_removed', 'user']);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ATS_LABEL: Record<string, string> = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workable: 'Workable', recruitee: 'Recruitee', personio: 'Personio' };
/** The link of a pasted job with no link: a reserved name that never resolves (RFC 2606). The UI shows "no link". */
export const NO_LINK_HOST = 'jobleft.invalid';

function iso(v: string | null): string | null {
  return v && DATE_TIME.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
}
function httpUrl(v: string | null | undefined): string | null {
  if (!v) return null;
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:' ? v : null; } catch { return null; }
}

export function contractJobId(r: Pick<JobRow, 'ats' | 'board' | 'job_id'>): string {
  return makeJobId(r.ats, r.board, r.job_id);
}

function workModelOf(r: JobRow): Job['workModel'] {
  if (r.work_mode === 'remote' || r.work_mode === 'hybrid' || r.work_mode === 'onsite') return r.work_mode;
  return r.remote === 1 ? 'remote' : null;
}

function payOf(r: JobRow): Job['pay'] {
  if (r.pay_min === null && r.pay_max === null) return null;
  const currency = (r.pay_currency ?? '').toUpperCase();
  const period = r.pay_period;
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  if (period !== 'hour' && period !== 'day' && period !== 'week' && period !== 'month' && period !== 'year') return null;
  return {
    min: r.pay_min, max: r.pay_max, currency, period,
    source: r.pay_source === 'api' ? 'board_field' : 'description',
    ranges: 1,
    annualMin: r.pay_min_annual, annualMax: r.pay_max_annual,
  };
}

function snippetOf(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const chars = [...t];
  return chars.length <= 300 ? t : chars.slice(0, 299).join('') + '…';
}

export function rowToJob(r: JobRow): Job {
  const external = r.ats === 'external';
  const id = contractJobId(r);
  const url = httpUrl(r.canonical_url) ?? `https://${NO_LINK_HOST}/job/${encodeURIComponent(id)}`;
  const apply = httpUrl(r.apply_url);
  const level = r.level && LEVEL_SET.has(r.level) ? (r.level as Level) : null;
  const employment = r.employment_type && EMPLOYMENT_SET.has(r.employment_type) ? (r.employment_type as Job['employmentType']) : null;
  const firstSeen = iso(r.first_seen) ?? new Date(0).toISOString();
  const lastSeen = iso(r.last_seen) ?? firstSeen;
  return {
    id,
    status: r.closed_at ? 'closed' : 'open',
    closedAt: iso(r.closed_at),
    closedReason: r.closed_reason && CLOSED_REASONS.has(r.closed_reason) ? (r.closed_reason as Job['closedReason']) : null,
    title: r.title,
    company: r.company,
    companyKey: companyKey(r.company),
    ats: !external && ATS_SET.has(r.ats) ? (r.ats as Job['ats']) : null,
    board: external ? null : r.board,
    externalId: external ? null : r.job_id,
    url,
    applyUrl: apply && apply !== url ? apply : null,
    canonicalUrl: url,
    places: r.location ? [{ text: r.location, city: null, region: null, country: null, placeId: null }] : [],
    isUs: r.is_us === null ? null : r.is_us === 1,
    workModel: workModelOf(r),
    remoteScope: null,
    employmentType: employment,
    level,
    levels: level ? [experienceLevelOf(level)] : [],
    yearsRequired: null,
    pay: payOf(r),
    postedAt: iso(r.posted_at),
    firstSeenAt: firstSeen,
    lastSeenAt: lastSeen,
    updatedAt: iso(r.updated_at) ?? lastSeen,
    department: r.department || null,
    statements: { sponsorship: null, clearanceRequired: null, usCitizenOnly: null },
    skills: [],
    evidence: {},
    sources: [{
      sourceId: external ? `external:${r.board}` : `ats:${r.ats}`,
      name: external ? 'Added by you' : `${r.company} careers (${ATS_LABEL[r.ats] ?? r.ats})`,
      url,
      credit: null,
      firstSeenAt: firstSeen,
      lastSeenAt: lastSeen,
    }],
    duplicateOf: r.duplicate_of !== null && r.d_ats && r.d_board && r.d_job_id ? makeJobId(r.d_ats, r.d_board, r.d_job_id) : null,
    contentHash: r.content_hash,
    description: r.description,
  };
}

export function toSummary(j: Job): JobSummary {
  const { description, ...rest } = j;
  return { ...rest, snippet: snippetOf(description) };
}

// ---------------------------------------------------------------- search

const SELECT = `SELECT j.*, d.ats AS d_ats, d.board AS d_board, d.job_id AS d_job_id,
  t.liked AS t_liked, t.hidden AS t_hidden, t.status AS t_status
  FROM jobs j
  LEFT JOIN jobs d ON d.id = j.duplicate_of
  LEFT JOIN srv_tracker t ON t.job_id = (lower(j.ats) || ':' || lower(j.board) || ':' || j.job_id)`;

type Row = JobRow & { t_liked: number | null; t_hidden: number | null; t_status: string | null; sort_key?: number | null };

interface Cursor { s: string; h: string; k: number | null; i: number }

function encodeCursor(c: Cursor): string { return Buffer.from(JSON.stringify(c)).toString('base64url'); }
function decodeCursor(text: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Cursor;
    if (typeof c.s === 'string' && typeof c.h === 'string' && typeof c.i === 'number' && (c.k === null || typeof c.k === 'number')) return c;
  } catch { /* fall through */ }
  return null;
}

const LEVEL_BUCKETS: Record<ExperienceLevel, Level[]> = {
  intern_new_grad: ['intern'], entry: ['entry'], mid: ['mid'], senior: ['senior'],
  lead_staff: ['staff', 'principal', 'lead', 'manager'], director_exec: ['director', 'vp', 'exec'],
};

/** Words for FTS5, each quoted as a phrase (operators and quotes are words, never syntax). */
function ftsQuery(q: string): { match: string | null; exact: string[] } {
  const words = q.split(/\s+/).map((w) => w.trim()).filter(Boolean).slice(0, 20);
  const tokens: string[] = [];
  const exact: string[] = [];
  for (const w of words) {
    const inner = w.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (inner) tokens.push(`"${inner.replace(/"/g, '""')}"`);
    if (/[+#.()]/.test(w)) exact.push(w.toLowerCase());
  }
  return { match: tokens.length ? tokens.join(' ') : null, exact };
}

export interface SearchDeps {
  hasProfile: () => boolean;
  networkCount: (companyKey: string) => number | null;
}

export class JobsService {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.function('jl_company_key', { deterministic: true }, (s: unknown) => companyKey(String(s ?? '')));
  }

  getRow(id: string): JobRow | null {
    const parts = /^([^:]+):([^:]+):(.+)$/.exec(id);
    if (!parts) return null;
    const head = `SELECT j.*, d.ats AS d_ats, d.board AS d_board, d.job_id AS d_job_id FROM jobs j LEFT JOIN jobs d ON d.id = j.duplicate_of`;
    // Exact match first: it uses the crawler's UNIQUE (ats, board, job_id) index. Stored ats and boards are lower
    // case in this build; the case-blind scan is only a fallback for rows written otherwise.
    const exact = this.db.prepare(`${head} WHERE j.ats = ? AND j.board = ? AND j.job_id = ?`).get(parts[1]!, parts[2]!, parts[3]!) as JobRow | undefined;
    if (exact) return exact;
    const r = this.db.prepare(`${head} WHERE lower(j.ats) = ? AND lower(j.board) = ? AND j.job_id = ?`)
      .get(parts[1]!.toLowerCase(), parts[2]!.toLowerCase(), parts[3]!) as JobRow | undefined;
    return r ?? null;
  }

  get(id: string): Job | null {
    const r = this.getRow(id);
    return r ? rowToJob(r) : null;
  }

  exists(id: string): boolean { return this.getRow(id) !== null; }

  /** The job whose page or apply link is this URL (extension fill), or null. */
  findByUrl(url: string): string | null {
    const r = this.db.prepare('SELECT ats, board, job_id FROM jobs WHERE canonical_url = ? OR apply_url = ? ORDER BY closed_at IS NOT NULL, id LIMIT 1')
      .get(url, url) as Pick<JobRow, 'ats' | 'board' | 'job_id'> | undefined;
    return r ? contractJobId(r) : null;
  }

  counts(): { jobs: number; openJobs: number } {
    const r = this.db.prepare('SELECT count(*) AS n, sum(closed_at IS NULL) AS o FROM jobs').get() as { n: number; o: number | null };
    return { jobs: Number(r.n), openJobs: Number(r.o ?? 0) };
  }

  search(req: JobSearchRequest, deps: SearchDeps): JobSearchResponse {
    const t0 = performance.now();
    const filter: JobFilter = req.filter ?? {};
    const sort = req.sort;
    const limit = req.limit ?? 20;
    const where: string[] = ['j.duplicate_of IS NULL', 'COALESCE(t.hidden, 0) = 0'];
    const args: SQLInputValue[] = [];
    const unknownOk = new Set(filter.includeUnknown ?? []);
    const nothing = () => where.push('0');

    where.push(filter.status === 'closed' ? 'j.closed_at IS NOT NULL' : 'j.closed_at IS NULL');

    if (req.q && req.q.trim()) {
      const { match, exact } = ftsQuery(req.q);
      if (match) { where.push('j.id IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)'); args.push(match); }
      for (const e of exact) { where.push("(instr(lower(j.title), ?) > 0 OR instr(lower(j.description), ?) > 0)"); args.push(e, e); }
    }
    if (filter.workModels?.length) {
      const parts = [`j.work_mode IN (${filter.workModels.map(() => '?').join(',')})`];
      args.push(...filter.workModels);
      if (filter.workModels.includes('remote')) parts.push("(j.work_mode = '' AND j.remote = 1)");
      if (unknownOk.has('workModel')) parts.push("(j.work_mode = '' AND j.remote = 0)");
      where.push(`(${parts.join(' OR ')})`);
    }
    if (filter.employmentTypes?.length) {
      const parts = [`j.employment_type IN (${filter.employmentTypes.map(() => '?').join(',')})`];
      args.push(...filter.employmentTypes);
      if (unknownOk.has('employmentType')) parts.push("j.employment_type = ''");
      where.push(`(${parts.join(' OR ')})`);
    }
    if (filter.levels?.length) {
      const lv = filter.levels.flatMap((b) => LEVEL_BUCKETS[b] ?? []);
      const parts = [lv.length ? `j.level IN (${lv.map(() => '?').join(',')})` : '0'];
      args.push(...lv);
      if (unknownOk.has('level')) parts.push('j.level IS NULL');
      where.push(`(${parts.join(' OR ')})`);
    }
    if (filter.postedWithin) {
      const ms = { '24h': 86_400_000, '3d': 3 * 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }[filter.postedWithin];
      const cutoff = new Date(nowMs() - ms).toISOString();
      where.push(`(julianday(j.posted_at) >= julianday(?)${unknownOk.has('postedAt') ? ' OR j.posted_at IS NULL' : ''})`);
      args.push(cutoff);
    }
    if (filter.minAnnualPayUsd !== undefined) {
      where.push(`((upper(j.pay_currency) = 'USD' AND COALESCE(j.pay_max_annual, j.pay_min_annual) >= ?)${unknownOk.has('pay') ? ' OR (j.pay_min IS NULL AND j.pay_max IS NULL)' : ''})`);
      args.push(filter.minAnnualPayUsd);
    }
    if (filter.countries?.length) {
      const us = filter.countries.includes('US');
      const other = filter.countries.some((c) => c !== 'US');
      const parts: string[] = [];
      if (us) parts.push('j.is_us = 1');
      if (other) parts.push('j.is_us = 0');
      if (unknownOk.has('place')) parts.push('j.is_us IS NULL');
      where.push(`(${parts.join(' OR ')})`);
    }
    if (filter.places?.length) {
      const parts = filter.places.map(() => 'instr(lower(j.location), ?) > 0');
      args.push(...filter.places.map((p) => p.text.toLowerCase()));
      if (unknownOk.has('place')) parts.push("j.location = ''");
      where.push(`(${parts.join(' OR ')})`);
    }
    if (filter.companies?.length) {
      where.push(`jl_company_key(j.company) IN (${filter.companies.map(() => '?').join(',')})`);
      args.push(...filter.companies);
    }
    if (filter.excludedCompanies?.length) {
      where.push(`jl_company_key(j.company) NOT IN (${filter.excludedCompanies.map(() => '?').join(',')})`);
      args.push(...filter.excludedCompanies);
    }
    for (const t of filter.excludedTitles ?? []) { where.push('instr(lower(j.title), ?) = 0'); args.push(t.toLowerCase()); }
    if (filter.jobFunctions?.length) {
      where.push(`(${filter.jobFunctions.map(() => 'instr(lower(j.title), ?) > 0').join(' OR ')})`);
      args.push(...filter.jobFunctions.map((f) => f.toLowerCase()));
    }
    for (const s of filter.skills ?? []) { where.push('(instr(lower(j.title), ?) > 0 OR instr(lower(j.description), ?) > 0)'); args.push(s.toLowerCase(), s.toLowerCase()); }
    for (const s of filter.excludedSkills ?? []) { where.push('instr(lower(j.description), ?) = 0'); args.push(s.toLowerCase()); }
    if (filter.sources?.length) {
      const parts: string[] = [];
      for (const s of filter.sources) {
        if (s.startsWith('ats:')) { parts.push('j.ats = ?'); args.push(s.slice(4)); }
        else if (s === 'external:url' || s === 'external:text') { parts.push("(j.ats = 'external' AND j.board = ?)"); args.push(s.slice(9)); }
      }
      where.push(parts.length ? `(${parts.join(' OR ')})` : '0');
    }
    // Facts this build does not have yet: a filter on them matches nothing (unless unknowns are allowed).
    if (filter.maxYearsRequired !== undefined && !unknownOk.has('years')) nothing();
    if (filter.remoteRegions?.length && !unknownOk.has('remoteRegion')) nothing();
    if (filter.h1bSponsorship) nothing();
    if (filter.industries?.length || filter.companyStages?.length || filter.roleTypes?.length) nothing();

    const keyExpr = sort === 'most_recent' ? 'julianday(j.posted_at)' : 'COALESCE(julianday(j.posted_at), julianday(j.first_seen))';
    const order = sort === 'most_recent' ? 'ORDER BY (sort_key IS NULL), sort_key DESC, j.id ASC' : 'ORDER BY sort_key DESC, j.id ASC';
    const hash = createHash('sha256').update(JSON.stringify([sort, req.q ?? '', filter])).digest('hex').slice(0, 16);

    const total = Number((this.db.prepare(`SELECT count(*) AS n FROM jobs j LEFT JOIN srv_tracker t ON t.job_id = (lower(j.ats) || ':' || lower(j.board) || ':' || j.job_id) WHERE ${where.join(' AND ')}`).get(...args) as { n: number }).n);

    const pageWhere = [...where];
    const pageArgs = [...args];
    if (req.cursor) {
      const c = decodeCursor(req.cursor);
      if (!c || c.h !== hash || c.s !== sort) throw new ApiFailure('bad_request', 'The cursor belongs to another search. Start again from the first page.');
      if (c.k === null) { pageWhere.push(`(${keyExpr} IS NULL AND j.id > ?)`); pageArgs.push(c.i); }
      else { pageWhere.push(`((${keyExpr} < ?) OR (${keyExpr} = ? AND j.id > ?) OR ${keyExpr} IS NULL)`); pageArgs.push(c.k, c.k, c.i); }
    }
    const rows = this.db.prepare(`${SELECT.replace('SELECT j.*', `SELECT ${keyExpr} AS sort_key, j.*`)} WHERE ${pageWhere.join(' AND ')} ${order} LIMIT ?`)
      .all(...pageArgs, limit + 1) as unknown as Row[];
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const items: JobListItem[] = page.map((r) => {
      const job = rowToJob(r);
      return {
        job: toSummary(job),
        match: null,
        liked: r.t_liked === 1,
        hidden: r.t_hidden === 1,
        trackerStatus: (r.t_status as TrackerStatus | null) ?? null,
        networkCount: deps.networkCount(job.companyKey),
        h1bTag: null,
        fitScore: null,
      };
    });
    return {
      items,
      total,
      nextCursor: more && last ? encodeCursor({ s: sort, h: hash, k: last.sort_key ?? null, i: last.id }) : null,
      fit: sort === 'top_matched' && !deps.hasProfile()
        ? { state: 'needs_profile', waiting: 0, model: null }
        : { state: 'not_ready', waiting: 0, model: null },
      tookMs: Math.round(performance.now() - t0),
    };
  }
}

export function detailOf(job: Job, extra: Omit<JobDetail, 'job'>): JobDetail {
  return { job, ...extra };
}
