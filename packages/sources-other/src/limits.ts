// Source limits that survive restarts and hold across processes (sources-other O3).
//   * runs:     at most `maxPerDay` runs in any 24 hours, and at least `minIntervalMs` between run starts
//   * requests: at most `requestLimits.perDay` requests in any 24 hours, `perRun` in one run (robots.txt, retries count)
//   * 429:      a source that asked jobleft to slow down gets nothing before its Retry-After (at least 1 hour)
//   * failures: scheduled and launch runs back off after failures (15 min doubling to 6 h); a manual refresh does not
// The windows use the app clock (nowMs(): JOBLEFT_NOW, JOBLEFT_CLOCK_OFFSET) so a stranger can skip time. Every
// reservation happens inside BEGIN IMMEDIATE, and a run lease stops two processes from running one source at once.

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { JobFeed } from './types.ts';

export const DAY_MS = 24 * 3_600_000;
export type RunReason = 'manual' | 'schedule' | 'launch';
export type WaitReason = 'too_early' | 'daily_limit' | 'request_limit' | 'rate_limited' | 'backoff';

/** "<pid>:<random>" of this process; a lease whose process is gone can be taken over at once. */
const PROCESS_ID = `${process.pid}:${randomUUID()}`;

function leaseOwnerAlive(owner: string | null): boolean {
  if (!owner) return false;
  if (owner === PROCESS_ID) return true;
  const pid = Number(owner.split(':')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return true; // unknown form: respect the lease until it ends
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export interface StateRow {
  source_id: string;
  enabled: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_outcome: string | null;
  last_problem: string | null;
  last_problem_at: string | null;
  last_error_code: string | null;
  consecutive_failures: number;
  retry_after_until: string | null;
  etag: string | null;
  lease_until_ms: number | null;
  lease_owner: string | null;
}

export function getState(db: DatabaseSync, sourceId: string): StateRow {
  const row = db.prepare('SELECT * FROM source_state WHERE source_id = ?').get(sourceId) as StateRow | undefined;
  return row ?? {
    source_id: sourceId, enabled: 0, last_attempt_at: null, last_success_at: null, last_outcome: null, last_problem: null,
    last_problem_at: null, last_error_code: null, consecutive_failures: 0, retry_after_until: null, etag: null,
    lease_until_ms: null, lease_owner: null,
  };
}

export function ensureState(db: DatabaseSync, sourceId: string): void {
  db.prepare('INSERT OR IGNORE INTO source_state (source_id, enabled, updated_at) VALUES (?, 0, ?)').run(sourceId, new Date().toISOString());
}

export function setEnabled(db: DatabaseSync, sourceId: string, enabled: boolean): void {
  ensureState(db, sourceId);
  db.prepare('UPDATE source_state SET enabled = ?, updated_at = ? WHERE source_id = ?').run(enabled ? 1 : 0, new Date().toISOString(), sourceId);
}

export function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(15 * 60_000 * 2 ** (failures - 1), 6 * 3_600_000);
}

function limitsText(feed: JobFeed): string {
  return feed.info.limits ?? 'its own limits';
}

export interface Wait { at: number; reason: WaitReason; message: string }

/** When the next run of a feed may start, or null when it may start now. Pure read. */
export function nextAllowed(db: DatabaseSync, feed: JobFeed, now: number, reason: RunReason): Wait | null {
  const waits: Wait[] = [];
  const id = feed.id;
  const runs = (db.prepare('SELECT started_at_ms AS t FROM source_runs WHERE source_id = ? AND started_at_ms > ? ORDER BY started_at_ms')
    .all(id, now - DAY_MS) as Array<{ t: number }>).map((r) => Number(r.t));
  const { maxPerDay, minIntervalMs } = feed.limits;
  if (maxPerDay !== null && runs.length >= maxPerDay) {
    const at = runs[runs.length - maxPerDay]! + DAY_MS;
    waits.push({ at, reason: 'daily_limit', message: `${feed.info.name} was refreshed ${runs.length} times in the last 24 hours (${limitsText(feed)})` });
  }
  const last = (db.prepare('SELECT max(started_at_ms) AS t FROM source_runs WHERE source_id = ?').get(id) as { t: number | null }).t;
  if (last !== null && last !== undefined && Number(last) + minIntervalMs > now) {
    waits.push({ at: Number(last) + minIntervalMs, reason: 'too_early', message: `${feed.info.name} was refreshed less than ${Math.round(minIntervalMs / 60_000)} minutes ago (${limitsText(feed)})` });
  }
  const perDay = feed.requestLimits?.perDay ?? null;
  if (perDay !== null) {
    const reqs = (db.prepare('SELECT at_ms AS t FROM source_requests WHERE source_id = ? AND at_ms > ? ORDER BY at_ms')
      .all(id, now - DAY_MS) as Array<{ t: number }>).map((r) => Number(r.t));
    if (reqs.length >= perDay) {
      waits.push({ at: reqs[reqs.length - perDay]! + DAY_MS, reason: 'request_limit', message: `${feed.info.name} used its ${perDay} requests for the last 24 hours` });
    }
  }
  const st = getState(db, id);
  if (st.retry_after_until) {
    const t = Date.parse(st.retry_after_until);
    if (Number.isFinite(t) && t > now) waits.push({ at: t, reason: 'rate_limited', message: `${feed.info.name} asked jobleft to slow down` });
  }
  if (reason !== 'manual' && st.last_outcome === 'failed' && st.last_attempt_at) {
    const t = Date.parse(st.last_attempt_at) + backoffMs(st.consecutive_failures);
    if (Number.isFinite(t) && t > now) waits.push({ at: t, reason: 'backoff', message: `${feed.info.name} failed ${st.consecutive_failures} time(s) in a row; the next automatic try waits` });
  }
  const due = waits.filter((w) => w.at > now);
  if (!due.length) return null;
  return due.reduce((a, b) => (b.at > a.at ? b : a));
}

export type Reserve =
  | { ok: true; runId: number; allowance: number }
  | { ok: false; reason: WaitReason | 'running'; nextAllowedAt: string | null; message: string };

/** Atomically checks every limit and, when allowed, records the run start and takes the run lease. */
export function reserveRun(db: DatabaseSync, feed: JobFeed, now: number, reason: RunReason, leaseMs: number): Reserve {
  db.exec('BEGIN IMMEDIATE');
  try {
    ensureState(db, feed.id);
    const st = getState(db, feed.id);
    const real = Date.now();
    if (st.lease_until_ms !== null && Number(st.lease_until_ms) > real && leaseOwnerAlive(st.lease_owner)) {
      db.exec('COMMIT');
      return { ok: false, reason: 'running', nextAllowedAt: null, message: `${feed.info.name} is being refreshed right now` };
    }
    const wait = nextAllowed(db, feed, now, reason);
    if (wait) {
      db.exec('COMMIT');
      return { ok: false, reason: wait.reason, nextAllowedAt: new Date(wait.at).toISOString(), message: `${wait.message}. The next refresh is allowed at ${new Date(wait.at).toISOString()}` };
    }
    const perDay = feed.requestLimits?.perDay ?? Number.POSITIVE_INFINITY;
    const used = (db.prepare('SELECT count(*) AS n FROM source_requests WHERE source_id = ? AND at_ms > ?').get(feed.id, now - DAY_MS) as { n: number }).n;
    const allowance = Math.max(0, Math.min(feed.requestLimits?.perRun ?? Number.POSITIVE_INFINITY, perDay - Number(used)));
    const r = db.prepare(`INSERT INTO source_runs (source_id, reason, started_at, started_at_ms, outcome) VALUES (?, ?, ?, ?, 'running')`)
      .run(feed.id, reason, new Date(now).toISOString(), now);
    db.prepare('UPDATE source_state SET lease_until_ms = ?, lease_owner = ?, last_attempt_at = ?, updated_at = ? WHERE source_id = ?')
      .run(real + leaseMs, PROCESS_ID, new Date(now).toISOString(), new Date(real).toISOString(), feed.id);
    db.exec('COMMIT');
    return { ok: true, runId: Number(r.lastInsertRowid), allowance };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* nothing open */ }
    throw e;
  }
}

