// Backup, restore, export and delete-all (server O7, O8; INTERFACES routes backup, restore, exportAll, deleteAllData).
//
// Backup: ONE sealed zip (see zip.ts): manifest.json (format, app version, schema versions, counts, and the size and
// SHA-256 of every file), data/jobleft.db (a consistent copy made with SQLite's online backup, with the extension
// pairings removed and the free pages wiped) and every uploaded file under files/. Never a key or a token: keys live
// in the secret store, the launch token only in memory and run/server.json, pairing tokens only as hashes (removed).
// Restore: the upload is checked in full (seal, names, sizes, CRC-32, SHA-256, SQLite integrity, schema version)
// before anything changes; then the current data/ and files/ are moved aside, the backup is moved in and opened, and
// on any failure the old folders are moved back. The result replaces the current data (no mixing, no duplicates).
// This computer's extension pairings are kept.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { SECRET_NAMES, nowIso } from '@jobleft/contracts';
import type { App, AppData } from '../app.ts';
import { AppData as AppDataClass } from '../app.ts';
import { ApiFailure, storageProblem, writeFailed } from '../errors.ts';
import { tmpName, type HomeLayout } from '../home.ts';
import { KNOWN_OWNERS } from '../db/schema.ts';
import { APP_VERSION } from '../version.ts';
import { ZipReader, ZipRejected, ZipWriter } from './zip.ts';

export const BACKUP_FORMAT = 'jobleft-backup';
export const BACKUP_FORMAT_VERSION = 1;
/** Largest restore upload. The free disk space is checked too. */
export const RESTORE_LIMIT = 4 * 1024 * 1024 * 1024;

export interface Manifest {
  format: string;
  formatVersion: number;
  appVersion: string;
  createdAt: string;
  schema: Record<string, number>;
  counts: Record<string, number>;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** The count per kind, read from a database file (the live one, a snapshot or a restored one). */
export function countsOf(db: DatabaseSync): Record<string, number> {
  const q = (table: string, where = '') => hasTable(db, table) ? Number((db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get() as { n: number }).n) : 0;
  // An older folder may lack the engine's `resumes` table (the engine makes it and adopts the stand-in rows on open).
  const hasResumes = !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'resumes'").get();
  const notAdopted = (cond: string) => { const parts = [cond, hasResumes ? 'id NOT IN (SELECT id FROM resumes)' : ''].filter(Boolean); return parts.length ? `WHERE ${parts.join(' AND ')}` : ''; };
  return {
    profile: q('srv_profile'),
    trackedJobs: q('srv_tracker'),
    likes: q('srv_tracker', 'WHERE liked = 1'),
    statuses: q('srv_tracker', 'WHERE status IS NOT NULL'),
    notes: q('srv_tracker_notes'),
    reminders: q('srv_tracker_reminders'),
    savedFilters: q('srv_saved_filters'),
    // Stand-in rows an older folder still holds count once: the engine adopts them into `resumes` on open.
    resumes: q('resumes') + q('srv_resumes', notAdopted('')),
    resumeFiles: q('resumes', "WHERE file_json IS NOT NULL") + q('srv_resumes', notAdopted('file_path IS NOT NULL')),
    contacts: q('network_contacts'),
    chats: q('srv_chats') + q('ai_chats'),
    chatMessages: q('srv_chat_messages'),
    savedAnswers: q('srv_saved_answers'),
    boards: q('srv_boards'),
    jobs: q('jobs'),
    notifications: q('srv_notifications'),
  };
}

function listFiles(root: string, under: string): string[] {
  const out: string[] = [];
  const dir = join(root, under);
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const rel = `${under}/${name}`;
    const p = join(root, rel);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(root, rel));
    else if (st.isFile() && !name.endsWith('.tmp')) out.push(rel);
  }
  return out;
}

export function freeBytes(path: string): number {
  try { const s = statfsSync(path); return Number(s.bavail) * Number(s.bsize); } catch { return Number.MAX_SAFE_INTEGER; }
}

