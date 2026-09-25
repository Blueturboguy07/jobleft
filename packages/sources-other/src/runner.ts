// The refresh of non-ATS sources. Each source runs on its own (a failure in one never stops another), through its own
// FeedClient (allow-listed hosts, robots.txt, the shared pacer, its request budget), and writes:
//   * the crawler's `jobs` table, only through @jobleft/crawler's exported Store functions (ats = "feed:<id>")
//   * this lane's `feed_postings` (link back, credit, the facts as the source states them)
// Never lose jobs silently (sources-other O6): an error, an empty answer, a cut-off answer, a partial answer, a failed
// page or an unreadable posting closes nothing and deletes nothing. Jobs close only when a complete, healthy answer
// no longer lists them (O7), and a close of more than half of 10 or more open jobs waits for a second answer at
// least 12 hours later. A job that comes back is reopened.

import type { DatabaseSync } from 'node:sqlite';
import { nowMs } from '@jobleft/contracts';
import { normalizeJob } from '@jobleft/crawler';
import type { Ats, BoardRef, CrawledJob, RobotsRules, Store } from '@jobleft/crawler';
import { ALL_FEEDS, ROBOTS_EXCEPTIONS } from './catalog.ts';
import { migrateSourcesOther } from './db.ts';
import { DbPacer, FeedClient, FeedError } from './http.ts';
import type { HostPacer } from './http.ts';
import { finishRun, getState, recordRequest, reserveRun } from './limits.ts';
import type { RunFinish, RunReason } from './limits.ts';
import type { FeedPosting, FeedResult, JobFeed, KeyReader } from './types.ts';
import { emptyFacts } from './feeds/common.ts';

export const MASS_CLOSE_SHARE = 0.5;
export const MASS_CLOSE_MIN_OPEN = 10;
export const MASS_CLOSE_CONFIRM_MS = 12 * 3_600_000;

export type SkipReason = 'not_crawled' | 'off' | 'needs_key' | 'offline' | 'per_query_only' | 'too_early' | 'daily_limit' | 'request_limit' | 'rate_limited' | 'backoff' | 'running';