/** Counts one request against the source's daily limit, at once (a crash mid-run still counts). */
export function recordRequest(db: DatabaseSync, sourceId: string, atMs: number, host: string): void {
  db.prepare('INSERT INTO source_requests (source_id, at_ms, host) VALUES (?, ?, ?)').run(sourceId, atMs, host);
}

export interface RunFinish {
  outcome: 'ok' | 'failed';
  problem: string | null;
  errorCode: string | null;
  complete: boolean | null;
  counts: { listed: number; inserted: number; updated: number; unchanged: number; merged: number; closed: number; reopened: number; unreadable: number; skipped: number };
  closeHeld: string | null;
  requests: number;
  notes: string[];
  /** A 429 answer's wait, in seconds (at least one hour is kept). */
  retryAfterSeconds: number | null;
  etag: string | null | undefined;
}

export function finishRun(db: DatabaseSync, sourceId: string, runId: number, now: number, f: RunFinish): void {
  const iso = new Date(now).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE source_runs SET finished_at = ?, outcome = ?, problem = ?, error_code = ?, complete = ?, listed = ?, inserted = ?,
      updated = ?, unchanged = ?, merged = ?, closed = ?, reopened = ?, close_held = ?, unreadable = ?, skipped = ?, requests = ?, notes = ?
      WHERE id = ?`).run(
      iso, f.outcome, f.problem, f.errorCode, f.complete === null ? null : f.complete ? 1 : 0, f.counts.listed, f.counts.inserted,
      f.counts.updated, f.counts.unchanged, f.counts.merged, f.counts.closed, f.counts.reopened, f.closeHeld, f.counts.unreadable,
      f.counts.skipped, f.requests, f.notes.length ? f.notes.join(' | ') : null, runId,
    );
    const retryUntil = f.errorCode === 'rate_limited'
      ? new Date(now + Math.max(3600, f.retryAfterSeconds ?? 0) * 1000).toISOString()
      : null;
    if (f.outcome === 'ok') {
      db.prepare(`UPDATE source_state SET last_outcome = 'ok', last_success_at = ?, consecutive_failures = 0, retry_after_until = NULL,
        last_error_code = NULL, lease_until_ms = NULL, lease_owner = NULL, updated_at = ?${f.etag !== undefined ? ', etag = ?' : ''} WHERE source_id = ?`)
        .run(...([iso, iso, ...(f.etag !== undefined ? [f.etag] : []), sourceId] as Array<string | null>));
      if (f.closeHeld) db.prepare('UPDATE source_state SET last_problem = ?, last_problem_at = ? WHERE source_id = ?').run(f.closeHeld, iso, sourceId);
    } else {
      db.prepare(`UPDATE source_state SET last_outcome = 'failed', last_problem = ?, last_problem_at = ?, last_error_code = ?,
        consecutive_failures = consecutive_failures + 1, retry_after_until = COALESCE(?, retry_after_until), lease_until_ms = NULL,
        lease_owner = NULL, updated_at = ? WHERE source_id = ?`).run(f.problem, iso, f.errorCode, retryUntil, iso, sourceId);
    }
    // Keep the request log small: rows older than two days no longer count for anything.
    db.prepare('DELETE FROM source_requests WHERE source_id = ? AND at_ms < ?').run(sourceId, now - 2 * DAY_MS);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* nothing open */ }
    throw e;
  }
}
