// Reading profiles, postings and company facts from files for the CLI and the preview server. Profiles may be a full
// contract Profile or a shorter hand-written one; missing lists become empty and missing answers stay null
// ("not in your profile"), never a guessed value.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { Company, H1bSummary, Job, Profile } from '@jobleft/contracts';
import { ProfileSchema, validate } from '@jobleft/contracts';
import { loadPlaceIndex } from '@jobleft/static-data';
import { jobFromHtml, jobFromText, looseJob, type LooseJob } from './loose.ts';
import { distanceFromPlaceIndex } from './geo.ts';
import { profileVersionOf } from './profile.ts';

const FIXED_TIME = '2026-01-01T00:00:00.000Z';
const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12' };

/** "2020-01-15" -> "2020-01"; "Jan 2020" -> "2020-01"; "2020" stays; "present" -> null. */
export function yearMonth(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || /^(present|current|now|today|ongoing)$/i.test(s)) return null;
  let m = /^(\d{4})-(\d{2})(-\d{2})?/.exec(s);
  if (m) return `${m[1]}-${m[2]}`;
  m = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
  m = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return `${m[2]}-${mo}`;
  }
  if (/^\d{4}$/.test(s)) return s;
  throw new Error('a date in the profile is not a date (use YYYY-MM, YYYY, "Jan 2020" or "present")');
}

const isPresent = (v: unknown) => typeof v === 'string' && /^(present|current|now|today|ongoing)$/i.test(v.trim());

type Obj = Record<string, unknown>;
const arrOf = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const strOr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const yn = (v: unknown): 'yes' | 'no' | null => {
  if (v === true || v === 'yes' || v === 'Yes' || v === 'YES') return 'yes';
  if (v === false || v === 'no' || v === 'No' || v === 'NO') return 'no';
  return null;
};

