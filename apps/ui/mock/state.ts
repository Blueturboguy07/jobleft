// The mock's data folder and in-memory state. Every change is written to disk (atomic rename + fsync) BEFORE the
// API answers, so "saved" on screen is true, a force-quit loses nothing that was acknowledged, and a failed write
// is reported and rolled back (the change is not kept in memory either).

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AiSettings, AppSettings, ChatThread, OnboardingState, Company, CoverLetter, CrawlBoardReport, CrawlRunSummary, Job, NetworkContact, Notification,
  PairingInfo, PracticeItem, PracticeSession, Profile, Resume, SavedFilter, TailorProposal, TrackerEntry,
} from '@jobleft/contracts';
import type { BoardFile, CompanyFixture } from './fixtures.ts';
import { functionOf } from './fixtures.ts';
import { boardsOrigin } from './jobs.ts';
import { readJson, writeJsonAtomic } from './util.ts';

export class SaveError extends Error {
  constructor(what: string) {
    super(`jobleft could not save ${what}: the data folder cannot be written right now. Nothing was changed, and your text is still on screen.`);
    this.name = 'SaveError';
  }
}

export interface PublikLocal {
  state: 'disconnected' | 'connected';
  /** The stand-in key. Only the loopback publik stand-in accepts it. The real app keeps keys in the OS secret store. */
  key: string | null;
  disclosureVersion: number | null;
}

export interface BoardStatus {
  state: 'not_checked' | 'live' | 'failing' | 'unreachable' | 'cooldown' | 'blocked';
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  openJobs: number | null;
  lastError: string | null;
}

export interface Persisted {
  tracker: Record<string, TrackerEntry>;
  filters: SavedFilter[];
  profile: Profile | null;
  resumes: Resume[];
  coverLetters: CoverLetter[];
  proposals: TailorProposal[];
  chats: ChatThread[];
  contacts: NetworkContact[];
  settings: AppSettings;
  ai: AiSettings;
  publik: PublikLocal;
  notifications: Notification[];
  practiceSessions: PracticeSession[];
  practiceItems: PracticeItem[];
  pairings: PairingInfo[];
  boardPrefs: Record<string, { followed: boolean; hidden: boolean; disabled: boolean }>;
  boardStatus: Record<string, BoardStatus>;
  sources: Record<string, { enabled: boolean }>;
  crawlRuns: CrawlRunSummary[];
  lastReport: CrawlBoardReport[];
  externalJobs: Job[];
  onboarding: OnboardingState | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  crawl: { intervalHours: 6, catchUpOnLaunch: true, runInTray: true },
  notifications: { reminders: true, alerts: true },
};

export function defaultAi(): AiSettings {
  return {
    provider: null, localKind: null, vendor: null, baseUrl: null, model: null, keySet: false, keyHint: null,
    meteredFetch: { enabled: false, pricesPer1000Micros: { search: 5_000_000, page: 2_000_000, jsPage: 4_000_000 } },
    updatedAt: null,
    costEstimates: null,
  };
}

function defaults(): Persisted {
  return {
    tracker: {}, filters: [], profile: null, resumes: [], coverLetters: [], proposals: [], chats: [], contacts: [],
    settings: DEFAULT_SETTINGS, ai: defaultAi(), publik: { state: 'disconnected', key: null, disclosureVersion: null },
    notifications: [], practiceSessions: [], practiceItems: [], pairings: [], boardPrefs: {}, boardStatus: {}, sources: {},
    crawlRuns: [], lastReport: [], externalJobs: [], onboarding: null,
  };
}

export interface JobRec {
  job: Job;
  fn: string | null;
  hay: string;
  boardId: string | null;
  /** Posted time in ms, or null. */
  postedMs: number | null;
}

export function haystack(job: Job): string {
  return `${job.title}\n${job.company}\n${job.places.map((p) => p.text).join(' ')}\n${job.skills.join(' ')}\n${job.department ?? ''}\n${'description' in job ? job.description : ''}`.toLowerCase();
}

export class MockState {
  readonly home: string;
  readonly dirs: { state: string; boards: string; files: string; run: string };
  data: Persisted;
  jobs = new Map<string, JobRec>();
  companies = new Map<string, Company>();
  /** Keys never written to disk (own provider keys). */
  secrets = new Map<string, string>();
  /** Simulated offline switch (ctl offline on). Real offline is also detected (no network interface). */
  offlineSwitch = false;

