// jobleft-server: helper commands for testers and developers. None of them runs while a server uses the folder.
//
//   node apps/server/src/cli.ts seed-jobs --home <dir> --count 100000
//       Adds <count> SYNTHETIC jobs (company "Synthetic Employer <n>", board "synthetic-<n>") to the crawl tables of
//       a data folder, for speed tests (server O9). Never run it on a real data folder: the rows look like jobs.
//   node apps/server/src/cli.ts fixture --home <dir> --schema 1
//       Makes a data folder as an OLDER build (server schema version 1) left it, with the test persona's data
//       (profile, likes, statuses, notes, reminders, saved filter, resume file, contacts, chat), for upgrade tests (O12).
//   node apps/server/src/cli.ts fixture --home <dir> --schema future
//       Makes a data folder that a NEWER build wrote (schema version 999), to see an older build refuse it.
//   node apps/server/src/cli.ts counts --home <dir>
//       Prints the count per kind (the same numbers a backup's manifest lists). Reads only.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { nowIso } from '@jobleft/contracts';
import { Store, normalizeJob, type RawJob } from '@jobleft/crawler';
import { openDatabase } from '@jobleft/store';
import { acquireLock } from './lock.ts';
import { ensureHome, homeLayout } from './home.ts';
import { SERVER_MIGRATIONS } from './db/schema.ts';
import { openReadOnly } from './db/open.ts';
import { countsOf } from './services/backup.ts';

process.umask(0o077);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { home: { type: 'string' }, count: { type: 'string' }, schema: { type: 'string' } },
});
const cmd = positionals[0];

function die(msg: string): never { process.stderr.write(`${msg}\n`); process.exit(1); }

if (!cmd || !['seed-jobs', 'fixture', 'counts'].includes(cmd)) {
  die('usage: cli.ts seed-jobs --home <dir> --count <n> | fixture --home <dir> --schema 1|future | counts --home <dir>');
}
if (!values.home) die('--home <dir> is required (a scratch data folder, never your real one)');
const layout = homeLayout(values.home);
ensureHome(layout);
const lock = acquireLock(layout.lockFile);
if (!lock.ok) die('a jobleft server is running on this data folder; stop it first');

const TITLES = ['Software Engineer', 'Data Analyst', 'Registered Nurse', 'Account Executive', 'Product Designer', 'Mechanical Engineer', 'Customer Success Manager', 'Financial Analyst', 'Warehouse Associate', 'Marketing Manager', 'Teacher', 'Electrician', 'Pharmacist', 'Paralegal', 'Chef'];
const CITIES = ['Austin, TX', 'New York, NY', 'Seattle, WA', 'Chicago, IL', 'Remote - US', 'Denver, CO', 'Boston, MA', 'Atlanta, GA', 'Toronto, ON', 'London, UK'];

function synthetic(i: number): { board: string; company: string; raw: RawJob } {
  const k = i % 2000;
  const title = `${TITLES[i % TITLES.length]}${i % 3 === 0 ? ' II' : i % 5 === 0 ? ', Senior' : ''}`;
  const company = `Synthetic Employer ${k}`;
  const hasPay = i % 3 === 0;
  return {
    board: `synthetic-${k}`,
    company,
    raw: {
      externalId: String(100000 + i), url: `https://boards.greenhouse.io/synthetic-${k}/jobs/${100000 + i}`, applyUrl: '',
      title, company, location: CITIES[i % CITIES.length]!,
      descriptionHtml: `<p>${title} at ${company}. This is a synthetic posting made by the seed-jobs command for speed tests.</p><ul><li>Work with a team</li><li>Skill ${i % 97}</li></ul>`,
      remote: i % CITIES.length === 4, workMode: i % 7 === 0 ? 'hybrid' : '', countries: [],
      postedAt: i % 4 === 0 ? null : new Date(Date.UTC(2026, 8, 1) - (i % 60) * 86_400_000).toISOString(),
      employmentType: i % 11 === 0 ? 'part_time' : 'full_time', department: '',
      pay: hasPay ? { min: 60000 + (i % 50) * 1000, max: 90000 + (i % 50) * 1000, currency: 'USD', period: 'year' } : null,
    },
  };
}

