// SQLite store on node:sqlite (built in, no native module to install). FTS5 is compiled in.
//
// Identity: UNIQUE (ats, board, job_id). A re-crawl is idempotent, an edited posting is updated in place, and two
// postings with different ids on one board are ALWAYS two jobs (even with the same title, place or page URL).
// Two routes to one posting:
//   * the same canonical URL AND the same company, title and text (or places) on ANOTHER board is the same posting: it is credited
//     (job_sources), not stored twice. A shared link alone never merges (two employers may share a generic careers link);
//   * the same company, title, places, description and pay on ANOTHER board is a repeat of the role: stored, flagged
//     `duplicate_of`. A different description or pay is a different opening, never hidden.
// Cheap path: an unchanged open posting only gets last_seen refreshed.
// Lifecycle: soft close only (`closed_at`); a closed row keeps every detail, and a posting that reappears reopens.
// A posting closes only when complete, clean readings of its board stopped listing it (see recordReading).
//
// Tables owned here: jobs, jobs_fts, boards, job_sources, crawler_runs, crawler_run_boards, crawler_hosts,
// crawler_robots, crawler_meta. Migrations are forward only, one transaction each, recorded in
// schema_migrations (owner 'crawler').

import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { closeTooBroad, cooldownFor, MAX_CLOSE_SHARE } from './lifecycle.ts';
import type { Ats, Job } from './types.ts';
import type { HostRecord, HostStateStore, RobotsRecord, Validators } from './http.ts';

export type SaveStatus = 'inserted' | 'updated' | 'unchanged' | 'dupUrl';
export interface SaveResult { status: SaveStatus; dupRole: boolean; /** The row this posting lives in (the credited row for dupUrl). */ row?: number }

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
  // crawler-lane columns (schema v2)
  etag?: string | null;
  last_modified?: string | null;
  validators_url?: string | null;
  last_listed?: number | null;
  last_status?: string | null;
  last_reason_code?: string | null;
  last_reason?: string | null;
  held_streak?: number;
  held_since?: string | null;
  notfound_streak?: number;
  notfound_since?: string | null;
  origin?: string | null;
  last_run_id?: number | null;
  last_checked_at?: string | null;
}

/** The newest crawler schema this build knows. */
export const CRAWLER_SCHEMA_VERSION = 2;

const SCHEMA_V1 = `
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

const V2_JOB_COLUMNS: Array<[string, string]> = [
  ['page_url', 'TEXT'], ['apply_link', 'TEXT'], ['places_json', "TEXT NOT NULL DEFAULT '[]'"], ['work_model', 'TEXT'],
  ['remote_scope_json', 'TEXT'], ['employment', 'TEXT'], ['levels_json', "TEXT NOT NULL DEFAULT '[]'"],
  ['years_min', 'INTEGER'], ['years_max', 'INTEGER'], ['statements_json', 'TEXT'], ['evidence_json', "TEXT NOT NULL DEFAULT '{}'"],
  ['pay_ranges', 'INTEGER'], ['board_updated_at', 'TEXT'], ['role_key', 'TEXT'],
  ['miss_count', 'INTEGER NOT NULL DEFAULT 0'], ['first_missed_at', 'TEXT'],
];
const V2_BOARD_COLUMNS: Array<[string, string]> = [
  ['etag', 'TEXT'], ['last_modified', 'TEXT'], ['validators_url', 'TEXT'], ['last_listed', 'INTEGER'], ['last_status', 'TEXT'],
  ['last_reason_code', 'TEXT'], ['last_reason', 'TEXT'], ['held_streak', 'INTEGER NOT NULL DEFAULT 0'], ['held_since', 'TEXT'],
  ['notfound_streak', 'INTEGER NOT NULL DEFAULT 0'], ['notfound_since', 'TEXT'], ['origin', 'TEXT'], ['last_run_id', 'INTEGER'],
  ['last_checked_at', 'TEXT'],
];
const V2_TABLES = `
DROP INDEX IF EXISTS jobs_canonical_url;
CREATE INDEX IF NOT EXISTS jobs_canonical ON jobs(canonical_url);
CREATE INDEX IF NOT EXISTS jobs_role_key ON jobs(role_key) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS jobs_duplicate_of ON jobs(duplicate_of) WHERE duplicate_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_missing ON jobs(ats, board) WHERE miss_count > 0 AND closed_at IS NULL;