/** A contract Profile from a full or a hand-written profile object. Throws with the issue paths when invalid. */
export function normalizeProfile(raw: unknown): Profile {
  const r = ((raw as Obj)?.profile ?? raw) as Obj;
  if (!r || typeof r !== 'object') throw new Error('the profile file must hold a JSON object');
  const personal = (r.personal ?? {}) as Obj;
  const prefs = (r.preferences ?? {}) as Obj;
  const auth = (r.workAuthorization ?? {}) as Obj;
  const eeo = (r.eeo ?? {}) as Obj;
  const p: Profile = {
    id: strOr(r.id) ?? 'default',
    personal: {
      firstName: strOr(personal.firstName), middleName: strOr(personal.middleName), lastName: strOr(personal.lastName),
      email: strOr(personal.email), phone: strOr(personal.phone), addressLine: strOr(personal.addressLine),
      city: strOr(personal.city), region: strOr(personal.region), postalCode: strOr(personal.postalCode),
      country: strOr(personal.country), links: arrOf(personal.links),
    },
    summary: strOr(r.summary),
    education: arrOf<Obj>(r.education).map((e, i) => ({
      id: strOr(e.id) ?? `edu${i + 1}`, school: String(e.school ?? ''), degree: strOr(e.degree), major: strOr(e.major), gpa: strOr(e.gpa),
      startDate: yearMonth(e.startDate), endDate: yearMonth(e.endDate), current: e.current === true || isPresent(e.endDate),
      achievements: arrOf(e.achievements), coursework: arrOf(e.coursework),
    })),
    work: arrOf<Obj>(r.work).map((w, i) => ({
      id: strOr(w.id) ?? `w${i + 1}`, company: String(w.company ?? ''), title: String(w.title ?? ''),
      employmentType: (strOr(w.employmentType) as Profile['work'][number]['employmentType']) ?? null, location: strOr(w.location),
      startDate: yearMonth(w.startDate), endDate: yearMonth(w.endDate), current: w.current === true || isPresent(w.endDate),
      summary: strOr(w.summary), bullets: arrOf<string>(w.bullets).map(String),
    })),
    projects: arrOf<Obj>(r.projects).map((x, i) => ({
      id: strOr(x.id) ?? `p${i + 1}`, name: String(x.name ?? ''), description: strOr(x.description), url: strOr(x.url),
      startDate: yearMonth(x.startDate), endDate: yearMonth(x.endDate), bullets: arrOf<string>(x.bullets).map(String),
    })),
    certifications: arrOf<unknown>(r.certifications).map((c) => (typeof c === 'string' ? { name: c, issuer: null, date: null } : {
      name: String((c as Obj).name ?? ''), issuer: strOr((c as Obj).issuer), date: yearMonth((c as Obj).date),
    })),
    skills: arrOf<unknown>(r.skills).map((s) => (typeof s === 'string' ? { name: s, years: null, source: 'user' as const } : {
      name: String((s as Obj).name ?? ''), years: typeof (s as Obj).years === 'number' ? (s as Obj).years as number : null,
      source: (s as Obj).source === 'resume' ? 'resume' as const : 'user' as const,
    })),
    preferences: {
      jobFunctions: arrOf(prefs.jobFunctions), targetTitles: arrOf(prefs.targetTitles), employmentTypes: arrOf(prefs.employmentTypes),
      workModels: arrOf(prefs.workModels), levels: arrOf(prefs.levels), countries: arrOf(prefs.countries),
      places: arrOf<unknown>(prefs.places).map((x) => (typeof x === 'string' ? { text: x, placeId: null, radiusMiles: null } : {
        text: String((x as Obj).text ?? ''), placeId: strOr((x as Obj).placeId), radiusMiles: typeof (x as Obj).radiusMiles === 'number' ? (x as Obj).radiusMiles as number : null,
      })),
      minAnnualPayUsd: typeof prefs.minAnnualPayUsd === 'number' ? prefs.minAnnualPayUsd : null,
      industries: arrOf(prefs.industries), companyStages: arrOf(prefs.companyStages), roleTypes: arrOf(prefs.roleTypes),
      excludedCompanies: arrOf(prefs.excludedCompanies),
    },
    workAuthorization: {
      usAuthorized: yn(auth.usAuthorized), needsSponsorship: yn(auth.needsSponsorship), usCitizen: yn(auth.usCitizen),
      hasSecurityClearance: yn(auth.hasSecurityClearance), authorizedCountries: arrOf(auth.authorizedCountries),
    },
    eeo: {
      disability: (strOr(eeo.disability) as Profile['eeo']['disability']) ?? null, veteran: (strOr(eeo.veteran) as Profile['eeo']['veteran']) ?? null,
      gender: strOr(eeo.gender), lgbtq: (strOr(eeo.lgbtq) as Profile['eeo']['lgbtq']) ?? null, race: strOr(eeo.race),
      hispanicOrLatino: (strOr(eeo.hispanicOrLatino) as Profile['eeo']['hispanicOrLatino']) ?? null, sexualOrientation: arrOf(eeo.sexualOrientation),
      pronouns: strOr(eeo.pronouns),
    },
    version: '',
    updatedAt: strOr(r.updatedAt) ?? FIXED_TIME,
  };
  const declined = arrOf<string>(r.declinedSkills).map(String).filter((x) => x.trim());
  if (declined.length) (p as Profile & { declinedSkills?: string[] }).declinedSkills = declined;
  p.version = profileVersionOf(p);
  const v = validate(ProfileSchema, p);
  if (!v.ok) throw new Error(`the profile does not match the contract: ${v.issues.slice(0, 5).map((i) => `${i.path || '(root)'} ${i.message}`).join('; ')}`);
  return p;
}

export function readProfile(path: string): Profile {
  return normalizeProfile(JSON.parse(readFileSync(path, 'utf8')));
}

const JOB_EXT = new Set(['.json', '.ndjson', '.txt', '.md', '.html', '.htm']);

/** Every posting in the files or folders given, in file-name order. */
export function readJobs(paths: string[]): Job[] {
  const files: string[] = [];
  for (const p of paths) {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const f of readdirSync(p).sort()) if (JOB_EXT.has(extname(f).toLowerCase()) && !f.startsWith('.')) files.push(join(p, f));
    } else files.push(p);
  }
  const out: Job[] = [];
  for (const f of files) out.push(...readJobFile(f));
  return out;
}

