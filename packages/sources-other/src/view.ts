// Contract Job records for jobs that other sources list, with every source's credit and link (sources-other O1, O2,
// O10). The store lane builds the app's Job records; this module is the reference for how feed facts map, and it
// backs the lane's CLI (`jobs`, `export`) and the source counts (`SourceInfo.status.openJobs`).
//
// A "shown" job is: open (jobs.closed_at IS NULL) and not a repeat of another OPEN row (duplicate_of pointing at an
// open row). The same rule gives the per-source counts, so a filter by source agrees with the source list (O14).

import type { DatabaseSync } from 'node:sqlite';
import {
  JobSchema, experienceLevelOf, validate,
} from '@jobleft/contracts';
import type { AtsId, Credit, EmploymentType, Job, JobEvidence, Level, Pay, Place, RemoteScope, SourceAttribution, WorkModel } from '@jobleft/contracts';
import { atsBoardFromUrl } from './discover.ts';
import { jobKeyOf } from './runner.ts';

interface Row {
  id: number; ats: string; board: string; job_id: string; canonical_url: string; apply_url: string; duplicate_of: number | null;
  title: string; company: string; company_slug: string; location: string; remote: number; work_mode: string; is_us: number | null;
  level: string | null; level_source: string | null; pay_min: number | null; pay_max: number | null; pay_currency: string | null;
  pay_period: string | null; pay_min_annual: number | null; pay_max_annual: number | null; pay_source: string | null;
  posted_at: string | null; employment_type: string; department: string; description: string; content_hash: string;
  first_seen: string; last_seen: string; updated_at: string; closed_at: string | null; closed_reason: string | null;
}

interface PostingRow {
  source_id: string; external_id: string; job_ats: string; job_board: string; job_ext_id: string; job_key: string;
  source_name: string; url: string; apply_url: string | null; canonical_url: string; credit_text: string | null;
  credit_url: string | null; title: string; company: string; posted_at: string | null; places_json: string;
  work_model: string | null; remote_scope_json: string | null; employment_type: string | null; level: string | null;
  pay_json: string | null; is_us: number | null; statements_json: string; evidence_json: string; first_seen_at: string;
  last_seen_at: string; status: string; closed_at: string | null; closed_reason: string | null;
}

const ATS_NAMES: Record<string, string> = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workable: 'Workable', recruitee: 'Recruitee', personio: 'Personio',
};

/** SQL condition for rows the job list shows (open, and not a repeat of another open row). Alias: j. */
export const SHOWN_SQL = `j.closed_at IS NULL AND (j.duplicate_of IS NULL OR NOT EXISTS (SELECT 1 FROM jobs d WHERE d.id = j.duplicate_of AND d.closed_at IS NULL))`;

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function creditOf(p: PostingRow): Credit | null {
  return p.credit_text && p.credit_url ? { text: p.credit_text, url: p.credit_url } : null;
}

/** One line of credit for notifications and alerts: "Found on Remote OK (https://remoteok.com/)". */
export function creditLine(sources: SourceAttribution[]): string {
  const parts = sources.filter((s) => s.credit).map((s) => `${s.credit!.text} (${s.credit!.url})`);
  return [...new Set(parts)].join(' · ');
}

function payFromRow(r: Row): Pay | null {
  if (!r.pay_currency || !r.pay_period || (r.pay_min === null && r.pay_max === null)) return null;
  return {
    min: r.pay_min, max: r.pay_max, currency: r.pay_currency, period: r.pay_period as Pay['period'],
    source: r.pay_source === 'api' ? 'board_field' : 'description', ranges: 1, annualMin: r.pay_min_annual, annualMax: r.pay_max_annual,
  };
}