function seedJobs(store: Store, n: number): number {
  const now = nowIso();
  let saved = 0;
  const batch = 5000;
  for (let start = 0; start < n; start += batch) {
    store.transaction(() => {
      for (let i = start; i < Math.min(n, start + batch); i++) {
        const s = synthetic(i);
        const j = normalizeJob({ ats: 'greenhouse', board: s.board, company: s.company }, s.raw);
        if (j && store.upsertJob(j, now).status !== 'dupUrl') saved++;
      }
    });
  }
  return saved;
}

try {
  if (cmd === 'counts') {
    if (!existsSync(layout.db)) die('this data folder has no jobleft data yet');
    const db = openReadOnly(layout.db);
    try { process.stdout.write(JSON.stringify(countsOf(db), null, 2) + '\n'); } finally { db.close(); }
  } else if (cmd === 'seed-jobs') {
    const n = Number(values.count ?? '1000');
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) die('--count must be 1 to 1000000');
    const store = new Store(layout.db);
    const t0 = Date.now();
    const saved = seedJobs(store, n);
    store.close();
    process.stdout.write(`added ${saved} synthetic jobs in ${((Date.now() - t0) / 1000).toFixed(1)} s to ${layout.db}\n`);
  } else {
    const which = values.schema ?? '1';
    if (which !== '1' && which !== 'future') die('--schema must be 1 or future');
    const db = openDatabase(layout.db);
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (owner, version))`);
    const have = new Set((db.prepare("SELECT version FROM schema_migrations WHERE owner = 'server'").all() as Array<{ version: number }>).map((r) => r.version));
    if (have.size) die('this folder already has jobleft data; use an empty folder');
    const m1 = SERVER_MIGRATIONS[0]!;
    db.exec('BEGIN');
    db.exec(m1.sql);
    db.prepare("INSERT INTO schema_migrations (owner, version, applied_at) VALUES ('server', 1, ?)").run('2026-09-20T12:00:00.000Z');
    db.prepare("INSERT INTO srv_kv (key, value, updated_at) VALUES ('created_at', ?, ?)").run(JSON.stringify('2026-09-20T12:00:00.000Z'), '2026-09-20T12:00:00.000Z');
    const t = '2026-09-21T15:30:00.000Z';
    const profile = {
      personal: { firstName: 'Jordan', middleName: null, lastName: 'Testwell', email: 'jordan.testwell@example.com', phone: '+1 555 0100', addressLine: null, city: 'Austin', region: 'TX', postalCode: '78701', country: 'US', links: [{ label: 'Portfolio', url: 'https://example.com/jordan' }] },
      summary: 'Analyst who likes clean data. Ünïcödé ✓ and emoji 🎯 stay as written.',
      education: [], work: [{ id: 'w1', company: 'Example Corp', title: 'Data Analyst', employmentType: 'full_time', location: 'Austin, TX', startDate: '2022-06', endDate: null, current: true, summary: null, bullets: ['Built weekly reports.'] }],
      projects: [], certifications: [], skills: [{ name: 'SQL', years: 3, source: 'user' }],
      preferences: { jobFunctions: ['Data'], targetTitles: ['Data Analyst'], employmentTypes: ['full_time'], workModels: ['hybrid'], levels: ['mid'], countries: ['US'], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
      workAuthorization: { usAuthorized: 'yes', needsSponsorship: 'no', usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
      eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
    };
    db.prepare("INSERT INTO srv_profile (id, data, version, updated_at) VALUES ('default', ?, 'fixture-v1', ?)").run(JSON.stringify(profile), t);
    db.exec('COMMIT');
    db.close();
    // Jobs through the crawler's own store, so the rows are exactly what a crawl writes.
    const store = new Store(layout.db);
    store.transaction(() => {
      for (let i = 0; i < 5; i++) {
        const s = synthetic(i);
        const j = normalizeJob({ ats: 'greenhouse', board: 'fixture-board', company: 'Fixture Employer' }, { ...s.raw, company: 'Fixture Employer', url: `https://boards.greenhouse.io/fixture-board/jobs/${900 + i}`, externalId: String(900 + i) });
        if (j) store.upsertJob(j, '2026-09-20T12:00:00.000Z');
      }
    });
    store.close();
    const db2 = new DatabaseSync(layout.db);
    db2.exec('BEGIN');
    const tr = db2.prepare('INSERT INTO srv_tracker (job_id, liked, hidden, external, status, applied_at, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?, ?, ?)');
    tr.run('greenhouse:fixture-board:900', 1, null, null, t, t);
    tr.run('greenhouse:fixture-board:901', 0, 'interviewing', t, t, t);
    db2.prepare('INSERT INTO srv_tracker_history (job_id, status, at) VALUES (?, ?, ?)').run('greenhouse:fixture-board:901', 'applied', t);
    db2.prepare('INSERT INTO srv_tracker_history (job_id, status, at) VALUES (?, ?, ?)').run('greenhouse:fixture-board:901', 'interviewing', '2026-09-22T09:00:00.000Z');
    db2.prepare('INSERT INTO srv_tracker_notes (id, job_id, position, text, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)').run('note_fixture1', 'greenhouse:fixture-board:901', 'Recruiter call went well. 面接 next week 🎉', t, t);
    db2.prepare('INSERT INTO srv_tracker_reminders (id, job_id, position, at, text, done) VALUES (?, ?, 0, ?, ?, 0)').run('rem_fixture1', 'greenhouse:fixture-board:901', '2026-10-01T16:00:00.000Z', 'Send thank-you note');
    db2.prepare('INSERT INTO srv_saved_filters (id, name, filter, sort, alert_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)').run('flt_fixture1', 'Hybrid analyst roles', JSON.stringify({ workModels: ['hybrid'] }), 'most_recent', t, t);
    const pdf = Buffer.from('%PDF-1.4\n% jobleft fixture resume for Jordan Testwell\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
    mkdirSync(layout.resumes, { recursive: true });
    writeFileSync(join(layout.resumes, 'res_0000000000000001.pdf'), pdf, { mode: 0o600 });
    const sha = (await import('node:crypto')).createHash('sha256').update(pdf).digest('hex');
    db2.prepare(`INSERT INTO srv_resumes (id, name, is_primary, kind, version, file_name, file_mime, file_bytes, file_sha256, file_path, document, created_at, updated_at)
      VALUES ('res_0000000000000001', 'Jordan Testwell resume', 1, 'base', 1, 'Jordan-Testwell.pdf', 'application/pdf', ?, ?, 'files/resumes/res_0000000000000001.pdf', ?, ?, ?)`)
      .run(pdf.length, sha, JSON.stringify({ header: { name: 'Jordan Testwell', email: 'jordan.testwell@example.com', phone: '+1 555 0100', city: 'Austin', links: [] }, sections: [] }), t, t);
    db2.prepare(`INSERT INTO srv_contacts (id, identity, first_name, last_name, email, company, company_key, position, connected_on, stage, note, imported_at, updated_at)
      VALUES ('con_fixture1', 'name:alex|example|fixture employer', 'Alex', 'Example', NULL, 'Fixture Employer', 'fixtureemployer', 'Recruiter', '2025-03-04', 'messaged', 'Said to ping after Oct 1', ?, ?)`).run(t, t);
    db2.prepare("INSERT INTO srv_chats (id, title, job_id, created_at, updated_at) VALUES ('chat_fixture1', 'Prep for the interview', 'greenhouse:fixture-board:901', ?, ?)").run(t, t);
    db2.prepare("INSERT INTO srv_chat_messages (chat_id, role, content, at) VALUES ('chat_fixture1', 'user', 'What should I prepare?', ?)").run(t);
    db2.prepare("INSERT INTO srv_chat_messages (chat_id, role, content, at) VALUES ('chat_fixture1', 'assistant', 'Review the job duties and your SQL work.', ?)").run(t);
    db2.exec('COMMIT');
    if (which === 'future') db2.prepare("INSERT INTO schema_migrations (owner, version, applied_at) VALUES ('server', 999, ?)").run(t);
    db2.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db2.close();
    process.stdout.write(`made a ${which === 'future' ? 'NEWER-build (schema 999)' : 'schema-1'} data folder with the test persona at ${values.home}\n`);
  }
} finally {
  lock.release();
}
