// Stand-ins for what other lanes own, used ONLY by this package's CLI and dev server until apps/server wires the real
// ones: a small job list with likes (the store lane's jobs and tracker), a profile (the store lane's profile), and the
// AI provider choice (the ai-engine lane's settings). Kept in $JOBLEFT_HOME/network-dev/standin.json (mode 0600).
// It holds job titles, company names, the made-up persona and an AI address. It never holds a connection's data.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Job, Profile } from '@jobleft/contracts';
import type { CompanyKeyFn } from '../company.ts';
import type { BridgeConfig, WalletSeen } from './ai-bridge.ts';

export interface StandInJob {
  id: string;
  title: string;
  company: string;
  department: string | null;
  liked: boolean;
  addedAt: string;
}

export interface StandInProfile {
  firstName: string;
  lastName: string;
  email: string;
  currentTitle: string | null;
  currentCompany: string | null;
  school: string | null;
  degree: string | null;
  targetTitles: string[];
  skills: string[];
}

interface State {
  version: 1;
  jobs: StandInJob[];
  profile: StandInProfile;
  ai: BridgeConfig;
  wallet: WalletSeen;
}

/** The made-up persona of every test ("Jordan Testwell"). */
export const DEFAULT_PROFILE: StandInProfile = {
  firstName: 'Jordan', lastName: 'Testwell', email: 'jordan.testwell@example.com',
  currentTitle: 'Software Engineer', currentCompany: 'Northwind Sample Labs',
  school: 'Sample State University', degree: 'B.S. Computer Science',
  targetTitles: ['Backend Engineer'], skills: ['TypeScript', 'PostgreSQL', 'Go'],
};

function emptyState(): State {
  return {
    version: 1, jobs: [], profile: { ...DEFAULT_PROFILE },
    ai: { provider: null, baseUrl: null, model: null },
    wallet: { balanceMicros: null, lastChargeMicros: null, at: null },
  };
}

export class StandIn {
  private readonly file: string;
  private state: State;
  private readonly keyFn: CompanyKeyFn;
  private cache: Map<string, Job> = new Map();

