// SQLite store on node:sqlite (built in, no native module to install). FTS5 is compiled in.
//
// Identity: UNIQUE (ats, board, job_id), so a re-crawl is idempotent (freehire `UNIQUE (source, external_id)`).
// Dedupe spine (Internship Machine): canonical_url is UNIQUE (same posting, never stored twice); dedup_hash groups a
// repost of the same role. A hash match is FLAGGED (`duplicate_of`), not dropped, because one employer posts the
// same title in many cities and a candidate filters on city.
// Cheap path (freehire RefreshUnchangedJob): an unchanged open posting only gets last_seen refreshed.
// Lifecycle: soft close only (`closed_at`). A posting that reappears is reopened by the upsert.

import { DatabaseSync } from 'node:sqlite';
import { cooldownFor } from './lifecycle.ts';
import type { Ats, Job } from './types.ts';

export type SaveStatus = 'inserted' | 'updated' | 'unchanged' | 'dupUrl';
export interface SaveResult { status: SaveStatus; dupRole: boolean }

export interface BoardRow {
  ats: string;
  board: string;
  company: string;
  region: string;
  consecutive_failures: number;
  cooldown_until: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_yield_at: string | null;
  last_error: string | null;
  last_ingested: number;
  empty_streak: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY,
  ats           TEXT NOT NULL,
  board         TEXT NOT NULL,
  job_id        TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  apply_url     TEXT NOT NULL,
  dedup_hash    TEXT NOT NULL,
  duplicate_of  INTEGER REFERENCES jobs(id),
  title         TEXT NOT NULL,
  company       TEXT NOT NULL,
  company_slug  TEXT NOT NULL,
  location      TEXT NOT NULL DEFAULT '',
  remote        INTEGER NOT NULL DEFAULT 0,
  work_mode     TEXT NOT NULL DEFAULT '',
  is_us         INTEGER,
  level         TEXT,
  level_source  TEXT,
  pay_min       INTEGER,
  pay_max       INTEGER,
  pay_currency  TEXT,
  pay_period    TEXT,
  pay_min_annual INTEGER,
  pay_max_annual INTEGER,
  pay_source    TEXT,
  posted_at     TEXT,
  employment_type TEXT NOT NULL DEFAULT '',
  department    TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  content_hash  TEXT NOT NULL,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  closed_at     TEXT,
  closed_reason TEXT,
  UNIQUE (ats, board, job_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_canonical_url ON jobs(canonical_url);
CREATE INDEX IF NOT EXISTS jobs_dedup_hash ON jobs(dedup_hash) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS jobs_open_board ON jobs(ats, board) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS jobs_last_seen ON jobs(last_seen);

CREATE TABLE IF NOT EXISTS boards (
  ats TEXT NOT NULL,
  board TEXT NOT NULL,
  company TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_yield_at TEXT,
  last_error TEXT,
  last_ingested INTEGER NOT NULL DEFAULT 0,
  empty_streak INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ats, board)
);
`;

const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
  title, company, location, description,
  content='jobs', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS jobs_fts_ai AFTER INSERT ON jobs BEGIN
  INSERT INTO jobs_fts(rowid, title, company, location, description) VALUES (new.id, new.title, new.company, new.location, new.description);
END;
CREATE TRIGGER IF NOT EXISTS jobs_fts_ad AFTER DELETE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, location, description) VALUES ('delete', old.id, old.title, old.company, old.location, old.description);
END;
CREATE TRIGGER IF NOT EXISTS jobs_fts_au AFTER UPDATE OF title, company, location, description ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, location, description) VALUES ('delete', old.id, old.title, old.company, old.location, old.description);
  INSERT INTO jobs_fts(rowid, title, company, location, description) VALUES (new.id, new.title, new.company, new.location, new.description);
END;
`;

function b(v: boolean | null): number | null { return v === null ? null : v ? 1 : 0; }

export interface StoreOptions { fts?: boolean }

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  constructor(path: string, opts: StoreOptions = {}) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    if (opts.fts ?? true) this.db.exec(FTS);
  }

  close(): void { this.db.close(); }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** Save one posting. `now` is an ISO string so tests can drive the clock. */
  upsertJob(j: Job, now: string): SaveResult {
    const existing = this.db.prepare(
      'SELECT id, content_hash, closed_at, canonical_url FROM jobs WHERE ats = ? AND board = ? AND job_id = ?',
    ).get(j.ats, j.board, j.jobId) as { id: number; content_hash: string; closed_at: string | null; canonical_url: string } | undefined;

    if (existing) {
      if (existing.content_hash === j.contentHash && existing.closed_at === null) {
        this.db.prepare('UPDATE jobs SET last_seen = ? WHERE id = ?').run(now, existing.id);
        return { status: 'unchanged', dupRole: false };
      }
      // Keep the old canonical URL when the new one already belongs to another row.
      let canonical = j.canonicalUrl;
      if (canonical !== existing.canonical_url) {
        const clash = this.db.prepare('SELECT id FROM jobs WHERE canonical_url = ? AND id <> ?').get(canonical, existing.id);
        if (clash) canonical = existing.canonical_url;
      }
      this.db.prepare(`UPDATE jobs SET canonical_url=?, apply_url=?, dedup_hash=?, title=?, company=?, company_slug=?,
        location=?, remote=?, work_mode=?, is_us=?, level=?, level_source=?, pay_min=?, pay_max=?, pay_currency=?,
        pay_period=?, pay_min_annual=?, pay_max_annual=?, pay_source=?, posted_at=?, employment_type=?, department=?,
        description=?, content_hash=?, last_seen=?, updated_at=?, closed_at=NULL, closed_reason=NULL WHERE id=?`).run(
        canonical, j.applyUrl, j.dedupHash, j.title, j.company, j.companySlug, j.location, j.remote ? 1 : 0, j.workMode,
        b(j.isUs), j.level, j.levelSource, j.payMin, j.payMax, j.payCurrency, j.payPeriod, j.payMinAnnual, j.payMaxAnnual,
        j.paySource, j.postedAt, j.employmentType, j.department, j.description, j.contentHash, now, now, existing.id,
      );
      return { status: 'updated', dupRole: false };
    }

    // New identity. Layer 1 of the spine: the same canonical URL is the same posting.
    const urlOwner = this.db.prepare('SELECT id FROM jobs WHERE canonical_url = ?').get(j.canonicalUrl);
    if (urlOwner) return { status: 'dupUrl', dupRole: false };

    // Layer 2: the same (company, title) hash is the same role. Point at the oldest open canonical row.
    const canon = this.db.prepare(
      'SELECT id FROM jobs WHERE dedup_hash = ? AND closed_at IS NULL AND duplicate_of IS NULL ORDER BY id LIMIT 1',
    ).get(j.dedupHash) as { id: number } | undefined;

    this.db.prepare(`INSERT INTO jobs (ats, board, job_id, canonical_url, apply_url, dedup_hash, duplicate_of, title, company,
      company_slug, location, remote, work_mode, is_us, level, level_source, pay_min, pay_max, pay_currency, pay_period,
      pay_min_annual, pay_max_annual, pay_source, posted_at, employment_type, department, description, content_hash,
      first_seen, last_seen, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      j.ats, j.board, j.jobId, j.canonicalUrl, j.applyUrl, j.dedupHash, canon ? canon.id : null, j.title, j.company,
      j.companySlug, j.location, j.remote ? 1 : 0, j.workMode, b(j.isUs), j.level, j.levelSource, j.payMin, j.payMax,
      j.payCurrency, j.payPeriod, j.payMinAnnual, j.payMaxAnnual, j.paySource, j.postedAt, j.employmentType, j.department,
      j.description, j.contentHash, now, now, now,
    );
    return { status: 'inserted', dupRole: canon !== undefined };
  }

  /** Close every open posting of one board that this run did not see. Caller has already proven the board covered. */
  closeUnseenForBoard(ats: string, board: string, cutoffIso: string, nowIso: string): number {
    const r = this.db.prepare(
      "UPDATE jobs SET closed_at = ?, closed_reason = 'unseen' WHERE ats = ? AND board = ? AND closed_at IS NULL AND last_seen < ?",
    ).run(nowIso, ats, board, cutoffIso);
    return Number(r.changes);
  }

  /** How many open postings a board close would touch (for the "too broad" guard). */
  countUnseenForBoard(ats: string, board: string, cutoffIso: string): { open: number; unseen: number } {
    const open = this.db.prepare('SELECT count(*) AS n FROM jobs WHERE ats = ? AND board = ? AND closed_at IS NULL').get(ats, board) as { n: number };
    const unseen = this.db.prepare('SELECT count(*) AS n FROM jobs WHERE ats = ? AND board = ? AND closed_at IS NULL AND last_seen < ?').get(ats, board, cutoffIso) as { n: number };
    return { open: Number(open.n), unseen: Number(unseen.n) };
  }

  /** Empty-feed net: close all open postings of a board that has listed nothing for a long time. */
  closeBoardEmpty(ats: string, board: string, nowIso: string): number {
    const r = this.db.prepare(
      "UPDATE jobs SET closed_at = ?, closed_reason = 'board_empty' WHERE ats = ? AND board = ? AND closed_at IS NULL",
    ).run(nowIso, ats, board);
    return Number(r.changes);
  }

  // ---- board health (freehire board_health) ----

  ensureBoard(ats: Ats, board: string, company: string, region = ''): void {
    this.db.prepare('INSERT OR IGNORE INTO boards (ats, board, company, region) VALUES (?,?,?,?)').run(ats, board, company, region);
  }

  getBoard(ats: string, board: string): BoardRow | undefined {
    return this.db.prepare('SELECT * FROM boards WHERE ats = ? AND board = ?').get(ats, board) as BoardRow | undefined;
  }

  isCooledDown(ats: string, board: string, nowMs: number): boolean {
    const r = this.getBoard(ats, board);
    if (!r || !r.cooldown_until) return false;
    return Date.parse(r.cooldown_until) > nowMs;
  }

  recordSuccess(ats: string, board: string, ingested: number, reached: boolean, nowIso: string): void {
    this.db.prepare(`UPDATE boards SET consecutive_failures = 0, cooldown_until = NULL, last_attempt_at = ?, last_success_at = ?,
      last_error = NULL, last_ingested = ?, last_yield_at = CASE WHEN ? THEN ? ELSE last_yield_at END,
      empty_streak = CASE WHEN ? THEN 0 ELSE empty_streak + 1 END WHERE ats = ? AND board = ?`)
      .run(nowIso, nowIso, ingested, reached ? 1 : 0, nowIso, reached ? 1 : 0, ats, board);
  }

  recordFailure(ats: string, board: string, err: string, nowIso: string): number {
    const row = this.getBoard(ats, board);
    const f = (row?.consecutive_failures ?? 0) + 1;
    const cd = cooldownFor(f);
    const until = cd === null ? null : new Date(Date.parse(nowIso) + cd).toISOString();
    this.db.prepare('UPDATE boards SET consecutive_failures = ?, cooldown_until = ?, last_attempt_at = ?, last_error = ? WHERE ats = ? AND board = ?')
      .run(f, until, nowIso, err.slice(0, 300), ats, board);
    return f;
  }

  // ---- reads used by the CLI and by tests ----

  count(where = '1=1', ...params: Array<string | number>): number {
    const r = this.db.prepare(`SELECT count(*) AS n FROM jobs WHERE ${where}`).get(...params) as { n: number };
    return Number(r.n);
  }

  search(query: string, limit = 10): Array<{ id: number; title: string; company: string; location: string }> {
    return this.db.prepare(
      `SELECT j.id, j.title, j.company, j.location FROM jobs_fts f JOIN jobs j ON j.id = f.rowid
       WHERE jobs_fts MATCH ? AND j.closed_at IS NULL AND j.duplicate_of IS NULL ORDER BY bm25(jobs_fts) LIMIT ?`,
    ).all(query, limit) as Array<{ id: number; title: string; company: string; location: string }>;
  }
}
