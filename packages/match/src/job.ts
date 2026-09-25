// What the match engine reads from one posting: its kind of work, level, stated years, work model, job type,
// industry, must-haves and the skills it names (required, preferred or mentioned), each with the posting's own words.
// The company name is never read (it cannot steer the score), only the title, the department, the description and
// the structured fields.

import type { Company, EmploymentType, Job, Level, WorkModel } from '@jobleft/contracts';
import { levelFromTitle } from '@jobleft/parsers';
import { analyzeText, quoteAround, textLanguage, type AnalyzedText, type SectionKind } from './text.ts';
import {
  FAMILIES, SKILLS, familyOfTitle, familyRelatedness, scanIndustries, scanSkills, tokensOfText, type IndustryHit,
} from './taxonomy.ts';
import { credentialRuns, primaryYears, readRequirements, type PostedRequirement } from './requirements.ts';

export type SkillImportance = 'required' | 'preferred' | 'mentioned';

export interface JobSkillItem {
  id: string;
  importance: SkillImportance;
  quote: string;
  start: number;
}

export interface JobFacts {
  job: Job;
  text: AnalyzedText;
  language: 'en' | 'other' | null;
  /** Words in the description, after text aimed at screeners is dropped. */
  words: number;
  family: string | null;
  familySource: 'title' | 'department' | 'description' | null;
  familyEvidence: string | null;
  level: Level | null;
  levelSource: 'job' | 'title' | 'years' | 'employment_type' | null;
  levelEvidence: string | null;
  requirements: PostedRequirement[];
  years: PostedRequirement | null;
  workModel: WorkModel | null;
  workModelEvidence: string | null;
  employmentType: EmploymentType | null;
  employmentTypeEvidence: string | null;
  skills: JobSkillItem[];
  /** Skill names the posting repeats or lists beyond any real job (keyword stuffing is counted once). */
  distinctSkillCount: number;
  industries: Array<{ industry: string; score: number; evidence: string; source: 'company' | 'posting' | 'title' }>;
  ignoredSentences: number;
  hasRequirementSection: boolean;
}

const SKIP_SECTIONS: ReadonlySet<SectionKind> = new Set(['about', 'benefits', 'eeo']);
const LINE_PREFERRED = /\b(preferred|preferably|a plus|is a plus|nice[- ]to[- ]have|bonus|desired|desirable|ideally|advantage|helpful|not required)\b/i;
const LINE_REQUIRED = /\b(required|must|mandatory|minimum|essential|necessary)\b/i;

/** A sentence that states what the person must bring, even without a heading ("2 years of experience, CDL-A, ..."). */
const REQUIREMENT_SENTENCE = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s*(\(\d+\)\s*)?(years?|yrs?|months?)\b[^.;]{0,60}\b(experience|exp\b)|\bexperience\b[^.;]{0,25}\b\d{1,2}\+?\s*(years?|months?)\b|\b(must have|must be able|must hold|must possess|you have|you'?ll need|you will need|you should have|we'?re looking for someone|looking for someone with|the ideal candidate|candidates? (must|should|will) have|requires?|required|minimum of|need(s)? to have|proven experience|experience (with|in|using|as)|knowledge of|proficien\w+ (in|with)|ability to)\b/i;
/** Words that make a licence or certificate in plain text a requirement ("Licensed therapists (LCSW, LPC or LMFT)"). */
const LICENCE_WORDS = /\b(licen[cs]ed|licen[cs]es?|licensure|certified|certifications?|certificates?|card|endorsements?|credentials?|registered|registration)\b/i;

function lineImportance(section: SectionKind, line: string, credential = false): SkillImportance {
  const pref = LINE_PREFERRED.test(line);
  const req = LINE_REQUIRED.test(line) && !/\bnot required\b/i.test(line);
  if (section === 'required') return pref && !req ? 'preferred' : 'required';
  if (section === 'preferred') return req && !pref ? 'required' : 'preferred';
  if (pref && !req) return 'preferred';
  if (req) return 'required';
  if (REQUIREMENT_SENTENCE.test(line)) return 'required';
  if (credential && LICENCE_WORDS.test(line)) return 'required';
  return 'mentioned';
}