/** Makes the backup file in tmp/. The caller streams it and removes it. */
export async function createBackup(d: AppData, l: HomeLayout): Promise<{ path: string; fileName: string; size: number }> {
  const work = join(l.tmp, tmpName('backup'));
  mkdirSync(work, { mode: 0o700 });
  const snap = join(work, 'jobleft.db');
  const zipPath = join(l.tmp, `${tmpName('backup')}.zip`);
  try {
    await sqliteBackup(d.db, snap);
    const s = new DatabaseSync(snap);
    let counts: Record<string, number>;
    let schema: Record<string, number> = {};
    try {
      s.exec('PRAGMA secure_delete = ON; PRAGMA temp_store = MEMORY;');
      if (hasTable(s, 'pairings')) s.exec('DELETE FROM pairings');
      if (hasTable(s, 'srv_kv')) stripComputerState(s);
      s.exec('PRAGMA journal_mode = DELETE');
      s.exec('VACUUM');
      counts = countsOf(s);
      for (const r of s.prepare('SELECT owner, max(version) AS v FROM schema_migrations GROUP BY owner').all() as Array<{ owner: string; v: number }>) schema[r.owner] = Number(r.v);
    } finally { s.close(); }
    const files = listFiles(l.home, 'files').filter((f) => !f.startsWith('files/exports/'));
    const createdAt = nowIso();
    const zip = new ZipWriter(zipPath, new Date(createdAt));
    try {
      const manifest: Manifest = { format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, appVersion: APP_VERSION, createdAt, schema, counts, files: [] };
      // The manifest goes last in content but first in meaning; it lists every other file with its checksum.
      const entries: Manifest['files'] = [];
      const db = await zip.addFile('data/jobleft.db', snap, true);
      entries.push({ path: 'data/jobleft.db', ...db });
      for (const f of files) {
        const r = await zip.addFile(f, join(l.home, ...f.split('/')), !/\.(pdf|docx|zip|png|jpe?g)$/i.test(f));
        entries.push({ path: f, ...r });
      }
      manifest.files = entries;
      zip.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)), true);
      zip.finish(true);
    } catch (e) { zip.abort(); throw e; }
    const stamp = createdAt.slice(0, 19).replace(/[:T]/g, '-');
    return { path: zipPath, fileName: `jobleft-backup-${stamp}.zip`, size: statSync(zipPath).size };
  } catch (e) {
    rmSync(zipPath, { force: true });
    const p = storageProblem(e);
    if (p) throw writeFailed(p);
    throw e;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * What belongs to this computer, not to the person's records (JL-settings-14, -15): the publik connection (its
 * install id, claim link and last balance, which let whoever holds them reach that account) and the hints of the AI
 * keys in this computer's secret store. A backup carries neither; a restore keeps this computer's own.
 */
const COMPUTER_KV = { publik: 'ai:ai.publik', engine: 'ai:ai.engine' } as const;

function stripComputerState(db: DatabaseSync): void {
  db.prepare('DELETE FROM srv_kv WHERE key = ?').run(COMPUTER_KV.publik);
  db.prepare("UPDATE srv_kv SET value = json_set(value, '$.keyHints', json('{}')) WHERE key = ? AND json_valid(value)").run(COMPUTER_KV.engine);
}

function reject(message: string): ApiFailure {
  return new ApiFailure('bad_request', /Nothing was changed\.$/.test(message) ? message : `${message} Nothing was changed.`);
}

