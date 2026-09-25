// The network tables and their migrations (owner "network" in schema_migrations, docs/INTERFACES.md section 3).
//   network_contacts  one row per connection, with the person's own tracking (stage, note, follow-up, plan)
//   network_meta      small key-value facts of the Network tool (key-function fingerprint, last import counts,
//                     which AI destinations the person approved for drafts). Never a name, email or note.
// Deletes are real: `secure_delete` is on for this connection, so deleted and replaced text is overwritten with
// zeros, and a delete ends with a WAL checkpoint that truncates the log (no old copy stays in the -wal file).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const NETWORK_OWNER = 'network';

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE network_contacts (
        id              TEXT PRIMARY KEY,
        url_key         TEXT,
        name_key        TEXT NOT NULL,
        first_name      TEXT NOT NULL,
        last_name       TEXT NOT NULL,
        profile_url     TEXT,
        email           TEXT,
        company         TEXT,
        company_key     TEXT,
        company_raw_key TEXT,
        position        TEXT,
        connected_on    TEXT,
        maybe_garbled   INTEGER NOT NULL DEFAULT 0,
        stage           TEXT NOT NULL DEFAULT 'to_contact',
        note            TEXT,
        follow_up_on    TEXT,
        in_plan         INTEGER NOT NULL DEFAULT 0,
        reminded_for    TEXT,
        in_latest_file  INTEGER NOT NULL DEFAULT 1,
        file_line       INTEGER,
        search_text     TEXT NOT NULL DEFAULT '',
        imported_at     TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX network_contacts_url ON network_contacts(url_key) WHERE url_key IS NOT NULL;
      CREATE INDEX network_contacts_name ON network_contacts(name_key);
      CREATE INDEX network_contacts_company ON network_contacts(company_key);
      CREATE INDEX network_contacts_company_raw ON network_contacts(company_raw_key);
      CREATE INDEX network_contacts_follow ON network_contacts(follow_up_on) WHERE follow_up_on IS NOT NULL;
      CREATE TABLE network_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

export const NETWORK_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Runs the network migrations (forward only, one transaction each). Refuses a database from a newer build. */
export function migrateNetwork(db: DatabaseSync, nowIso: string): { from: number; to: number } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (owner, version))`);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations WHERE owner = ?').get(NETWORK_OWNER) as { v: number | null } | undefined;
  const from = row?.v ?? 0;
  if (from > NETWORK_SCHEMA_VERSION) {
    throw new Error(`The network data was written by a newer jobleft (schema ${from}; this build knows ${NETWORK_SCHEMA_VERSION}). It was left untouched.`);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (owner, version, applied_at) VALUES (?, ?, ?)').run(NETWORK_OWNER, m.version, nowIso);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return { from, to: NETWORK_SCHEMA_VERSION };
}

/**
 * Opens a database file the way @jobleft/store does (page_size 16384 on a new file, WAL, synchronous NORMAL,
 * foreign keys on). Used by this package's own CLI and dev server; the app passes the store's connection.
 */
export function openNetworkDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  const pages = db.prepare('PRAGMA page_count').get() as { page_count: number };
  if (pages.page_count === 0) db.exec('PRAGMA page_size = 16384');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** Empties the write-ahead log into the database file and truncates it, so deleted rows leave no old copy there. */
export function checkpoint(db: DatabaseSync): void {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* not in WAL mode, or busy: the next checkpoint does it */ }
}

export interface ContactRow {
  id: string;
  url_key: string | null;
  name_key: string;
  first_name: string;
  last_name: string;
  profile_url: string | null;
  email: string | null;
  company: string | null;
  company_key: string | null;
  company_raw_key: string | null;
  position: string | null;
  connected_on: string | null;
  maybe_garbled: number;
  stage: string;
  note: string | null;
  follow_up_on: string | null;
  in_plan: number;
  reminded_for: string | null;
  in_latest_file: number;
  file_line: number | null;
  search_text: string;
  imported_at: string;
  updated_at: string;
}