const RANK: Record<SkillImportance, number> = { required: 0, preferred: 1, mentioned: 2 };

function jobFamily(job: Job, a: AnalyzedText): { family: string | null; source: JobFacts['familySource']; evidence: string | null } {
  const byTitle = familyOfTitle(job.title);
  if (byTitle) return { family: byTitle.family, source: 'title', evidence: byTitle.phrase };
  if (job.department) {
    const byDept = familyOfTitle(job.department);
    if (byDept) return { family: byDept.family, source: 'department', evidence: byDept.phrase };
  }
  // Vote from the skills the requirement and duty lines name, and from job titles written in the text.
  const votes = new Map<string, number>();
  for (const m of scanSkills(a.live)) {
    const tok = a.live.find((t) => t.start === m.start);
    const section = tok ? a.lines[tok.line]?.section : undefined;
    if (!section || SKIP_SECTIONS.has(section)) continue;
    const fams = SKILLS.get(m.id)?.families;
    if (!fams) continue;
    for (const f of fams) votes.set(f, (votes.get(f) ?? 0) + 1 / fams.size);
  }
  for (const line of a.lines) {
    if (SKIP_SECTIONS.has(line.section)) continue;
    for (const part of line.text.split(/[,.;:()]/)) {
      const f = familyOfTitle(part.length < 80 ? part : '');
      if (f) votes.set(f.family, (votes.get(f.family) ?? 0) + 1.5);
    }
  }
  const ranked = [...votes].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  if (ranked.length && ranked[0][1] >= 2 && (ranked.length < 2 || ranked[0][1] >= ranked[1][1] * 1.5)) {
    return { family: ranked[0][0], source: 'description', evidence: null };
  }
  return { family: null, source: null, evidence: null };
}

