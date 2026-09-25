// The resume CLI's own small stores, all inside the data folder ($JOBLEFT_HOME):
//   data/jobleft.db               the shared SQLite file (only the resume lane's tables are touched)
//   files/resumes/profile.json    the profile (a stand-in for the store lane's profile table until the server wires it)
//   files/resumes/jobs.json       jobs added with "job add" (a stand-in for the store's jobs table)
//   files/resumes/ai.json         which AI provider to use (never a key: keys come from an environment variable)
// Folders are created 0700 and files 0600. Nothing is written outside the data folder.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AiProviderKind, Job, Place, Profile, ProfileInput } from '@jobleft/contracts';
import { nowIso, ProfileInputSchema, validate } from '@jobleft/contracts';
import { emptyProfileInput } from '../import/index.ts';

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JOBLEFT_HOME) return env.JOBLEFT_HOME;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'jobleft');
  if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'jobleft');
  return join(homedir(), '.local', 'share', 'jobleft');
}

export interface Paths { home: string; db: string; files: string; profile: string; jobs: string; ai: string }

export function paths(home: string): Paths {
  const files = join(home, 'files', 'resumes');
  return { home, db: join(home, 'data', 'jobleft.db'), files, profile: join(files, 'profile.json'), jobs: join(files, 'jobs.json'), ai: join(files, 'ai.json') };
}

export function ensureHome(p: Paths): void {
  for (const d of [p.home, join(p.home, 'data'), join(p.home, 'files'), p.files]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}

function writePrivate(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path); // atomic: a crash never leaves half a file
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

/** Opens the database like @jobleft/store's openDatabase (page size, WAL, NORMAL sync, foreign keys). */
export function openDb(path: string): DatabaseSync {
  const fresh = !existsSync(path);
  const db = new DatabaseSync(path);
  if (fresh) db.exec('PRAGMA page_size = 16384');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return db;
}

// ------------------------------------------------------------------------------------------------ profile

function profileVersion(input: ProfileInput): string {
  const { preferences: _p, eeo: _e, workAuthorization: _w, ...facts } = input;
  void _p; void _e; void _w;
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16);
}

export function readProfile(p: Paths): Profile {
  if (!existsSync(p.profile)) return { id: 'default', ...emptyProfileInput(), version: 'empty', updatedAt: '1970-01-01T00:00:00.000Z' };
  return JSON.parse(readFileSync(p.profile, 'utf8')) as Profile;
}

export function hasProfile(p: Paths): boolean {
  return existsSync(p.profile);
}

/** Validates and saves the editable profile; the store sets version and time (like PUT /api/v1/profile). */
export function writeProfile(p: Paths, input: ProfileInput): Profile {
  const v = validate(ProfileInputSchema, input);
  if (!v.ok) throw new Error(`The profile does not match its contract: ${v.issues.slice(0, 3).map((i) => `${i.path || '/'} ${i.message}`).join('; ')}`);
  const { id: _i, version: _v, updatedAt: _u, ...clean } = input as ProfileInput & { id?: string; version?: string; updatedAt?: string };
  void _i; void _v; void _u;
  const profile: Profile = { id: 'default', ...(clean as ProfileInput), version: profileVersion(clean as ProfileInput), updatedAt: nowIso() };
  writePrivate(p.profile, JSON.stringify(profile, null, 2) + '\n');
  return profile;
}

// ------------------------------------------------------------------------------------------------ jobs

export function readJobs(p: Paths): Job[] {
  if (!existsSync(p.jobs)) return [];
  return JSON.parse(readFileSync(p.jobs, 'utf8')) as Job[];
}

export function saveJob(p: Paths, job: Job): void {
  const jobs = readJobs(p).filter((j) => j.id !== job.id);
  jobs.push(job);
  writePrivate(p.jobs, JSON.stringify(jobs, null, 2) + '\n');
}

export function htmlToPlain(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function placeOf(text: string): Place {
  const m = /^\s*([^,]+),\s*([A-Za-z .]+)\s*$/.exec(text);
  return { text, city: m ? m[1]!.trim() : text.trim(), region: m ? m[2]!.trim() : null, country: m && /^[A-Z]{2}$/.test(m[2]!.trim()) ? 'US' : null, placeId: null };
}

/** A contract Job from pasted text (an "external" job). Facts the text does not state stay unknown. */
export function jobFromText(input: { title: string; company: string; text: string; city?: string | null; url?: string | null }): Job {
  const hash = createHash('sha256').update(`${input.title}\n${input.company}\n${input.text}`).digest('hex');
  const id = `ext:${hash.slice(0, 16)}`;
  const url = input.url && /^https?:\/\//i.test(input.url) ? input.url : `https://jobs.example.invalid/pasted/${hash.slice(0, 16)}`;
  const now = nowIso();
  const years = /(\d{1,2})\s*\+?\s*(?:or more\s+)?years?/i.exec(input.text);
  const clearance = /\b(?:security clearance|TS\/SCI|top secret|secret clearance)\b/i.test(input.text) ? true : null;
  return {
    id, status: 'open', closedAt: null, closedReason: null, title: input.title, company: input.company,
    companyKey: input.company.toLowerCase().replace(/[^a-z0-9]+/g, ''), ats: null, board: null, externalId: null,
    url, applyUrl: null, canonicalUrl: url, places: input.city ? [placeOf(input.city)] : [], isUs: null, workModel: null, remoteScope: null,
    employmentType: null, level: null, levels: [], yearsRequired: years ? { min: Number(years[1]), max: null } : null, pay: null, postedAt: null,
    firstSeenAt: now, lastSeenAt: now, updatedAt: now, department: null,
    statements: { sponsorship: null, clearanceRequired: clearance, usCitizenOnly: null }, skills: [], evidence: {},
    sources: [{ sourceId: 'external:text', name: 'Added by you', url, credit: null, firstSeenAt: now, lastSeenAt: now }],
    duplicateOf: null, contentHash: hash, description: input.text,
  };
}

// ------------------------------------------------------------------------------------------------ AI settings

export interface CliAiSettings {
  provider: AiProviderKind | 'none';
  baseUrl: string | null;
  model: string | null;
  /** Name of the environment variable that holds the key (the key itself is never stored). */
  keyEnv: string | null;
  timeoutSeconds: number;
}

export function readAi(p: Paths): CliAiSettings {
  if (!existsSync(p.ai)) return { provider: 'none', baseUrl: null, model: null, keyEnv: null, timeoutSeconds: 120 };
  return JSON.parse(readFileSync(p.ai, 'utf8')) as CliAiSettings;
}

export function writeAi(p: Paths, s: CliAiSettings): void {
  writePrivate(p.ai, JSON.stringify(s, null, 2) + '\n');
}
