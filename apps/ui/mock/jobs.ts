// Maps a stand-in board posting to the contract Job. Facts come only from the posting (board fields and text);
// anything the posting does not state stays null. Each derived fact keeps its evidence.

import {
  experienceLevelOf, type ExperienceLevel, type FactEvidence, type Job, type JobSummary, type Level, type Pay, type PayPeriod, type Place,
} from '@jobleft/contracts';
import { CITIES, resolveCity } from './cities.ts';
import { SKILLS, type BoardFile, type RawPay, type RawPosting } from './fixtures.ts';
import { PORTS, companyKey, sha256 } from './util.ts';

const ANNUAL: Record<PayPeriod, number> = { hour: 2080, day: 260, week: 52, month: 12, year: 1 };

export function boardsOrigin(): string {
  return `http://127.0.0.1:${PORTS.boards}`;
}

export function postingUrl(board: string, externalId: string): string {
  return `${boardsOrigin()}/${encodeURIComponent(board)}/jobs/${encodeURIComponent(externalId)}`;
}

function levelFromTitle(title: string): { level: Level; text: string } | null {
  const t = title.toLowerCase();
  const rules: Array<[RegExp, Level]> = [
    [/\bchief\b|\bceo\b|\bcoo\b/, 'exec'], [/\bvp\b|vice president/, 'vp'], [/\bdirector\b/, 'director'],
    [/\bprincipal\b/, 'principal'], [/\bstaff\b/, 'staff'], [/\bmanager\b|\bcontroller\b/, 'manager'], [/\blead\b|\bcharge nurse\b/, 'lead'],
    [/\bsenior\b|\bsr\.?\b/, 'senior'], [/\bintern\b/, 'intern'], [/\bnew grad\b|\bassociate\b|\bjunior\b|\bcoordinator\b/, 'entry'],
  ];
  for (const [re, level] of rules) {
    const m = re.exec(t);
    if (m) return { level, text: title };
  }
  return null;
}

function yearsFromText(text: string): { min: number | null; max: number | null; quote: string } | null {
  const range = /(\d{1,2})\s*(?:to|-|–)\s*(\d{1,2})\s+years?\s+of\s+[a-z ]*experience/i.exec(text);
  if (range) return { min: Number(range[1]), max: Number(range[2]), quote: range[0] };
  const plus = /(\d{1,2})\+\s+years?\s+of\s+[a-z ]*experience/i.exec(text);
  if (plus) return { min: Number(plus[1]), max: null, quote: plus[0] };
  return null;
}

const CURRENCY_SYMBOLS: Array<[string, string]> = [['CA$', 'CAD'], ['£', 'GBP'], ['€', 'EUR'], ['$', 'USD']];