export interface SourceRunResult {
  sourceId: string;
  name: string;
  outcome: 'ok' | 'failed' | 'skipped';
  skipReason: SkipReason | null;
  /** One plain sentence. Never a key, an email or a query string. */
  message: string;
  nextAllowedAt: string | null;
  complete: boolean | null;
  listed: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Postings that another source or an employer board already had (one job, both credits). */
  merged: number;
  closed: number;
  reopened: number;
  closeHeld: string | null;
  unreadable: number;
  skipped: number;
  requests: number;
  notes: string[];
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RefreshOptions {
  /** The crawler store on the app's database file. This lane's tables live in the same file (store.db). */
  store: Store;
  keys: KeyReader;
  reason: RunReason;
  /** Only these sources (default: every feed). */
  ids?: readonly string[];
  feeds?: readonly JobFeed[];
  /** The app clock (default nowMs(): JOBLEFT_NOW, JOBLEFT_CLOCK_OFFSET). */
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Real host -> loopback stand-in (JOBLEFT_HOST_MAP). */
  hostMap?: Record<string, string>;
  /** JOBLEFT_OFFLINE=1: nothing is sent. */
  offline?: boolean;
  pacer?: HostPacer;
  /** Per request. Default 15 s. */
  timeoutMs?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  onResult?: (r: SourceRunResult) => void;
}

function blank(feed: JobFeed): SourceRunResult {
  return {
    sourceId: feed.id, name: feed.info.name, outcome: 'skipped', skipReason: null, message: '', nextAllowedAt: null,
    complete: null, listed: 0, inserted: 0, updated: 0, unchanged: 0, merged: 0, closed: 0, reopened: 0, closeHeld: null,
    unreadable: 0, skipped: 0, requests: 0, notes: [], startedAt: null, finishedAt: null,
  };
}

/** The job id format of docs/INTERFACES.md section 3: "<ats>:<board>:<externalId>", ats and board in lower case. */
export function jobKeyOf(ats: string, board: string, externalId: string): string {
  return `${ats.toLowerCase()}:${board.toLowerCase()}:${externalId}`;
}

/** Secrets that must never appear in any text: the whole key and each word of it (USAJOBS: email and key). */
function secretsOf(key: string | null): string[] {
  if (!key) return [];
  const k = key.trim();
  return [k, ...k.split(/\s+/)].filter((s) => s.length >= 3);
}

interface JobsRow {
  id: number; ats: string; board: string; job_id: string; canonical_url: string; apply_url: string; dedup_hash: string;
  title: string; company: string; company_slug: string; location: string; remote: number; work_mode: string;
  is_us: number | null; level: string | null; level_source: string | null; pay_min: number | null; pay_max: number | null;
  pay_currency: string | null; pay_period: string | null; pay_min_annual: number | null; pay_max_annual: number | null;
  pay_source: string | null; posted_at: string | null; employment_type: string; department: string; description: string;
  content_hash: string; last_seen: string; closed_at: string | null;
}

/** A crawler Job rebuilt from its own row, so an unchanged re-save only refreshes last_seen (keeps a row open). */
function crawledFromRow(r: JobsRow): CrawledJob {
  return {
    ats: r.ats as Ats, board: r.board, jobId: r.job_id, applyUrl: r.apply_url, canonicalUrl: r.canonical_url,
    dedupHash: r.dedup_hash, title: r.title, company: r.company, companySlug: r.company_slug, location: r.location,
    remote: r.remote === 1, workMode: r.work_mode as CrawledJob['workMode'], isUs: r.is_us === null ? null : r.is_us === 1,
    level: r.level as CrawledJob['level'], levelSource: r.level_source as CrawledJob['levelSource'], payMin: r.pay_min,
    payMax: r.pay_max, payCurrency: r.pay_currency, payPeriod: r.pay_period as CrawledJob['payPeriod'],
    payMinAnnual: r.pay_min_annual, payMaxAnnual: r.pay_max_annual, paySource: r.pay_source as CrawledJob['paySource'],
    postedAt: r.posted_at, employmentType: r.employment_type, department: r.department, description: r.description,
    contentHash: r.content_hash,
  };
}

function postingsOf(res: FeedResult): FeedPosting[] {
  if (res.postings) return res.postings;
  return res.jobs.map((raw) => ({ raw, sourceUrl: raw.url, facts: emptyFacts() }));
}

/** Stores one feed answer. Runs in one transaction. Returns the counts. Exported for tests. */
export function applyFeedResult(store: Store, feed: JobFeed, res: FeedResult, now: number): Pick<SourceRunResult, 'listed' | 'inserted' | 'updated' | 'unchanged' | 'merged' | 'closed' | 'reopened' | 'closeHeld' | 'unreadable'> {
  const db = store.db;
  const nowIso = new Date(now).toISOString();
  const ats = `feed:${feed.id}`;
  const board = feed.id;
  const out = { listed: 0, inserted: 0, updated: 0, unchanged: 0, merged: 0, closed: 0, reopened: 0, closeHeld: null as string | null, unreadable: 0 };
  if (!feed.storable) return out; // per-query partners whose terms forbid storage are never saved (O13)

  return store.transaction(() => {
    if (res.notModified) {
      // 304: the list is exactly as it was. Every open posting counts as seen again; nothing closes.
      const r = db.prepare(`UPDATE feed_postings SET last_seen_at = ?, missing_since = NULL WHERE source_id = ? AND status = 'open'`).run(nowIso, feed.id);
      out.listed = Number(r.changes);
      out.unchanged = out.listed;
      return out;
    }
    const ref: BoardRef = { ats: ats as Ats, board, company: '' };
    const keep = new Set<string>(res.unreadableIds ?? []);
    const getPosting = db.prepare('SELECT status, first_seen_at FROM feed_postings WHERE source_id = ? AND external_id = ?');
    const ownerByUrl = db.prepare('SELECT ats, board, job_id, closed_at FROM jobs WHERE canonical_url = ?');
    const upsertPosting = db.prepare(`INSERT INTO feed_postings (source_id, external_id, job_ats, job_board, job_ext_id, job_key, source_name,
        url, apply_url, canonical_url, credit_text, credit_url, title, company, posted_at, places_json, work_model, remote_scope_json,
        employment_type, level, pay_json, is_us, statements_json, evidence_json, first_seen_at, last_seen_at, missing_since, status,
        closed_at, closed_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'open',NULL,NULL)
      ON CONFLICT(source_id, external_id) DO UPDATE SET job_ats = excluded.job_ats, job_board = excluded.job_board,
        job_ext_id = excluded.job_ext_id, job_key = excluded.job_key, source_name = excluded.source_name, url = excluded.url,
        apply_url = excluded.apply_url, canonical_url = excluded.canonical_url, credit_text = excluded.credit_text,
        credit_url = excluded.credit_url, title = excluded.title, company = excluded.company, posted_at = excluded.posted_at,
        places_json = excluded.places_json, work_model = excluded.work_model, remote_scope_json = excluded.remote_scope_json,
        employment_type = excluded.employment_type, level = excluded.level, pay_json = excluded.pay_json, is_us = excluded.is_us,
        statements_json = excluded.statements_json, evidence_json = excluded.evidence_json, last_seen_at = excluded.last_seen_at,
        missing_since = NULL, status = 'open', closed_at = NULL, closed_reason = NULL`);
    const selRow = db.prepare('SELECT * FROM jobs WHERE ats = ? AND board = ? AND job_id = ?');

    for (const p of postingsOf(res)) {
      const extId = String(p.raw.externalId ?? '').trim();
      const job = normalizeJob(ref, p.raw);
      if (!job || !extId) { out.unreadable++; if (extId) keep.add(extId); continue; }
      keep.add(extId);
      out.listed++;
      const saved = store.upsertJob(job, nowIso);
      let owner = { ats: job.ats as string, board: job.board, jobId: job.jobId };
      if (saved.status === 'dupUrl') {
        const o = ownerByUrl.get(job.canonicalUrl) as { ats: string; board: string; job_id: string; closed_at: string | null } | undefined;
        if (!o) { out.unreadable++; continue; }
        owner = { ats: o.ats, board: o.board, jobId: o.job_id };
        out.merged++;
        // A row owned by another feed that closed it comes back while this source still lists it (O10).
        if (o.closed_at !== null && o.ats.startsWith('feed:')) {
          const row = selRow.get(o.ats, o.board, o.job_id) as JobsRow | undefined;
          if (row) { store.upsertJob(crawledFromRow(row), nowIso); out.reopened++; }
        }
      } else if (saved.status === 'inserted') out.inserted++;
      else if (saved.status === 'updated') out.updated++;
      else out.unchanged++;
      const before = getPosting.get(feed.id, extId) as { status: string; first_seen_at: string } | undefined;
      if (before && before.status === 'closed') out.reopened++;
      const credit = p.credit === undefined ? feed.credit : p.credit;
      const f = p.facts;
      upsertPosting.run(
        feed.id, extId, owner.ats, owner.board, owner.jobId, jobKeyOf(owner.ats, owner.board, owner.jobId), feed.info.name,
        p.sourceUrl, job.applyUrl && job.applyUrl !== p.sourceUrl ? job.applyUrl : null, job.canonicalUrl,
        credit?.text ?? null, credit?.url ?? null, job.title, job.company, f.postedAt, JSON.stringify(f.places), f.workModel,
        f.remoteScope ? JSON.stringify(f.remoteScope) : null, f.employmentType, f.level, f.pay ? JSON.stringify(f.pay) : null,
        f.isUs === null ? null : f.isUs ? 1 : 0, JSON.stringify(f.statements), JSON.stringify(f.evidence),
        before?.first_seen_at ?? nowIso, nowIso,
      );
    }

    // ---- close what the source no longer lists, only with proof ----
    const canClose = res.complete && !res.problem && out.listed > 0 && (res.unreadableWithoutId ?? 0) === 0;
    if (!canClose) return out;
    const open = db.prepare(`SELECT external_id, missing_since FROM feed_postings WHERE source_id = ? AND status = 'open'`).all(feed.id) as Array<{ external_id: string; missing_since: string | null }>;
    const missing = open.filter((r) => !keep.has(r.external_id));
    if (missing.length) {
      let toClose = missing;
      if (open.length >= MASS_CLOSE_MIN_OPEN && missing.length / open.length > MASS_CLOSE_SHARE) {
        toClose = missing.filter((m) => m.missing_since !== null && Date.parse(m.missing_since) <= now - MASS_CLOSE_CONFIRM_MS);
        const mark = db.prepare('UPDATE feed_postings SET missing_since = ? WHERE source_id = ? AND external_id = ? AND missing_since IS NULL');
        for (const m of missing) mark.run(nowIso, feed.id, m.external_id);
        if (toClose.length < missing.length) {
          out.closeHeld = `the answer left out ${missing.length} of ${open.length} open jobs (more than half), so nothing was closed; they close if an answer at least 12 hours later still leaves them out`;
        }
      }
      const close = db.prepare(`UPDATE feed_postings SET status = 'closed', closed_at = ?, closed_reason = 'source_removed' WHERE source_id = ? AND external_id = ?`);
      for (const m of toClose) close.run(nowIso, feed.id, m.external_id);
      out.closed = toClose.length;
    }
    // Rows this feed owns: keep open every row some source still lists (touch it), then close the rest through the
    // crawler's own function (rows not seen at this instant).
    const keepRows = db.prepare(`SELECT j.* FROM jobs j WHERE j.ats = ? AND j.board = ? AND j.closed_at IS NULL AND j.last_seen < ?
        AND EXISTS (SELECT 1 FROM feed_postings fp WHERE fp.job_ats = j.ats AND fp.job_board = j.board AND fp.job_ext_id = j.job_id AND fp.status = 'open')`)
      .all(ats, board, nowIso) as unknown as JobsRow[];
    for (const r of keepRows) store.upsertJob(crawledFromRow(r), nowIso);
    store.closeUnseenForBoard(ats, board, nowIso, nowIso);
    return out;
  });
}

/** Plain words for any failure. Keys, emails and query strings are removed. */
export function plainProblem(e: unknown, secrets: string[]): { message: string; code: string; retryAfterSeconds: number | null } {
  let message: string;
  let code = 'internal';
  let retryAfterSeconds: number | null = null;
  if (e instanceof FeedError) { message = e.message; code = e.code; retryAfterSeconds = e.retryAfterSeconds; }
  else message = 'an unexpected error happened while reading this source';
  for (const s of secrets) message = message.split(s).join('[redacted]');
  return { message, code, retryAfterSeconds };
}

/** Refreshes the chosen sources (all by default). Each result says what happened in plain words. */
export async function refreshSources(opts: RefreshOptions): Promise<SourceRunResult[]> {
  const store = opts.store;
  const db: DatabaseSync = store.db;
  migrateSourcesOther(db);
  const now = opts.now ?? (() => nowMs());
  const all = opts.feeds ?? ALL_FEEDS;
  const feeds = opts.ids ? all.filter((f) => opts.ids!.includes(f.id)) : all;
  const pacer = opts.pacer ?? new DbPacer(db);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const robotsCache = new Map<string, Promise<RobotsRules>>();

  async function runOne(feed: JobFeed): Promise<SourceRunResult> {
    const r = blank(feed);
    const st = getState(db, feed.id);
    const skip = (why: SkipReason, message: string, nextAllowedAt: string | null = null): SourceRunResult => {
      r.skipReason = why; r.message = message; r.nextAllowedAt = nextAllowedAt; return r;
    };
    if (!feed.info.crawled) return skip('not_crawled', `${feed.info.name} is not crawled: ${feed.info.reason ?? 'not approved'}`);
    if (!st.enabled) return skip('off', `${feed.info.name} is off`);
    if (!feed.storable) return skip('per_query_only', `${feed.info.name} runs only for a search and is never stored`);
    let key: string | null = null;
    if (feed.info.needsKey) {
      key = await opts.keys(feed.id);
      if (!key || !key.trim()) return skip('needs_key', `${feed.info.name} needs a key. ${feed.keyHelp ?? ''}`.trim());
      const bad = feed.checkKey?.(key) ?? null;
      if (bad) return skip('needs_key', `The saved key for ${feed.info.name} does not look right: ${bad}`);
    }
    if (opts.offline) return skip('offline', 'jobleft is offline (JOBLEFT_OFFLINE=1); nothing was sent');
    const startMs = now();
    const res0 = reserveRun(db, feed, startMs, opts.reason, timeoutMs * ((feed.requestLimits?.perRun ?? 10) + 2) + 60_000);
    if (!res0.ok) return skip(res0.reason, res0.message, res0.nextAllowedAt);
    r.startedAt = new Date(startMs).toISOString();
    const secrets = secretsOf(key);
    const client = new FeedClient({
      sourceId: feed.id,
      allowedHosts: feed.hosts ?? [],
      pacer,
      hostMap: opts.hostMap,
      fetchImpl: opts.fetchImpl,
      timeoutMs,
      budget: { remaining: res0.allowance },
      onRequest: (host) => recordRequest(db, feed.id, now(), host),
      secrets,
      offline: false,
      signal: opts.signal,
      robotsExceptions: ROBOTS_EXCEPTIONS,
      robotsCache,
      retryDelayMs: opts.retryDelayMs,
    });
    const finish: RunFinish = {
      outcome: 'ok', problem: null, errorCode: null, complete: null,
      counts: { listed: 0, inserted: 0, updated: 0, unchanged: 0, merged: 0, closed: 0, reopened: 0, unreadable: 0, skipped: 0 },
      closeHeld: null, requests: 0, notes: [], retryAfterSeconds: null, etag: undefined,
    };
    try {
      const res = await feed.fetch({ http: client, key, now: now(), signal: opts.signal, etag: st.etag });
      const openBefore = (db.prepare(`SELECT count(*) AS n FROM feed_postings WHERE source_id = ? AND status = 'open'`).get(feed.id) as { n: number }).n;
      const counts = applyFeedResult(store, feed, res, now());
      // An empty answer from a source that listed jobs before is a problem to show, never a reason to close (O6).
      if (!res.problem && !res.notModified && counts.listed === 0 && Number(openBefore) > 0) {
        res.problem = `the answer listed no jobs, although this source listed ${openBefore} before`;
      }
      Object.assign(r, counts);
      r.skipped = res.skipped ?? 0;
      r.complete = res.complete;
      r.notes = [...(res.notes ?? [])];
      finish.complete = res.complete;
      finish.counts = { ...counts, skipped: r.skipped };
      finish.closeHeld = counts.closeHeld;
      finish.notes = r.notes;
      finish.etag = res.problem ? undefined : (res.etag ?? null);
      if (res.problem) {
        const p = plainProblem(new FeedError('http', res.problem), secrets);
        finish.outcome = 'failed'; finish.problem = p.message; finish.errorCode = 'partial';
        r.outcome = 'failed';
        r.message = `${feed.info.name}: ${p.message}. ${counts.listed} jobs were read and kept; nothing was closed.`;
      } else {
        r.outcome = 'ok';
        r.message = res.notModified
          ? `${feed.info.name} has not changed since the last refresh (${counts.listed} open jobs)`
          : `${feed.info.name}: ${counts.listed} jobs listed, ${counts.inserted} new, ${counts.closed} closed${counts.reopened ? `, ${counts.reopened} reopened` : ''}${counts.merged ? `, ${counts.merged} already known from another source` : ''}${counts.unreadable || (res.unreadableIds?.length ?? 0) || (res.unreadableWithoutId ?? 0) ? `, ${counts.unreadable + (res.unreadableIds?.length ?? 0) + (res.unreadableWithoutId ?? 0)} could not be read` : ''}${!res.complete ? ' (not the whole feed, so nothing was closed)' : ''}${counts.closeHeld ? `; ${counts.closeHeld}` : ''}`;
      }
    } catch (e) {
      const p = plainProblem(e, secrets);
      finish.outcome = 'failed'; finish.problem = p.message; finish.errorCode = p.code; finish.retryAfterSeconds = p.retryAfterSeconds;
      r.outcome = 'failed';
      r.message = `${feed.info.name} failed: ${p.message}. Its saved jobs were kept.`;
    } finally {
      finish.requests = client.requests;
      r.requests = client.requests;
      const end = now();
      r.finishedAt = new Date(end).toISOString();
      finishRun(db, feed.id, res0.runId, end, finish);
    }
    return r;
  }

  const results = await Promise.all(feeds.map(async (f) => {
    let res: SourceRunResult;
    try { res = await runOne(f); } catch (e) {
      res = blank(f);
      res.outcome = 'failed';
      res.message = `${f.info.name} failed: ${plainProblem(e, []).message}`;
    }
    opts.onResult?.(res);
    return res;
  }));
  return results;
}