  constructor(home: string, keyFn: CompanyKeyFn) {
    const dir = join(home, 'network-dev');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'standin.json');
    this.keyFn = keyFn;
    this.state = emptyState();
    if (existsSync(this.file)) {
      try {
        const s = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<State>;
        this.state = { ...emptyState(), ...s, profile: { ...DEFAULT_PROFILE, ...(s.profile ?? {}) } } as State;
      } catch {
        this.state = emptyState();
      }
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* best effort */ }
    this.cache.clear();
  }

  // ---------------------------------------------------------------- jobs

  jobs(): StandInJob[] { return this.state.jobs; }

  addJob(input: { title: string; company: string; department?: string | null; liked?: boolean }, nowIso: string): StandInJob {
    const title = input.title.trim();
    const company = input.company.trim();
    if (!title || !company) throw new Error('A job needs a title and a company.');
    const base = createHash('sha256').update(`${company}\u0000${title}\u0000${this.state.jobs.length}`).digest('hex').slice(0, 10);
    const job: StandInJob = { id: `standin:jobs:${base}`, title, company, department: input.department?.trim() || null, liked: !!input.liked, addedAt: nowIso };
    this.state.jobs.push(job);
    this.save();
    return job;
  }

  addJobs(list: Array<{ title: string; company: string; department?: string | null; liked?: boolean }>, nowIso: string): number {
    let n = 0;
    for (const input of list) {
      const title = String(input.title ?? '').trim();
      const company = String(input.company ?? '').trim();
      if (!title || !company) continue;
      const base = createHash('sha256').update(`${company}\u0000${title}\u0000${this.state.jobs.length}`).digest('hex').slice(0, 10);
      this.state.jobs.push({ id: `standin:jobs:${base}`, title, company, department: input.department ? String(input.department) : null, liked: !!input.liked, addedAt: nowIso });
      n++;
    }
    this.save();
    return n;
  }

  like(id: string, liked: boolean): StandInJob | null {
    const j = this.state.jobs.find((x) => x.id === id);
    if (!j) return null;
    j.liked = liked;
    this.save();
    return j;
  }

  removeJob(id: string): boolean {
    const before = this.state.jobs.length;
    this.state.jobs = this.state.jobs.filter((x) => x.id !== id);
    if (this.state.jobs.length === before) return false;
    this.save();
    return true;
  }

  clearJobs(): number {
    const n = this.state.jobs.length;
    this.state.jobs = [];
    this.save();
    return n;
  }

  /** A job by id, by the last part of its id, or by its title when exactly one job has that title. */
  findJob(ref: string): StandInJob | null {
    const byId = this.state.jobs.find((x) => x.id === ref) ?? this.state.jobs.find((x) => x.id.endsWith(`:${ref}`));
    if (byId) return byId;
    const byTitle = this.state.jobs.filter((x) => x.title.toLowerCase() === ref.trim().toLowerCase());
    return byTitle.length === 1 ? byTitle[0]! : null;
  }

  companyKeyOf(j: StandInJob): string {
    try { return this.keyFn(j.company); } catch { return ''; }
  }

  /** A stand-in job as a contract Job (the facts the Network tool reads: title, company, company key, department). */
  asJob(id: string): Job | null {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const j = this.findJob(id);
    if (!j) return null;
    const t = j.addedAt;
    const url = `https://jobs.example.com/${encodeURIComponent(j.id.split(':').pop()!)}`;
    const job: Job = {
      id: j.id, status: 'open', closedAt: null, closedReason: null, title: j.title, company: j.company,
      companyKey: this.companyKeyOf(j), ats: null, board: null, externalId: null, url, applyUrl: null, canonicalUrl: url,
      places: [], isUs: null, workModel: null, remoteScope: null, employmentType: null, level: null, levels: [],
      yearsRequired: null, pay: null, postedAt: null, firstSeenAt: t, lastSeenAt: t, updatedAt: t, department: j.department,
      statements: { sponsorship: null, clearanceRequired: null, usCitizenOnly: null }, skills: [], evidence: {},
      sources: [{ sourceId: 'external:text', name: 'Stand-in job (network dev tool)', url, credit: null, firstSeenAt: t, lastSeenAt: t }],
      duplicateOf: null, contentHash: createHash('sha256').update(`${j.title}|${j.company}|${j.department ?? ''}`).digest('hex'),
      description: '',
    };
    this.cache.set(id, job);
    return job;
  }

  /** Target companies: the companies of liked stand-in jobs. */
  targets(): Array<{ companyKey: string; companyName: string }> {
    return this.state.jobs.filter((j) => j.liked).map((j) => ({ companyKey: this.companyKeyOf(j), companyName: j.company }));
  }

  // ---------------------------------------------------------------- profile

  profile(): StandInProfile { return this.state.profile; }

  setProfile(patch: Partial<StandInProfile>): StandInProfile {
    const p = { ...this.state.profile };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      (p as Record<string, unknown>)[k] = v;
    }
    this.state.profile = p;
    this.save();
    return p;
  }

  /** The stand-in profile as a contract Profile, so drafts use the same profileSummary() the app uses. */
  asProfile(nowIso: string): Profile {
    const p = this.state.profile;
    return {
      id: 'default',
      personal: { firstName: p.firstName || null, middleName: null, lastName: p.lastName || null, email: p.email || null, phone: null, addressLine: null, city: null, region: null, postalCode: null, country: null, links: [] },
      summary: null,
      education: p.school ? [{ id: 'edu1', school: p.school, degree: p.degree, major: null, gpa: null, startDate: null, endDate: null, current: false, achievements: [], coursework: [] }] : [],
      work: p.currentTitle && p.currentCompany ? [{ id: 'w1', company: p.currentCompany, title: p.currentTitle, employmentType: null, location: null, startDate: null, endDate: null, current: true, summary: null, bullets: [] }] : [],
      projects: [], certifications: [],
      skills: p.skills.map((name) => ({ name, years: null, source: 'user' as const })),
      preferences: { jobFunctions: [], targetTitles: p.targetTitles, employmentTypes: [], workModels: [], levels: [], countries: [], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
      workAuthorization: { usAuthorized: null, needsSponsorship: null, usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
      eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
      version: 'standin', updatedAt: nowIso,
    } as unknown as Profile;
  }

  // ---------------------------------------------------------------- AI choice

  ai(): BridgeConfig { return this.state.ai; }

  setAi(cfg: BridgeConfig): BridgeConfig {
    this.state.ai = cfg;
    this.state.wallet = { balanceMicros: null, lastChargeMicros: null, at: null };
    this.save();
    return cfg;
  }

  wallet(): WalletSeen { return this.state.wallet; }

  setWallet(w: WalletSeen): void {
    this.state.wallet = w;
    this.save();
  }
}
