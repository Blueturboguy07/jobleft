// A small in-memory stand-in for the records of the lanes that are not wired into one server yet (store, match, resume,
// network, static-data). It answers the SAME documented local API routes with contract-valid bodies, so the assistant is
// the same code whether it talks to this, to a running apps/server (HTTP), or to the real stores in the app process.
// It is deliberately simple and deterministic; the real scoring lives in @jobleft/match. It can be seeded from a JSON file
// (see README "Load your own test data") and it saves itself to a file, so a second process sees an approved change.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  LocalApiError, TRACKER_STATUSES, bandFor, nowIso, type ApiError, type CallInput, type Job, type JobSummary, type LocalApiClient,
  type MatchResult, type NetworkContact, type Profile, type Resume, type RouteName, type TrackerEntry,
} from '@jobleft/contracts';
import { demoData, type SeedCompany, type SeedContact, type SeedData, type SeedJob, type SeedTracker } from './persona.ts';

const NOW = () => nowIso();

function err(status: number, code: string, message: string): LocalApiError {
  return new LocalApiError(status, { error: { code, message } } as ApiError);
}

export function toJob(s: SeedJob): Job {
  const t = NOW();
  const pay = s.pay ? (() => {
    const mult = { hour: 2080, day: 260, week: 52, month: 12, year: 1 }[s.pay.period];
    return { min: s.pay.min, max: s.pay.max, currency: s.pay.currency ?? 'USD', period: s.pay.period, source: 'board_field' as const, ranges: 1, annualMin: s.pay.min === null ? null : Math.round(s.pay.min * mult), annualMax: s.pay.max === null ? null : Math.round(s.pay.max * mult) };
  })() : null;
  const url = s.url ?? `https://jobs.example.com/${s.id.replace(/[^a-z0-9]+/gi, '/')}`;
  const [ats, board, ext] = s.id.split(':');
  const levels = s.level ? [(s.level === 'intern' ? 'intern_new_grad' : s.level === 'entry' ? 'entry' : s.level === 'mid' ? 'mid' : s.level === 'senior' ? 'senior' : ['staff', 'principal', 'lead', 'manager'].includes(s.level) ? 'lead_staff' : 'director_exec') as Job['levels'][number]] : [];
  return {
    id: s.id, status: s.status ?? 'open', closedAt: s.closedAt ?? null, closedReason: s.status === 'closed' ? 'unseen' : null,
    title: s.title, company: s.company, companyKey: s.companyKey ?? s.company.toLowerCase().replace(/[^a-z0-9]+/g, ''),
    ats: (['greenhouse', 'lever', 'ashby'].includes(ats ?? '') ? ats : null) as Job['ats'], board: board ?? null, externalId: ext ?? null,
    url, applyUrl: s.applyUrl ?? null, canonicalUrl: url,
    places: (s.places ?? []).map((p) => ({ text: p, city: null, region: null, country: null, placeId: null })),
    isUs: null, workModel: s.workModel ?? null, remoteScope: null, employmentType: s.employmentType ?? null, level: s.level ?? null, levels,
    yearsRequired: s.yearsMin != null ? { min: s.yearsMin, max: null } : null, pay,
    postedAt: s.postedAt ?? null, firstSeenAt: t, lastSeenAt: t, updatedAt: t, department: s.department ?? null,
    statements: { sponsorship: s.sponsorship ?? null, clearanceRequired: null, usCitizenOnly: null },
    skills: s.skills ?? [], evidence: {},
    sources: [{ sourceId: 'stand-in', name: 'Stand-in jobs', url, credit: null, firstSeenAt: t, lastSeenAt: t }],
    duplicateOf: null, contentHash: createHash('sha256').update(s.id + s.title + s.description).digest('hex'),
    description: s.description,
  };
}

function summary(j: Job): JobSummary {
  const { description, ...rest } = j;
  return { ...rest, snippet: description.replace(/\s+/g, ' ').slice(0, 300) };
}

const LEVEL_RANK: Record<string, number> = { intern: 0, entry: 1, mid: 2, senior: 3, staff: 4, principal: 4, lead: 4, manager: 4, director: 5, vp: 6, exec: 6 };

