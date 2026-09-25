// Opens the one database file and brings it to this build's schema (server O12):
//   * a file written by a NEWER build (an owner step this build does not know) is refused with a plain message and
//     left untouched: it is first read with SQLite's `immutable` flag, which writes nothing, not even -wal/-shm;
//   * a read-only data folder is refused before any write;
//   * every pending server step runs in ONE transaction, so an upgrade that fails (full disk, read-only file)
//     leaves the file exactly as it was, and the app never runs on half-upgraded data.

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { nowIso } from '@jobleft/contracts';
import { openDatabase } from '@jobleft/store';
import { storageProblem } from '../errors.ts';
import { KNOWN_OWNERS, SERVER_MIGRATIONS } from './schema.ts';

/** A startup refusal with a message for the person. `kind` picks the exit code in main.ts. */
export class DataFolderError extends Error {
  readonly kind: 'newer' | 'read_only' | 'full' | 'not_jobleft' | 'upgrade_failed';
  constructor(kind: DataFolderError['kind'], message: string) {
    super(message);
    this.name = 'DataFolderError';
    this.kind = kind;
  }
}

type Versions = Record<string, number>;

function readVersions(db: DatabaseSync): Versions {
  const has = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!has) return {};
  const out: Versions = {};
  for (const r of db.prepare('SELECT owner, max(version) AS v FROM schema_migrations GROUP BY owner').all() as Array<{ owner: string; v: number }>) {
    out[r.owner] = Number(r.v);
  }
  return out;
}

function newerThanThisBuild(v: Versions): string | null {
  for (const [owner, version] of Object.entries(v)) {
    const known = KNOWN_OWNERS[owner];
    if (known === undefined) return `it holds "${owner}" data that this build does not know`;
    if (version > known) return `its "${owner}" data is at version ${version}, and this build knows version ${known}`;
  }
  return null;
}

function notJobleft(): DataFolderError {
  return new DataFolderError('not_jobleft', 'The database file in the data folder is not a jobleft database, so jobleft left it untouched. Choose another data folder, or restore a backup.');
}

/** Reads the schema versions without writing anything. null when there is no file yet. */
export function inspectVersions(dbPath: string): Versions | null {
  if (!existsSync(dbPath)) return null;
  const wal = `${dbPath}-wal`;
  const walHasData = existsSync(wal) && statSync(wal).size > 0;
  let db: DatabaseSync;
  try {
    if (walHasData) {
      // A crash left committed pages in the WAL: `immutable` would not see them. A plain read-only open does.
      db = new DatabaseSync(dbPath, { readOnly: true });
    } else {
      const u = pathToFileURL(dbPath);
      u.searchParams.set('immutable', '1');
      db = new DatabaseSync(u, { readOnly: true });
    }
  } catch {
    throw notJobleft();
  }
  try {
    return readVersions(db);
  } catch (e) {
    if (storageProblem(e) === 'corrupt' || /not a database/i.test(String((e as Error).message))) throw notJobleft();
    throw e;
  } finally {
    db.close();
  }
}

function writable(path: string): boolean {
  try { accessSync(path, constants.W_OK); return true; } catch { return false; }
}

export interface OpenResult {
  db: DatabaseSync;
  from: number;
  to: number;
  fresh: boolean;
}

export function openAndMigrate(dbPath: string): OpenResult {
  const before = inspectVersions(dbPath);
  if (before) {
    const why = newerThanThisBuild(before);
    if (why) {
      throw new DataFolderError('newer', `This data folder was written by a newer jobleft (${why}). This version refuses to open it and changed nothing. Use the newer jobleft, or choose another data folder.`);
    }
  }
  const dir = dirname(dbPath);
  if (!writable(dir) || (before && !writable(dbPath))) {
    throw new DataFolderError('read_only', 'The jobleft data folder is read-only, so jobleft did not start and changed nothing. Make the folder writable, then start jobleft again.');
  }
  let db: DatabaseSync;
  try {
    db = openDatabase(dbPath);
  } catch (e) {
    const p = storageProblem(e);
    if (p === 'full') throw new DataFolderError('full', 'The disk that holds the jobleft data folder is full, so jobleft did not start and changed nothing. Free some space, then start jobleft again.');
    if (p === 'read_only') throw new DataFolderError('read_only', 'The jobleft data folder is read-only, so jobleft did not start and changed nothing. Make the folder writable, then start jobleft again.');
    throw notJobleft();
  }
  try {
    // FULL: a confirmed save is on disk before the answer goes out, even across a power cut (server O4).
    db.exec('PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
  } catch { /* pragmas are best effort */ }

  const fresh = !before;
  let from = 0;
  let to = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (owner, version))`);
      const v = readVersions(db);
      const why = newerThanThisBuild(v);
      if (why) throw new DataFolderError('newer', `This data folder was written by a newer jobleft (${why}). This version refuses to open it and changed nothing.`);
      from = v.server ?? 0;
      to = from;
      const ins = db.prepare('INSERT INTO schema_migrations (owner, version, applied_at) VALUES (?, ?, ?)');
      for (const m of SERVER_MIGRATIONS) {
        if (m.version <= from) continue;
        db.exec(m.sql);
        ins.run('server', m.version, nowIso());
        to = m.version;
      }
      const created = db.prepare("SELECT 1 FROM srv_kv WHERE key = 'created_at'").get();
      if (!created) db.prepare("INSERT INTO srv_kv (key, value, updated_at) VALUES ('created_at', ?, ?)").run(JSON.stringify(nowIso()), nowIso());
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* the failed statement may have ended it */ }
      throw e;
    }
  } catch (e) {
    try { db.close(); } catch { /* ignore */ }
    if (e instanceof DataFolderError) throw e;
    const p = storageProblem(e);
    if (p === 'full') throw new DataFolderError('full', 'The disk that holds the jobleft data folder is full, so the data could not be upgraded. Nothing was changed. Free some space, then start jobleft again.');
    if (p === 'read_only') throw new DataFolderError('read_only', 'The jobleft data folder is read-only, so the data could not be upgraded. Nothing was changed.');
    if (p === 'corrupt' || /not a database/i.test(String((e as Error)?.message))) throw notJobleft();
    throw new DataFolderError('upgrade_failed', 'jobleft could not upgrade the data in this folder, so it left the data as it was and did not start.');
  }
  return { db, from, to, fresh };
}
