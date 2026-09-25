// Tables owned by @jobleft/sources-other (docs/INTERFACES.md section 3). Forward-only migrations, one transaction
// each, recorded in schema_migrations(owner = 'sources-other', version). A file with a newer version is refused.
//
//   source_state       on/off, last run, last problem, 429 back-off, ETag, run lease (one row per source)
//   source_runs        every run with its outcome and counts; the daily run limit counts these (limits survive restarts)
//   source_requests    every request sent, per source, for the daily request limit
//   source_host_slots  the shared pacer: next free slot per host (real time), shared by every process
//   feed_postings      each posting as each feed lists it: the link back, the credit, and the facts as the source
//                      states them (remote scope, places, level, pay, statements, evidence). Several rows may point at
//                      one job row in the crawler's `jobs` table (the same posting from two places keeps both credits)

import type { DatabaseSync } from 'node:sqlite';

export const OWNER = 'sources-other';

const STEPS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS source_state (
  source_id            TEXT PRIMARY KEY,
  enabled              INTEGER NOT NULL DEFAULT 0,
  last_attempt_at      TEXT,
  last_success_at      TEXT,
  last_outcome         TEXT,
  last_problem         TEXT,
  last_problem_at      TEXT,
  last_error_code      TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  retry_after_until    TEXT,
  etag                 TEXT,
  lease_until_ms       INTEGER,
  lease_owner          TEXT,
  updated_at           TEXT
);
CREATE TABLE IF NOT EXISTS source_runs (
  id            INTEGER PRIMARY KEY,
  source_id     TEXT NOT NULL,
  reason        TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  finished_at   TEXT,
  outcome       TEXT NOT NULL,
  problem       TEXT,
  error_code    TEXT,
  complete      INTEGER,
  listed        INTEGER NOT NULL DEFAULT 0,
  inserted      INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,
  unchanged     INTEGER NOT NULL DEFAULT 0,
  merged        INTEGER NOT NULL DEFAULT 0,
  closed        INTEGER NOT NULL DEFAULT 0,
  reopened      INTEGER NOT NULL DEFAULT 0,
  close_held    TEXT,
  unreadable    INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  requests      INTEGER NOT NULL DEFAULT 0,
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS source_runs_by_source ON source_runs(source_id, started_at_ms);
CREATE TABLE IF NOT EXISTS source_requests (
  source_id TEXT NOT NULL,
  at_ms     INTEGER NOT NULL,
  host      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS source_requests_by_source ON source_requests(source_id, at_ms);
CREATE TABLE IF NOT EXISTS source_host_slots (
  host       TEXT PRIMARY KEY,
  next_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feed_postings (
  source_id         TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  job_ats           TEXT NOT NULL,
  job_board         TEXT NOT NULL,
  job_ext_id        TEXT NOT NULL,
  job_key           TEXT NOT NULL,
  source_name       TEXT NOT NULL,
  url               TEXT NOT NULL,
  apply_url         TEXT,
  canonical_url     TEXT NOT NULL,
  credit_text       TEXT,
  credit_url        TEXT,
  title             TEXT NOT NULL,
  company           TEXT NOT NULL,
  posted_at         TEXT,
  places_json       TEXT NOT NULL DEFAULT '[]',
  work_model        TEXT,
  remote_scope_json TEXT,
  employment_type   TEXT,
  level             TEXT,
  pay_json          TEXT,
  is_us             INTEGER,
  statements_json   TEXT NOT NULL DEFAULT '{"sponsorship":null,"clearanceRequired":null,"usCitizenOnly":null}',
  evidence_json     TEXT NOT NULL DEFAULT '{}',
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  missing_since     TEXT,
  status            TEXT NOT NULL DEFAULT 'open',
  closed_at         TEXT,
  closed_reason     TEXT,
  PRIMARY KEY (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS feed_postings_job ON feed_postings(job_key);
CREATE INDEX IF NOT EXISTS feed_postings_open ON feed_postings(source_id, status);
`,
  },
];

export const SCHEMA_VERSION = STEPS[STEPS.length - 1]!.version;

export class NewerSchemaError extends Error {
  constructor(found: number) {
    super(`this data folder was written by a newer jobleft (sources-other schema ${found}, this build knows ${SCHEMA_VERSION}); nothing was changed`);
    this.name = 'NewerSchemaError';
  }
}

/** Runs this lane's migrations. Safe to call on every start. */
export function migrateSourcesOther(db: DatabaseSync): { from: number; to: number } {
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (owner TEXT, version INTEGER, applied_at TEXT, PRIMARY KEY (owner, version))`);
  const row = db.prepare('SELECT max(version) AS v FROM schema_migrations WHERE owner = ?').get(OWNER) as { v: number | null };
  const from = Number(row?.v ?? 0);
  if (from > SCHEMA_VERSION) throw new NewerSchemaError(from);
  for (const step of STEPS) {
    if (step.version <= from) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(step.sql);
      db.prepare('INSERT INTO schema_migrations (owner, version, applied_at) VALUES (?, ?, ?)').run(OWNER, step.version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return { from, to: SCHEMA_VERSION };
}
