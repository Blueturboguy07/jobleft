// Crawl rows -> contract `Job` records (packages/contracts/src/job.ts). The store lane serves them on the jobs
// endpoints; the crawler's own CLI (`jobleft-crawl jobs`) prints the same records so a crawl can be checked alone.

import type { DatabaseSync } from 'node:sqlite';
import type {
  EmploymentType, ExperienceLevel, Job as ContractJob, JobEvidence, Level, Pay, PayPeriod, Place, PostingStatements, RemoteScope,
  SourceAttribution,
} from '@jobleft/contracts';
import { ATS_NAMES } from './store.ts';

/** The contract job id: "<ats>:<board>:<externalId>" with ATS and board in lower case (same rule as store makeJobId). */
export function jobIdOf(ats: string, board: string, externalId: string): string {
  return `${ats.toLowerCase()}:${board.toLowerCase()}:${externalId}`;
}

/**
 * A simple company key for the crawler's own output (lower case, accents removed, "&" and "+" to "and", a leading "the"
 * and legal suffixes removed, punctuation and spaces removed). The app uses @jobleft/static-data companyKey instead.
 */
export function simpleCompanyKey(name: string): string {
  let s = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/[&+]/g, ' and ');
  s = s.replace(/^\s*the\s+/, '');
  s = s.replace(/[.,]/g, ' ');
  s = s.replace(/\b(inc|llc|l l c|corp|corporation|co|ltd|llp|plc|pbc|gmbh)\b\s*$/g, '').trim();
  s = s.replace(/\b(inc|llc|corp|corporation|co|ltd|llp|plc|pbc|gmbh)\b\s*$/g, '').trim();
  return s.replace(/[^a-z0-9]+/g, '');
}

export interface JobRow {
  id: number; ats: string; board: string; job_id: string; canonical_url: string; apply_url: string; duplicate_of: number | null;
  title: string; company: string; location: string; is_us: number | null; level: string | null; pay_min: number | null;
  pay_max: number | null; pay_currency: string | null; pay_period: string | null; pay_min_annual: number | null;
  pay_max_annual: number | null; pay_source: string | null; posted_at: string | null; department: string; description: string;
  content_hash: string; first_seen: string; last_seen: string; updated_at: string; closed_at: string | null;
  closed_reason: string | null; page_url: string | null; apply_link: string | null; places_json: string; work_model: string | null;
  remote_scope_json: string | null; employment: string | null; levels_json: string; years_min: number | null;
  years_max: number | null; statements_json: string | null; evidence_json: string; pay_ranges: number | null;
  miss_count: number; first_missed_at: string | null; board_updated_at: string | null;
}
interface SourceRow { source_id: string; name: string; url: string; credit_json: string | null; first_seen: string; last_seen: string }

function json<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
function httpOrNull(u: string | null | undefined): string | null {
  if (!u) return null;
  return /^https?:\/\//i.test(u) ? u : null;
}

const CLOSED_REASONS = new Set(['unseen', 'board_empty', 'source_removed', 'user']);

export interface ToJobOptions {
  companyKey?: (name: string) => string;
  /** The contract id of the row this one repeats, when duplicate_of is set. */
  duplicateOfId?: string | null;
}

export function toContractJob(r: JobRow, sources: SourceRow[], opts: ToJobOptions = {}): ContractJob {
  const url = httpOrNull(r.page_url) ?? httpOrNull(r.apply_url) ?? r.canonical_url;
  let pay: Pay | null = null;
  if ((r.pay_min !== null || r.pay_max !== null) && r.pay_period && r.pay_currency) {
    pay = {
      min: r.pay_min, max: r.pay_max, currency: r.pay_currency, period: r.pay_period as PayPeriod,
      source: r.pay_source === 'api' ? 'board_field' : 'description',
      ranges: r.pay_ranges && r.pay_ranges > 0 ? r.pay_ranges : 1,
      annualMin: r.pay_min_annual, annualMax: r.pay_max_annual,
    };
  }
  const attributions: SourceAttribution[] = sources
    .filter((s) => httpOrNull(s.url))
    .map((s) => ({ sourceId: s.source_id, name: s.name, url: s.url, credit: json(s.credit_json, null), firstSeenAt: s.first_seen, lastSeenAt: s.last_seen }));
  if (attributions.length === 0) {
    attributions.push({ sourceId: `ats:${r.ats}`, name: `${r.company} careers (${ATS_NAMES[r.ats] ?? r.ats})`, url, credit: null, firstSeenAt: r.first_seen, lastSeenAt: r.last_seen });
  }
  const statements = json<PostingStatements>(r.statements_json, { sponsorship: null, clearanceRequired: null, usCitizenOnly: null });
  const years = r.years_min === null && r.years_max === null ? null : { min: r.years_min, max: r.years_max };
  const reason = r.closed_at ? (r.closed_reason === 'board_gone' ? 'board_empty' : CLOSED_REASONS.has(r.closed_reason ?? '') ? r.closed_reason : 'unseen') : null;
  return {
    id: jobIdOf(r.ats, r.board, r.job_id),
    status: r.closed_at ? 'closed' : 'open',
    closedAt: r.closed_at,
    closedReason: reason as ContractJob['closedReason'],
    title: r.title,
    company: r.company,
    companyKey: (opts.companyKey ?? simpleCompanyKey)(r.company),
    ats: r.ats as ContractJob['ats'],
    board: r.board,
    externalId: r.job_id,
    url,
    applyUrl: httpOrNull(r.apply_link),
    canonicalUrl: r.canonical_url,
    places: json<Place[]>(r.places_json, []),
    isUs: r.is_us === null ? null : r.is_us === 1,
    workModel: (r.work_model as ContractJob['workModel']) ?? null,
    remoteScope: json<RemoteScope | null>(r.remote_scope_json, null),
    employmentType: (r.employment as EmploymentType | null) ?? null,
    level: (r.level as Level | null) ?? null,
    levels: json<ExperienceLevel[]>(r.levels_json, []),
    yearsRequired: years,
    pay,
    postedAt: r.posted_at,
    firstSeenAt: r.first_seen,
    lastSeenAt: r.last_seen,
    updatedAt: r.updated_at,
    department: r.department ? r.department : null,
    statements,
    skills: [],
    evidence: json<JobEvidence>(r.evidence_json, {}),
    sources: attributions,
    duplicateOf: opts.duplicateOfId ?? null,
    contentHash: r.content_hash,
    description: r.description,
  };
}

