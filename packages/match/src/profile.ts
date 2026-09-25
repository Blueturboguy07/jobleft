// The profile as the match engine reads it. Only these facts are read: work history (titles, employers, dates,
// summaries, bullets), skills, certifications, education, projects, the summary, preferences, the work-authorization
// answers and the home city. Never read: name, email, phone, street address, links, and the equal-employment answers.

import { createHash } from 'node:crypto';
import type { Profile, WorkEntry } from '@jobleft/contracts';
import { analyzeText } from './text.ts';
import {
  SKILLS, familyOfTitle, foldTitleWords, industryOfName, scanIndustries, scanSkills, skillIdFor, skillName, FAMILIES,
} from './taxonomy.ts';

/** Months since year 0: 2024-01 -> 2024*12. */
export type MonthIndex = number;

export function monthIndex(ym: string, end: boolean): MonthIndex | null {
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(ym.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : end ? 12 : 1;
  if (mo < 1 || mo > 12) return null;
  return y * 12 + (mo - 1);
}

export function monthOf(now: number): MonthIndex {
  const d = new Date(now);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

export function monthLabel(m: MonthIndex): string {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[m % 12]} ${Math.floor(m / 12)}`;
}

/** "3 years 6 months", "8 months", "1 year". */
export function formatMonths(months: number): string {
  const y = Math.floor(months / 12);
  const mo = months % 12;
  const parts: string[] = [];
  if (y) parts.push(`${y} year${y === 1 ? '' : 's'}`);
  if (mo || !y) parts.push(`${mo} month${mo === 1 ? '' : 's'}`);
  return parts.join(' ');
}

export interface RoleFact {
  title: string;
  company: string;
  /** First and last month counted (inclusive); null when the dates cannot be counted. */
  from: MonthIndex | null;
  to: MonthIndex | null;
  months: number;
  current: boolean;
  /** Why the role is not counted, when it is not. */
  notCounted: string | null;
  family: string | null;
  familyPhrase: string | null;
  industry: string | null;
  industryEvidence: string | null;
  internship: boolean;
}

export type SkillSource = 'skills' | 'certifications' | 'work' | 'projects' | 'summary';

export interface HeldSkill {
  id: string;
  source: SkillSource;
  /** The profile's own words for it ("Microsoft Excel", or the role that names it). */
  evidence: string;
}

export interface Degree {
  rank: number;
  label: string;
  text: string;
  inProgress: boolean;
  field: string | null;
}

export interface ProfileFacts {
  version: string;
  roles: RoleFact[];
  /** Months covered by at least one counted role (overlaps counted once). null when no role has usable dates. */
  totalMonths: number | null;
  held: Map<string, HeldSkill>;
  /** Profile skills the dictionaries do not know, kept to match the same words in a posting. */
  rawSkills: Array<{ name: string; words: string[] }>;
  declined: Set<string>;
  /** Credentials a past title suggests (never counted as held). */
  impliedCreds: Map<string, string>;
  families: Map<string, { months: number; roles: RoleFact[] }>;
  targetFamilies: Array<{ family: string; text: string }>;
  majorFamilies: Array<{ family: string; text: string }>;
  industries: Map<string, { months: number; evidence: string; role: string }>;
  degrees: Degree[];
  hasWork: boolean;
  hasEducation: boolean;
  profile: Profile;
}

// ---------------------------------------------------------------- version

/** The facts the score reads, in a fixed order, without ids, contact details or equal-employment answers. */
export function scoringView(p: Profile): unknown {
  const pr = p.preferences;
  const wa = p.workAuthorization;
  return {
    home: { city: p.personal.city, region: p.personal.region, country: p.personal.country },
    summary: p.summary,
    work: p.work.map((w) => [w.company, w.title, w.employmentType, w.location, w.startDate, w.endDate, w.current, w.summary, w.bullets]),
    education: p.education.map((e) => [e.school, e.degree, e.major, e.startDate, e.endDate, e.current]),
    projects: p.projects.map((x) => [x.name, x.description, x.bullets]),
    certifications: p.certifications.map((c) => [c.name, c.issuer, c.date]),
    skills: p.skills.map((s) => [s.name, s.years]),
    declinedSkills: (p as { declinedSkills?: string[] }).declinedSkills ?? [],
    preferences: [pr.jobFunctions, pr.targetTitles, pr.employmentTypes, pr.workModels, pr.levels, pr.countries,
      pr.places.map((x) => [x.text, x.placeId, x.radiusMiles]), pr.minAnnualPayUsd, pr.industries],
    auth: [wa.usAuthorized, wa.needsSponsorship, wa.usCitizen, wa.hasSecurityClearance, wa.authorizedCountries],
  };
}

/** Hash of the profile facts the score reads (MatchResult.profileVersion). */
export function profileVersionOf(p: Profile): string {
  return 'pv1-' + createHash('sha256').update(JSON.stringify(scoringView(p))).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- degrees

const DEGREE_RANKS: Array<[number, string, RegExp]> = [
  [5, 'doctorate', /\b(ph\.? ?d|doctorate|doctoral|doctor of|d\.?phil|ed\.? ?d|psy\.? ?d|dnp|pharm\.? ?d|m\.? ?d\b|j\.? ?d\b|juris doctor|dds|dmd|dvm|d\.?p\.?t)\b/i],
  [4, "master's", /\b(master'?s?|m\.? ?s\.?(?![a-z])|m\.? ?a\.?(?![a-z])|mba|msn|m\.? ?ed|mph|msw|m\.? ?sc|m\.? ?eng|mfa|mpa|llm|m\.? ?acc|mat\b|graduate degree)/i],
  [3, "bachelor's", /\b(bachelor'?s?|baccalaureate|b\.? ?s\.?(?![a-z])|b\.? ?a\.?(?![a-z])|b\.? ?sc|bsn|bba|b\.? ?eng|bfa|b\.? ?ed|undergraduate degree|4[- ]year degree|four[- ]year degree)/i],
  [2, "associate's", /\b(associate'?s?|a\.? ?a\.? ?s\.?(?![a-z])|a\.? ?a\.?(?![a-z])|a\.? ?s\.?(?![a-z])|adn|asn|2[- ]year degree|two[- ]year degree)/i],
  [1, 'high school diploma', /\b(high school|ged|hs diploma|secondary school|diploma)\b/i],
];

export function degreeRankOf(text: string): { rank: number; label: string } | null {
  for (const [rank, label, re] of DEGREE_RANKS) if (re.test(text)) return { rank, label };
  return null;
}

const MAJOR_FAMILIES: Array<[RegExp, string]> = [
  [/\b(computer science|software engineering|computer engineering|informatics|computing)\b/i, 'software'],
  [/\b(data science|statistics|mathematics|applied math|analytics|economics)\b/i, 'data'],
  [/\b(information systems|information technology|cybersecurity|network)\b/i, 'it'],
  [/\b(nursing|bsn|adn|msn)\b/i, 'nursing'],
  [/\b(accounting|accountancy)\b/i, 'accounting'],
  [/\b(finance|financial|banking)\b/i, 'finance'],
  [/\b(education|teaching|elementary ed|special education|curriculum)\b/i, 'teaching'],
  [/\b(early childhood|child development)\b/i, 'childcare'],
  [/\b(marketing|communications|journalism|public relations|advertising)\b/i, 'marketing'],
  [/\b(human resources|hr management)\b/i, 'hr'],
  [/\b(graphic design|design|fine arts|visual arts)\b/i, 'design'],
  [/\b(mechanical|electrical|civil|chemical|industrial|aerospace|biomedical) engineering\b/i, 'engineering'],
  [/\b(psychology|social work|counseling|counselling)\b/i, 'counseling'],
  [/\b(biology|chemistry|biochemistry|physics|microbiology|environmental science)\b/i, 'science'],
  [/\b(supply chain|logistics|operations management)\b/i, 'logistics'],
  [/\b(hospitality|hotel management|culinary)\b/i, 'hospitality'],
  [/\b(construction management)\b/i, 'construction_mgmt'],
  [/\b(paralegal|legal studies|pre-law|law)\b/i, 'legal'],
  [/\b(health administration|health information|healthcare administration|medical billing|medical coding)\b/i, 'health_admin'],
  [/\b(pharmacy|physical therapy|occupational therapy|respiratory|radiologic|kinesiology|exercise science|nutrition)\b/i, 'health_clinical'],
  [/\b(electrical technology|electrician|hvac|welding|automotive technology|construction technology)\b/i, 'trades_electrical'],
  [/\b(business administration|management|business)\b/i, 'operations'],
];

// ---------------------------------------------------------------- facts

const INTERN = /\b(intern|internship|co-?op|apprentice|trainee|student worker|work[- ]study)\b/i;

function roleOf(w: WorkEntry, nowMonth: MonthIndex): RoleFact {
  const fam = familyOfTitle(w.title);
  let family = fam?.family ?? null;
  let familyPhrase = fam?.phrase ?? null;
  if (!family) {
    // Fall back to the kind of work the role's own text names ("Associate" at a store: cash handling, POS).
    const votes = new Map<string, number>();
    const a = analyzeText([w.summary ?? '', ...w.bullets].join('\n'));
    for (const m of scanSkills(a.live)) {
      const fams = SKILLS.get(m.id)?.families;
      if (!fams) continue;
      for (const f of fams) votes.set(f, (votes.get(f) ?? 0) + 1 / fams.size);
    }
    const ranked = [...votes].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    if (ranked.length && ranked[0][1] >= 1.5 && (ranked.length < 2 || ranked[0][1] >= ranked[1][1] * 1.5)) {
      family = ranked[0][0];
      familyPhrase = null;
    }
  }
  let from: MonthIndex | null = w.startDate ? monthIndex(w.startDate, false) : null;
  let to: MonthIndex | null = w.current ? nowMonth : w.endDate ? monthIndex(w.endDate, true) : null;
  let notCounted: string | null = null;
  if (from === null) notCounted = 'no start date';
  else if (to === null) notCounted = 'no end date and not marked current';
  else {
    if (to > nowMonth) to = nowMonth;
    if (from > nowMonth) notCounted = 'starts in the future';
    else if (to < from) notCounted = 'ends before it starts';
  }
  if (notCounted) { from = null; to = null; }
  const months = from !== null && to !== null ? to - from + 1 : 0;
  // Industry of the role: the employer's name first, then the role's own words, then the kind of work.
  let industry: string | null = null;
  let industryEvidence: string | null = null;
  const byName = industryOfName(w.company);
  if (byName) { industry = byName.industry; industryEvidence = `the employer name "${byName.phrase}"`; }
  if (!industry) {
    const text = [w.summary ?? '', ...w.bullets].join('\n');
    const hits = scanIndustries(analyzeText(text).live).filter((h) => h.strength === 'strong');
    if (hits.length) { industry = hits[0].industry; industryEvidence = `"${text.slice(hits[0].start, hits[0].end)}" in that role`; }
  }
  if (!industry && family) {
    const implied = FAMILIES.get(family)?.industry ?? null;
    if (implied) { industry = implied; industryEvidence = `the title "${w.title}"`; }
  }
  return {
    title: w.title, company: w.company, from, to, months, current: w.current, notCounted, family, familyPhrase, industry, industryEvidence,
    internship: INTERN.test(w.title) || w.employmentType === 'internship',
  };
}

/** Months covered by the roles, each month counted once. */
export function unionMonths(roles: Array<{ from: MonthIndex | null; to: MonthIndex | null }>): number {
  const spans = roles.filter((r) => r.from !== null && r.to !== null).map((r) => [r.from!, r.to!] as [number, number]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = -1, curE = -2;
  for (const [s, e] of spans) {
    if (s > curE + 1) { if (curE >= curS && curS >= 0) total += curE - curS + 1; curS = s; curE = e; }
    else if (e > curE) curE = e;
  }
  if (curS >= 0 && curE >= curS) total += curE - curS + 1;
  return total;
}

/** Ordinary words people list as skills; they are never matched word for word in a posting. */
const COMMON_SKILL_WORDS = new Set(('leadership leading teamwork team communication communications collaboration management managing ' +
  'sales selling marketing inventory scheduling coaching mentoring training teaching planning budgeting recruiting ' +
  'hiring customer customers service services operations organization organizational organized negotiation ' +
  'presentation presentations research writing editing reading analysis analytics problem solving creativity ' +
  'detail adaptability flexibility multitasking reliability punctuality empathy patience safety quality ' +
  'accounting finance nursing cooking cleaning driving administration support strategy development design ' +
  'relationship relationships retail hospitality healthcare education engineering technology computers computer ' +
  'office excellent strong professional time interpersonal verbal written microsoft google experience skills').split(/\s+/));

/**
 * A profile skill the dictionaries do not know is matched word for word only when it looks like the name of a tool
 * or a product ("Pyxis", "PowerSchool", "SAP Ariba", "OSHA-40"): a digit, an inner capital, all capitals, or one
 * capitalised word that is not an ordinary word.
 */
function rawSkillWorthMatching(name: string): boolean {
  const t = name.trim();
  if (t.length < 3 || t.length > 40) return false;
  const words = t.split(/\s+/);
  if (words.length > 3) return false;
  if (words.every((w) => COMMON_SKILL_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, '')))) return false;
  if (/\d/.test(t)) return true;
  if (words.some((w) => /^[A-Z0-9]{2,}$/.test(w))) return true;
  if (words.some((w) => /^[A-Za-z][a-z]+[A-Z]/.test(w))) return true;
  return words.length === 1 && /^[A-Z][a-z]{3,}$/.test(t);
}

const SOURCE_RANK: Record<SkillSource, number> = { skills: 0, certifications: 1, work: 2, projects: 3, summary: 4 };

export function profileFacts(p: Profile, now: number): ProfileFacts {
  const nowMonth = monthOf(now);
  const roles = p.work.map((w) => roleOf(w, nowMonth));
  const counted = roles.filter((r) => r.from !== null);
  // No work entries at all, with education listed: a student or a new graduate, counted as 0 months of work.
  const totalMonths = counted.length ? unionMonths(counted) : p.work.length === 0 && p.education.length > 0 ? 0 : null;

  const declinedNames = (p as { declinedSkills?: string[] }).declinedSkills ?? [];
  const declined = new Set<string>();
  for (const d of declinedNames) declined.add(skillIdFor(d) ?? `raw:${d.trim().toLowerCase()}`);

  const held = new Map<string, HeldSkill>();
  const hold = (id: string, source: SkillSource, evidence: string) => {
    if (declined.has(id)) return;
    const prev = held.get(id);
    if (!prev || SOURCE_RANK[source] < SOURCE_RANK[prev.source]) held.set(id, { id, source, evidence });
  };
  const rawSkills: ProfileFacts['rawSkills'] = [];
  for (const s of p.skills) {
    const name = s.name.trim();
    if (!name) continue;
    const whole = skillIdFor(name);
    if (whole) { hold(whole, 'skills', name); continue; }
    const found = scanSkills(analyzeText(name).live, { relaxed: true });
    if (found.length) { for (const m of found) hold(m.id, 'skills', name); continue; }
    if (rawSkillWorthMatching(name) && !declined.has(`raw:${name.toLowerCase()}`)) {
      rawSkills.push({ name, words: foldTitleWords(name) });
    }
  }
  for (const c of p.certifications) {
    const name = c.name.trim();
    if (!name) continue;
    const whole = skillIdFor(name);
    if (whole) { hold(whole, 'certifications', name); continue; }
    for (const m of scanSkills(analyzeText(name).live, { relaxed: true })) hold(m.id, 'certifications', name);
  }
  for (const w of p.work) {
    const text = [w.title, w.summary ?? '', ...w.bullets].join('\n');
    for (const m of scanSkills(analyzeText(text).live)) {
      if (SKILLS.get(m.id)?.kind === 'cred') continue; // a licence is held only when the profile lists it
      hold(m.id, 'work', `${w.title} at ${w.company}`);
    }
  }
  for (const x of p.projects) {
    const text = [x.name, x.description ?? '', ...x.bullets].join('\n');
    for (const m of scanSkills(analyzeText(text).live)) {
      if (SKILLS.get(m.id)?.kind === 'cred') continue;
      hold(m.id, 'projects', `the project "${x.name}"`);
    }
  }
  if (p.summary) {
    for (const m of scanSkills(analyzeText(p.summary).live)) {
      if (SKILLS.get(m.id)?.kind === 'cred') continue;
      hold(m.id, 'summary', 'your summary');
    }
  }

  // Credentials a past title suggests, such as an RN licence for a registered nurse.
  const impliedCreds = new Map<string, string>();
  for (const s of SKILLS.values()) {
    if (s.kind !== 'cred' || !s.impliedBy?.length || held.has(s.id)) continue;
    for (const r of roles) {
      const tw = foldTitleWords(r.title);
      const hit = s.impliedBy.some((ph) => ph.length && tw.some((_, i) => ph.every((x, k) => tw[i + k] === x)));
      if (hit) { impliedCreds.set(s.id, r.title); break; }
    }
  }

  const families = new Map<string, { months: number; roles: RoleFact[] }>();
  for (const r of roles) {
    if (!r.family) continue;
    const f = families.get(r.family) ?? { months: 0, roles: [] };
    f.roles.push(r);
    families.set(r.family, f);
  }
  for (const f of families.values()) f.months = unionMonths(f.roles);

  const targetFamilies: ProfileFacts['targetFamilies'] = [];
  for (const t of [...p.preferences.targetTitles, ...p.preferences.jobFunctions]) {
    const fam = familyOfTitle(t);
    if (fam && !targetFamilies.some((x) => x.family === fam.family)) targetFamilies.push({ family: fam.family, text: t });
  }

  const degrees: Degree[] = [];
  const majorFamilies: ProfileFacts['majorFamilies'] = [];
  for (const e of p.education) {
    const text = [e.degree ?? '', e.major ?? ''].join(' ').trim();
    const r = e.degree ? degreeRankOf(e.degree) : null;
    const endM = e.endDate ? monthIndex(e.endDate, true) : null;
    const inProgress = e.current || (endM !== null && endM > nowMonth);
    if (r) degrees.push({ rank: r.rank, label: r.label, text: text || e.school, inProgress, field: e.major });
    if (e.major) {
      for (const [re, fam] of MAJOR_FAMILIES) {
        if (re.test(e.major)) { if (!majorFamilies.some((x) => x.family === fam)) majorFamilies.push({ family: fam, text: e.major }); break; }
      }
    }
  }

  const industries = new Map<string, { months: number; evidence: string; role: string }>();
  for (const r of roles) {
    if (!r.industry) continue;
    const prev = industries.get(r.industry);
    const role = `${r.title} at ${r.company}`;
    if (!prev) industries.set(r.industry, { months: r.months, evidence: r.industryEvidence ?? '', role });
    else prev.months += r.months; // refined below with a union
  }
  for (const [id, v] of industries) v.months = unionMonths(roles.filter((r) => r.industry === id));

  return {
    version: profileVersionOf(p), roles, totalMonths, held, rawSkills, declined, impliedCreds, families, targetFamilies,
    majorFamilies, industries, degrees, hasWork: p.work.length > 0, hasEducation: p.education.length > 0, profile: p,
  };
}

/** Where a held skill came from, in words. */
export function heldFrom(h: HeldSkill): string {
  switch (h.source) {
    case 'skills': return `your skills list ("${h.evidence}")`;
    case 'certifications': return `your certifications ("${h.evidence}")`;
    case 'work': return `your role ${h.evidence}`;
    case 'projects': return h.evidence;
    case 'summary': return 'your summary';
  }
}

export { skillName };