/** Checks an uploaded backup in full and unpacks it into a staging folder. Changes nothing else. */
async function stage(upload: string, stageDir: string, l: HomeLayout): Promise<Manifest> {
  let z: ZipReader;
  const room = Math.max(0, freeBytes(l.tmp) - 64 * 1024 * 1024);
  try {
    z = await ZipReader.open(upload, { sealed: true, maxUncompressed: Math.min(room, 16 * 1024 * 1024 * 1024) });
  } catch (e) {
    if (e instanceof ZipRejected) throw reject(e.message);
    throw reject('The file is not a jobleft backup.');
  }
  try {
    const me = z.entries.find((e) => e.name === 'manifest.json');
    if (!me) throw reject('The file is not a jobleft backup (it has no manifest).');
    let m: Manifest;
    try { m = JSON.parse((await z.readSmall(me)).toString('utf8')) as Manifest; } catch (e) {
      if (e instanceof ZipRejected) throw reject(e.message);
      throw reject('The backup manifest cannot be read.');
    }
    if (m.format !== BACKUP_FORMAT || typeof m.formatVersion !== 'number') throw reject('The file is not a jobleft backup.');
    if (m.formatVersion > BACKUP_FORMAT_VERSION) throw reject('The backup was made by a newer jobleft. Update jobleft first.');
    for (const [owner, v] of Object.entries(m.schema ?? {})) {
      const known = KNOWN_OWNERS[owner];
      if (known === undefined || v > known) throw reject('The backup was made by a newer jobleft. Update jobleft first.');
    }
    const listed = new Map((m.files ?? []).map((f) => [f.path, f]));
    const names = z.entries.map((e) => e.name).filter((n) => n !== 'manifest.json');
    if (!listed.has('data/jobleft.db')) throw reject('The backup has no database.');
    if (names.length !== listed.size || names.some((n) => !listed.has(n))) throw reject('The backup does not match its own list of files.');
    for (const n of names) {
      if (n !== 'data/jobleft.db' && !n.startsWith('files/')) throw reject('The backup holds a file outside the jobleft data folder layout.');
      if (n.startsWith('files/exports/')) throw reject('The backup holds a file outside the jobleft data folder layout.');
    }
    for (const e of z.entries) {
      if (e.name === 'manifest.json') continue;
      const f = listed.get(e.name)!;
      if (f.bytes !== e.usize) throw reject('The backup does not match its own list of files.');
      const dest = join(stageDir, ...e.name.split('/'));
      if (!dest.startsWith(stageDir + sep)) throw reject('The backup holds a file name that is not allowed.');
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      try { await z.extract(e, dest, f.sha256); } catch (err) {
        if (err instanceof ZipRejected) throw reject(err.message);
        const p = storageProblem(err);
        if (p) throw writeFailed(p);
        throw reject('The backup could not be unpacked.');
      }
    }
    // The database itself must be whole and a jobleft database.
    const dbPath = join(stageDir, 'data', 'jobleft.db');
    let db: DatabaseSync;
    try { db = new DatabaseSync(dbPath); } catch { throw reject('The database in the backup is damaged.'); }
    try {
      const ok = db.prepare('PRAGMA integrity_check').get() as Record<string, string> | undefined;
      if (!ok || Object.values(ok)[0] !== 'ok') throw reject('The database in the backup is damaged.');
      if (!hasTable(db, 'schema_migrations')) throw reject('The file is not a jobleft backup.');
      // A backup brings data, never code: every trigger and view in the copy is dropped. The app makes its own again
      // when it opens the database (the crawler's full-text triggers, the server's search index triggers).
      const objs = db.prepare("SELECT type, name FROM sqlite_schema WHERE type IN ('trigger', 'view')").all() as Array<{ type: string; name: string }>;
      for (const o of objs) db.exec(`DROP ${o.type === 'view' ? 'VIEW' : 'TRIGGER'} IF EXISTS "${o.name.replace(/"/g, '""')}"`);
      if (objs.length) db.exec("DROP TABLE IF EXISTS srv_job_index");
    } catch (e) {
      if (e instanceof ApiFailure) throw e;
      throw reject('The database in the backup is damaged.');
    } finally { db.close(); }
    return m;
  } finally {
    z.close();
  }
}

