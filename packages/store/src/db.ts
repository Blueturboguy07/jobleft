// The one SQLite file: open it safely and run the store's migrations.

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const STORE_OWNER = 'store';

/** Plain error with a code the server maps to an HTTP answer. The message is one plain sentence. */
export class StoreError extends Error {
  readonly code: 'bad_request' | 'not_found' | 'conflict' | 'needs_profile' | 'not_ready' | 'internal';
  constructor(code: StoreError['code'], message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export interface OpenOptions {
  /** Open read-only (no migration, no writes). */
  readOnly?: boolean;
  /** How long a writer waits for another process's write to finish (ms). Default 10 s. */
  busyTimeoutMs?: number;
}

/**
 * Opens (or creates) the database. A new file gets mode 0600 and `page_size = 16384` before any table (spike S2),
 * then WAL, `synchronous = NORMAL` and `foreign_keys = ON`. The parent folder is created with mode 0700.
 */
export function openDatabase(path: string, opts: OpenOptions = {}): DatabaseSync {
  const memory = path === ':memory:' || path === '';
  if (!memory && !opts.readOnly) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
  }
  const db = new DatabaseSync(path, { readOnly: opts.readOnly ?? false, timeout: opts.busyTimeoutMs ?? 10_000 });
  if (!opts.readOnly) {
    const fresh = (db.prepare('SELECT count(*) AS n FROM sqlite_schema').get() as { n: number }).n === 0;
    if (fresh) db.exec('PRAGMA page_size = 16384; PRAGMA auto_vacuum = INCREMENTAL;');
    db.exec('PRAGMA journal_mode = WAL');
    if (!memory) { try { chmodSync(path, 0o600); } catch { /* not ours to change */ } }
  }
  db.exec('PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -65536;');
  return db;
}

/** BEGIN IMMEDIATE ... COMMIT, rolled back on any error. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO store_meta (key, value) VALUES ('rev', '0');

-- The store's copy of every posting (named store_jobs so it never clashes with the crawler's own jobs table).
-- rid is the dense row number used by the in-memory arrays and as the FTS5 rowid.
CREATE TABLE store_jobs (
  rid           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  status        INTEGER NOT NULL,
  closed_at     TEXT,
  closed_reason TEXT,
  dup_of        INTEGER,
  company_key   TEXT NOT NULL,
  board_scope   TEXT,
  posted_at     TEXT,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  embed_hash    TEXT NOT NULL,
  precedence    INTEGER NOT NULL,
  facets        BLOB NOT NULL,
  doc           BLOB NOT NULL,
  rev           INTEGER NOT NULL
);
CREATE INDEX store_jobs_rev ON store_jobs (rev);
CREATE INDEX store_jobs_company ON store_jobs (company_key);
CREATE INDEX store_jobs_scope ON store_jobs (board_scope) WHERE status = 1;

-- Every key that names a posting: its id, its canonical links, its ATS posting id, its content fingerprint.
CREATE TABLE job_keys (key TEXT PRIMARY KEY, rid INTEGER NOT NULL) WITHOUT ROWID;
-- Rows removed from store_jobs (so the in-memory arrays of another process drop them too).
CREATE TABLE job_tombstones (rid INTEGER PRIMARY KEY, rev INTEGER NOT NULL);
CREATE INDEX job_tombstones_rev ON job_tombstones (rev);
CREATE INDEX job_keys_rid ON job_keys (rid);

-- Interned strings used by the filter arrays (places, countries, skills, sources, regions). Ids never change.
CREATE TABLE facet_tags (id INTEGER PRIMARY KEY, tag TEXT NOT NULL UNIQUE);

-- Company facts the filters read (industry, stage, staffing agency, H-1B history).
CREATE TABLE companies (
  key          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  industries   TEXT NOT NULL DEFAULT '[]',
  stage        TEXT,
  is_staffing  INTEGER,
  h1b          TEXT,
  updated_at   TEXT NOT NULL,
  rev          INTEGER NOT NULL
);
CREATE INDEX companies_rev ON companies (rev);

-- Words: title, company and skills/department/places (full detail: phrases and column filters work),
-- and the description (detail=none: small and fast; every word still matches).
CREATE VIRTUAL TABLE job_head_fts USING fts5(title, company, extra, content='', contentless_delete=1,
  tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE job_body_fts USING fts5(body, content='', contentless_delete=1, detail=none,
  tokenize='porter unicode61 remove_diacritics 2');

-- Fit vectors: float16, 384 dims, one per (job, model). embed_hash = hash of the text that was embedded.
CREATE TABLE job_vectors (
  rid        INTEGER NOT NULL,
  model      TEXT NOT NULL,
  embed_hash TEXT NOT NULL,
  vec        BLOB NOT NULL,
  rev        INTEGER NOT NULL,
  PRIMARY KEY (rid, model)
);
CREATE INDEX job_vectors_rev ON job_vectors (rev);

CREATE TABLE fit_runs (
  id          INTEGER PRIMARY KEY,
  model       TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  indexed     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tracker (
  job_id      TEXT PRIMARY KEY,
  liked       INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0,
  external    INTEGER NOT NULL DEFAULT 0,
  status      TEXT,
  applied_at  TEXT,
  resume_id   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  rev         INTEGER NOT NULL
);
CREATE INDEX tracker_rev ON tracker (rev);
CREATE TABLE tracker_history (id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, status TEXT, at TEXT NOT NULL);
CREATE INDEX tracker_history_job ON tracker_history (job_id);
CREATE TABLE tracker_notes (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, pos INTEGER NOT NULL, text TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX tracker_notes_job ON tracker_notes (job_id);
CREATE TABLE tracker_reminders (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, pos INTEGER NOT NULL, at TEXT NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL
);
CREATE INDEX tracker_reminders_job ON tracker_reminders (job_id);

CREATE TABLE saved_filters (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, filter TEXT NOT NULL, sort TEXT NOT NULL,
  alert_enabled INTEGER NOT NULL DEFAULT 0, last_notified_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE profile (id TEXT PRIMARY KEY, data TEXT NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, job_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE chat_messages (chat_id TEXT NOT NULL, pos INTEGER NOT NULL, message TEXT NOT NULL, PRIMARY KEY (chat_id, pos));

CREATE TABLE notifications (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, target TEXT,
  created_at TEXT NOT NULL, acked_at TEXT
);
`,
  },
];

export const STORE_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (owner, version))`);
}

/** The store's schema version in this file (0 = none). */
export function storeVersion(db: DatabaseSync): number {
  const t = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!t) return 0;
  const r = db.prepare('SELECT max(version) AS v FROM schema_migrations WHERE owner = ?').get(STORE_OWNER) as { v: number | null };
  return Number(r.v ?? 0);
}

