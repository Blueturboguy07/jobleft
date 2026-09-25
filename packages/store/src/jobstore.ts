// JobStore: the public face of the job side of the store (reads, search, writes, export, storage, crawler sync).

import { existsSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { nowMs, type Job, type JobSearchRequest, type JobSearchResponse, type StorageInfo } from '@jobleft/contracts';
import type { H1bIndex, PlaceIndex } from '@jobleft/static-data';
import { decodeRecord } from './codec.ts';
import { getMeta, setMeta, StoreError, q } from './db.ts';
import { MODEL_ID } from './embed/model.ts';
import { runtimeOf, vectorsOf, type FitIndex, type Runtime } from './fit.ts';
import { MemIndex } from './memindex.ts';
import { companyKeyOf, normalizeInput } from './record.ts';
import { overlay, search, type SearchDeps } from './search.ts';
import { JobWriter, type CompanyInput, type UpsertStats } from './writer.ts';
import { TrackerStore } from './userdata.ts';

export interface SearchContext {
  /** The profile vector for Top Matched; null = no profile (the answer says fit needs a profile). */
  profileVector: Float32Array | null;
  h1b: H1bIndex | null;
  places: PlaceIndex | null;
  now: number;
  /** The fit index (vectors, waiting count, lazy requests). Optional: without it fit order loads vectors itself. */
  fit?: FitIndex | null;
  /** Why there is no profile vector: no profile yet, or the fit model is not downloaded. Default needs_profile. */
  fitUnavailable?: 'needs_profile' | 'not_ready';
}

export interface ImportResult extends UpsertStats {
  /** Lines or items that were refused, with the reason (nothing else was changed by them). */
  rejected: Array<{ index: number; error: string }>;
  closeHeld?: string | null;
}

function isoNow(now?: number): string {
  return new Date(now ?? nowMs()).toISOString();
}

export class JobStore {
  readonly writer: JobWriter;
  readonly rt: Runtime;

  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.writer = new JobWriter(db);
    this.rt = runtimeOf(db, (d) => new MemIndex(d));
  }

  get mem(): MemIndex { return this.rt.mem; }

  /** One job by its id or by an alias id (a merged copy). Closed jobs are returned too (their details stay). */
  get(id: string): Job | null {
    const r = q(this.db, `SELECT s.id, s.status, s.closed_at, s.closed_reason, s.first_seen, s.last_seen, s.doc FROM job_keys k
      JOIN store_jobs s ON s.rid = k.rid WHERE k.key = ?`).get(`id:${id}`) as
      { id: string; status: number; closed_at: string | null; closed_reason: string | null; first_seen: string; last_seen: string; doc: Uint8Array } | undefined;
    if (!r) return null;
    return overlay(decodeRecord<Job>(r.doc), r);
  }

  /** Search with words, filters and a sort. Closed, hidden and duplicate jobs never appear or count. */
  search(req: JobSearchRequest, ctx: SearchContext): JobSearchResponse {
    const fit = ctx.fit ?? null;
    const vec = fit ? fit.vec : req.sort === 'top_matched' && ctx.profileVector ? vectorsOf(this.rt, this.db, MODEL_ID) : null;
    const waiting = fit ? fit.counts().waiting : 0;
    const deps: SearchDeps = {
      db: this.db,
      mem: this.mem,
      vec,
      profileVector: ctx.profileVector,
      fitUnavailable: ctx.fitUnavailable,
      fitModel: fit?.model ?? (vec ? vec.model : null),
      fitWaiting: waiting,
      fitModelReady: fit ? fit.hasEmbedder() : vec !== null,
      h1b: ctx.h1b,
      places: ctx.places,
      now: ctx.now,
      requestFit: fit ? (rids) => fit.request(rids) : undefined,
    };
    return search(req, deps);
  }

  /** Saves postings given as contract Jobs or in the lenient import shape. Invalid items are refused one by one. */
  upsertJobs(inputs: unknown[], opts: { now?: number; source?: { sourceId: string; name: string } } = {}): ImportResult & { rids: number[] } {
    const at = isoNow(opts.now);
    const jobs: Job[] = [];
    const rejected: ImportResult['rejected'] = [];
    inputs.forEach((x, i) => {
      const r = normalizeInput(x, at, opts.source);
      if (r.job) jobs.push(r.job); else rejected.push({ index: i, error: r.error ?? 'not valid' });
    });
    const stats = this.writer.upsert(jobs, at);
    this.mem.refresh();
    return { ...stats, rejected };
  }

  /**
   * A complete listing of one board or source: saves the jobs and closes the scope's open jobs that are no longer
   * listed (an empty listing closes nothing; a close of over half of a board of 10 or more is held).
   */
  refreshScope(scope: string, inputs: unknown[], opts: { now?: number; source?: { sourceId: string; name: string } } = {}): ImportResult {
    const at = isoNow(opts.now);
    const jobs: Job[] = [];
    const rejected: ImportResult['rejected'] = [];
    inputs.forEach((x, i) => {
      const r = normalizeInput(x, at, opts.source);
      if (r.job) jobs.push(r.job); else rejected.push({ index: i, error: r.error ?? 'not valid' });
    });
    const res = this.writer.refreshScope(scope, jobs, at);
    this.mem.refresh();
    return { ...res, rejected };
  }

  closeJobs(ids: string[], reason: NonNullable<Job['closedReason']> = 'source_removed', now?: number): UpsertStats {
    const r = this.writer.close(ids, reason, isoNow(now));
    this.mem.refresh();
    return r;
  }

  upsertCompanies(list: CompanyInput[], now?: number): number {
    const n = this.writer.upsertCompanies(list, isoNow(now));
    this.mem.refresh();
    return n;
  }

  /** Saves a job added by URL or text (External tab) and marks it external in the tracker. Returns the stored job. */
  saveExternal(job: Job, now?: number): Job {
    const at = isoNow(now);
    const r = normalizeInput(job, at);
    if (!r.job) throw new StoreError('bad_request', `The job is not valid (${r.error}).`);
    const input = r.job;
    if (!input.sources.some((s) => s.sourceId.startsWith('external:'))) {
      input.sources = [...input.sources, { sourceId: 'external:url', name: 'Added by you', url: input.url, credit: null, firstSeenAt: at, lastSeenAt: at }];
    }
    this.writer.upsert([input], at);
    this.mem.refresh();
    const stored = this.get(input.id);
    if (!stored) throw new StoreError('internal', 'The job could not be saved.');
    new TrackerStore(this.db).patch(stored.id, {}, now ?? nowMs(), { external: true });
    this.mem.refresh();
    return stored;
  }

  /** NDJSON lines of saved jobs (liked, tracked or added by the person) with their source credits. */
  *exportSaved(): Iterable<string> {
    const rows = q(this.db, `SELECT t.job_id AS job_id FROM tracker t WHERE t.liked = 1 OR t.status IS NOT NULL OR t.external = 1 ORDER BY t.job_id`).all() as Array<{ job_id: string }>;
    const tracker = new TrackerStore(this.db);
    for (const r of rows) {
      const job = this.get(r.job_id);
      if (!job) continue;
      yield JSON.stringify({ job, credits: job.sources.map((s) => ({ source: s.name, url: s.url, credit: s.credit })), tracker: tracker.get(r.job_id) });
    }
  }

  storage(dbPath: string, dataDir: string): StorageInfo {
    let bytes = 0;
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(f)) bytes += statSync(f).size;
    const jobs = Number((q(this.db, 'SELECT count(*) AS n FROM store_jobs').get() as { n: number }).n);
    const openJobs = Number((q(this.db, 'SELECT count(*) AS n FROM store_jobs WHERE status = 1').get() as { n: number }).n);
    return { dataDir, dbPath, dbBytes: bytes, jobs, openJobs };
  }

  /** Compacts the word index and returns freed pages to the disk (run weekly, or after large removals). */
  vacuum(full = false): void {
    this.db.exec("INSERT INTO job_head_fts (job_head_fts) VALUES ('optimize')");
    this.db.exec("INSERT INTO job_body_fts (job_body_fts) VALUES ('optimize')");
    this.db.exec('DELETE FROM job_tombstones WHERE rev < (SELECT CAST(value AS INTEGER) - 100000 FROM store_meta WHERE key = \'rev\')');
    if (full) this.db.exec('VACUUM');
    else this.db.exec('PRAGMA incremental_vacuum');
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /**
   * Mirrors the crawler's own `jobs` table (same file, @jobleft/crawler Store) into the store: new and changed
   * postings are saved, postings the crawler closed are closed. Returns what changed. Safe to run any time.
   */
  syncFromCrawler(now?: number): ImportResult & { seen: number } {
    const has = q(this.db, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'jobs'").get();
    const empty = { inserted: 0, updated: 0, unchanged: 0, merged: 0, reopened: 0, closed: 0, purged: 0, rejected: [], seen: 0 };
    if (!has) return empty;
    const since = getMeta(this.db, 'crawler_sync_at') ?? '';
    const rows = q(this.db, `SELECT ats, board, job_id, canonical_url, apply_url, title, company, location, remote, work_mode, is_us,
      level, pay_min, pay_max, pay_currency, pay_period, pay_min_annual, pay_max_annual, pay_source, posted_at, employment_type,
      department, description, first_seen, last_seen, updated_at, closed_at, closed_reason FROM jobs
      WHERE updated_at > ? OR last_seen > ? OR coalesce(closed_at, '') > ?`).all(since, since, since) as Array<Record<string, unknown>>;
    let mark = since;
    const open: unknown[] = [];
    const closedIds: string[] = [];
    for (const r of rows) {
      for (const k of ['updated_at', 'last_seen', 'closed_at']) { const v = r[k]; if (typeof v === 'string' && v > mark) mark = v; }
      const input = crawlRowToInput(r);
      if (r.closed_at) closedIds.push(String(input.id)); else open.push(input);
    }
    const res = this.upsertJobs(open, { now });
    const closed = closedIds.length > 0 ? this.closeJobs(closedIds, 'unseen', now) : null;
    setMeta(this.db, 'crawler_sync_at', mark);
    return { ...res, closed: res.closed + (closed?.closed ?? 0), purged: res.purged + (closed?.purged ?? 0), seen: rows.length };
  }
}

const EMPLOYMENT: Record<string, string> = { full_time: 'full_time', part_time: 'part_time', contract: 'contract', internship: 'internship', temporary: 'temporary' };

/** A crawler row (its `jobs` table) in the lenient import shape. Facts the crawler did not find stay unknown. */
export function crawlRowToInput(r: Record<string, unknown>): Record<string, unknown> {
  const s = (k: string) => (typeof r[k] === 'string' && (r[k] as string).trim() !== '' ? (r[k] as string) : null);
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : r[k] === null || r[k] === undefined ? null : Number(r[k]));
  const ats = String(r.ats);
  const board = String(r.board);
  const company = s('company') ?? board;
  const url = s('canonical_url') ?? s('apply_url')!;
  const workMode = s('work_mode');
  const remote = Number(r.remote) === 1;
  const period = s('pay_period');
  const pay = period && (n('pay_min') !== null || n('pay_max') !== null) && s('pay_currency')
    ? { min: n('pay_min'), max: n('pay_max'), currency: s('pay_currency'), period, source: s('pay_source') === 'text' ? 'description' : 'board_field', annualMin: n('pay_min_annual'), annualMax: n('pay_max_annual') }
    : null;
  const isUs = r.is_us === null || r.is_us === undefined ? null : Number(r.is_us) === 1;
  return {
    id: `${ats.toLowerCase()}:${board.toLowerCase()}:${String(r.job_id)}`,
    title: s('title'),
    company,
    companyKey: companyKeyOf(company),
    ats, board, externalId: String(r.job_id),
    url,
    applyUrl: s('apply_url') && s('apply_url') !== url ? s('apply_url') : null,
    location: s('location'),
    isUs,
    workModel: workMode ?? (remote ? 'remote' : null),
    employmentType: EMPLOYMENT[s('employment_type') ?? ''] ?? null,
    level: s('level'),
    pay,
    postedAt: s('posted_at'),
    department: s('department'),
    description: s('description') ?? '',
    firstSeenAt: s('first_seen'),
    lastSeenAt: s('last_seen'),
    sources: [{ sourceId: `ats:${ats}`, name: `${company} careers (${ats[0]!.toUpperCase()}${ats.slice(1)})`, url, credit: null, firstSeenAt: s('first_seen'), lastSeenAt: s('last_seen') }],
    status: r.closed_at ? 'closed' : 'open',
    closedReason: s('closed_reason'),
  };
}