/** Restores an uploaded backup file (already saved at `upload`). Replaces the current data, or changes nothing. */
export async function restoreBackup(app: App, upload: string): Promise<Record<string, number>> {
  const l = app.cfg.layout;
  const stageDir = join(l.tmp, tmpName('restore'));
  mkdirSync(stageDir, { mode: 0o700 });
  let manifest: Manifest;
  try {
    manifest = await stage(upload, stageDir, l);
  } catch (e) {
    rmSync(stageDir, { recursive: true, force: true });
    throw e;
  }
  const pairingRows = app.data
    ? app.data.db.prepare('SELECT * FROM pairings').all() as Array<Record<string, string | null>>
    : [];
  // This computer's publik connection and AI key hints stay as they are (the keys are in this computer's secret store).
  const ownPublik = app.data ? app.data.kv.get<unknown>(COMPUTER_KV.publik) : null;
  const ownHints = app.data ? app.data.kv.get<{ keyHints?: Record<string, string | null> }>(COMPUTER_KV.engine)?.keyHints ?? {} : {};
  const aside = join(l.tmp, tmpName('pre-restore'));
  const journal = join(l.run, 'restore-journal.json');
  let counts: Record<string, number> = {};
  await app.swap('restore', async () => {
    mkdirSync(aside, { mode: 0o700 });
    writeFileSync(journal, JSON.stringify({ aside: relative(l.home, aside), at: nowIso() }), { mode: 0o600 });
    const moved: Array<'data' | 'files'> = [];
    try {
      for (const part of ['data', 'files'] as const) {
        if (existsSync(join(l.home, part))) { renameSync(join(l.home, part), join(aside, part)); moved.push(part); }
      }
      renameSync(join(stageDir, 'data'), join(l.home, 'data'));
      if (existsSync(join(stageDir, 'files'))) renameSync(join(stageDir, 'files'), join(l.home, 'files'));
      else mkdirSync(join(l.home, 'files'), { mode: 0o700 });
      for (const sub of ['resumes', 'exports']) mkdirSync(join(l.home, 'files', sub), { recursive: true, mode: 0o700 });
      // Open once to prove it works (and upgrade an older backup), put this computer's pairings back, count.
      const probe = new AppDataClass(app.cfg);
      try {
        const ins = probe.db.prepare(`INSERT OR REPLACE INTO pairings (extension_id, token_hash, browser, extension_version, paired_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`);
        for (const r of pairingRows) ins.run(r.extension_id, r.token_hash, r.browser, r.extension_version, r.paired_at, r.last_seen_at);
        // Keys never travel in a backup: the restored AI state says a key is set only for the keys this computer's
        // secret store holds (its own hints), and the publik connection is this computer's own, never the backup's
        // (an older backup may still carry one).
        const aiState = probe.kv.get<Record<string, unknown>>(COMPUTER_KV.engine);
        if (aiState || Object.keys(ownHints).length) probe.kv.set(COMPUTER_KV.engine, { ...(aiState ?? {}), keyHints: ownHints });
        if (ownPublik) probe.kv.set(COMPUTER_KV.publik, ownPublik);
        else probe.kv.delete(COMPUTER_KV.publik);
        counts = countsOf(probe.db);
      } finally { await probe.close(); }
    } catch (e) {
      // Put everything back as it was.
      rmSync(join(l.home, 'data'), { recursive: true, force: true });
      rmSync(join(l.home, 'files'), { recursive: true, force: true });
      for (const part of moved) renameSync(join(aside, part), join(l.home, part));
      for (const part of ['data', 'files'] as const) if (!existsSync(join(l.home, part))) mkdirSync(join(l.home, part), { mode: 0o700 });
      rmSync(journal, { force: true });
      rmSync(aside, { recursive: true, force: true });
      rmSync(stageDir, { recursive: true, force: true });
      if (e instanceof ApiFailure) throw e;
      const p = storageProblem(e);
      if (p) throw writeFailed(p);
      throw reject('The backup could not be opened by this version of jobleft.');
    }
    rmSync(journal, { force: true });
    rmSync(aside, { recursive: true, force: true });
    rmSync(stageDir, { recursive: true, force: true });
  });
  void manifest;
  return counts;
}

/** At start: finishes or undoes a restore that a crash interrupted. */
export function recoverInterruptedRestore(l: HomeLayout): 'none' | 'rolled_back' | 'finished' {
  const journal = join(l.run, 'restore-journal.json');
  if (!existsSync(journal)) return 'none';
  let aside: string | null = null;
  try { aside = join(l.home, JSON.parse(readFileSync(journal, 'utf8')).aside as string); } catch { aside = null; }
  if (aside && existsSync(aside)) {
    const dbOk = existsSync(join(l.home, 'data', 'jobleft.db'));
    if (!dbOk) {
      // The swap stopped half-way: put the old data back.
      for (const part of ['data', 'files'] as const) {
        if (existsSync(join(aside, part))) { rmSync(join(l.home, part), { recursive: true, force: true }); renameSync(join(aside, part), join(l.home, part)); }
      }
      rmSync(aside, { recursive: true, force: true });
      rmSync(journal, { force: true });
      return 'rolled_back';
    }
    rmSync(aside, { recursive: true, force: true });
  }
  rmSync(journal, { force: true });
  return 'finished';
}