/**
 * Runs the store's migrations (forward only, one transaction each, recorded in `schema_migrations`).
 * A newer file than this build knows is refused with a plain error and left untouched.
 */
export function migrate(db: DatabaseSync): { from: number; to: number } {
  const from = storeVersion(db);
  if (from > STORE_SCHEMA_VERSION) {
    throw new StoreError('conflict',
      `This data file was written by a newer jobleft (store schema ${from}; this build knows ${STORE_SCHEMA_VERSION}). It was left untouched.`);
  }
  ensureMigrationsTable(db);
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    tx(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (owner, version, applied_at) VALUES (?, ?, ?)')
        .run(STORE_OWNER, m.version, new Date().toISOString());
    });
  }
  return { from, to: STORE_SCHEMA_VERSION };
}

/** The next change number. Call inside a write transaction; every row written in it carries this number. */
export function nextRev(db: DatabaseSync): number {
  const r = db.prepare("UPDATE store_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev' RETURNING value").get() as { value: string | number };
  return Number(r.value);
}

export function currentRev(db: DatabaseSync): number {
  const r = db.prepare("SELECT value FROM store_meta WHERE key = 'rev'").get() as { value: string | number } | undefined;
  return r ? Number(r.value) : 0;
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const r = db.prepare('SELECT value FROM store_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? String(r.value) : null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}
