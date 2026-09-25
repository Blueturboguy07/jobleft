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
import { canonicalizeUrl } from '@jobleft/crawler';
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
  for (const raw of words) {
    const w = raw.replace(/^["'“”‘’]+|["'“”‘’,;:!?]+$/g, '');
    const inner = w.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (inner) tokens.push(`"${inner.replace(/"/g, '""')}"`);
    if (/[+#.()]/.test(w)) exact.push(w.toLowerCase());
  }
  return { match: tokens.length ? tokens.join(' ') : null, exact };
}

export interface CandidateRow {
  id: number; title: string; company: string; location: string; work_mode: string; remote: number;
  employment_type: string; level: string | null; is_us: number | null; sort_rec: number | null;
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
    this.ensureIndexes();
  }

  /**
   * INTERIM search index (the store lane's search replaces it). The crawler's `jobs` rows keep the long description
   * before the state columns, so reading `closed_at` means reading the whole posting. `srv_job_index` holds one
   * narrow row per OPEN, NON-DUPLICATE job with the facts the filters and sorts use; triggers keep it in step with
   * every write to `jobs` (they use built-in SQL only, so the crawler's own connection can fire them). A search
   * reads this small table in index order and fetches full postings only for the page it returns.
   */
  private ensureIndexes(): void {
    const has = (name: string) => this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(name) !== undefined;
    const cols = `id, sort_rec, sort_new, work_mode, remote, employment_type, level, is_us, pay_currency, pay_annual, has_pay, title, company, location, ats, board`;
    const vals = (r: string) => `${r}.id, COALESCE(julianday(${r}.posted_at), julianday(${r}.first_seen)), julianday(${r}.posted_at), ${r}.work_mode, ${r}.remote,
      ${r}.employment_type, ${r}.level, ${r}.is_us, upper(${r}.pay_currency), COALESCE(${r}.pay_max_annual, ${r}.pay_min_annual),
      (${r}.pay_min IS NOT NULL OR ${r}.pay_max IS NOT NULL), ${r}.title, ${r}.company, ${r}.location, ${r}.ats, ${r}.board`;
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS srv_jobs_apply ON jobs(apply_url);
      CREATE INDEX IF NOT EXISTS srv_jobs_key ON jobs(lower(ats), lower(board), job_id);
    `);
    if (has('srv_job_index') && has('srv_job_index_au')) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        DROP TABLE IF EXISTS srv_job_index;
        CREATE TABLE srv_job_index (
          id INTEGER PRIMARY KEY, sort_rec REAL, sort_new REAL, work_mode TEXT NOT NULL, remote INTEGER NOT NULL,
          employment_type TEXT NOT NULL, level TEXT, is_us INTEGER, pay_currency TEXT, pay_annual REAL, has_pay INTEGER NOT NULL,
          title TEXT NOT NULL, company TEXT NOT NULL, location TEXT NOT NULL, ats TEXT NOT NULL, board TEXT NOT NULL
        );
        CREATE INDEX srv_job_index_rec ON srv_job_index(sort_rec DESC, id);
        CREATE INDEX srv_job_index_new ON srv_job_index((sort_new IS NULL), sort_new DESC, id);
        INSERT INTO srv_job_index (${cols}) SELECT ${vals('j')} FROM jobs j WHERE j.closed_at IS NULL AND j.duplicate_of IS NULL;
        CREATE TRIGGER IF NOT EXISTS srv_job_index_ai AFTER INSERT ON jobs WHEN NEW.closed_at IS NULL AND NEW.duplicate_of IS NULL BEGIN
          INSERT OR REPLACE INTO srv_job_index (${cols}) VALUES (${vals('NEW')});
        END;
        CREATE TRIGGER IF NOT EXISTS srv_job_index_ad AFTER DELETE ON jobs BEGIN
          DELETE FROM srv_job_index WHERE id = OLD.id;
        END;
        CREATE TRIGGER IF NOT EXISTS srv_job_index_au AFTER UPDATE OF closed_at, duplicate_of, posted_at, first_seen, work_mode, remote,
          employment_type, level, is_us, pay_currency, pay_min, pay_max, pay_min_annual, pay_max_annual, title, company, location ON jobs BEGIN
          DELETE FROM srv_job_index WHERE id = OLD.id;
          INSERT INTO srv_job_index (${cols}) SELECT ${vals('NEW')} WHERE NEW.closed_at IS NULL AND NEW.duplicate_of IS NULL;
        END;
      `);
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ended */ }
      throw e;
    }
  }

  /** Crawler row ids of the jobs the person hid. */
  private hiddenRowIds(): number[] {
    const out: number[] = [];
    for (const r of this.db.prepare('SELECT job_id FROM srv_tracker WHERE hidden = 1').all() as Array<{ job_id: string }>) {
      const row = this.getRow(r.job_id);
      if (row) out.push(Number(row.id));
    }
    return out;
  }

  getRow(id: string): JobRow | null {
    const parts = /^([^:]+):([^:]+):(.+)$/.exec(id);
    if (!parts) return null;
    const head = `SELECT j.*, d.ats AS d_ats, d.board AS d_board, d.job_id AS d_job_id FROM jobs j LEFT JOIN jobs d ON d.id = j.duplicate_of`;
    // Exact match first: it uses the crawler's UNIQUE (ats, board, job_id) index. Stored ats and boards are lower
    // case in this build; the case-blind scan is only a fallback for rows written otherwise.
    const exact = this.db.prepare(`${head} WHERE j.ats = ? AND j.board = ? AND j.job_id = ?`).get(parts[1]!, parts[2]!, parts[3]!) as JobRow | undefined;
    if (exact) return exact;
    const r = this.db.prepare(`${head} WHERE lower(j.ats) = ? AND lower(j.board) = ? AND j.job_id = ? LIMIT 1`)
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
    for (const u of new Set([url, canonicalizeUrl(url)])) {
      if (!u) continue;
      const r = (this.db.prepare('SELECT ats, board, job_id FROM jobs WHERE canonical_url = ?').get(u)
        ?? this.db.prepare('SELECT ats, board, job_id FROM jobs WHERE apply_url = ? ORDER BY closed_at IS NOT NULL, id LIMIT 1').get(u)) as Pick<JobRow, 'ats' | 'board' | 'job_id'> | undefined;
      if (r) return contractJobId(r);
    }
    return null;
  }

  counts(): { jobs: number; openJobs: number } {
    const n = this.db.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number };
    const o = this.db.prepare('SELECT count(*) AS n FROM jobs WHERE closed_at IS NULL').get() as { n: number };
    return { jobs: Number(n.n), openJobs: Number(o.n) };
  }

  /**
   * The WHERE clause of a search (every filter and the words), over `srv_job_index x` for open jobs or `jobs x` for
   * closed ones. `restrictIds` (i-core): crawler row ids a filter computed outside SQL (the H-1B filter) must be in.
   */
  buildWhere(req: JobSearchRequest, restrictIds?: number[] | null): { T: string; where: string[]; args: SQLInputValue[]; closed: boolean } {
    const filter: JobFilter = req.filter ?? {};
    const closed = filter.status === 'closed';
    // Open jobs: the narrow index table. Closed jobs (rare): the crawler's table itself.
    const T = closed ? 'jobs x' : 'srv_job_index x';
    const where: string[] = closed ? ['x.closed_at IS NOT NULL', 'x.duplicate_of IS NULL'] : [];
    const args: SQLInputValue[] = [];
    const unknownOk = new Set(filter.includeUnknown ?? []);
    const nothing = () => where.push('0');
    const fts = (text: string): string | null => ftsQuery(text).match;

    if (req.q && req.q.trim()) {
      const { match, exact } = ftsQuery(req.q);
      if (match) { where.push('x.id IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)'); args.push(match); }
      // Words with symbols (C++, C#, .NET, 401(k)) must appear as written: checked only on the rows the words matched.
      for (const e of exact) {
        if (match) { where.push('x.id IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ? AND (instr(lower(title), ?) > 0 OR instr(lower(description), ?) > 0))'); args.push(match, e, e); }
        else { where.push('x.id IN (SELECT id FROM jobs WHERE instr(lower(title), ?) > 0 OR instr(lower(description), ?) > 0)'); args.push(e, e); }
      }
    }
    if (filter.workModels?.length) {
      const parts = [`x.work_mode IN (${filter.workModels.map(() => '?').join(',')})`];
      args.push(...filter.workModels);
      if (filter.workModels.includes('remote')) parts.push("(x.work_mode = '' AND x.remote = 1)");
      if (unknownOk.has('workModel')) parts.push("(x.work_mode = '' AND x.remote = 0)");
      where.push(`(${parts.join(' OR ')})`);
    }
    if (filter.employmentTypes?.length) {
      const parts = [`x.employment_type IN (${filter.employmentTypes.map(() => '?').join(',')})`];
      args.push(...filter.employmentTypes);
      if (unknownOk.has('employmentType')) parts.push("x.employment_type = ''");
      where.push(`(${parts.join(' OR ')})`);
    }
    if (filter.levels?.length) {
      const lv = filter.levels.flatMap((b) => LEVEL_BUCKETS[b] ?? []);
      const parts = [lv.length ? `x.level IN (${lv.map(() => '?').join(',')})` : '0'];
      args.push(...lv);
      if (unknownOk.has('level')) parts.push('x.level IS NULL');
      where.push(`(${parts.join(' OR ')})`);
    }
    if (filter.postedWithin) {
      const ms = { '24h': 86_400_000, '3d': 3 * 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }[filter.postedWithin];
      const cutoff = new Date(nowMs() - ms).toISOString();
      const col = closed ? 'julianday(x.posted_at)' : 'x.sort_new';
      where.push(`(${col} >= julianday(?)${unknownOk.has('postedAt') ? ` OR ${col} IS NULL` : ''})`);
      args.push(cutoff);
    }
    if (filter.minAnnualPayUsd !== undefined) {
      const cur = closed ? 'upper(x.pay_currency)' : 'x.pay_currency';
      const amount = closed ? 'COALESCE(x.pay_max_annual, x.pay_min_annual)' : 'x.pay_annual';
      const none = closed ? '(x.pay_min IS NULL AND x.pay_max IS NULL)' : 'x.has_pay = 0';
      where.push(`((${cur} = 'USD' AND ${amount} >= ?)${unknownOk.has('pay') ? ` OR ${none}` : ''})`);
      args.push(filter.minAnnualPayUsd);
    }
    if (filter.countries?.length) {
      const parts: string[] = [];
      if (filter.countries.includes('US')) parts.push('x.is_us = 1');
      if (filter.countries.some((c) => c !== 'US')) parts.push('x.is_us = 0');
      if (unknownOk.has('place')) parts.push('x.is_us IS NULL');
      where.push(`(${parts.join(' OR ')})`);
    }
    if (filter.places?.length) {
      const parts = filter.places.map(() => 'instr(lower(x.location), ?) > 0');
      args.push(...filter.places.map((p) => p.text.toLowerCase()));
      if (unknownOk.has('place')) parts.push("x.location = ''");
      where.push(`(${parts.join(' OR ')})`);
    }
    if (filter.companies?.length) {
      where.push(`jl_company_key(x.company) IN (${filter.companies.map(() => '?').join(',')})`);
      args.push(...filter.companies);
    }
    if (filter.excludedCompanies?.length) {
      where.push(`jl_company_key(x.company) NOT IN (${filter.excludedCompanies.map(() => '?').join(',')})`);
      args.push(...filter.excludedCompanies);
    }
    for (const t of filter.excludedTitles ?? []) { where.push('instr(lower(x.title), ?) = 0'); args.push(t.toLowerCase()); }
    if (filter.jobFunctions?.length) {
      where.push(`(${filter.jobFunctions.map(() => 'instr(lower(x.title), ?) > 0').join(' OR ')})`);
      args.push(...filter.jobFunctions.map((f) => f.toLowerCase()));
    }
    for (const sk of filter.skills ?? []) {
      const m = fts(sk);
      if (m) { where.push('x.id IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)'); args.push(m); }
    }
    for (const sk of filter.excludedSkills ?? []) {
      const m = fts(sk);
      if (m) { where.push('x.id NOT IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)'); args.push(m); }
    }
    if (filter.sources?.length) {
      const parts: string[] = [];
      for (const src of filter.sources) {
        if (src.startsWith('ats:')) { parts.push('x.ats = ?'); args.push(src.slice(4)); }
        else if (src === 'external:url' || src === 'external:text') { parts.push("(x.ats = 'external' AND x.board = ?)"); args.push(src.slice(9)); }
      }
      where.push(parts.length ? `(${parts.join(' OR ')})` : '0');
    }
    // Facts this build does not have yet: a filter on them matches nothing (unless unknowns are allowed).
    if (filter.maxYearsRequired !== undefined && !unknownOk.has('years')) nothing();
    if (filter.remoteRegions?.length && !unknownOk.has('remoteRegion')) nothing();
    if (restrictIds) { where.push('x.id IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify(restrictIds)); }
    else if (filter.h1bSponsorship) nothing();
    if (filter.industries?.length || filter.companyStages?.length || filter.roleTypes?.length) nothing();

    // Jobs the person hid never appear: a short list of row ids (hidden jobs are few).
    const hidden = this.hiddenRowIds();
    if (hidden.length) where.push(`x.id NOT IN (${hidden.join(',')})`);
    return { T, where, args, closed };
  }

  /** i-core: the narrow facts of every job a search matches (the personal ranking reads them). */
  candidates(req: JobSearchRequest, restrictIds?: number[] | null): CandidateRow[] {
    const { T, where, args, closed } = this.buildWhere(req, restrictIds);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rec = closed ? 'COALESCE(julianday(x.posted_at), julianday(x.first_seen))' : 'x.sort_rec';
    const wm = closed ? "COALESCE(x.work_mode, '')" : 'x.work_mode';
    return this.db.prepare(`SELECT x.id AS id, x.title AS title, x.company AS company, x.location AS location, ${wm} AS work_mode, x.remote AS remote,
      x.employment_type AS employment_type, x.level AS level, x.is_us AS is_us, ${rec} AS sort_rec FROM ${T} ${w}`).all(...args) as unknown as CandidateRow[];
  }

  /** i-core: list items for crawler row ids, in the given order. */
  itemsFor(ids: number[], deps: SearchDeps): JobListItem[] {
    const byId = new Map<number, Row>();
    if (ids.length) {
      for (const r of this.db.prepare(`${SELECT} WHERE j.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as Row[]) byId.set(r.id, r);
    }
    const items: JobListItem[] = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) continue;
      const job = rowToJob(r);
      items.push({
        job: toSummary(job), match: null, liked: r.t_liked === 1, hidden: r.t_hidden === 1,
        trackerStatus: (r.t_status as TrackerStatus | null) ?? null, networkCount: deps.networkCount(job.companyKey), h1bTag: null, fitScore: null,
      });
    }
    return items;
  }

  search(req: JobSearchRequest, deps: SearchDeps, restrictIds?: number[] | null): JobSearchResponse {
    const t0 = performance.now();
    const filter: JobFilter = req.filter ?? {};
    const sort = req.sort;
    const limit = req.limit ?? 20;
    const { T, where, args, closed } = this.buildWhere(req, restrictIds);

    const keyExpr = closed
      ? (sort === 'most_recent' ? 'julianday(x.posted_at)' : 'COALESCE(julianday(x.posted_at), julianday(x.first_seen))')
      : (sort === 'most_recent' ? 'x.sort_new' : 'x.sort_rec');
    const order = sort === 'most_recent' ? `ORDER BY (${keyExpr} IS NULL), ${keyExpr} DESC, x.id` : `ORDER BY ${keyExpr} DESC, x.id`;
    const hash = createHash('sha256').update(JSON.stringify([sort, req.q ?? '', filter])).digest('hex').slice(0, 16);
    const w = (list: string[]) => (list.length ? `WHERE ${list.join(' AND ')}` : '');

    const total = Number((this.db.prepare(`SELECT count(*) AS n FROM ${T} ${w(where)}`).get(...args) as { n: number }).n);

    const pageWhere = [...where];
    const pageArgs = [...args];
    if (req.cursor) {
      const c = decodeCursor(req.cursor);
      if (!c || c.h !== hash || c.s !== sort) throw new ApiFailure('bad_request', 'The cursor belongs to another search. Start again from the first page.');
      if (c.k === null) { pageWhere.push(`(${keyExpr} IS NULL AND x.id > ?)`); pageArgs.push(c.i); }
      else { pageWhere.push(`((${keyExpr} < ?) OR (${keyExpr} = ? AND x.id > ?) OR ${keyExpr} IS NULL)`); pageArgs.push(c.k, c.k, c.i); }
    }
    const ids = this.db.prepare(`SELECT x.id AS id, ${keyExpr} AS sort_key FROM ${T} ${w(pageWhere)} ${order} LIMIT ?`)
      .all(...pageArgs, limit + 1) as Array<{ id: number; sort_key: number | null }>;
    const more = ids.length > limit;
    const pageIds = more ? ids.slice(0, limit) : ids;
    const last = pageIds[pageIds.length - 1];
    const items = this.itemsFor(pageIds.map((x) => x.id), deps);
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