function payFromText(text: string): { pay: RawPay; quote: string } | null {
  const line = /The pay for this role is ([^.\n]*?)(?: in our main office|\.)/.exec(text);
  if (!line) return null;
  const body = line[1]!;
  const periodWord = /per (hour|day|week|month|year)/.exec(body);
  if (!periodWord) return null;
  let currency = 'USD';
  for (const [sym, code] of CURRENCY_SYMBOLS) if (body.includes(sym)) { currency = code; break; }
  const nums = [...body.matchAll(/(?:CA\$|£|€|\$)([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1]!.replace(/,/g, '')));
  if (nums.length === 0) return null;
  const period = periodWord[1] as PayPeriod;
  const ranges = /a second range applies/.test(text) ? 2 : 1;
  let min: number | null = null, max: number | null = null;
  if (/^up to/i.test(body)) max = nums[0]!;
  else if (/^from/i.test(body)) min = nums[0]!;
  else if (nums.length >= 2) { min = nums[0]!; max = nums[1]!; }
  else { min = nums[0]!; max = nums[0]!; }
  return { pay: { min, max, currency, period, ranges }, quote: line[0].slice(0, 300) };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SKILL_RES = SKILLS.map((s) => ({ name: s, re: new RegExp(`(?<![A-Za-z0-9.])${escapeRe(s)}(?![A-Za-z0-9+#])`) }));

export function skillsIn(text: string): string[] {
  const found: Array<{ name: string; at: number }> = [];
  for (const { name, re } of SKILL_RES) {
    const m = re.exec(text);
    if (m) found.push({ name, at: m.index });
  }
  return found.sort((a, b) => a.at - b.at).map((x) => x.name);
}

function placesFrom(locations: string[]): Place[] {
  const out: Place[] = [];
  for (const text of locations) {
    if (/^remote/i.test(text)) {
      out.push({ text, city: null, region: null, country: /\bUS\b|United States/i.test(text) ? 'US' : null, placeId: null });
      continue;
    }
    const hits = resolveCity(text);
    const c = hits.length === 1 ? hits[0]! : null;
    if (c) out.push({ text, city: c.city, region: c.region, country: c.country as Place['country'], placeId: c.id, lat: c.lat, lon: c.lon });
    else out.push({ text, city: null, region: null, country: null, placeId: null });
  }
  return out;
}

function remoteScopeFrom(text: string): { regions: string[]; text: string } | null {
  const m = /(Remote \(US only\)|Remote - United States|Remote, anywhere in North America|Remote \(open to EU time zones\)|remote \(US only\)|remote - United States|remote, anywhere in North America|remote \(open to EU time zones\))/.exec(text);
  if (!m) return null;
  const t = m[1]!;
  const regions = /North America/i.test(t) ? ['NA'] : /EU/.test(t) ? ['EU'] : ['US'];
  return { regions, text: t.charAt(0).toUpperCase() + t.slice(1) };
}

export interface MappedJob {
  job: Job;
  /** The job-function family (the mock's stand-in for the store's mapping), for the job function filter. */
  fn: string | null;
}

/** Posting -> contract Job. `seen` carries firstSeenAt from an earlier crawl, so a re-crawl keeps it. */
export function toJob(board: BoardFile, p: RawPosting, seen: { firstSeenAt: string; lastSeenAt: string; fn: string | null }): Job {
  const evidence: Job['evidence'] = {};
  const text = p.description;
  const id = `${board.ats}:${board.board}:${p.externalId}`.toLowerCase();
  const url = postingUrl(board.board, p.externalId);

  // places
  const places = placesFrom(p.locations);
  if (places.length) evidence.places = { source: 'board_field', text: p.locations.join('; ').slice(0, 500) };

  // work model
  let workModel: Job['workModel'] = p.workplace;
  if (workModel) evidence.workModel = { source: 'board_field', text: `workplace: ${workModel}` };
  else if (p.locations.some((l) => /^remote/i.test(l))) {
    workModel = 'remote';
    evidence.workModel = { source: 'location_text', text: p.locations.find((l) => /^remote/i.test(l))! };
  }
  const scope = workModel === 'remote' ? remoteScopeFrom(text) ?? remoteScopeFrom(p.locations.join(' ')) : null;
  if (scope) evidence.remoteScope = { source: 'description', text: scope.text };

  // employment type
  if (p.employmentType) evidence.employmentType = { source: 'board_field', text: p.employmentType };

  // level and years
  const lv = levelFromTitle(p.title);
  const yrs = yearsFromText(text);
  let level: Level | null = lv?.level ?? null;
  if (lv) evidence.level = { source: 'title', text: lv.text.slice(0, 500) };
  else if (yrs && yrs.min !== null) {
    level = yrs.min >= 5 ? 'senior' : yrs.min >= 2 ? 'mid' : 'entry';
    evidence.level = { source: 'description', text: yrs.quote };
  }
  const levels: ExperienceLevel[] = level ? [experienceLevelOf(level)] : [];
  if (yrs) evidence.years = { source: 'description', text: yrs.quote };

  // pay
  let pay: Pay | null = null;
  const fromText = payFromText(text);
  const raw = p.pay ?? fromText?.pay ?? null;
  if (raw && (raw.min !== null || raw.max !== null)) {
    const f = ANNUAL[raw.period];
    pay = {
      min: raw.min, max: raw.max, currency: raw.currency, period: raw.period,
      source: p.pay ? 'board_field' : 'description', ranges: raw.ranges,
      annualMin: raw.min === null ? null : Math.round(raw.min * f), annualMax: raw.max === null ? null : Math.round(raw.max * f),
    };
    evidence.pay = p.pay ? { source: 'board_field', text: `pay field: ${raw.min ?? ''}-${raw.max ?? ''} ${raw.currency} per ${raw.period}` } : { source: 'description', text: fromText!.quote };
  }

  // statements
  const statements: Job['statements'] = { sponsorship: null, clearanceRequired: null, usCitizenOnly: null };
  const sponsorYes = /Visa sponsorship is available[^.\n]*/.exec(text);
  const sponsorNo = /unable to sponsor[^.\n]*/i.exec(text);
  if (sponsorNo) { statements.sponsorship = 'no'; evidence.sponsorship = { source: 'description', text: sponsorNo[0] }; }
  else if (sponsorYes) { statements.sponsorship = 'yes'; evidence.sponsorship = { source: 'description', text: sponsorYes[0] }; }
  const clearance = /security clearance is required/i.exec(text);
  if (clearance) { statements.clearanceRequired = true; evidence.clearanceRequired = { source: 'description', text: clearance[0] }; }
  const citizen = /US citizenship is required/i.exec(text);
  if (citizen) { statements.usCitizenOnly = true; evidence.usCitizenOnly = { source: 'description', text: citizen[0] }; }

  // US or not
  const countries = new Set(places.map((x) => x.country).filter(Boolean));
  let isUs: boolean | null = null;
  if (countries.size) isUs = countries.has('US') ? true : false;
  else if (scope) isUs = scope.regions.includes('US') ? true : null;

  const job: Job = {
    id,
    status: 'open',
    closedAt: null,
    closedReason: null,
    title: p.title,
    company: board.company,
    companyKey: companyKey(board.company),
    ats: board.ats,
    board: board.board,
    externalId: p.externalId,
    url,
    applyUrl: p.hasApplyPage ? `${url}/apply` : null,
    canonicalUrl: url,
    places,
    isUs,
    workModel,
    remoteScope: scope,
    employmentType: p.employmentType,
    level,
    levels,
    yearsRequired: yrs ? { min: yrs.min, max: yrs.max } : null,
    pay,
    postedAt: p.postedAt,
    firstSeenAt: seen.firstSeenAt,
    lastSeenAt: seen.lastSeenAt,
    updatedAt: seen.lastSeenAt,
    department: p.department,
    statements,
    skills: skillsIn(`${p.title}\n${text}`),
    evidence,
    sources: [{
      sourceId: `ats:${board.ats}`,
      name: `${board.company} careers (${board.ats.charAt(0).toUpperCase()}${board.ats.slice(1)})`,
      url,
      credit: null,
      firstSeenAt: seen.firstSeenAt,
      lastSeenAt: seen.lastSeenAt,
    }],
    duplicateOf: null,
    contentHash: '',
    description: text,
  };
  job.contentHash = sha256(JSON.stringify([job.title, job.company, job.places, job.workModel, job.employmentType, job.pay, job.postedAt, job.description]));
  return job;
}

/** A job without its description, plus a snippet (list items). */
export function toSummary(job: Job): JobSummary {
  const { description, ...rest } = job;
  const lines = description.split('\n').map((l) => l.trim()).filter((l) => l && !/^(About the role|What you will do)$/.test(l));
  return { ...rest, snippet: (lines[0] ?? '').slice(0, 300) };
}

/** Evidence text helper for tests. */
export function evidenceOf(job: Job, key: keyof Job['evidence']): FactEvidence | undefined {
  return job.evidence[key];
}

export const KNOWN_CITY_IDS = new Set(CITIES.map((c) => c.id));