export function readJobFile(file: string): Job[] {
  const ext = extname(file).toLowerCase();
  // The id is the file name with its extension, so "a.txt" and "a.html" are two jobs.
  const name = basename(file);
  const text = readFileSync(file, 'utf8');
  if (ext === '.txt' || ext === '.md') return [jobFromText(text, `file:${name}`)];
  if (ext === '.html' || ext === '.htm') return [jobFromHtml(text, `file:${name}`)];
  if (ext === '.ndjson') return text.split('\n').filter((l) => l.trim()).map((l, i) => withId(looseJob(JSON.parse(l)), JSON.parse(l), `file:${name}#${i + 1}`));
  const data = JSON.parse(text) as unknown;
  const list = Array.isArray(data) ? data : Array.isArray((data as Obj)?.jobs) ? (data as Obj).jobs as unknown[] : [data];
  return list.map((j, i) => withId(looseJob(j as LooseJob), j as Obj, list.length === 1 ? `file:${name}` : `file:${name}#${i + 1}`));
}

function withId(job: Job, raw: Obj, fallback: string): Job {
  return raw && typeof raw.id === 'string' && raw.id ? job : { ...job, id: fallback };
}

/** Company facts for the H-1B chip and the industry: a map by name, or a list. Hand-written facts are marked as such. */
export function readCompanies(path: string | undefined): (job: Job) => Company | null {
  if (!path) return () => null;
  const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const list: Obj[] = Array.isArray(data) ? data as Obj[] : Object.entries(data as Obj).map(([k, v]) => ({ name: k, ...(v as Obj) }));
  const byKey = new Map<string, Company>();
  for (const c of list) {
    const company = normalizeCompany(c);
    byKey.set(norm(company.name), company);
    byKey.set(company.key, company);
    for (const a of company.aliases) byKey.set(norm(a), company);
  }
  return (job) => byKey.get(job.companyKey) ?? byKey.get(norm(job.company)) ?? null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

function normalizeCompany(c: Obj): Company {
  const name = String(c.name ?? c.key ?? 'Company');
  const source = { name: 'fixture file', url: null, retrievedAt: FIXED_TIME };
  let h1b: H1bSummary | null = null;
  if (c.h1b && typeof c.h1b === 'object') h1b = c.h1b as H1bSummary;
  else if (c.h1b === 'likely' || c.h1b === 'some_history') {
    h1b = {
      status: c.h1b, certifiedFilings: typeof c.h1bFilings === 'number' ? c.h1bFilings : 0, window: { from: '2024-10-01', to: '2026-09-30' }, byYear: [],
      similarRoleShare: null, roleFamily: null, filerEntities: [name], dataThrough: '2026-06-30', source: 'fixture file (test data)',
      note: 'Past filings do not guarantee sponsorship for this role.',
    };
  }
  const facts: Company['facts'] = {};
  if (Array.isArray(c.industries)) facts.industries = { value: c.industries.map(String), source };
  if (typeof c.stage === 'string') facts.stage = { value: c.stage as 'early' | 'growth' | 'late' | 'public', source };
  if (Array.isArray(c.investors)) facts.investors = { value: c.investors.map(String), source };
  if (c.facts && typeof c.facts === 'object') Object.assign(facts, c.facts);
  return {
    key: String(c.key ?? norm(name)), name, aliases: arrOf<string>(c.aliases), facts, h1b,
    isStaffingAgency: typeof c.isStaffingAgency === 'boolean' ? c.isStaffingAgency : null, factsFreshUntil: null, updatedAt: FIXED_TIME,
  };
}

/**
 * Distances between places from the shipped place dictionary of @jobleft/static-data, when that lane has built it.
 * Until then (its loader says "not implemented yet") there are no distances: two different cities in one state are
 * "distance not checked", never a broken location preference.
 */
export function tryDistance(dataDir: string): ((a: import('@jobleft/contracts').Place, b: import('@jobleft/contracts').PlaceQuery) => number | null) | undefined {
  try {
    return distanceFromPlaceIndex(loadPlaceIndex({ dataDir }));
  } catch {
    return undefined;
  }
}