// ---------------------------------------------------------------- export (readable files, no keys)

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  // Cells that a spreadsheet would run as a formula get a leading quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function exportAll(d: AppData, l: HomeLayout): Promise<{ path: string; fileName: string; size: number }> {
  const zipPath = join(l.tmp, `${tmpName('export')}.zip`);
  const createdAt = nowIso();
  const zip = new ZipWriter(zipPath, new Date(createdAt));
  try {
    const j = (name: string, v: unknown) => zip.addBuffer(name, Buffer.from(JSON.stringify(v, null, 2) + '\n'));
    zip.addBuffer('README.txt', Buffer.from([
      'jobleft export',
      `Made ${createdAt} by jobleft ${APP_VERSION}.`,
      '',
      'profile.json            your profile, preferences and saved answers for forms',
      'tracker.json            every job you liked, hid, added or applied to, with notes, reminders and status history',
      'saved-jobs.ndjson       the full posting of each job in tracker.json, one per line',
      'saved-filters.json      your saved searches',
      'resumes.json            your resumes; the uploaded files are in files/resumes/',
      'network-contacts.csv    your imported connections, with your stages and notes (also as .json)',
      'chats.json              your saved conversations',
      'boards.json             the job boards you added',
      'settings.json           app settings (crawl schedule, notifications)',
      '',
      'No key, token or password is in this export.',
      '',
    ].join('\n')), false);
    j('profile.json', d.profile.get());
    const views = ['liked', 'applied', 'external', 'hidden', 'closed'] as const;
    const seen = new Map<string, unknown>();
    for (const v of views) for (const it of d.tracker.list(v).items) seen.set(it.entry.jobId, it);
    const tracker = [...seen.values()];
    j('tracker.json', tracker);
    const lines: string[] = [];
    for (const id of seen.keys()) { const job = d.jobs.get(id); if (job) lines.push(JSON.stringify(job)); }
    zip.addBuffer('saved-jobs.ndjson', Buffer.from(lines.join('\n') + (lines.length ? '\n' : '')));
    j('saved-filters.json', d.filters.list());
    const resumes = d.resumes.list();
    j('resumes.json', resumes);
    for (const r of resumes) {
      const f = d.resumes.file(r.id);
      if (f) zip.addBuffer(`files/resumes/${r.id}-${f.fileName.replace(/[^\p{L}\p{N} ._()-]/gu, '_')}`, f.bytes, false);
    }
    const contacts = d.network.list();
    j('network-contacts.json', contacts);
    const cols = ['firstName', 'lastName', 'profileUrl', 'email', 'company', 'position', 'connectedOn', 'stage', 'note', 'followUpOn', 'inPlan'] as const;
    zip.addBuffer('network-contacts.csv', Buffer.from([cols.join(','), ...contacts.map((c) => cols.map((k) => csvCell(c[k])).join(','))].join('\r\n') + '\r\n'));
    j('chats.json', d.chats.list().map((c) => d.chats.get(c.id)).filter(Boolean));
    j('saved-answers.json', d.db.prepare('SELECT label, value, created_at AS createdAt, updated_at AS updatedAt FROM srv_saved_answers ORDER BY label').all());
    j('boards.json', d.boards.list({ limit: 100_000 }).items);
    j('settings.json', d.settings.get());
    zip.finish(false);
  } catch (e) {
    zip.abort();
    rmSync(zipPath, { force: true });
    const p = storageProblem(e);
    if (p) throw writeFailed(p);
    throw e;
  }
  const stamp = createdAt.slice(0, 19).replace(/[:T]/g, '-');
  return { path: zipPath, fileName: `jobleft-export-${stamp}.zip`, size: statSync(zipPath).size };
}

// ---------------------------------------------------------------- delete everything

/**
 * What "Delete my data" keeps (JL-settings-22): the crawled jobs and the boards they come from, which are public
 * postings and no one's personal record. Every other table is emptied, so a table added later is personal until it
 * is named here. Jobs the person added by link or text (ats "external") go with the personal records.
 */
