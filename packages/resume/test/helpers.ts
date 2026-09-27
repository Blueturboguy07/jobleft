// Shared test helpers: the persona "Jordan Testwell" as a profile, jobs from the fixture postings, a temp data folder.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Job, Profile } from '@jobleft/contracts';
import { jobFromText } from '../src/cli/store.ts';
import { JORDAN } from './fixtures/src/persona.ts';
import { tmpdir } from 'node:os';
// Scratch folders: /private/tmp on macOS (short paths, no symlink games), the system temp folder elsewhere (Windows).
const TMP = process.platform === 'darwin' ? '/private/tmp' : tmpdir();

export const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const read = (name: string) => new Uint8Array(readFileSync(join(FIX, name)));

// A fixed clock: work-year sums and "current" dates do not move while the tests run.
process.env.JOBLEFT_NOW ??= '2026-09-25T12:00:00Z';

export function jordanProfile(): Profile {
  const J = JORDAN;
  const [first, last] = J.name.split(' ') as [string, string];
  return {
    id: 'default',
    personal: { firstName: first, middleName: null, lastName: last, email: J.email, phone: J.phone, addressLine: null, city: 'Austin', region: 'TX', postalCode: null, country: 'US', links: J.links.map((u, i) => ({ label: i === 0 ? 'Website' : 'GitHub', url: u })) },
    summary: J.summary,
    education: J.education.map((e, i) => ({ id: `e${i}`, school: e.school, degree: e.degree, major: e.major, gpa: e.gpa, startDate: e.startYm, endDate: e.endYm, current: false, achievements: [], coursework: [] })),
    work: J.jobs.map((w, i) => ({ id: `w${i}`, company: w.company, title: w.title, employmentType: null, location: w.location, startDate: w.startYm, endDate: w.endYm, current: w.current, summary: null, bullets: [...w.bullets] })),
    projects: J.projects.map((p, i) => ({ id: `p${i}`, name: p.name, description: p.description, url: null, startDate: null, endDate: null, bullets: [...p.bullets] })),
    certifications: [],
    skills: J.skills.map((s) => ({ name: s, years: null, source: 'resume' as const })),
    preferences: { jobFunctions: [], targetTitles: [], employmentTypes: [], workModels: [], levels: [], countries: [], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
    workAuthorization: { usAuthorized: null, needsSponsorship: null, usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
    eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
    extraSections: [],
    version: 'test',
    updatedAt: '2026-09-25T12:00:00.000Z',
  };
}

export function fixtureJob(file: string, title: string, company: string, city: string | null = null): Job {
  return jobFromText({ title, company, text: readFileSync(join(FIX, 'jobs', file), 'utf8'), city });
}

export const J_FIT = () => fixtureJob('j-fit.txt', 'Backend Engineer', 'Globex Sample Co', 'Austin, TX');
export const J_GAP = () => fixtureJob('j-gap.txt', 'Senior Platform Engineer', 'Acme Health, Inc.', 'Seattle, WA');
export const J_INJECT = () => fixtureJob('j-inject.txt', 'Senior Platform Engineer', 'Acme Health, Inc.', 'Seattle, WA');

export function tempDir(prefix: string): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(TMP, `${prefix}-`));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
