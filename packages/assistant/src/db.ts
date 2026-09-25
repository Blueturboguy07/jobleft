// The assistant's tables (owner "ai-engine" in docs/INTERFACES.md section 3): chats, practice sessions and items, and
// the list of paid charges. One SQLite file. Deleting a row is real: secure_delete is ON and a delete ends with a WAL
// checkpoint that truncates the -wal file, so deleted text is not left behind in the database or its -wal file.

import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ASSISTANT_OWNER = 'ai-engine';
export const ASSISTANT_SCHEMA_VERSION = 1;

const STEPS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE ai_chats (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, job_id TEXT, preset TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE ai_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT NOT NULL, at TEXT NOT NULL,
  incomplete INTEGER NOT NULL DEFAULT 0, refs_json TEXT
);
CREATE INDEX ai_chat_messages_chat ON ai_chat_messages(chat_id, id);
CREATE TABLE practice_sessions (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, company TEXT NOT NULL, title TEXT NOT NULL, label TEXT NOT NULL,
  questions_json TEXT NOT NULL, made_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX practice_sessions_job ON practice_sessions(job_id, created_at);
CREATE TABLE practice_answers (
  session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL, answer TEXT NOT NULL, feedback TEXT, sample_answer TEXT, answered_at TEXT NOT NULL,
  PRIMARY KEY (session_id, question_id)
);
CREATE TABLE practice_items (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL, question TEXT, answer TEXT, feedback TEXT, notes TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX practice_items_job ON practice_items(job_id);
CREATE TABLE ai_usage (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, what TEXT NOT NULL, cost_micros INTEGER NOT NULL, chat_id TEXT, request_id TEXT
);
`,
  },
];

/** Opens (and creates, mode 0700 folder and 0600 file) the assistant's database. */
export function openAssistantDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') { try { chmodSync(path, 0o600); } catch { /* ignore */ } }
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA secure_delete = ON');
  db.exec('PRAGMA temp_store = MEMORY');
  migrateAssistant(db);
  return db;
}

/** Runs the pending steps in one transaction. A file with a newer version is refused and left untouched. */
export function migrateAssistant(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (owner, version))');
  const row = db.prepare('SELECT max(version) AS v FROM schema_migrations WHERE owner = ?').get(ASSISTANT_OWNER) as { v: number | null };
  const have = row.v ?? 0;
  if (have > ASSISTANT_SCHEMA_VERSION) throw new Error('This data folder was made by a newer jobleft. Update jobleft. Nothing was changed.');
  const pending = STEPS.filter((s) => s.version > have);
  if (!pending.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const s of pending) {
      db.exec(s.sql);
      db.prepare('INSERT INTO schema_migrations (owner, version, applied_at) VALUES (?, ?, ?)').run(ASSISTANT_OWNER, s.version, new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

/** Runs `fn` in one transaction. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

/** After a delete: truncate the -wal file so deleted text does not stay there. */
export function scrub(db: DatabaseSync): void {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* a busy checkpoint is retried at the next delete */ }
}

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