const KEEP_ON_DELETE = new Set([
  'schema_migrations',
  // crawler: postings, the sources that listed them, board health, pacing, robots.txt answers and run history
  'jobs', 'jobs_fts', 'job_sources', 'boards', 'crawler_hosts', 'crawler_meta', 'crawler_robots', 'crawler_runs', 'crawler_run_boards',
  // the boards list and its refresh history; the search index of the jobs
  'srv_boards', 'srv_crawl_runs', 'srv_job_index',
  // the boards lane's tables, when present
  'board_prefs', 'board_checks', 'crawl_runs', 'crawl_board_reports', 'host_pacing', 'robots_cache',
]);
/** srv_kv keys that describe the boards, not the person: which boards the first run added (their origin). */
const KEEP_KV_ON_DELETE = ['core.seededBoards'];

/** Empties every personal table of the database file in place and wipes the freed pages. Throws on any failure. */
function deletePersonalRecords(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON; PRAGMA foreign_keys = OFF;');
    const tables = db.prepare('PRAGMA main.table_list').all() as Array<{ name: string; type: string }>;
    const names = new Set(tables.map((t) => t.name));
    db.exec('BEGIN IMMEDIATE');
    try {
      if (names.has('jobs')) {
        const added = "SELECT id FROM jobs WHERE ats = 'external'";
        db.exec(`UPDATE jobs SET duplicate_of = NULL WHERE duplicate_of IN (${added})`);
        if (names.has('job_sources')) db.exec(`DELETE FROM job_sources WHERE job IN (${added})`);
        db.exec("DELETE FROM jobs WHERE ats = 'external'");
      }
      for (const t of tables) {
        if (t.name.startsWith('sqlite_') || t.type === 'shadow' || t.type === 'view' || KEEP_ON_DELETE.has(t.name)) continue;
        const q = `"${t.name.replace(/"/g, '""')}"`;
        if (t.name === 'srv_kv') {
          db.prepare(`DELETE FROM srv_kv WHERE key NOT IN (${KEEP_KV_ON_DELETE.map(() => '?').join(',')})`).run(...KEEP_KV_ON_DELETE);
          continue;
        }
        if (t.type === 'virtual') {
          // A full-text index without its own content (contentless) is emptied with its delete-all command.
          try { db.exec(`DELETE FROM ${q}`); } catch { db.exec(`INSERT INTO ${q}(${q}) VALUES ('delete-all')`); }
          continue;
        }
        db.exec(`DELETE FROM ${q}`);
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ended */ }
      throw e;
    }
    // secure_delete zeroes the freed pages; VACUUM rewrites the file, and the checkpoint leaves no copy in the -wal.
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
}

export async function deleteAllData(app: App): Promise<void> {
  const l = app.cfg.layout;
  const names: string[] = [];
  if (app.data) await app.data.ai.forgetKeys();
  await app.swap('delete', async () => {
    // Personal records go; the crawled jobs and boards stay (the screen says "Crawled jobs stay"). When the file
    // cannot be cleaned in place, the whole data folder goes, as before: nothing personal may stay behind.
    let kept = false;
    if (existsSync(l.db)) {
      try { deletePersonalRecords(l.db); kept = true; } catch (e) {
        app.cfg.log.warn('delete.in_place_failed', { error: e instanceof Error ? e.name : 'error' });
      }
    }
    if (kept) {
      for (const name of readdirSync(l.data)) if (join(l.data, name) !== l.db) rmSync(join(l.data, name), { recursive: true, force: true });
    } else rmSync(l.data, { recursive: true, force: true });
    for (const part of [l.files, l.backups]) rmSync(part, { recursive: true, force: true });
    for (const name of readdirSync(l.tmp)) rmSync(join(l.tmp, name), { recursive: true, force: true });
    for (const name of readdirSync(l.logs)) rmSync(join(l.logs, name), { recursive: true, force: true });
    for (const d of [l.data, l.files, l.resumes, l.exports, l.backups]) mkdirSync(d, { recursive: true, mode: 0o700 });
    for (const n of [...names, SECRET_NAMES.publikKey, ...app.cfg.secrets.knownNames()]) {
      try { await app.cfg.secrets.delete(n); } catch { /* not there */ }
    }
  });
}

export function sha256File(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