function skillSet(p: Profile): Set<string> {
  const s = new Set(p.skills.map((x) => x.name.toLowerCase()));
  for (const w of p.work) for (const b of [w.summary ?? '', ...w.bullets]) for (const sk of ['sql', 'excel', 'python', 'tableau', 'typescript']) if (b.toLowerCase().includes(sk)) s.add(sk);
  return s;
}

function score(p: Profile, j: Job): MatchResult {
  const have = skillSet(p);
  const declined = new Set((p.declinedSkills ?? []).map((x) => x.toLowerCase()));
  const req = [...new Set(j.skills)];
  const matched = req.filter((s) => have.has(s.toLowerCase()) && !declined.has(s.toLowerCase()));
  const missing = req.filter((s) => !matched.includes(s));
  const skillsPct = req.length ? Math.round((matched.length / req.length) * 100) : null;
  const myLevel = p.preferences.levels.map((l) => ({ intern_new_grad: 0, entry: 1, mid: 2, senior: 3, lead_staff: 4, director_exec: 5 })[l] ?? 2);
  const jl = j.level ? LEVEL_RANK[j.level] ?? 2 : null;
  const lvlPct = jl === null || !myLevel.length ? null : Math.max(0, 100 - 30 * Math.min(...myLevel.map((m) => Math.abs(m - jl))));
  const parts = [skillsPct, lvlPct].filter((x): x is number => x !== null);
  const percent = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : 50;
  return {
    jobId: j.id, profileVersion: 'stand-in', engineVersion: 'stand-in-1', percent, band: bandFor(percent),
    subScores: {
      experienceLevel: { percent: lvlPct, reasons: lvlPct === null ? [{ code: 'level_unknown', text: 'The posting states no level.', points: 0 }] : [] },
      skills: { percent: skillsPct, reasons: [] },
      industryExperience: { percent: null, reasons: [{ code: 'industry_unknown', text: 'The posting states no industry.', points: 0 }] },
    },
    whyFit: matched.length ? [{ kind: 'skills', label: `${matched.length} of ${req.length} skills`, positive: true }] : [],
    blockers: [], reasons: matched.map((s) => ({ code: 'skill_matched', text: `Your profile shows ${s}.`, points: 5 })).concat(missing.map((s) => ({ code: 'skill_missing', text: `The posting asks for ${s}. Your profile does not show it.`, points: -5 }))),
    skills: { matched, missing, required: req, preferred: [] }, experienceYearsUsed: null, computedAt: NOW(), complete: false, unknownParts: ['industryExperience'], notes: ['Stand-in score: skills overlap and level only.'],
  };
}

export interface WorldSnapshot { profile: Record<string, unknown> | null; jobs: SeedJob[]; tracker: SeedTracker[]; resumes: SeedData['resumes']; contacts: SeedContact[]; companies: SeedCompany[] }

export class World {
  profileInput: Record<string, unknown> | null;
  jobs = new Map<string, Job>();
  tracker = new Map<string, TrackerEntry>();
  resumes: Resume[] = [];
  contacts: NetworkContact[] = [];
  companies = new Map<string, SeedCompany>();
  covers: Array<{ id: string; jobId: string; resumeId: string; text: string }> = [];
  private file: string | null;
  private idn = 0;

  constructor(seed: SeedData | null, file: string | null = null) {
    this.file = file;
    const s = seed ?? demoData();
    this.profileInput = s.profile;
    this.load(s);
  }