function toJob(db: DatabaseSync, r: Row, postings: PostingRow[]): Job {
  const own = r.ats.startsWith('feed:');
  const primary = postings.find((p) => own && `feed:${p.source_id}` === r.ats && p.job_key === jobKeyOf(r.ats, r.board, r.job_id)) ?? postings[0]!;
  const facts = {
    places: parseJson<Place[]>(primary.places_json, []),
    remoteScope: parseJson<RemoteScope | null>(primary.remote_scope_json, null),
    pay: parseJson<Pay | null>(primary.pay_json, null),
    evidence: parseJson<JobEvidence>(primary.evidence_json, {}),
    statements: parseJson<Job['statements']>(primary.statements_json, { sponsorship: null, clearanceRequired: null, usCitizenOnly: null }),
  };
  const evidence: JobEvidence = { ...facts.evidence };
  let level = (primary.level as Level | null) ?? null;
  if (!level && r.level) {
    level = r.level as Level;
    evidence.level = { source: r.level_source === 'title' ? 'title' : 'description', text: r.level_source === 'title' ? r.title.slice(0, 500) : 'years of experience stated in the posting' };
  }
  let pay = facts.pay;
  if (!pay) {
    pay = payFromRow(r);
    if (pay && !evidence.pay) evidence.pay = { source: 'description', text: 'pay range stated in the posting text' };
  }
  const workModel = (primary.work_model as WorkModel | null) ?? null;
  const isUs = primary.is_us !== null ? primary.is_us === 1 : r.is_us === null ? null : r.is_us === 1;
  const sources: SourceAttribution[] = postings.map((p) => ({
    sourceId: p.source_id, name: p.source_name, url: p.url, credit: creditOf(p), firstSeenAt: p.first_seen_at, lastSeenAt: p.last_seen_at,
  }));
  if (!own) {
    sources.unshift({
      sourceId: `ats:${r.ats}`, name: `${r.company} careers (${ATS_NAMES[r.ats] ?? r.ats})`, url: r.apply_url || r.canonical_url,
      credit: null, firstSeenAt: r.first_seen, lastSeenAt: r.last_seen,
    });
  }
  const link = own ? primary.url : (r.apply_url || r.canonical_url);
  const detected = atsBoardFromUrl(primary.apply_url ?? primary.url);
  let duplicateOf: string | null = null;
  if (r.duplicate_of !== null) {
    const d = db.prepare('SELECT ats, board, job_id FROM jobs WHERE id = ?').get(r.duplicate_of) as { ats: string; board: string; job_id: string } | undefined;
    if (d) duplicateOf = jobKeyOf(d.ats, d.board, d.job_id);
  }
  const et = (primary.employment_type as EmploymentType | null) ?? (r.employment_type ? r.employment_type as EmploymentType : null);
  const job: Job = {
    id: jobKeyOf(r.ats, r.board, r.job_id),
    status: r.closed_at ? 'closed' : 'open',
    closedAt: r.closed_at,
    closedReason: r.closed_at ? (own && r.closed_reason === 'unseen' ? 'source_removed' : (r.closed_reason as Job['closedReason']) ?? 'source_removed') : null,
    title: r.title,
    company: r.company,
    companyKey: r.company_slug,
    ats: own ? (detected?.ats ?? null) as AtsId | null : r.ats as AtsId,
    board: own ? detected?.board ?? null : r.board,
    externalId: own ? primary.external_id : r.job_id,
    url: link,
    applyUrl: own ? (primary.apply_url && primary.apply_url !== link ? primary.apply_url : null) : null,
    canonicalUrl: r.canonical_url,
    places: facts.places,
    isUs,
    workModel,
    remoteScope: facts.remoteScope,
    employmentType: et && ['full_time', 'part_time', 'contract', 'internship', 'temporary', 'other'].includes(et) ? et : null,
    level,
    levels: level ? [experienceLevelOf(level)] : [],
    yearsRequired: null,
    pay,
    postedAt: primary.posted_at ?? r.posted_at,
    firstSeenAt: r.first_seen,
    lastSeenAt: r.last_seen,
    updatedAt: r.updated_at,
    department: r.department || null,
    statements: facts.statements,
    skills: [],
    evidence,
    sources,
    duplicateOf,
    contentHash: r.content_hash,
    description: r.description,
  };
  return job;
}

