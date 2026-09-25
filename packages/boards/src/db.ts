// The boards lane's tables in the one jobleft database. Forward-only migrations, one transaction each, recorded in
// schema_migrations (owner 'boards'). No migration drops or rewrites a person's rows.
//
//   board_prefs          the person's boards (added by link) and choices on directory boards (follow, hide, disable)
//   board_checks         what the last checks of each board saw: state, failures in a row, last good check, open jobs,
//                        and the next check date of a board in back-off
//   crawl_runs           one row per refresh run (the report)
//   crawl_board_reports  one row per board per run, with the reason for anything but ok
//   board_pending_links  links pasted while offline, kept so the person can try again
//   host_pacing          the shared request schedule per host (1 request per second per host across every process)

import type { DatabaseSync } from 'node:sqlite';

export const OWNER = 'boards';

const MIGRATIONS: string[] = [
  // 1
  `
  CREATE TABLE IF NOT EXISTS board_prefs (
    id            TEXT PRIMARY KEY,
    ats           TEXT NOT NULL,
    board         TEXT NOT NULL,
    region        TEXT,
    company       TEXT NOT NULL,
    added_by_user INTEGER NOT NULL DEFAULT 0,
    followed      INTEGER NOT NULL DEFAULT 0,
    hidden        INTEGER NOT NULL DEFAULT 0,
    disabled      INTEGER NOT NULL DEFAULT 0,
    added_at      TEXT,
    updated_at    TEXT NOT NULL,
    source_url    TEXT
  );
  CREATE TABLE IF NOT EXISTS board_checks (
    id                   TEXT PRIMARY KEY,
    state                TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_check_at        TEXT,
    last_success_at      TEXT,
    next_check_at        TEXT,
    open_jobs            INTEGER,
    last_error           TEXT,
    last_outcome         TEXT
  );
  CREATE TABLE IF NOT EXISTS crawl_runs (
    id          INTEGER PRIMARY KEY,
    reason      TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    boards      INTEGER NOT NULL DEFAULT 0,
    ok          INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,
    inserted    INTEGER NOT NULL DEFAULT 0,
    updated     INTEGER NOT NULL DEFAULT 0,
    closed      INTEGER NOT NULL DEFAULT 0,
    requests    INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS crawl_board_reports (
    run_id      INTEGER NOT NULL,
    board_id    TEXT NOT NULL,
    status      TEXT NOT NULL,
    reason      TEXT,
    listed      INTEGER NOT NULL DEFAULT 0,
    inserted    INTEGER NOT NULL DEFAULT 0,
    updated     INTEGER NOT NULL DEFAULT 0,
    unchanged   INTEGER NOT NULL DEFAULT 0,
    skipped     INTEGER NOT NULL DEFAULT 0,
    unreadable  INTEGER NOT NULL DEFAULT 0,
    closed      INTEGER NOT NULL DEFAULT 0,
    close_held  TEXT,
    requests    INTEGER NOT NULL DEFAULT 0,
    finished_at TEXT NOT NULL,
    PRIMARY KEY (run_id, board_id)
  );
  CREATE TABLE IF NOT EXISTS board_pending_links (
    url        TEXT PRIMARY KEY,
    reason     TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS host_pacing (
    host       TEXT PRIMARY KEY,
    next_at    INTEGER NOT NULL DEFAULT 0,
    busy_until INTEGER NOT NULL DEFAULT 0
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Runs the boards migrations. A database newer than this build is refused and left untouched. */
export function migrateBoards(db: DatabaseSync): { from: number; to: number } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (owner, version))`);
  const row = db.prepare('SELECT max(version) AS v FROM schema_migrations WHERE owner = ?').get(OWNER) as { v: number | null };
  const from = Number(row.v ?? 0);
  if (from > MIGRATIONS.length) {
    throw new Error(`The board tables were written by a newer jobleft (version ${from}); this build knows version ${MIGRATIONS.length}. Nothing was changed.`);
  }
  for (let v = from + 1; v <= MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v - 1]!);
      db.prepare('INSERT INTO schema_migrations (owner, version, applied_at) VALUES (?, ?, ?)').run(OWNER, v, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return { from, to: MIGRATIONS.length };
}

/** Runs fn in one transaction (all or nothing). */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