  static open(file: string, seed: SeedData | null = null, reset = false): World {
    if (!reset && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { seed: SeedData; tracker: TrackerEntry[]; jobs: Job[]; resumes: Resume[]; contacts: NetworkContact[]; profile: Record<string, unknown> | null; companies: SeedCompany[] };
        const w = new World({ profile: raw.profile ?? {}, jobs: [], tracker: [], resumes: [], contacts: [], companies: raw.companies ?? [] }, file);
        w.profileInput = raw.profile;
        for (const j of raw.jobs) w.jobs.set(j.id, j);
        for (const t of raw.tracker) w.tracker.set(t.jobId, t);
        w.resumes = raw.resumes; w.contacts = raw.contacts;
        return w;
      } catch { /* a broken file: start again from the seed */ }
    }
    const w = new World(seed, file);
    w.save();
    return w;
  }

  private load(s: SeedData): void {
    this.jobs.clear(); this.tracker.clear(); this.companies.clear();
    for (const j of s.jobs) this.jobs.set(j.id, toJob(j));
    for (const c of s.companies) this.companies.set(c.key, c);
    const t = NOW();
    for (const tr of s.tracker) this.tracker.set(tr.jobId, this.entryFrom(tr, t));
    this.resumes = s.resumes.map((r) => this.resumeFrom(r));
    this.contacts = s.contacts.map((c) => this.contactFrom(c));
  }

  private entryFrom(tr: SeedTracker, t: string): TrackerEntry {
    return {
      jobId: tr.jobId, liked: tr.liked ?? false, hidden: tr.hidden ?? false, external: tr.external ?? false, status: tr.status ?? null,
      statusHistory: tr.status ? [{ status: tr.status, at: tr.appliedAt ?? t }] : [], appliedAt: tr.appliedAt ?? null, resumeId: null,
      notes: (tr.notes ?? []).map((n) => ({ id: `n${++this.idn}`, text: n, createdAt: t, updatedAt: t })),
      reminders: (tr.reminders ?? []).map((r) => ({ id: `r${++this.idn}`, at: r.at, text: r.text, done: r.done ?? false })),
      createdAt: t, updatedAt: t,
    };
  }

  private resumeFrom(r: SeedData['resumes'][number]): Resume {
    const t = NOW();
    return {
      id: r.id, name: r.name, targetTitle: r.targetTitle ?? null, isPrimary: r.isPrimary ?? false, kind: r.kind ?? 'base', baseResumeId: r.baseResumeId ?? null, jobId: r.jobId ?? null,
      version: 1, file: null, document: { header: { name: 'Jordan Testwell', email: null, phone: null, city: null, links: [] }, sections: [] }, importReport: null, atsReport: null, createdAt: t, updatedAt: t,
    };
  }

  private contactFrom(c: SeedContact): NetworkContact {
    const t = NOW();
    return {
      id: c.id, firstName: c.firstName, lastName: c.lastName, profileUrl: null, email: c.email, company: c.company, companyKey: c.company.toLowerCase().replace(/[^a-z0-9]+/g, ''),
      position: c.position, connectedOn: c.connectedOn ?? null, maybeGarbled: false, stage: (c.stage ?? 'to_contact') as NetworkContact['stage'], note: null, followUpOn: null, inPlan: false,
      importedAt: t, updatedAt: t, inLatestFile: true, followUpDue: false,
    };
  }

  /** Replaces everything (POST /dev/seed). Missing parts stay as they are in the demo set only when `merge` is true. */
  replace(seed: Partial<SeedData>): void {
    this.profileInput = seed.profile ?? null;
    this.load({ profile: seed.profile ?? {}, jobs: seed.jobs ?? [], tracker: seed.tracker ?? [], resumes: seed.resumes ?? [], contacts: seed.contacts ?? [], companies: seed.companies ?? [] });
    this.save();
  }

  /** Adds jobs and tracker rows without removing anything. */
  add(seed: Partial<SeedData>): void {
    const t = NOW();
    for (const j of seed.jobs ?? []) this.jobs.set(j.id, toJob(j));
    for (const tr of seed.tracker ?? []) this.tracker.set(tr.jobId, this.entryFrom(tr, t));
    for (const c of seed.companies ?? []) this.companies.set(c.key, c);
    for (const c of seed.contacts ?? []) this.contacts.push(this.contactFrom(c));
    this.save();
  }

  save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ profile: this.profileInput, jobs: [...this.jobs.values()], tracker: [...this.tracker.values()], resumes: this.resumes, contacts: this.contacts, companies: [...this.companies.values()] }, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Everything the person owns, as one readable snapshot (what "export" shows in this stand-in). */
  snapshot(): Record<string, unknown> {
    return { profile: this.profile(), jobs: [...this.jobs.values()], tracker: [...this.tracker.values()], resumes: this.resumes, contacts: this.contacts, companies: [...this.companies.values()] };
  }

  profile(): Profile | null {
    if (!this.profileInput || !Object.keys(this.profileInput).length) return null;
    return { id: 'default', ...(this.profileInput as object), version: 'stand-in', updatedAt: NOW() } as Profile;
  }

  private visible(j: Job): boolean {
    const t = this.tracker.get(j.id);
    return j.status === 'open' && !(t?.hidden);
  }

  // ------------------------------------------------------------------ the routes

  async call(name: RouteName, input: CallInput<RouteName> = {}): Promise<never> {
    const out = this.route(name, input as { params?: Record<string, string>; query?: Record<string, string | undefined>; body?: any });
    return JSON.parse(JSON.stringify(out)) as never;
  }

  private detail(j: Job) {
    const p = this.profile();
    const co = this.companies.get(j.companyKey);
    const contacts = this.contacts.filter((c) => c.companyKey === j.companyKey).length;
    return {
      job: j,
      company: co ? this.company(co) : null,
      match: p ? score(p, j) : null,
      tracker: this.tracker.get(j.id) ?? null,
      networkCount: contacts || null,
      h1bTag: (j.statements.sponsorship === 'yes' ? 'post_says_yes' : j.statements.sponsorship === 'no' ? 'post_says_no' : co?.h1bFilings ? 'likely_by_history' : null) as 'post_says_yes' | 'post_says_no' | 'likely_by_history' | null,
    };
  }

  private company(co: SeedCompany) {
    const src = { name: 'Stand-in company facts', url: null, retrievedAt: NOW() };
    const facts: Record<string, unknown> = {};
    if (co.website) facts.website = { value: co.website, source: src };
    if (co.description) facts.description = { value: co.description, source: src };
    if (co.headquarters) facts.headquarters = { value: co.headquarters, source: src };
    if (co.founded) facts.founded = { value: co.founded, source: src };
    if (co.size) facts.size = { value: co.size, source: src };
    return {
      key: co.key, name: co.name, aliases: [], facts,
      h1b: co.h1bFilings ? { status: 'likely', certifiedFilings: co.h1bFilings, window: { from: '2024-10-01', to: '2026-06-30' }, byYear: [], similarRoleShare: null, roleFamily: null, filerEntities: [co.name], dataThrough: '2026-06-30', source: 'US Department of Labor, LCA disclosure data', note: 'Past filings do not guarantee that this company will sponsor a visa for this role.' } : null,
      isStaffingAgency: null, factsFreshUntil: null, updatedAt: NOW(),
    };
  }

  private route(name: RouteName, input: { params?: Record<string, string>; query?: Record<string, string | undefined>; body?: any }): unknown {
    const params = input.params ?? {}; const query = input.query ?? {}; const body = input.body ?? {};
    switch (name) {
      case 'health': return { app: 'jobleft', version: 'stand-in', apiVersion: 1, extensionProtocol: 1 };
      case 'getProfile': { const p = this.profile(); if (!p) throw err(404, 'not_found', 'There is no profile yet.'); return p; }
      case 'putProfile': this.profileInput = body; this.save(); return this.profile();
      case 'getJob': {
        const j = this.jobs.get(params.jobId ?? '');
        if (!j) throw err(404, 'not_found', 'That job was not found.');
        return this.detail(j);
      }
      case 'getMatch': {
        const j = this.jobs.get(params.jobId ?? '');
        if (!j) throw err(404, 'not_found', 'That job was not found.');
        const p = this.profile();
        if (!p) throw err(409, 'needs_profile', 'The match score needs your profile.');
        return score(p, j);
      }
      case 'searchJobs': case 'listJobs': {
        const b = name === 'listJobs' ? { q: query.q, sort: query.sort, limit: query.limit ? Number(query.limit) : 25, filter: {} } : body;
        const words = String(b.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const f = b.filter ?? {};
        const p = this.profile();
        let list = [...this.jobs.values()].filter((j) => (f.status === 'closed' ? j.status === 'closed' : this.visible(j)));
        if (words.length) list = list.filter((j) => { const hay = `${j.title} ${j.company} ${j.skills.join(' ')} ${j.description}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
        if (f.workModels?.length) list = list.filter((j) => j.workModel && f.workModels.includes(j.workModel));
        if (f.minAnnualPayUsd) list = list.filter((j) => j.pay?.annualMin != null && j.pay.annualMin >= f.minAnnualPayUsd);
        if (f.companies?.length) list = list.filter((j) => f.companies.includes(j.companyKey));
        const withMatch = list.map((j) => ({ j, m: p ? score(p, j) : null }));
        const sort = b.sort ?? 'recommended';
        withMatch.sort((a, c) => sort === 'most_recent' ? Date.parse(c.j.postedAt ?? '') - Date.parse(a.j.postedAt ?? '') : (c.m?.percent ?? 0) - (a.m?.percent ?? 0));
        const limit = Math.min(b.limit ?? 20, 100);
        return {
          items: withMatch.slice(0, limit).map(({ j, m }) => ({ job: summary(j), match: m ? { percent: m.percent, band: m.band, whyFit: m.whyFit.slice(0, 2) } : null, liked: this.tracker.get(j.id)?.liked ?? false, hidden: false, trackerStatus: this.tracker.get(j.id)?.status ?? null, networkCount: null, h1bTag: null, fitScore: null })),
          total: withMatch.length, nextCursor: null, fit: { state: p ? 'ready' : 'needs_profile', waiting: 0, model: 'stand-in' }, tookMs: 1,
        };
      }
      case 'listTracker': {
        const view = query.view ?? 'liked';
        const all = [...this.tracker.values()].filter((t) => this.jobs.has(t.jobId));
        const pick = all.filter((t) => {
          const j = this.jobs.get(t.jobId)!;
          if (view === 'liked') return t.liked && !t.hidden && j.status === 'open';
          if (view === 'applied') return t.status !== null && (!query.status || t.status === query.status);
          if (view === 'external') return t.external;
          if (view === 'hidden') return t.hidden;
          if (view === 'closed') return j.status === 'closed' && (t.liked || t.status !== null);
          return false;
        });
        const by = Object.fromEntries(TRACKER_STATUSES.map((s) => [s, all.filter((t) => t.status === s).length]));
        return {
          items: pick.map((t) => ({ entry: t, job: summary(this.jobs.get(t.jobId)!) })),
          counts: { liked: all.filter((t) => t.liked && !t.hidden).length, applied: all.filter((t) => t.status !== null).length, external: all.filter((t) => t.external).length, hidden: all.filter((t) => t.hidden).length, closed: all.filter((t) => this.jobs.get(t.jobId)!.status === 'closed').length, byStatus: by },
        };
      }
      case 'updateTracker': {
        const id = params.jobId ?? '';
        if (!this.jobs.has(id)) throw err(404, 'not_found', 'That job was not found.');
        const t = this.tracker.get(id) ?? this.entryFrom({ jobId: id }, NOW());
        const now = NOW();
        if (body.liked !== undefined) t.liked = !!body.liked;
        if (body.hidden !== undefined) t.hidden = !!body.hidden;
        if (body.status !== undefined && body.status !== t.status) {
          t.status = body.status; t.statusHistory.push({ status: body.status, at: now });
          if (body.status && !t.appliedAt) t.appliedAt = now;
        }
        if (body.resumeId !== undefined) t.resumeId = body.resumeId;
        if (Array.isArray(body.notes)) t.notes = body.notes.map((n: { id?: string; text: string }) => { const old = t.notes.find((x) => x.id === n.id); return { id: n.id ?? `n${++this.idn}`, text: n.text, createdAt: old?.createdAt ?? now, updatedAt: now }; });
        if (Array.isArray(body.reminders)) t.reminders = body.reminders.map((r: { id?: string; at: string; text: string; done?: boolean }) => ({ id: r.id ?? `r${++this.idn}`, at: r.at, text: r.text, done: r.done ?? false }));
        t.updatedAt = now;
        this.tracker.set(id, t);
        this.save();
        return t;
      }
      case 'listResumes': return this.resumes;
      case 'deleteResume': {
        const r = this.resumes.find((x) => x.id === params.resumeId);
        if (!r) throw err(404, 'not_found', 'That resume was not found.');
        const versions = this.resumes.filter((x) => x.baseResumeId === r.id);
        if (versions.length && query.withVersions !== 'true') throw err(409, 'conflict', 'This resume has tailored versions. Delete them too, or keep the resume.');
        this.resumes = this.resumes.filter((x) => x.id !== r.id && x.baseResumeId !== r.id);
        this.save();
        return { deleted: 1 + versions.length };
      }
      case 'tailorResume': {
        const r = this.resumes.find((x) => x.id === params.resumeId); const j = this.jobs.get(body.jobId); const p = this.profile();
        if (!r || !j) throw err(404, 'not_found', 'That resume or job was not found.');
        const m = p ? score(p, j) : null;
        return { id: `tp${++this.idn}`, resumeId: r.id, jobId: j.id, changes: [], gaps: m?.skills.missing ?? [], violations: [], provider: 'stand-in', createdAt: NOW(), costMicros: null, notice: 'Stand-in tailoring: it shows the gaps only and changes nothing.', refused: [] };
      }
      case 'createCoverLetter': {
        const j = this.jobs.get(body.jobId); const r = this.resumes.find((x) => x.id === body.resumeId); const p = this.profile();
        if (!j || !r) throw err(404, 'not_found', 'That job or resume was not found.');
        const skills = p ? p.skills.map((s) => s.name).slice(0, 4).join(', ') : '';
        const text = `Dear hiring team at ${j.company},\n\nI am applying for the ${j.title} role.${skills ? ` My work so far used ${skills}.` : ''}\n\nThank you for your time.\n`;
        const id = `cl${++this.idn}`;
        this.covers.push({ id, jobId: j.id, resumeId: r.id, text });
        return { id, jobId: j.id, resumeId: r.id, text, violations: [], ready: true, createdAt: NOW(), updatedAt: NOW(), gaps: [], notice: null, provider: 'none', costMicros: null };
      }
      case 'getCompany': {
        const co = this.companies.get(params.companyKey ?? '');
        if (!co) throw err(404, 'not_found', 'No facts are stored for that company.');
        return this.company(co);
      }
      case 'h1bLookup': {
        const q = String(query.company ?? '').toLowerCase();
        const co = [...this.companies.values()].find((c) => c.name.toLowerCase() === q || c.key === q.replace(/[^a-z0-9]+/g, ''));
        if (!co?.h1bFilings) return { input: query.company ?? '', companyKey: null, status: 'unknown', summary: null };
        return { input: query.company, companyKey: co.key, status: 'found', summary: this.company(co).h1b };
      }
      case 'listContacts': {
        const q = String(query.q ?? '').toLowerCase();
        let list = this.contacts;
        if (query.companyKey) list = list.filter((c) => c.companyKey === query.companyKey);
        if (q) list = list.filter((c) => `${c.firstName} ${c.lastName} ${c.company ?? ''}`.toLowerCase().includes(q));
        return list.slice(0, Number(query.limit ?? 50));
      }
      case 'updateContact': {
        const c = this.contacts.find((x) => x.id === params.contactId);
        if (!c) throw err(404, 'not_found', 'That contact was not found.');
        if (body.stage) c.stage = body.stage;
        c.updatedAt = NOW();
        this.save();
        return c;
      }
      case 'addExternalJob': {
        const text = String(body.text ?? '');
        if (!text.trim()) throw err(400, 'bad_request', 'Give the pasted posting text.');
        const id = `ext:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
        const first = text.split('\n').find((l) => l.trim())?.trim() ?? 'External job';
        const job = toJob({ id, title: first.slice(0, 80), company: 'External', description: text, workModel: null, skills: [] });
        this.jobs.set(id, job);
        const tr = this.tracker.get(id) ?? this.entryFrom({ jobId: id, external: true }, NOW());
        this.tracker.set(id, tr);
        this.save();
        return { job, tracker: tr };
      }
      default: throw err(404, 'not_found', `The stand-in does not serve ${name}.`);
    }
  }

  asApi(): Pick<LocalApiClient, 'call'> { return { call: (n, i) => this.call(n as RouteName, i as never) as never }; }
}

