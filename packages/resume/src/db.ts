// The resume lane's tables (docs/INTERFACES.md section 3): resumes (base resumes and tailored versions),
// tailor_proposals and cover_letters. Forward-only migrations, recorded in schema_migrations with owner 'resume'.

import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '@jobleft/contracts';
import { ResumeError } from './errors.ts';

export const RESUME_SCHEMA_VERSION = 1;

const STEPS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE resumes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_title TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('base', 'tailored')),
  base_resume_id TEXT,
  job_id TEXT,
  job_label_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  file_json TEXT,
  document_json TEXT NOT NULL,
  import_report_json TEXT,
  proposed_profile_json TEXT,
  snapshot_json TEXT,
  snapshot_source TEXT,
  ats_report_json TEXT,
  proposal_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX resumes_base ON resumes(base_resume_id);
CREATE INDEX resumes_job ON resumes(job_id);
CREATE TABLE tailor_proposals (
  id TEXT PRIMARY KEY,
  resume_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  ops_json TEXT NOT NULL,
  base_document_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX tailor_proposals_resume ON tailor_proposals(resume_id);
CREATE TABLE cover_letters (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  resume_id TEXT NOT NULL,
  text TEXT NOT NULL,
  violations_json TEXT NOT NULL,
  ready INTEGER NOT NULL,
  extra_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX cover_letters_job ON cover_letters(job_id);
`,
  },
];

/** Runs the resume migrations. A database newer than this build is refused and left untouched. */
export function migrateResume(db: DatabaseSync): { from: number; to: number } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (owner, version))`);
  const row = db.prepare(`SELECT MAX(version) AS v FROM schema_migrations WHERE owner = 'resume'`).get() as { v: number | null } | undefined;
  const from = row?.v ?? 0;
  if (from > RESUME_SCHEMA_VERSION) {
    throw new ResumeError('internal', 'The resume data was written by a newer version of jobleft. Update jobleft to open it; nothing was changed.');
  }
  for (const step of STEPS) {
    if (step.version <= from) continue;
    db.exec('BEGIN');
    try {
      db.exec(step.sql);
      db.prepare(`INSERT INTO schema_migrations (owner, version, applied_at) VALUES ('resume', ?, ?)`).run(step.version, nowIso());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return { from, to: RESUME_SCHEMA_VERSION };
}