const REMOTE_RE = /\b(fully remote|100% remote|remote[- ]first|remote position|remote role|remote job|remote opportunity|remote work|work(ing)? from home|wfh|telecommut\w*|work remotely|this (is a )?remote|(role|position|job) is remote|remote \((us|u\.s\.|usa|united states|anywhere)|remote - |remote, (us|usa|united states)|remote in the (us|u\.s\.|united states)|remote within|remote \/ |open to remote|remote eligible|remote-eligible)\b/i;
const REMOTE_LOCATION = /^\s*(remote|anywhere|work from home|wfh|virtual)\b/i;
const HYBRID_RE = /\bhybrid\b/i;
const ONSITE_RE = /\b(on[- ]?site|in[- ]office|in[- ]person|office[- ]based|must (work|report) (from|to|at|in) (our|the|an?) (office|location|site|facility|store|hospital|plant|warehouse)|not (a )?remote|no remote|not eligible for remote|this is not a remote|onsite in|on-site in|work on site)\b/i;
const NOT_REMOTE_WORK = /\bremote (patient )?(monitoring|sites?|locations?|areas?|communities|villages|access)\b/i;

function readWorkModel(job: Job, a: AnalyzedText): { model: WorkModel | null; evidence: string | null } {
  if (job.workModel) return { model: job.workModel, evidence: (job.evidence?.workModel?.text ?? job.places.map((p) => p.text).join('; ')) || null };
  const placeText = job.places.map((p) => p.text).join('; ');
  if (placeText && REMOTE_LOCATION.test(placeText) && !HYBRID_RE.test(placeText)) return { model: 'remote', evidence: placeText };
  if (placeText && HYBRID_RE.test(placeText)) return { model: 'hybrid', evidence: placeText };
  const text = a.text;
  const live = a.sentences.filter((s) => !s.ignored);
  const find = (re: RegExp) => {
    for (const s of live) {
      if (a.lines[s.line]?.section === 'eeo') continue;
      const m = re.exec(s.text);
      if (m && !(re === REMOTE_RE && NOT_REMOTE_WORK.test(s.text))) return quoteAround(text, s.start + m.index, s.start + m.index + m[0].length, 160);
    }
    return null;
  };
  const titleOnsite = ONSITE_RE.test(job.title) ? job.title : null;
  const onsite = find(/\b(not (a )?remote|no remote|not eligible for remote|this is not a remote)\b/i);
  if (onsite) return { model: 'onsite', evidence: onsite };
  const hybrid = find(HYBRID_RE) ?? (HYBRID_RE.test(job.title) ? job.title : null);
  if (hybrid) return { model: 'hybrid', evidence: hybrid };
  const remote = find(REMOTE_RE) ?? (/\bremote\b/i.test(job.title) ? job.title : null);
  const on = titleOnsite ?? find(ONSITE_RE);
  if (remote && !on) return { model: 'remote', evidence: remote };
  if (on && !remote) return { model: 'onsite', evidence: on };
  return { model: null, evidence: null };
}

/** Job type in a title ("Contract Recruiter", "Part-Time Cashier"). */
const TYPE_RES: Array<[EmploymentType, RegExp]> = [
  ['internship', /\b(internship|intern|co-?op)\b/i],
  ['contract', /\b(contract|contractor|1099|contract[- ]to[- ]hire|temp[- ]to[- ]hire|c2h)\b/i],
  ['temporary', /\b(temporary|seasonal|temp)\b/i],
  ['part_time', /\b(part[- ]time|per diem|prn)\b/i],
  ['full_time', /\b(full[- ]time)\b/i],
];
/**
 * Job type in the text: only phrases about the job itself. "An electrical contractor" or "a defense contractor"
 * describes the employer, never the job type.
 */
const TEXT_TYPE_RES: Array<[EmploymentType, RegExp]> = [
  ['contract', /\b(contract (position|role|assignment|job|opportunity|basis|engagement|work|opening)|on a contract basis|contract[- ]to[- ]hire|temp[- ]to[- ]hire|c2h|1099 (contract|contractor|position|role|basis)|w-?2 contract|\d+[- ](month|week)s?\s+contract|(is|be) a contract\b|(job|employment|position|work) type:?\s*contract|independent contractor (position|role|agreement))\b/i],
  ['temporary', /\b(temporary (position|role|assignment|job|opening|employee)|seasonal (position|role|job|associate|help|employee|work)|temp (position|role|job)|(job|employment|position) type:?\s*(temporary|seasonal))\b/i],
  ['part_time', /\b(part[- ]time|per diem|prn)\b/i],
  ['full_time', /\b(full[- ]time)\b/i],
];

function readEmploymentType(job: Job, a: AnalyzedText): { type: EmploymentType | null; evidence: string | null } {
  if (job.employmentType) return { type: job.employmentType, evidence: job.evidence?.employmentType?.text ?? null };
  for (const [type, re] of TYPE_RES) if (re.test(job.title)) return { type, evidence: job.title };
  const found = new Map<EmploymentType, string>();
  for (const s of a.sentences) {
    if (s.ignored || a.lines[s.line]?.section === 'eeo') continue;
    for (const [type, re] of TEXT_TYPE_RES) {
      const m = re.exec(s.text);
      if (m && !found.has(type)) found.set(type, quoteAround(a.text, s.start + m.index, s.start + m.index + m[0].length, 140));
    }
  }
  if (found.size === 1) { const [type, ev] = [...found][0]; return { type, evidence: ev }; }
  return { type: null, evidence: null };
}

/** Titles with "manager" that manage work, not people ("Account Manager", "Product Manager", "Case Manager"). */
const IC_MANAGER = /\b(account|product|project|program|case|property|community|social media|marketing|brand|content|relationship|territory|key account|customer success|client success|success|category|practice|care|portfolio|event|events|engagement|partner|partnerships|channel|technical account|implementation|delivery|release|configuration|data|compliance|contracts?|office|leasing|pmo|campaign|digital marketing|product marketing|growth|seo|email marketing|demand generation|study|clinical trial|grants?|development|fundraising|wealth|asset)\s+manager\b/i;

/**
 * The level a title states, from @jobleft/parsers plus the match lane's reading of a few titles: an "Account Manager"
 * is not a people manager; an executive chef runs a kitchen team; a sous chef leads one.
 */
export function levelOfTitle(title: string): Level | null {
  const t = title.trim();
  if (/\b(executive chef|head chef|chef de cuisine|culinary director)\b/i.test(t)) return 'manager';
  if (/\bsous chef\b/i.test(t)) return 'lead';
  const base = levelFromTitle(t);
  if (base === 'manager' && IC_MANAGER.test(t) && !/\b(managers|team manager|people manager)\b/i.test(t)) {
    if (/\b(senior|sr\.?)\b/i.test(t)) return 'senior';
    if (/\b(principal|group|lead)\b/i.test(t)) return 'lead';
    return /\b(associate|junior|jr\.?|assistant)\b/i.test(t) ? 'entry' : 'mid';
  }
  return base;
}

function levelFromYears(min: number | null): Level | null {
  if (min === null) return null;
  if (min <= 1) return 'entry';
  if (min <= 4) return 'mid';
  if (min <= 7) return 'senior';
  return 'lead';
}

function jobIndustries(job: Job, a: AnalyzedText, company: Company | null, family: string | null): JobFacts['industries'] {
  const scores = new Map<string, { score: number; strong: string | null; weak: string[]; source: 'company' | 'posting' | 'title' }>();
  const facts = company?.facts?.industries?.value ?? [];
  for (const f of facts) {
    for (const h of scanIndustries(tokensOfText(f))) {
      const cur = scores.get(h.industry) ?? { score: 0, strong: null, weak: [], source: 'company' as const };
      cur.score += 3;
      cur.strong ??= `${f} (company data)`;
      cur.source = 'company';
      scores.set(h.industry, cur);
    }
  }
  const tokens = a.live.filter((t) => { const s = a.lines[t.line]?.section; return s !== 'required' && s !== 'preferred' && s !== 'benefits' && s !== 'eeo'; });
  const seen = new Set<string>();
  const hits: IndustryHit[] = scanIndustries(tokens);
  for (const h of hits) {
    const key = `${h.industry}:${h.phrase}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cur = scores.get(h.industry) ?? { score: 0, strong: null, weak: [], source: 'posting' as const };
    if (h.strength === 'strong') { cur.score += 3; cur.strong ??= quoteAround(a.text, h.start, h.end, 140); }
    else { cur.score += 1; cur.weak.push(a.text.slice(h.start, h.end)); }
    scores.set(h.industry, cur);
  }
  const out: JobFacts['industries'] = [];
  for (const [industry, v] of scores) {
    if (v.score < 3) continue;
    out.push({ industry, score: v.score, evidence: v.strong ?? v.weak.join(', '), source: v.source });
  }
  out.sort((x, y) => y.score - x.score || (x.industry < y.industry ? -1 : 1));
  if (!out.length && family) {
    const implied = FAMILIES.get(family)?.industry;
    if (implied) out.push({ industry: implied, score: 3, evidence: job.title, source: 'title' });
  }
  // Keep the leading industries only: a posting is mostly about one or two.
  return out.filter((x, i) => i === 0 || x.score >= out[0].score * 0.5).slice(0, 3);
}

export function readJob(job: Job, company: Company | null): JobFacts {
  const a = analyzeText(job.description ?? '');
  const liveWords = a.live.filter((t) => /\p{L}/u.test(t.raw)).length;
  // Language from the ordinary words only: a list of skill names is not prose in any language.
  const skillSpans = scanSkills(a.live);
  const inSkill = new Set<number>();
  for (const m of skillSpans) for (let k = m.i; k < m.i + m.len; k++) inSkill.add(k);
  const prose = a.live.filter((_, k) => !inSkill.has(k)).map((t) => t.raw).join(' ');
  const language = textLanguage(prose) ?? textLanguage(job.title);
  const fam = jobFamily(job, a);
  const requirements = language === 'other' ? [] : readRequirements(a);
  const years = primaryYears(requirements);

  let level: Level | null = job.level ?? null;
  let levelSource: JobFacts['levelSource'] = level ? 'job' : null;
  let levelEvidence: string | null = level ? job.evidence?.level?.text ?? job.title : null;
  // The title, read by the match lane, wins over a crawler's level for the few titles the parsers misread.
  const t = levelOfTitle(job.title);
  if (t && (!level || (level === 'manager' && t !== 'manager'))) { level = t; levelSource = 'title'; levelEvidence = job.title; }
  if (!level && job.employmentType === 'internship') { level = 'intern'; levelSource = 'employment_type'; levelEvidence = 'internship'; }
  if (!level && years && years.importance === 'required') {
    const y = levelFromYears(years.detail.minYears ?? null);
    if (y) { level = y; levelSource = 'years'; levelEvidence = years.quote; }
  }

  const wm = readWorkModel(job, a);
  const et = readEmploymentType(job, a);

  // Skills: every distinct skill once, at its strongest importance, with the posting's words.
  const items = new Map<string, JobSkillItem>();
  if (language !== 'other') {
    const all = scanSkills(a.live);
    // "LCSW, LPC or LMFT" is one item that any of the three meets.
    const altOf = new Map<number, string>();
    for (const run of credentialRuns(a.text, all.filter((m) => SKILLS.get(m.id)?.kind === 'cred'))) {
      if (!run.alternative) continue;
      const key = `alt:${run.ids.join('|')}`;
      for (const m of all) if (m.start >= run.start && m.end <= run.end) altOf.set(m.start, key);
    }
    const tokAt = new Map(a.live.map((t) => [t.start, t]));
    for (const m0 of all) {
      const m = altOf.has(m0.start) ? { ...m0, id: altOf.get(m0.start)! } : m0;
      const def = SKILLS.get(m0.id)!;
      const tok = tokAt.get(m.start)!;
      const line = a.lines[tok.line];
      if (!line || SKIP_SECTIONS.has(line.section)) continue;
      const sentence = a.sentences[tok.sentence]?.text ?? line.text;
      const imp = lineImportance(line.section, sentence, def.kind === 'cred');
      if (def.kind === 'cred' && imp === 'mentioned') continue;
      if (imp === 'mentioned' && def.families && fam.family) {
        let fits = false;
        for (const f of def.families) if (familyRelatedness(fam.family, f) >= 0.3) { fits = true; break; }
        if (!fits) continue;
      }
      const prev = items.get(m.id);
      if (prev && RANK[prev.importance] <= RANK[imp]) continue;
      items.set(m.id, { id: m.id, importance: imp, quote: quoteAround(a.text, m.start, m.end, 140), start: m.start });
    }
    // Skills listed only in the structured field (some boards send tags) join as mentioned.
    for (const name of job.skills ?? []) {
      const found = scanSkills(tokensOfText(name), { relaxed: true });
      for (const m of found) if (!items.has(m.id) && SKILLS.get(m.id)?.kind !== 'cred') items.set(m.id, { id: m.id, importance: 'mentioned', quote: name, start: Number.MAX_SAFE_INTEGER });
    }
  }
  const skills = [...items.values()].sort((x, y) => RANK[x.importance] - RANK[y.importance] || x.start - y.start);

  return {
    job, text: a, language, words: liveWords, family: fam.family, familySource: fam.source, familyEvidence: fam.evidence,
    level, levelSource, levelEvidence, requirements, years, workModel: wm.model, workModelEvidence: wm.evidence,
    employmentType: et.type, employmentTypeEvidence: et.evidence, skills, distinctSkillCount: skills.length,
    industries: language === 'other' && !(company?.facts?.industries) ? [] : jobIndustries(job, a, company, fam.family),
    ignoredSentences: a.ignoredSentences,
    hasRequirementSection: a.lines.some((l) => l.section === 'required' || l.section === 'preferred'),
  };
}

export { familyRelatedness };