export interface JobQuery {
  /** open, closed or all (default all). */
  status?: 'open' | 'closed' | 'all';
  /** Words to find (all of them) in title, company, places and description. */
  q?: string;
  /** Only this board: "<ats>:<board>". */
  board?: string;
  /** Include rows that repeat another board's posting (hidden by default, as in the app). */
  includeDuplicates?: boolean;
  limit?: number;
  /** Opaque cursor from the previous page. */
  cursor?: string | null;
  companyKey?: (name: string) => string;
}

export interface JobPage { total: number; open: number; closed: number; items: ContractJob[]; nextCursor: string | null }

/** Turns user words into a safe FTS5 query: every word must appear; no word is read as syntax. */
export function ftsQuery(q: string): string | null {
  const words = q.normalize('NFKC').split(/\s+/).map((w) => w.replace(/["]/g, '').trim()).filter(Boolean).slice(0, 32);
  if (words.length === 0) return null;
  return words.map((w) => `"${w}"`).join(' ');
}

function sourcesFor(db: DatabaseSync, id: number): SourceRow[] {
  return db.prepare('SELECT source_id, name, url, credit_json, first_seen, last_seen FROM job_sources WHERE job = ? ORDER BY first_seen, source_id').all(id) as unknown as SourceRow[];
}

function dupId(db: DatabaseSync, row: JobRow): string | null {
  if (row.duplicate_of === null) return null;
  const d = db.prepare('SELECT ats, board, job_id FROM jobs WHERE id = ?').get(row.duplicate_of) as { ats: string; board: string; job_id: string } | undefined;
  return d ? jobIdOf(d.ats, d.board, d.job_id) : null;
}

/** Reads jobs as contract records: filter, words, paging by row id (stable while new rows arrive). */
export function queryJobs(db: DatabaseSync, q: JobQuery = {}): JobPage {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (q.status === 'open') where.push('j.closed_at IS NULL');
  else if (q.status === 'closed') where.push('j.closed_at IS NOT NULL');
  if (!q.includeDuplicates) where.push('j.duplicate_of IS NULL');
  if (q.board) {
    const i = q.board.indexOf(':');
    where.push('lower(j.ats) = ? AND lower(j.board) = ?');
    params.push(q.board.slice(0, i).toLowerCase(), q.board.slice(i + 1).toLowerCase());
  }
  let from = 'jobs j';
  const fts = q.q ? ftsQuery(q.q) : null;
  if (fts) {
    from = 'jobs_fts f CROSS JOIN jobs j';
    where.push('j.id = f.rowid AND jobs_fts MATCH ?');
    params.push(fts);
  }
  const base = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const counts = db.prepare(`SELECT count(*) AS n, sum(j.closed_at IS NULL) AS o FROM ${from} ${base}`).get(...params) as { n: number; o: number | null };
  const limit = Math.max(1, Math.min(10_000, q.limit ?? 100));
  const after = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString('utf8')) : 0;
  const rows = db.prepare(`SELECT j.* FROM ${from} ${base ? base + ' AND' : 'WHERE'} j.id > ? ORDER BY j.id LIMIT ?`)
    .all(...params, Number.isFinite(after) ? after : 0, limit + 1) as unknown as JobRow[];
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const total = Number(counts.n);
  const open = Number(counts.o ?? 0);
  return {
    total, open, closed: total - open,
    items: page.map((r) => toContractJob(r, sourcesFor(db, r.id), { companyKey: q.companyKey, duplicateOfId: dupId(db, r) })),
    nextCursor: more ? Buffer.from(String(page[page.length - 1]!.id), 'utf8').toString('base64url') : null,
  };
}

/** One job by its contract id, or null. */
export function getJobById(db: DatabaseSync, id: string, opts: { companyKey?: (name: string) => string } = {}): ContractJob | null {
  const a = id.indexOf(':');
  const b = id.indexOf(':', a + 1);
  if (a < 0 || b < 0) return null;
  const row = db.prepare('SELECT * FROM jobs WHERE lower(ats) = ? AND lower(board) = ? AND job_id = ?')
    .get(id.slice(0, a).toLowerCase(), id.slice(a + 1, b).toLowerCase(), id.slice(b + 1)) as unknown as JobRow | undefined;
  return row ? toContractJob(row, sourcesFor(db, row.id), { companyKey: opts.companyKey, duplicateOfId: dupId(db, row) }) : null;
}