export interface FeedJobQuery {
  /** Only jobs this source lists (its posting is open) — or, with status 'closed' / 'all', ever listed. */
  sourceId?: string;
  status?: 'open' | 'closed' | 'all';
  /** Remote jobs open to US applicants (US or worldwide stated); with includeUnknownRegion, also region not stated. */
  openToUs?: boolean;
  includeUnknownRegion?: boolean;
  limit?: number;
}

/** Contract Jobs for rows that other sources list. Each record is checked against JobSchema. */
export function feedJobs(db: DatabaseSync, q: FeedJobQuery = {}): Job[] {
  const status = q.status ?? 'open';
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (status === 'open') where.push(SHOWN_SQL);
  if (status === 'closed') where.push('j.closed_at IS NOT NULL');
  if (q.sourceId) {
    where.push(`EXISTS (SELECT 1 FROM feed_postings fp WHERE fp.job_ats = j.ats AND fp.job_board = j.board AND fp.job_ext_id = j.job_id AND fp.source_id = ?${status === 'open' ? " AND fp.status = 'open'" : ''})`);
    params.push(q.sourceId);
  } else {
    where.push('EXISTS (SELECT 1 FROM feed_postings fp WHERE fp.job_ats = j.ats AND fp.job_board = j.board AND fp.job_ext_id = j.job_id)');
  }
  const sql = `SELECT j.* FROM jobs j WHERE ${where.join(' AND ')} ORDER BY COALESCE(j.posted_at, '') DESC, j.id ${q.limit ? `LIMIT ${Math.max(1, Math.floor(q.limit))}` : ''}`;
  const rows = db.prepare(sql).all(...params) as unknown as Row[];
  const postingsFor = db.prepare('SELECT * FROM feed_postings WHERE job_ats = ? AND job_board = ? AND job_ext_id = ? ORDER BY first_seen_at, source_id');
  const out: Job[] = [];
  for (const r of rows) {
    const postings = postingsFor.all(r.ats, r.board, r.job_id) as unknown as PostingRow[];
    if (!postings.length) continue;
    const job = toJob(db, r, postings);
    const v = validate(JobSchema, job);
    if (!v.ok) throw new Error(`job ${job.id} does not match the Job contract: ${v.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
    if (q.openToUs) {
      const regions = job.remoteScope?.regions ?? [];
      const us = job.isUs === true || regions.some((x) => x === 'US' || x === 'WORLDWIDE' || x === 'NA');
      const unknown = job.isUs === null && regions.length === 0;
      if (!(us || (q.includeUnknownRegion && unknown))) continue;
    }
    out.push(job);
  }
  return out;
}

/** Open jobs a source lists now, counted the way the job list shows them. null before its first run. */
export function openJobsFor(db: DatabaseSync, sourceId: string): number | null {
  const any = db.prepare('SELECT 1 FROM source_runs WHERE source_id = ? AND outcome <> ? LIMIT 1').get(sourceId, 'running');
  if (!any) return null;
  const r = db.prepare(`SELECT count(DISTINCT j.id) AS n FROM feed_postings fp JOIN jobs j ON j.ats = fp.job_ats AND j.board = fp.job_board AND j.job_id = fp.job_ext_id
    WHERE fp.source_id = ? AND fp.status = 'open' AND ${SHOWN_SQL}`).get(sourceId) as { n: number };
  return Number(r.n);
}

/** NDJSON lines: one contract Job per line, each with its sources, links and credits (sources-other O2). */
export function* exportFeedJobs(db: DatabaseSync, q: FeedJobQuery = {}): Iterable<string> {
  for (const j of feedJobs(db, q)) yield JSON.stringify({ ...j, creditLine: creditLine(j.sources) });
}

/** Contract Jobs for results that must not be stored (per-query partners, O13). Never written anywhere. */
export function ephemeralJobs(jobs: Job[]): Job[] {
  return jobs.map((j) => ({ ...j, ephemeral: true }));
}

// Re-exported for callers that only need the id format.
export { jobKeyOf };
