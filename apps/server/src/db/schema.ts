// The server's tables (owner "server" in schema_migrations). Forward-only steps; a step never rewrites or drops
// user data (INTERFACES 1.4 rule 5).
//
// Two kinds of table live here:
//   * server-owned for good: `pairings` (INTERFACES section 3) and `srv_kv` (the server's own small settings).
//   * INTERIM stand-ins, prefixed `srv_`: the person's records that belong to lanes not merged into this branch yet
//     (store: profile, tracker, saved filters, notifications, chats; resume: resumes; network: contacts; boards:
//     user boards and crawl runs). They keep the server whole and testable on its own. The prefix keeps them apart
//     from the owning lanes' tables, so a merge never collides; at integration each lane's package replaces its
//     stand-in (see apps/server/README.md, "Interim stand-ins").

import { CRAWLER_SCHEMA_VERSION } from '@jobleft/crawler';
import { RESUME_SCHEMA_VERSION } from '@jobleft/resume';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const SERVER_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'pairings, settings, notifications and the interim record tables',
    sql: `
CREATE TABLE pairings (
  extension_id      TEXT PRIMARY KEY,
  token_hash        TEXT NOT NULL,
  browser           TEXT NOT NULL,
  extension_version TEXT NOT NULL,
  paired_at         TEXT NOT NULL,
  last_seen_at      TEXT
);
CREATE TABLE srv_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE srv_notifications (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  target     TEXT,
  created_at TEXT NOT NULL,
  acked_at   TEXT,
  dedupe_key TEXT UNIQUE
);
CREATE TABLE srv_profile (
  id         TEXT PRIMARY KEY CHECK (id = 'default'),
  data       TEXT NOT NULL,
  version    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE srv_tracker (
  job_id     TEXT PRIMARY KEY,
  liked      INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0,
  external   INTEGER NOT NULL DEFAULT 0,
  status     TEXT,
  applied_at TEXT,
  resume_id  TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE srv_tracker_history (
  id     INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES srv_tracker(job_id) ON DELETE CASCADE,
  status TEXT,
  at     TEXT NOT NULL
);
CREATE INDEX srv_tracker_history_job ON srv_tracker_history(job_id, id);
CREATE TABLE srv_tracker_notes (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES srv_tracker(job_id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX srv_tracker_notes_job ON srv_tracker_notes(job_id, position);
CREATE TABLE srv_tracker_reminders (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES srv_tracker(job_id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  at          TEXT NOT NULL,
  text        TEXT NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  notified_at TEXT
);
CREATE INDEX srv_tracker_reminders_job ON srv_tracker_reminders(job_id, position);
CREATE TABLE srv_saved_filters (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  filter           TEXT NOT NULL,
  sort             TEXT NOT NULL,
  alert_enabled    INTEGER NOT NULL DEFAULT 0,
  last_notified_at TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE TABLE srv_resumes (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  target_title   TEXT,
  is_primary     INTEGER NOT NULL DEFAULT 0,
  kind           TEXT NOT NULL,
  base_resume_id TEXT,
  job_id         TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  file_name      TEXT,
  file_mime      TEXT,
  file_bytes     INTEGER,
  file_sha256    TEXT,
  file_path      TEXT,
  document       TEXT NOT NULL,
  import_report  TEXT,
  ats_report     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE srv_contacts (
  id             TEXT PRIMARY KEY,
  identity       TEXT NOT NULL UNIQUE,
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  profile_url    TEXT,
  email          TEXT,
  company        TEXT,
  company_key    TEXT,
  position       TEXT,
  connected_on   TEXT,
  maybe_garbled  INTEGER NOT NULL DEFAULT 0,
  stage          TEXT NOT NULL DEFAULT 'to_contact',
  note           TEXT,
  follow_up_on   TEXT,
  in_plan        INTEGER NOT NULL DEFAULT 0,
  in_last_import INTEGER NOT NULL DEFAULT 1,
  imported_at    TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX srv_contacts_company ON srv_contacts(company_key);
CREATE TABLE srv_chats (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  job_id     TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE srv_chat_messages (
  id         INTEGER PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES srv_chats(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  at         TEXT NOT NULL,
  incomplete INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX srv_chat_messages_chat ON srv_chat_messages(chat_id, id);
CREATE TABLE srv_boards (
  id       TEXT PRIMARY KEY,
  ats      TEXT NOT NULL,
  board    TEXT NOT NULL,
  region   TEXT,
  company  TEXT NOT NULL,
  followed INTEGER NOT NULL DEFAULT 1,
  hidden   INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL
);
CREATE TABLE srv_crawl_runs (
  id          INTEGER PRIMARY KEY,
  reason      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  summary     TEXT,
  boards      TEXT
);
`,
  },
  {
    version: 2,
    name: 'extension: answers the person saved during a review, and the review log',
    sql: `
CREATE TABLE srv_saved_answers (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  label_key  TEXT NOT NULL UNIQUE,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE srv_extension_reviews (
  request_id   TEXT PRIMARY KEY,
  extension_id TEXT,
  job_id       TEXT,
  page_url     TEXT NOT NULL,
  ats          TEXT NOT NULL,
  submitted    INTEGER NOT NULL,
  filled       INTEGER NOT NULL,
  edited       INTEGER NOT NULL,
  at           TEXT NOT NULL
);
`,
  },
];

export const SERVER_SCHEMA_VERSION = SERVER_MIGRATIONS[SERVER_MIGRATIONS.length - 1]!.version;

/** Owners whose steps this build runs. A file with steps of any other owner came from a build this one cannot read. */
// 'resume': the resumes, tailor_proposals and cover_letters tables (i-resume wires the resume lane into the app database).
// 'crawler': the crawler's own Store records its steps in the same schema_migrations table, so a second start must know it.
export const KNOWN_OWNERS: Readonly<Record<string, number>> = { server: SERVER_SCHEMA_VERSION, crawler: CRAWLER_SCHEMA_VERSION, resume: RESUME_SCHEMA_VERSION };