  constructor(home: string) {
    this.home = home;
    this.dirs = { state: join(home, 'state'), boards: join(home, 'boards'), files: join(home, 'files'), run: join(home, 'run') };
    for (const d of Object.values(this.dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
    const d = defaults();
    const loaded = {} as Record<string, unknown>;
    for (const k of Object.keys(d) as Array<keyof Persisted>) loaded[k] = readJson(join(this.dirs.state, `${k}.json`), d[k]);
    this.data = loaded as unknown as Persisted;
    if (!('costEstimates' in this.data.ai)) this.data.ai.costEstimates = null;
    this.loadJobs();
    this.loadCompanies();
  }

  // ---------------------------------------------------------------- persistence

  /** Runs `fn` on a copy of one collection, writes it to disk, and only then keeps it. */
  mutate<K extends keyof Persisted>(key: K, what: string, fn: (draft: Persisted[K]) => void): Persisted[K] {
    const draft = structuredClone(this.data[key]);
    fn(draft);
    try {
      writeJsonAtomic(join(this.dirs.state, `${key}.json`), draft);
    } catch {
      throw new SaveError(what);
    }
    this.data[key] = draft;
    return draft;
  }

  set<K extends keyof Persisted>(key: K, what: string, value: Persisted[K]): Persisted[K] {
    try {
      writeJsonAtomic(join(this.dirs.state, `${key}.json`), value);
    } catch {
      throw new SaveError(what);
    }
    this.data[key] = value;
    return value;
  }

  private jobsFile(): string {
    return join(this.dirs.state, 'jobs.ndjson');
  }

  loadJobs(): void {
    this.jobs.clear();
    const f = this.jobsFile();
    if (existsSync(f)) {
      const text = readFileSync(f, 'utf8');
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line) as { job: Job; boardId: string | null };
          this.putJob(rec.job, rec.boardId);
        } catch { /* a torn last line after a crash is skipped */ }
      }
    }
    for (const j of this.data.externalJobs) this.putJob(j, null);
  }

  putJob(job: Job, boardId: string | null): JobRec {
    const rec: JobRec = { job, fn: functionOf(job.title), hay: haystack(job), boardId, postedMs: job.postedAt ? Date.parse(job.postedAt) : null };
    this.jobs.set(job.id, rec);
    return rec;
  }

  /** Writes every crawled job (one NDJSON line each). Temp file + rename, so a crash keeps the previous file. */
  saveJobs(): void {
    const lines: string[] = [];
    for (const r of this.jobs.values()) if (r.boardId !== null) lines.push(JSON.stringify({ job: r.job, boardId: r.boardId }));
    const f = this.jobsFile();
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
    renameSync(tmp, f);
  }

  // ---------------------------------------------------------------- boards and companies

  boardFiles(): BoardFile[] {
    const out: BoardFile[] = [];
    if (!existsSync(this.dirs.boards)) return out;
    for (const name of readdirSync(this.dirs.boards).sort()) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.dirs.boards, name), 'utf8')) as BoardFile);
      } catch { /* a broken board file is reported by the crawl */ }
    }
    return out;
  }

  loadCompanies(): void {
    this.companies.clear();
    const list = readJson<CompanyFixture[]>(join(this.home, 'companies.json'), []);
    for (const c of list) this.companies.set(c.key, companyFromFixture(c, this.home));
  }

  companyFor(job: Job): Company | null {
    return this.companies.get(job.companyKey) ?? null;
  }

  networkCount(companyKey: string): number | null {
    let n = 0;
    for (const c of this.data.contacts) if (c.companyKey === companyKey) n++;
    return n > 0 ? n : null;
  }
}

const RETRIEVED = '2026-09-20T12:00:00.000Z';

/** A fixture company -> the contract Company, every fact with its source and date. */
export function companyFromFixture(c: CompanyFixture, _home: string): Company {
  const registry = { name: 'Stand-in company registry (mock data)', url: `${boardsOrigin()}/registry/${c.key}`, retrievedAt: RETRIEVED };
  const ai = { name: 'AI summary written by the chosen AI provider (mock data)', url: null, retrievedAt: RETRIEVED };
  const facts: Company['facts'] = {};
  if (c.description) facts.description = { value: c.description, source: c.aiWritten ? ai : registry };
  if (c.founded !== null) facts.founded = { value: c.founded, source: registry };
  if (c.headquarters) facts.headquarters = { value: c.headquarters, source: registry };
  if (c.size) facts.size = { value: c.size, source: registry };
  if (c.industries.length) facts.industries = { value: c.industries, source: registry };
  if (c.stage) facts.stage = { value: c.stage, source: c.aiWritten ? ai : registry };
  if (c.totalFundingUsd !== null) facts.totalFundingUsd = { value: c.totalFundingUsd, source: c.aiWritten ? ai : registry };
  if (c.investors) facts.investors = { value: c.investors, source: c.aiWritten ? ai : registry };
  if (c.leaders) facts.leaders = { value: c.leaders, source: registry };
  if (c.news) facts.news = { value: c.news.map((n) => ({ title: n.title, url: `${boardsOrigin()}/news/${c.key}`, publishedAt: n.publishedAt, outlet: n.outlet })), source: registry };
  return {
    key: c.key, name: c.name, aliases: [], facts, h1b: c.h1b, isStaffingAgency: c.isStaffingAgency,
    factsFreshUntil: '2026-10-20T12:00:00.000Z', updatedAt: RETRIEVED,
  };
}