CREATE TABLE IF NOT EXISTS job_sources (
  job INTEGER NOT NULL REFERENCES jobs(id),
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  ats TEXT,
  board TEXT,
  credit_json TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (job, source_id, url)
);

CREATE TABLE IF NOT EXISTS crawler_runs (
  id INTEGER PRIMARY KEY,
  reason TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  pid INTEGER,
  heartbeat_at TEXT,
  boards_total INTEGER NOT NULL DEFAULT 0,
  boards_done INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  deferred INTEGER NOT NULL DEFAULT 0,
  listed INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE TABLE IF NOT EXISTS crawler_run_boards (
  run_id INTEGER NOT NULL REFERENCES crawler_runs(id),
  position INTEGER NOT NULL,
  ats TEXT NOT NULL,
  board TEXT NOT NULL,
  company TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  origin TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  status TEXT,
  reason_code TEXT,
  reason TEXT,
  listed INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  close_held TEXT,
  requests INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  not_modified INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT,
  PRIMARY KEY (run_id, ats, board, region)
);
CREATE TABLE IF NOT EXISTS crawler_hosts (
  host TEXT PRIMARY KEY,
  not_before_ms INTEGER,
  not_before_reason TEXT,
  last_request_ms INTEGER
);
CREATE TABLE IF NOT EXISTS crawler_robots (
  origin TEXT PRIMARY KEY,
  status INTEGER NOT NULL,
  body TEXT,
  etag TEXT,
  last_modified TEXT,
  fetched_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  problem TEXT
);
CREATE TABLE IF NOT EXISTS crawler_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function b(v: boolean | null): number | null { return v === null ? null : v ? 1 : 0; }

export class SchemaTooNewError extends Error {
  constructor(found: number) {
    super(`this database was written by a newer jobleft (crawler schema ${found}); this build knows schema ${CRAWLER_SCHEMA_VERSION}. Nothing was changed.`);
    this.name = 'SchemaTooNewError';
  }
}

export interface StoreOptions {
  fts?: boolean;
  /** Milliseconds a writer waits for another process's lock before giving up. Default 10 s. */
  busyTimeoutMs?: number;
}

/** What closes a posting that its board stopped listing. */
export interface ClosePolicy {
  /** A second complete reading at least this long after the first miss confirms the removal. */
  confirmGapMs: number;
  /** A posting not seen for this long closes as soon as a second complete reading (even in the same run) confirms it. */
  graceMs: number;
  /** Mass-close guard: a reading that would close more than half of a board with at least this many open jobs is held. */
  guardMinOpen?: number;
  /** A held drop is accepted after this many held readings in a row... */
  heldReleaseReadings?: number;
  /** ...spanning at least this long. */
  heldReleaseMs?: number;
}

export interface ReadingResult {
  open: number;
  /** Open postings this reading did not list. */
  missing: number;
  /** Postings missing for the first time (the runner confirms them with a second reading). */
  newlyMissing: number;
  closed: number;
  /** Set when the mass-close guard held the reading. */
  held: string | null;
}

const DAY = 24 * 3600 * 1000;

export const ATS_NAMES: Readonly<Record<string, string>> = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workable: 'Workable', recruitee: 'Recruitee', personio: 'Personio',
};

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  private stmts = new Map<string, StatementSync>();
  private ownsDb: boolean;

  /** Opens (or creates) the crawl store at `path`, or uses an open database (the app's one connection). */
  constructor(pathOrDb: string | DatabaseSync, opts: StoreOptions = {}) {
    if (typeof pathOrDb === 'string') {
      this.path = pathOrDb;
      this.db = new DatabaseSync(pathOrDb);
      this.ownsDb = true;
    } else {
      this.path = '(shared connection)';
      this.db = pathOrDb;
      this.ownsDb = false;
    }
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 10_000))};`);
    if (this.ownsDb) {
      const fresh = (this.db.prepare('SELECT count(*) AS n FROM sqlite_schema').get() as { n: number }).n === 0;
      if (fresh) this.db.exec('PRAGMA page_size = 16384;');
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    }
    this.migrate(opts.fts ?? true);
  }

  close(): void { if (this.ownsDb) this.db.close(); }

  private st(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }

  // ---------------------------------------------------------------------------------------------- migrations

  /** The crawler schema version recorded in this database. */
  schemaVersion(): number {
    const r = this.db.prepare("SELECT max(version) AS v FROM schema_migrations WHERE owner = 'crawler'").get() as { v: number | null };
    return Number(r.v ?? 0);
  }

  private hasTable(name: string): boolean {
    return this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined;
  }
  private columns(table: string): Set<string> {
    return new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  }

  private migrate(fts: boolean): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (owner, version))');
    let v = this.schemaVersion();
    if (v > CRAWLER_SCHEMA_VERSION) throw new SchemaTooNewError(v);
    const record = (version: number) => this.db.prepare('INSERT OR IGNORE INTO schema_migrations (owner, version, applied_at) VALUES (?, ?, ?)')
      .run('crawler', version, new Date().toISOString());
    if (v < 1) {
      this.transaction(() => {
        this.db.exec(SCHEMA_V1);
        record(1);
      });
      v = 1;
    }
    if (v < 2) {
      this.transaction(() => {
        const jc = this.columns('jobs');
        for (const [name, type] of V2_JOB_COLUMNS) if (!jc.has(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
        const bc = this.columns('boards');
        for (const [name, type] of V2_BOARD_COLUMNS) if (!bc.has(name)) this.db.exec(`ALTER TABLE boards ADD COLUMN ${name} ${type}`);
        this.db.exec(V2_TABLES);
        // Rows from before v2 (the S1 spike): their page link is the canonical link; credit their own board.
        this.db.exec(`UPDATE jobs SET page_url = canonical_url WHERE page_url IS NULL`);
        this.db.exec(`INSERT OR IGNORE INTO job_sources (job, source_id, name, url, ats, board, first_seen, last_seen)
          SELECT id, 'ats:' || ats, company || ' careers', page_url, ats, board, first_seen, last_seen FROM jobs`);
        record(2);
      });
    }
    if (fts && !this.hasTable('jobs_fts')) this.db.exec(FTS);
  }

  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ---------------------------------------------------------------------------------------------- jobs

  private credit(row: number, j: Job, now: string): void {
    const name = `${j.company} careers (${ATS_NAMES[j.ats] ?? j.ats})`;
    this.st(`INSERT INTO job_sources (job, source_id, name, url, ats, board, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT (job, source_id, url) DO UPDATE SET last_seen = excluded.last_seen, name = excluded.name`)
      .run(row, `ats:${j.ats}`, name, j.pageUrl ?? j.canonicalUrl, j.ats, j.board, now, now);
  }

  private roleCanonical(j: Job, selfId: number | null): number | null {
    if (!j.roleKey) return null;
    const r = this.st(`SELECT id FROM jobs WHERE role_key = ? AND closed_at IS NULL AND duplicate_of IS NULL
      AND NOT (ats = ? AND board = ?) AND id <> ? ORDER BY id LIMIT 1`).get(j.roleKey, j.ats, j.board, selfId ?? -1) as { id: number } | undefined;
    return r ? r.id : null;
  }

  /** Save one posting. `now` is an ISO string so tests can drive the clock. */
  upsertJob(j: Job, now: string): SaveResult {
    const existing = this.st(
      'SELECT id, content_hash, closed_at, duplicate_of, role_key FROM jobs WHERE ats = ? AND board = ? AND job_id = ?',
    ).get(j.ats, j.board, j.jobId) as { id: number; content_hash: string; closed_at: string | null; duplicate_of: number | null; role_key: string | null } | undefined;

    if (existing) {
      // Unchanged only when the role key is unchanged too: a new key (new rules) must re-check the duplicate flag.
      if (existing.content_hash === j.contentHash && existing.closed_at === null && existing.role_key === (j.roleKey ?? null)) {
        this.st('UPDATE jobs SET last_seen = ?, miss_count = 0, first_missed_at = NULL WHERE id = ?').run(now, existing.id);
        this.credit(existing.id, j, now);
        return { status: 'unchanged', dupRole: false, row: existing.id };
      }
      const dup = existing.role_key === (j.roleKey ?? null) && existing.duplicate_of !== null ? existing.duplicate_of : this.roleCanonical(j, existing.id);
      this.st(`UPDATE jobs SET canonical_url=?, apply_url=?, dedup_hash=?, title=?, company=?, company_slug=?,
        location=?, remote=?, work_mode=?, is_us=?, level=?, level_source=?, pay_min=?, pay_max=?, pay_currency=?,
        pay_period=?, pay_min_annual=?, pay_max_annual=?, pay_source=?, posted_at=?, employment_type=?, department=?,
        description=?, content_hash=?, last_seen=?, updated_at=?, closed_at=NULL, closed_reason=NULL,
        page_url=?, apply_link=?, places_json=?, work_model=?, remote_scope_json=?, employment=?, levels_json=?,
        years_min=?, years_max=?, statements_json=?, evidence_json=?, pay_ranges=?, board_updated_at=?, role_key=?,
        miss_count=0, first_missed_at=NULL, duplicate_of=? WHERE id=?`).run(
        j.canonicalUrl, j.applyUrl, j.dedupHash, j.title, j.company, j.companySlug, j.location, j.remote ? 1 : 0, j.workMode,
        b(j.isUs), j.level, j.levelSource, j.payMin, j.payMax, j.payCurrency, j.payPeriod, j.payMinAnnual, j.payMaxAnnual,
        j.paySource, j.postedAt, j.employmentType, j.department, j.description, j.contentHash, now, now,
        j.pageUrl ?? j.canonicalUrl, j.applyLink ?? null, JSON.stringify(j.places ?? []), j.workModel ?? null,
        j.remoteScope ? JSON.stringify(j.remoteScope) : null, j.employment ?? null, JSON.stringify(j.levels ?? []),
        j.yearsRequired?.min ?? null, j.yearsRequired?.max ?? null, j.statements ? JSON.stringify(j.statements) : null,
        JSON.stringify(j.evidence ?? {}), j.payRanges ?? null, j.boardUpdatedAt ?? null, j.roleKey ?? null, dup, existing.id,
      );
      this.credit(existing.id, j, now);
      return { status: 'updated', dupRole: dup !== null, row: existing.id };
    }

    // New identity. The same canonical URL with the same company, title and text (or places) on ANOTHER board is the
    // same posting reached by a second route: credit it. A generic link shared by different postings is not enough.
    // Gate 1 (single builder): the link, company and title alone are not enough. Two openings of the same role in two
    // cities can share one careers link: when both postings state places and the places differ, they stay apart.
    // Otherwise the shared link is the identity (aggregator lists wrap the same posting in their own words).
    const placesJson = JSON.stringify(j.places ?? []);
    const urlOwner = this.st(`SELECT id FROM jobs WHERE canonical_url = ? AND dedup_hash = ? AND NOT (ats = ? AND board = ?)
      AND (content_hash = ? OR places_json = ? OR places_json = '[]' OR ? = '[]') ORDER BY id LIMIT 1`)
      .get(j.canonicalUrl, j.dedupHash, j.ats, j.board, j.contentHash, placesJson, placesJson) as { id: number } | undefined;
    if (urlOwner) {
      this.credit(urlOwner.id, j, now);
      return { status: 'dupUrl', dupRole: false, row: urlOwner.id };
    }

    const canon = this.roleCanonical(j, null);
    const r = this.st(`INSERT INTO jobs (ats, board, job_id, canonical_url, apply_url, dedup_hash, duplicate_of, title, company,
      company_slug, location, remote, work_mode, is_us, level, level_source, pay_min, pay_max, pay_currency, pay_period,
      pay_min_annual, pay_max_annual, pay_source, posted_at, employment_type, department, description, content_hash,
      first_seen, last_seen, updated_at, page_url, apply_link, places_json, work_model, remote_scope_json, employment,
      levels_json, years_min, years_max, statements_json, evidence_json, pay_ranges, board_updated_at, role_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      j.ats, j.board, j.jobId, j.canonicalUrl, j.applyUrl, j.dedupHash, canon, j.title, j.company,
      j.companySlug, j.location, j.remote ? 1 : 0, j.workMode, b(j.isUs), j.level, j.levelSource, j.payMin, j.payMax,
      j.payCurrency, j.payPeriod, j.payMinAnnual, j.payMaxAnnual, j.paySource, j.postedAt, j.employmentType, j.department,
      j.description, j.contentHash, now, now, now, j.pageUrl ?? j.canonicalUrl, j.applyLink ?? null,
      JSON.stringify(j.places ?? []), j.workModel ?? null, j.remoteScope ? JSON.stringify(j.remoteScope) : null,
      j.employment ?? null, JSON.stringify(j.levels ?? []), j.yearsRequired?.min ?? null, j.yearsRequired?.max ?? null,
      j.statements ? JSON.stringify(j.statements) : null, JSON.stringify(j.evidence ?? {}), j.payRanges ?? null,
      j.boardUpdatedAt ?? null, j.roleKey ?? null,
    );
    const row = Number(r.lastInsertRowid);
    this.credit(row, j, now);
    return { status: 'inserted', dupRole: canon !== null, row };
  }

  /** A closed canonical row stops hiding its repeats: they become visible on their own. */
  private releaseDuplicatesOfClosed(): void {
    this.st(`UPDATE jobs SET duplicate_of = NULL WHERE duplicate_of IS NOT NULL
      AND duplicate_of IN (SELECT id FROM jobs WHERE closed_at IS NOT NULL)`).run();
  }

  /** Close every open posting of one board that this run did not see. Caller has already proven the board covered. */
  closeUnseenForBoard(ats: string, board: string, cutoffIso: string, nowIso: string): number {
    const r = this.st(
      "UPDATE jobs SET closed_at = ?, closed_reason = 'unseen' WHERE ats = ? AND board = ? AND closed_at IS NULL AND last_seen < ?",
    ).run(nowIso, ats, board, cutoffIso);
    if (Number(r.changes) > 0) this.releaseDuplicatesOfClosed();
    return Number(r.changes);
  }

  /** How many open postings a board close would touch (for the "too broad" guard). */
  countUnseenForBoard(ats: string, board: string, cutoffIso: string): { open: number; unseen: number } {
    const open = this.st('SELECT count(*) AS n FROM jobs WHERE ats = ? AND board = ? AND closed_at IS NULL').get(ats, board) as { n: number };
    const unseen = this.st('SELECT count(*) AS n FROM jobs WHERE ats = ? AND board = ? AND closed_at IS NULL AND last_seen < ?').get(ats, board, cutoffIso) as { n: number };
    return { open: Number(open.n), unseen: Number(unseen.n) };
  }

  /** Empty-feed net: close all open postings of a board that has listed nothing for a long time. */
  closeBoardEmpty(ats: string, board: string, nowIso: string, reason = 'board_empty'): number {
    const r = this.st(
      'UPDATE jobs SET closed_at = ?, closed_reason = ? WHERE ats = ? AND board = ? AND closed_at IS NULL',
    ).run(nowIso, reason, ats, board);
    if (Number(r.changes) > 0) this.releaseDuplicatesOfClosed();
    return Number(r.changes);
  }

  /**
   * One complete, clean reading of a board that listed `listedIds`. Open postings it did not list get a miss; a
   * posting closes when a second reading confirms the miss and either the readings are `confirmGapMs` apart or the
   * posting was last seen `graceMs` ago. The mass-close guard holds a reading that would touch over half of a board
   * with at least 10 open postings; such a drop is accepted only after 3 held readings over 24 hours.
   */
  recordReading(ats: string, board: string, listedIds: Iterable<string>, nowIso: string, policy: ClosePolicy): ReadingResult {
    const listed = new Set(listedIds);
    const open = this.st('SELECT id, job_id, last_seen, miss_count, first_missed_at FROM jobs WHERE ats = ? AND board = ? AND closed_at IS NULL')
      .all(ats, board) as Array<{ id: number; job_id: string; last_seen: string; miss_count: number; first_missed_at: string | null }>;
    const missing = open.filter((r) => !listed.has(r.job_id));
    return this.applyMisses(ats, board, open.length, missing, nowIso, policy);
  }

  /** A 304 answer: the board lists exactly what its last proven reading listed. */
  recordNotModified(ats: string, board: string, nowIso: string, policy: ClosePolicy): ReadingResult {
    this.st('UPDATE jobs SET last_seen = ? WHERE ats = ? AND board = ? AND closed_at IS NULL AND miss_count = 0').run(nowIso, ats, board);
    this.st(`UPDATE job_sources SET last_seen = ? WHERE ats = ? AND board = ? AND job IN
      (SELECT id FROM jobs WHERE ats = ? AND board = ? AND closed_at IS NULL AND miss_count = 0)`).run(nowIso, ats, board, ats, board);
    const open = this.st('SELECT id, job_id, last_seen, miss_count, first_missed_at FROM jobs WHERE ats = ? AND board = ? AND closed_at IS NULL')
      .all(ats, board) as Array<{ id: number; job_id: string; last_seen: string; miss_count: number; first_missed_at: string | null }>;
    return this.applyMisses(ats, board, open.length, open.filter((r) => r.miss_count > 0), nowIso, policy);
  }

  private applyMisses(
    ats: string, board: string, openCount: number,
    missing: Array<{ id: number; last_seen: string; miss_count: number; first_missed_at: string | null }>,
    nowIso: string, policy: ClosePolicy,
  ): ReadingResult {
    const now = Date.parse(nowIso);
    const res: ReadingResult = { open: openCount, missing: missing.length, newlyMissing: 0, closed: 0, held: null };
    const row = this.getBoard(ats, board);
    const newly = missing.filter((m) => m.miss_count === 0).length;
    if (closeTooBroad(openCount, newly, policy.guardMinOpen ?? 10)) {
      const streak = (row?.held_streak ?? 0) + 1;
      const since = row?.held_since ?? nowIso;
      const readings = policy.heldReleaseReadings ?? 3;
      const span = policy.heldReleaseMs ?? DAY;
      if (streak >= readings && now - Date.parse(since) >= span) {
        // The same large drop, read again and again over a day: the employer really removed those postings.
        const close = this.st("UPDATE jobs SET closed_at = ?, closed_reason = 'unseen', miss_count = miss_count + 1, first_missed_at = coalesce(first_missed_at, ?) WHERE id = ?");
        for (const m of missing) { close.run(nowIso, since, m.id); res.closed++; }
        this.st('UPDATE boards SET held_streak = 0, held_since = NULL WHERE ats = ? AND board = ?').run(ats, board);
        if (res.closed > 0) this.releaseDuplicatesOfClosed();
        return res;
      }
      this.st('UPDATE boards SET held_streak = ?, held_since = ? WHERE ats = ? AND board = ?').run(streak, since, ats, board);
      res.held = `would close ${newly} of ${openCount} open jobs at once (over ${Math.round(MAX_CLOSE_SHARE * 100)}%); held for review: they close only if ${readings} readings over ${Math.round(span / 3600000)} hours agree`;
      return res;
    }
    if (row && (row.held_streak ?? 0) > 0) this.st('UPDATE boards SET held_streak = 0, held_since = NULL WHERE ats = ? AND board = ?').run(ats, board);
    const mark = this.st('UPDATE jobs SET miss_count = ?, first_missed_at = ? WHERE id = ?');
    const close = this.st("UPDATE jobs SET miss_count = ?, first_missed_at = ?, closed_at = ?, closed_reason = 'unseen' WHERE id = ?");
    for (const m of missing) {
      const count = m.miss_count + 1;
      const first = m.first_missed_at ?? nowIso;
      if (m.miss_count === 0) res.newlyMissing++;
      const confirmed = count >= 2 && (now - Date.parse(first) >= policy.confirmGapMs || now - Date.parse(m.last_seen) >= policy.graceMs);
      if (confirmed) { close.run(count, first, nowIso, m.id); res.closed++; } else mark.run(count, first, m.id);
    }
    if (res.closed > 0) this.releaseDuplicatesOfClosed();
    return res;
  }

  /** Open postings of a board that are waiting for a confirming reading, with the time of their first miss. */
  pendingMisses(ats: string, board: string): { count: number; firstMissedAt: string | null } {
    const r = this.st('SELECT count(*) AS n, min(first_missed_at) AS f FROM jobs WHERE ats = ? AND board = ? AND closed_at IS NULL AND miss_count > 0')
      .get(ats, board) as { n: number; f: string | null };
    return { count: Number(r.n), firstMissedAt: r.f };
  }

  // ---------------------------------------------------------------------------------------------- boards

  ensureBoard(ats: Ats, board: string, company: string, region = '', origin: string | null = null): void {
    this.st('INSERT OR IGNORE INTO boards (ats, board, company, region) VALUES (?,?,?,?)').run(ats, board, company, region);
    this.st('UPDATE boards SET origin = ?, company = CASE WHEN ? <> \'\' THEN ? ELSE company END WHERE ats = ? AND board = ?')
      .run(origin, company, company, ats, board);
  }

  getBoard(ats: string, board: string): BoardRow | undefined {
    return this.st('SELECT * FROM boards WHERE ats = ? AND board = ?').get(ats, board) as BoardRow | undefined;
  }

  listBoards(): BoardRow[] {
    return this.st('SELECT * FROM boards ORDER BY ats, board').all() as unknown as BoardRow[];
  }

  isCooledDown(ats: string, board: string, nowMs: number): boolean {
    const r = this.getBoard(ats, board);
    if (!r || !r.cooldown_until) return false;
    return Date.parse(r.cooldown_until) > nowMs;
  }

  recordSuccess(ats: string, board: string, ingested: number, reached: boolean, nowIso: string): void {
    this.st(`UPDATE boards SET consecutive_failures = 0, cooldown_until = NULL, last_attempt_at = ?, last_success_at = ?,
      last_error = NULL, last_ingested = ?, last_yield_at = CASE WHEN ? THEN ? ELSE last_yield_at END,
      empty_streak = CASE WHEN ? THEN 0 ELSE empty_streak + 1 END, notfound_streak = 0, notfound_since = NULL
      WHERE ats = ? AND board = ?`)
      .run(nowIso, nowIso, ingested, reached ? 1 : 0, nowIso, reached ? 1 : 0, ats, board);
  }

  /** A 304: the board answered and is unchanged. Health is good; the empty streak and the yield stamp keep their values. */
  recordUnchanged(ats: string, board: string, nowIso: string): void {
    this.st(`UPDATE boards SET consecutive_failures = 0, cooldown_until = NULL, last_attempt_at = ?, last_success_at = ?,
      last_error = NULL, notfound_streak = 0, notfound_since = NULL WHERE ats = ? AND board = ?`).run(nowIso, nowIso, ats, board);
  }

  /** One more failure. `cooldownMs` adds an immediate back-off (for example after a 403). Returns the failure count. */
  recordFailure(ats: string, board: string, err: string, nowIso: string, opts: { cooldownMs?: number; notFound?: boolean } = {}): number {
    const row = this.getBoard(ats, board);
    const f = (row?.consecutive_failures ?? 0) + 1;
    const cd = cooldownFor(f);
    const now = Date.parse(nowIso);
    let until = cd === null ? null : now + cd;
    if (opts.cooldownMs && opts.cooldownMs > 0) until = Math.max(until ?? 0, now + opts.cooldownMs);
    this.st(`UPDATE boards SET consecutive_failures = ?, cooldown_until = ?, last_attempt_at = ?, last_error = ?,
      notfound_streak = CASE WHEN ? THEN notfound_streak + 1 ELSE 0 END,
      notfound_since = CASE WHEN ? THEN coalesce(notfound_since, ?) ELSE NULL END WHERE ats = ? AND board = ?`)
      .run(f, until === null ? null : new Date(until).toISOString(), nowIso, err.slice(0, 300),
        opts.notFound ? 1 : 0, opts.notFound ? 1 : 0, nowIso, ats, board);
    return f;
  }

  /** What the last check of a board found, in plain words (for status and the board list). */
  recordOutcome(ats: string, board: string, o: { status: string; code: string; reason: string | null; listed: number | null; runId: number | null; nowIso: string }): void {
    this.st(`UPDATE boards SET last_status = ?, last_reason_code = ?, last_reason = ?, last_listed = coalesce(?, last_listed),
      last_run_id = coalesce(?, last_run_id), last_checked_at = ? WHERE ats = ? AND board = ?`)
      .run(o.status, o.code, o.reason, o.listed, o.runId, o.nowIso, ats, board);
  }

  getValidators(ats: string, board: string): Validators | null {
    const r = this.getBoard(ats, board);
    if (!r || !r.validators_url || (!r.etag && !r.last_modified)) return null;
    return { url: r.validators_url, etag: r.etag ?? null, lastModified: r.last_modified ?? null };
  }

  /** Keeps the validators of a proven reading (so the next request can be conditional), or clears them (null). */
  setValidators(ats: string, board: string, v: Validators | null): void {
    const keep = v && (v.etag || v.lastModified) ? v : null;
    this.st('UPDATE boards SET etag = ?, last_modified = ?, validators_url = ? WHERE ats = ? AND board = ?')
      .run(keep?.etag ?? null, keep?.lastModified ?? null, keep?.url ?? null, ats, board);
  }

  // ---------------------------------------------------------------------------------------------- reads

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

  // ---------------------------------------------------------------------------------------------- meta

  getMeta(key: string): string | null {
    const r = this.st('SELECT value FROM crawler_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }
  setMeta(key: string, value: string | null): void {
    if (value === null) this.st('DELETE FROM crawler_meta WHERE key = ?').run(key);
    else this.st('INSERT INTO crawler_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Persistence for the HTTP client: robots.txt files, host waits and the last request time per host. */
  hostState(): HostStateStore {
    return {
      getRobots: (origin: string): RobotsRecord | null => {
        const r = this.st('SELECT * FROM crawler_robots WHERE origin = ?').get(origin) as {
          status: number; body: string | null; etag: string | null; last_modified: string | null; fetched_at_ms: number; expires_at_ms: number; problem: string | null;
        } | undefined;
        return r ? { status: r.status, body: r.body, etag: r.etag, lastModified: r.last_modified, fetchedAtMs: Number(r.fetched_at_ms), expiresAtMs: Number(r.expires_at_ms), problem: r.problem } : null;
      },
      putRobots: (origin: string, rec: RobotsRecord): void => {
        this.st(`INSERT INTO crawler_robots (origin, status, body, etag, last_modified, fetched_at_ms, expires_at_ms, problem) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT (origin) DO UPDATE SET status = excluded.status, body = excluded.body, etag = excluded.etag,
          last_modified = excluded.last_modified, fetched_at_ms = excluded.fetched_at_ms, expires_at_ms = excluded.expires_at_ms, problem = excluded.problem`)
          .run(origin, rec.status, rec.body, rec.etag, rec.lastModified, rec.fetchedAtMs, rec.expiresAtMs, rec.problem);
      },
      getHost: (host: string): HostRecord | null => {
        const r = this.st('SELECT * FROM crawler_hosts WHERE host = ?').get(host) as { not_before_ms: number | null; not_before_reason: string | null; last_request_ms: number | null } | undefined;
        return r ? { notBeforeMs: r.not_before_ms === null ? null : Number(r.not_before_ms), notBeforeReason: r.not_before_reason, lastRequestMs: r.last_request_ms === null ? null : Number(r.last_request_ms) } : null;
      },
      setHostWait: (host: string, untilMs: number, reason: string): void => {
        this.st(`INSERT INTO crawler_hosts (host, not_before_ms, not_before_reason) VALUES (?,?,?)
          ON CONFLICT (host) DO UPDATE SET not_before_ms = max(coalesce(not_before_ms, 0), excluded.not_before_ms), not_before_reason = excluded.not_before_reason`)
          .run(host, Math.round(untilMs), reason);
      },
      noteRequest: (host: string, atMs: number): void => {
        this.st(`INSERT INTO crawler_hosts (host, last_request_ms) VALUES (?,?)
          ON CONFLICT (host) DO UPDATE SET last_request_ms = max(coalesce(last_request_ms, 0), excluded.last_request_ms)`)
          .run(host, Math.round(atMs));
      },
    };
  }

  /** Hosts that asked to be left alone, with until when and why. */
  hostWaits(nowMs: number): Array<{ host: string; untilMs: number; reason: string | null }> {
    return (this.st('SELECT host, not_before_ms, not_before_reason FROM crawler_hosts WHERE not_before_ms > ? ORDER BY host').all(nowMs) as Array<{ host: string; not_before_ms: number; not_before_reason: string | null }>)
      .map((r) => ({ host: r.host, untilMs: Number(r.not_before_ms), reason: r.not_before_reason }));
  }
}
