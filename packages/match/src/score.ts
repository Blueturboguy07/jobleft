// The match score: three parts (Experience Level, Skills, Industry Experience), an overall percent, a band, why-fit
// chips from real job data, must-haves and deal-breakers with the posting's own words, and a reason for every number.
// Pure and deterministic: the same profile, job, company and month give the same result, field for field.

import type { Blocker, Company, Job, MatchResult, Place, PlaceQuery, Profile, Reason, SubScore, WhyFitChip } from '@jobleft/contracts';
import { bandFor } from '@jobleft/contracts';
import { configTag, resolveConfig, type MatchConfig, type MatchConfigInput } from './config.ts';
import { comparePlace, placeLabel, parsePlaceText } from './geo.ts';
import { levelOfTitle, readJob, REQUIREMENT_SENTENCE, verbatim, type JobFacts, type JobSkillItem } from './job.ts';
import {
  formatMonths, heldFrom, monthLabel, monthOf, profileFacts, scoringView, unionMonths, type ProfileFacts, type RoleFact,
} from './profile.ts';
import { yearsLabel, type PostedRequirement } from './requirements.ts';
import {
  SKILLS, familyLabel, familyRelatedness, foldTitleWords, industryName, industryRelatedness, skillName,
} from './taxonomy.ts';

export const ENGINE_BASE_VERSION = 'match-1.0.0';

// ---------------------------------------------------------------- result extras (additive contract fields)

import type { DealBreakerCheck, ExperienceDetail, JobFactView, MustHave, SkillCheck } from '@jobleft/contracts';
export type { DealBreakerCheck, ExperienceDetail, JobFactView, MustHave, SkillCheck };

export type Part = 'experienceLevel' | 'skills' | 'industryExperience';

export interface MatchExtras {
  complete: boolean;
  unknownParts: Part[];
  mustHaves: MustHave[];
  dealBreakers: DealBreakerCheck[];
  jobFacts: Record<'level' | 'years' | 'pay' | 'sponsorship' | 'industry' | 'workModel' | 'employmentType', JobFactView>;
  experience: ExperienceDetail;
  skillDetail: SkillCheck[];
  cap: { percent: number; reason: string } | null;
  notes: string[];
}

export type FullMatchResult = MatchResult & MatchExtras;

export interface ScoreInput {
  profile: Profile;
  job: Job;
  company: Company | null;
  /** ms since the epoch. Only the month is used (a current role counts up to this month). */
  now: number;
  profileVector?: Float32Array | ArrayLike<number> | null;
  jobVector?: Float32Array | ArrayLike<number> | null;
  config?: MatchConfigInput | null;
  /** Great-circle miles between a posting's place and a wanted place, when a place dictionary is at hand. */
  distanceMiles?: (a: Place, b: PlaceQuery) => number | null;
}

// ---------------------------------------------------------------- helpers

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const pct = (x: number) => Math.round(clamp(x, 0, 100));

function listNames(names: string[], max = 8): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

function q(s: string): string {
  return `"${s}"`;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

// ---------------------------------------------------------------- level scales

/** Kinds of work where a supervisor or a store manager is a few years in, not a decade. */
const FRONTLINE = new Set(['retail', 'food', 'hospitality', 'logistics', 'driving', 'manufacturing', 'security_services', 'health_support', 'support', 'admin', 'childcare', 'construction', 'maintenance', 'trades_electrical', 'trades_mech', 'health_admin']);
const LICENSED = new Set(['nursing', 'teaching', 'counseling', 'health_clinical']);

type Scale = 'professional' | 'frontline' | 'licensed';

function scaleOf(family: string | null): Scale {
  if (family && FRONTLINE.has(family)) return 'frontline';
  if (family && LICENSED.has(family)) return 'licensed';
  return 'professional';
}

const LEVEL_ORD: Record<Scale, Record<string, number>> = {
  professional: { intern: 0, entry: 1, mid: 2, senior: 3, staff: 4, lead: 4, manager: 4, principal: 5, director: 5, vp: 6, exec: 6 },
  frontline: { intern: 0, entry: 1, mid: 1.5, senior: 2, staff: 2, lead: 2, manager: 3, principal: 4, director: 4.5, vp: 5.5, exec: 6 },
  licensed: { intern: 0, entry: 1, mid: 2, senior: 3, staff: 3, lead: 3, manager: 4, principal: 5, director: 5, vp: 6, exec: 6 },
};
/** People-leading levels: 1 lead, 2 manager, 3 director, 4 vp, 5 executive. */
const LEAD_ORD: Record<string, number> = { lead: 1, manager: 2, director: 3, vp: 4, exec: 5 };
/** Kinds of work that sit one step below another on a common ladder (job family -> the families above it). */
const STEP_DOWN: Record<string, string[]> = {
  health_support: ['nursing', 'health_clinical'],
  childcare: ['teaching'],
};
const LEVEL_WORD: Record<string, string> = {
  intern: 'Intern', entry: 'Entry Level', mid: 'Mid Level', senior: 'Senior Level', staff: 'Staff', lead: 'Lead',
  manager: 'Manager', principal: 'Principal', director: 'Director', vp: 'Vice President', exec: 'Executive',
};

/** Years of work to an ordinal on a scale. */
function yearsOrd(years: number, scale: Scale): number {
  const steps: Record<Scale, Array<[number, number]>> = {
    professional: [[0, 1], [1, 1], [3, 2], [6, 3], [10, 4], [15, 5], [25, 6]],
    frontline: [[0, 1], [0.5, 1], [2, 2], [4, 3], [8, 4], [12, 5], [20, 6]],
    licensed: [[0, 1], [1, 1], [3, 2], [6, 3], [10, 4], [15, 5], [25, 6]],
  };
  const s = steps[scale];
  if (years <= s[0][0]) return s[0][1];
  for (let i = 1; i < s.length; i++) {
    const [y1, o1] = s[i];
    const [y0, o0] = s[i - 1];
    if (years <= y1) return o0 + ((years - y0) / (y1 - y0 || 1)) * (o1 - o0);
  }
  return s[s.length - 1][1];
}

// ---------------------------------------------------------------- Experience Level

interface ExperienceOut {
  sub: SubScore;
  detail: ExperienceDetail;
  yearsUsed: number | null;
  levelFit: number | null;
  blockers: Array<{ kind: 'years' | 'level'; message: string; quote: string; source: 'title' | 'description' }>;
  mustHaves: MustHave[];
  /** Ceilings that are not must-haves: a clear step down (overqualified). */
  caps: Array<{ cap: number; reason: string }>;
}

function relevanceOf(pf: ProfileFacts, jf: JobFacts, cfg: MatchConfig): { rel: number | null; reasons: Reason[]; relevantMonths: number | null } {
  const reasons: Reason[] = [];
  const fam = jf.family;
  const jobKind = fam ? familyLabel(fam).toLowerCase() : null;
  const titleWords = jf.familyEvidence ? q(jf.familyEvidence) : q(jf.job.title);
  if (!fam) {
    reasons.push({ code: 'role_unknown_job', text: `Not enough information: jobleft could not tell the kind of work from the title ${q(jf.job.title)} or the posting.`, points: 0 });
    return { rel: null, reasons, relevantMonths: null };
  }
  let best = 0;
  let bestRole: RoleFact | null = null;
  for (const r of pf.roles) {
    if (!r.family) continue;
    const rel = familyRelatedness(fam, r.family);
    if (rel > best || (rel === best && bestRole && r.months > bestRole.months)) { best = rel; bestRole = r; }
  }
  const sameMonths = pf.families.get(fam)?.months ?? 0;
  let relRoles = best;
  if (best >= 1) relRoles = sameMonths >= 12 ? 1 : sameMonths >= 6 ? 0.9 : 0.8;
  let rel = relRoles;
  let target: { family: string; text: string } | null = null;
  for (const t of pf.targetFamilies) {
    const r = Math.min(cfg.experience.targetOnly, familyRelatedness(fam, t.family) * cfg.experience.targetOnly);
    if (r > rel) { rel = r; target = t; }
  }
  let study: { family: string; text: string } | null = null;
  const workMonths = pf.totalMonths ?? 0;
  if (workMonths < 24 || relRoles < 0.5) {
    for (const m of pf.majorFamilies) {
      const r = Math.min(cfg.experience.studyOnly, familyRelatedness(fam, m.family) * cfg.experience.studyOnly);
      if (r > rel) { rel = r; study = m; target = null; }
    }
  }
  const known = pf.roles.some((r) => r.family) || pf.targetFamilies.length > 0 || pf.majorFamilies.length > 0;
  if (!known) {
    reasons.push({
      code: 'role_unknown_profile',
      text: pf.hasWork
        ? `Not enough information: jobleft could not tell the kind of work in your profile roles (${listNames(pf.roles.map((r) => q(r.title)), 4)}).`
        : 'Not enough information: your profile has no work history, target titles or field of study.',
      points: 0,
    });
    return { rel: null, reasons, relevantMonths: null };
  }
  if (rel <= 0) rel = cfg.experience.unrelated;
  if (bestRole && relRoles >= rel && relRoles > 0) {
    if (best >= 1) {
      reasons.push({ code: 'role_match', text: `The job is ${jobKind} work (title ${titleWords}); you have ${formatMonths(sameMonths)} in it, as ${listNames([...new Set(pf.families.get(fam)!.roles.map((r) => q(r.title)))], 3)}.`, points: 0 });
    } else {
      reasons.push({ code: 'role_related', text: `The job is ${jobKind} work (title ${titleWords}); your closest role is ${q(bestRole.title)} (${familyLabel(bestRole.family!).toLowerCase()}), related but not the same work, so it counts ${Math.round(relRoles * 100)}%.`, points: -Math.round((1 - relRoles) * 100) });
    }
  } else if (target) {
    reasons.push({ code: 'role_target_only', text: `The job is ${jobKind} work; no past role in your profile is in it, but your target ${q(target.text)} is. Target titles count at most ${Math.round(cfg.experience.targetOnly * 100)}%.`, points: -Math.round((1 - rel) * 100) });
  } else if (study) {
    reasons.push({ code: 'role_study_only', text: `The job is ${jobKind} work; no past role in your profile is in it, but your field of study ${q(study.text)} is. Study counts at most ${Math.round(cfg.experience.studyOnly * 100)}%.`, points: -Math.round((1 - rel) * 100) });
  } else {
    const kinds = [...new Set(pf.roles.filter((r) => r.family).map((r) => familyLabel(r.family!).toLowerCase()))];
    reasons.push({ code: 'role_unrelated', text: `The job is ${jobKind} work (title ${titleWords}); none of your roles is in it or close to it${kinds.length ? ` (your roles are ${listNames(kinds, 3)})` : ''}.`, points: -Math.round((1 - rel) * 100) });
  }
  return { rel, reasons, relevantMonths: best >= 1 ? sameMonths : bestRole ? 0 : null };
}

/**
 * Months of work like this job: roles of the same (or a very close) kind count fully, related roles count half,
 * other roles are not counted. A role whose kind cannot be read counts fully (it is never assumed unrelated).
 */
function relevantWork(pf: ProfileFacts, fam: string | null): { months: number | null; full: RoleFact[]; half: RoleFact[]; none: RoleFact[] } {
  const dated = pf.roles.filter((r) => r.from !== null);
  if (pf.totalMonths === null) return { months: null, full: [], half: [], none: [] };
  if (!dated.length) return { months: pf.totalMonths, full: [], half: [], none: [] };
  if (!fam) return { months: pf.totalMonths, full: dated, half: [], none: [] };
  const full: RoleFact[] = [], half: RoleFact[] = [], none: RoleFact[] = [];
  for (const r of dated) {
    const rel = r.family ? familyRelatedness(fam, r.family) : 1;
    if (rel >= 0.7) full.push(r); else if (rel >= 0.4) half.push(r); else none.push(r);
  }
  const f = unionMonths(full);
  const both = unionMonths([...full, ...half]);
  return { months: f + Math.round((both - f) / 2), full, half, none };
}

function scoreExperience(pf: ProfileFacts, jf: JobFacts, cfg: MatchConfig, now: number): ExperienceOut {
  const reasons: Reason[] = [];
  const blockers: ExperienceOut['blockers'] = [];
  const mustHaves: MustHave[] = [];
  const caps: Array<{ cap: number; reason: string }> = [];
  void now;
  const work = relevantWork(pf, jf.family);
  const kind = jf.family ? familyLabel(jf.family).toLowerCase() : null;
  const role = (r: RoleFact) => ({ title: r.title, company: r.company, from: monthLabel(r.from!), to: r.current ? 'present' : monthLabel(r.to!), months: r.months });
  const detail: ExperienceDetail = {
    totalMonths: pf.totalMonths,
    text: work.months === null ? 'not in your profile (no roles with dates)'
      : !pf.hasWork ? 'no work history in your profile (counted as 0)'
      : work.months === pf.totalMonths ? formatMonths(work.months)
      : `${formatMonths(work.months)} of ${kind} and related work (${formatMonths(pf.totalMonths!)} of work in total)`,
    rolesCounted: work.full.map(role),
    rolesNotCounted: [
      ...work.half.map((r) => ({ title: r.title, company: r.company, why: `counted at half: related but not the same kind of work (${r.months} months, ${monthLabel(r.from!)} to ${r.current ? 'present' : monthLabel(r.to!)})` })),
      ...work.none.map((r) => ({ title: r.title, company: r.company, why: `not counted: a different kind of work than ${kind ?? 'this job'} (${r.months} months)` })),
      ...pf.roles.filter((r) => r.from === null).map((r) => ({ title: r.title, company: r.company, why: r.notCounted ?? 'no dates' })),
    ],
    relevantMonths: work.months,
    jobYears: jf.years ? { min: jf.years.detail.minYears ?? null, max: jf.years.detail.maxYears ?? null, importance: jf.years.importance, quote: jf.years.quote } : null,
    jobLevel: jf.level ? LEVEL_WORD[jf.level] : null,
  };
  const { rel, reasons: relReasons } = relevanceOf(pf, jf, cfg);
  const years = work.months === null ? null : work.months / 12;
  const yearsUsed = years === null ? null : Math.round(years * 100) / 100;
  const yearsText = work.months === null ? 'no dated work' : pf.hasWork && work.months !== pf.totalMonths && kind
    ? `${formatMonths(work.months)} of ${kind} and related work`
    : `${formatMonths(work.months)} of work`;

  // Level fit.
  const scale = scaleOf(jf.family);
  let levelFit: number | null = null;
  const levelReasons: Reason[] = [];
  // A level read only from the years the posting asks for is used for "above the level" only (the years themselves
  // are compared below, so being under is not counted twice).
  const levelFromYearsOnly = jf.levelSource === 'years';
  if (jf.level && !levelFromYearsOnly) {
    const jobOrd = LEVEL_ORD[scale][jf.level];
    const levelSrc = jf.levelSource === 'title' || jf.levelSource === 'job' ? `title ${q(jf.levelEvidence ?? jf.job.title)}` : q(jf.levelEvidence ?? '');
    if (years === null) {
      if (!levelFromYearsOnly) levelReasons.push({ code: 'level_no_dates', text: `The job is ${LEVEL_WORD[jf.level]} (${levelSrc}); your work dates are not in your profile, so the level cannot be checked.`, points: 0 });
    } else {
      // In frontline work, years alone make a person experienced, not a supervisor: titles show the rest.
      const candYears = scale === 'frontline' ? Math.min(yearsOrd(years, scale), 2) : yearsOrd(years, scale);
      // Titles can lift the level a little above the years (a charge nurse, a shift lead), never far.
      let titleOrd = 0;
      let candLead = 0;
      let leadTitle: string | null = null;
      for (const r of pf.roles) {
        const l = levelOfTitle(r.title);
        if (!l) continue;
        const related = !r.family || !jf.family ? 0.5 : familyRelatedness(jf.family, r.family);
        if (related >= 0.3) {
          titleOrd = Math.max(titleOrd, LEVEL_ORD[scale][l]);
          if ((LEAD_ORD[l] ?? 0) > candLead) { candLead = LEAD_ORD[l]; leadTitle = r.title; }
        }
      }
      const cand = Math.max(candYears, Math.min(titleOrd, candYears + 1));
      const gap = jobOrd - cand;
      // Below the level costs a lot; far above it costs too (a step down is rarely a strong fit).
      let fit = gap > 0.5 ? 100 - (gap - 0.5) * 30 : gap < -1.5 ? 100 - (-gap - 1.5) * 25 : 100;
      fit = clamp(fit, gap > 0 ? 15 : scale === 'frontline' ? 60 : 50, 100);
      if (levelFromYearsOnly && gap > 0) fit = 100;
      const jobLead = LEAD_ORD[jf.level] ?? 0;
      const tech = jf.family === 'software' || jf.family === 'data' || jf.family === 'security';
      const peopleRole = !levelFromYearsOnly && jobLead > 0 && !(tech && jf.level === 'lead');
      const leadGap = peopleRole ? jobLead - candLead : 0;
      if (leadGap >= 1) {
        const capFit = leadGap >= 3 ? 40 : leadGap === 2 ? 60 : 75;
        const needs = candLead === 0 ? 'no role in your profile has a lead, supervisor or manager title' : `the most senior people-leading title in your profile is ${leadGap >= 2 ? 'at least two levels' : 'one level'} below it`;
        if (capFit < fit) {
          fit = capFit;
          levelReasons.push({ code: 'lead_gap', text: `The job leads people as ${article(LEVEL_WORD[jf.level])} ${LEVEL_WORD[jf.level].toLowerCase()} (${levelSrc}); ${needs}.`, points: -(100 - capFit) });
        }
        if (leadGap >= 2) blockers.push({ kind: 'level', message: `This is ${article(LEVEL_WORD[jf.level])} ${LEVEL_WORD[jf.level]} role that leads people (title ${q(jf.job.title)}); ${needs}.`, quote: jf.job.title, source: 'title' });
      }
      // A manager applying to a role that leads nobody at entry or mid level is stepping down.
      if (candLead >= 2 && jobLead === 0 && jobOrd <= LEVEL_ORD[scale].mid && fit > 60) {
        fit = 60;
        const why = `You have led people (${q(leadTitle ?? '')}); this job is ${LEVEL_WORD[jf.level]} (${levelSrc}) and leads nobody, a step down.`;
        levelReasons.push({ code: 'step_down', text: why, points: -40 });
        caps.push({ cap: cfg.caps.stepDown, reason: why });
      } else if (gap <= -2 && !levelFromYearsOnly) {
        caps.push({ cap: cfg.caps.stepDown, reason: `The job is ${LEVEL_WORD[jf.level]} (${levelSrc}), well below the level of ${yearsText} in your profile.` });
      }
      levelFit = Math.round(fit);
      if (gap > 0.5 && !levelFromYearsOnly) {
        levelReasons.push({ code: 'level_below', text: `The job is ${LEVEL_WORD[jf.level]} (${levelSrc}); ${yearsText} in your profile puts you about ${gap >= 1.5 ? `${Math.round(gap)} levels` : 'one level'} below it.`, points: -(100 - levelFit) });
        if (gap >= 2.5 && !blockers.some((b) => b.kind === 'level')) blockers.push({ kind: 'level', message: `This is ${article(LEVEL_WORD[jf.level])} ${LEVEL_WORD[jf.level]} role (title ${q(jf.job.title)}); your profile shows ${yearsText}, well below that level.`, quote: jf.job.title, source: 'title' });
      } else if (gap < -1.5) {
        levelReasons.push({ code: 'level_above', text: `The job is ${LEVEL_WORD[jf.level]} (${levelSrc}); with ${yearsText} you are above that level and may be overqualified.`, points: -(100 - levelFit) });
      } else if (!levelReasons.length && !levelFromYearsOnly) {
        levelReasons.push({ code: 'level_fit', text: `The job is ${LEVEL_WORD[jf.level]} (${levelSrc}); ${yearsText} in your profile fits that level.`, points: 0 });
      }
      if (levelFromYearsOnly && levelFit === 100) levelFit = null;
    }
  }
  // Work one tier below your current field (patient-care support for a registered nurse) is a step down.
  if (jf.family && STEP_DOWN[jf.family]) {
    const current = pf.roles.filter((r) => r.family && STEP_DOWN[jf.family!].includes(r.family) && (r.current || (r.months >= 24)));
    if (current.length && !pf.roles.some((r) => r.current && r.family === jf.family)) {
      const cap = 60;
      const why = `The job is ${familyLabel(jf.family).toLowerCase()} work, a step below your ${familyLabel(current[0].family!).toLowerCase()} role ${q(current[0].title)}.`;
      if (levelFit === null || levelFit > cap) {
        levelFit = cap;
        levelReasons.push({ code: 'step_down', text: why, points: -40 });
      }
      caps.push({ cap: cfg.caps.stepDown, reason: why });
    }
  }

  // Years fit.
  let yearsFit: number | null = null;
  const y = jf.years;
  if (y) {
    const min = y.detail.minYears ?? null;
    const max = y.detail.maxYears ?? null;
    const label = yearsLabel(min, max);
    const pref = y.importance === 'preferred';
    const mh: MustHave = { kind: 'years', requirement: `${label} of experience${pref ? ' (preferred)' : ''}`, importance: pref ? 'preferred' : 'required', state: 'info', quote: y.quote, message: '' };
    if (years === null) {
      mh.state = pref ? 'info' : 'not_in_profile';
      mh.message = `The posting asks for ${label} (${q(y.quote)}); your work dates are not in your profile.`;
      levelReasons.push({ code: 'years_no_dates', text: mh.message, points: 0 });
    } else if (min === null || min === 0) {
      yearsFit = 100;
      mh.state = 'met';
      mh.message = `The posting asks for ${label} (${q(y.quote)}).`;
      levelReasons.push({ code: 'years_met', text: `The posting asks for ${label} (${q(y.quote)}); your profile shows ${yearsText}.`, points: 0 });
    } else if (years >= min) {
      yearsFit = max !== null && years > max + 4 ? 90 : 100;
      if (max !== null && max <= 3 && years > max + 4 && !y.detail.alternative) caps.push({ cap: cfg.caps.stepDown, reason: `The posting asks for ${label} (${q(y.quote)}); with ${yearsText} you are well above that range.` });
      mh.state = 'met';
      mh.message = `The posting asks for ${label} (${q(y.quote)}); your profile shows ${yearsText}.`;
      levelReasons.push({ code: 'years_met', text: mh.message + (yearsFit < 100 ? ' That is well above the range.' : ''), points: yearsFit - 100 });
    } else {
      const ratio = years / min;
      yearsFit = Math.round(30 + 70 * Math.pow(ratio, 1.2));
      if (pref) yearsFit = Math.round((yearsFit + 100) / 2);
      mh.state = pref ? 'info' : 'unmet';
      mh.message = `The posting ${pref ? 'prefers' : 'asks for'} ${label} (${q(y.quote)}); your profile shows ${yearsText}.`;
      levelReasons.push({ code: 'years_short', text: mh.message, points: yearsFit - 100 });
      if (!pref && ratio < 0.6 && min - years >= 2) blockers.push({ kind: 'years', message: mh.message, quote: y.quote, source: 'description' });
    }
    mustHaves.push(mh);
  }

  let levelYears: number | null;
  if (levelFit !== null && yearsFit !== null) levelYears = (levelFit + yearsFit) / 2;
  else levelYears = levelFit ?? yearsFit;
  if (levelYears === null && !jf.level && !y) {
    levelReasons.push({ code: 'level_not_stated', text: `The posting states no level and no years of experience, so jobleft cannot confirm the level fits; this part is at most ${cfg.experience.noLevelStated}%.`, points: -(100 - cfg.experience.noLevelStated) });
  } else if (levelYears === null && jf.levelSource === 'years') {
    // Level came only from the years: nothing more to add.
  }

  reasons.push(...relReasons, ...levelReasons);
  let percent: number | null = null;
  if (rel !== null) {
    const base = levelYears ?? (years === null && (jf.level || y) ? null : cfg.experience.noLevelStated);
    percent = base === null ? null : pct(rel * base);
  }
  if (percent === null && rel !== null) {
    reasons.push({ code: 'level_unknown', text: 'Not enough information: the level cannot be checked without work dates in your profile.', points: 0 });
  }
  return { sub: { percent, reasons: ensureReason(percent, reasons, 'Experience Level') }, detail, yearsUsed, levelFit, blockers, mustHaves, caps };
}

function ensureReason(percent: number | null, reasons: Reason[], part: string): Reason[] {
  if (reasons.length) return reasons;
  return [{ code: percent === null ? 'unknown' : 'computed', text: percent === null ? `Not enough information to judge ${part}.` : `${part}: ${percent}%.`, points: 0 }];
}

// ---------------------------------------------------------------- Skills

/** A higher licence covers a lower one of the same kind (OSHA 30 covers OSHA 10; a CDL-A covers a driver's licence). */
const COVERS: Record<string, string[]> = {
  master_elec: ['journeyman_elec', 'elec_apprentice'], journeyman_elec: ['elec_apprentice'], osha30: ['osha10'],
  cdl_a: ['cdl_b', 'cdl', 'drivers_license'], cdl_b: ['cdl', 'drivers_license'], cdl: ['drivers_license'],
  aprn: ['rn'], servsafe: ['food_handler'], ccnp: ['ccna'], cfa: [], cpa: [], lcsw: [], bcba: ['rbt'],
  paramedic: ['emt'], acls: ['bls', 'cpr_skill', 'cpr'], pals: ['cpr_skill', 'cpr'], bls: ['cpr_skill', 'cpr'],
  critical_care: ['acute_care'], med_surg: ['acute_care'], emergency_nursing: ['acute_care'], telemetry: ['acute_care'],
  perioperative: ['acute_care'], nicu: ['pediatrics'],
};

function heldOrBetter(pf: ProfileFacts, id: string): import('./profile.ts').HeldSkill | null {
  const h = pf.held.get(id);
  if (h) return h;
  for (const [better, covered] of Object.entries(COVERS)) if (covered.includes(id) && pf.held.has(better)) return pf.held.get(better)!;
  return null;
}

interface SkillsOut { sub: SubScore; checks: SkillCheck[]; lists: MatchResult['skills']; coverage: number | null; total: number }

function scoreSkills(pf: ProfileFacts, jf: JobFacts, cfg: MatchConfig): SkillsOut {
  const reasons: Reason[] = [];
  const empty: MatchResult['skills'] = { matched: [], missing: [], required: [], preferred: [] };
  if (jf.language === 'other') {
    reasons.push({ code: 'skills_not_english', text: 'Not enough information: the posting is not in English, and jobleft reads skills in English postings only.', points: 0 });
    return { sub: { percent: null, reasons }, checks: [], lists: empty, coverage: null, total: 0 };
  }
  const nameOf = (id: string) => (id.startsWith('alt:') ? id.slice(4).split('|').map(skillName).join(' or ') : skillName(id));
  const items: Array<JobSkillItem & { name: string; raw?: boolean }> = jf.skills.map((s) => ({ ...s, name: nameOf(s.id) }));
  // Profile skills the dictionaries do not know, matched word for word ("Pyxis", "Kronos").
  if (pf.rawSkills.length) {
    const toks = jf.text.live.filter((t) => { const sec = jf.text.lines[t.line]?.section; return sec !== 'about' && sec !== 'benefits' && sec !== 'eeo'; });
    const words = toks.map((t) => t.norm);
    for (const r of pf.rawSkills) {
      const w = r.words.map((x) => x);
      for (let i = 0; i + w.length <= words.length; i++) {
        if (!w.every((x, k) => words[i + k] === x)) continue;
        const t0 = toks[i];
        const sec = jf.text.lines[t0.line]?.section ?? 'other';
        // Word-for-word names count only where the posting says what it needs.
        const sentence = jf.text.sentences[t0.sentence]?.text ?? '';
        if (sec !== 'required' && sec !== 'preferred' && !REQUIREMENT_SENTENCE.test(sentence)) continue;
        const imp = sec === 'preferred' ? 'preferred' : 'required';
        items.push({ id: `raw:${r.name.toLowerCase()}`, importance: imp, quote: jf.text.text.slice(t0.start, toks[i + w.length - 1].end), start: t0.start, name: r.name, raw: true });
        break;
      }
    }
  }
  const hasRequired = items.some((i) => i.importance === 'required');
  const weightOf = (imp: JobSkillItem['importance']) => imp === 'required' ? cfg.skills.required : imp === 'preferred' ? cfg.skills.preferred : hasRequired ? cfg.skills.mentioned : cfg.skills.required;
  const checks: SkillCheck[] = [];
  let num = 0, den = 0;
  for (const it of items) {
    const w = weightOf(it.importance);
    let state: SkillCheck['state'] = 'missing';
    let credit = 0;
    let from: string | null = null;
    let via: string | null = null;
    if (it.raw) { state = 'met'; credit = 1; from = `your skills list ("${it.name}")`; }
    else {
      const ids = it.id.startsWith('alt:') ? it.id.slice(4).split('|') : [it.id];
      const h = ids.map((id) => heldOrBetter(pf, id)).find((x) => x) ?? null;
      if (h) { state = 'met'; credit = 1; from = heldFrom(h); }
      else {
        const def = SKILLS.get(ids[0])!;
        const rel = ids.length === 1 ? [...def.related].find((r) => pf.held.has(r)) : undefined;
        const implied = ids.map((id) => pf.impliedCreds.get(id)).find((x) => x);
        if (rel) { state = 'related'; credit = cfg.skills.related; via = skillName(rel); from = heldFrom(pf.held.get(rel)!); }
        else if (implied) { state = 'implied'; credit = cfg.skills.implied; via = implied; }
      }
    }
    num += credit * w;
    den += w;
    checks.push({ name: it.name, importance: it.importance, state, quote: it.quote, heldFrom: from, via });
  }
  const lists: MatchResult['skills'] = {
    matched: checks.filter((c) => c.state === 'met').map((c) => c.name),
    missing: checks.filter((c) => c.state !== 'met').map((c) => c.name),
    required: checks.filter((c) => c.importance !== 'preferred').map((c) => c.name),
    preferred: checks.filter((c) => c.importance === 'preferred').map((c) => c.name),
  };
  const judgeable = items.length >= cfg.skills.minItems || hasRequired;
  if (!items.length) {
    reasons.push({ code: 'skills_none_listed', text: jf.words < 25 ? 'Not enough information: the posting has too little text to name any skills.' : 'Not enough information: the posting names no skills or credentials that jobleft can check.', points: 0 });
    return { sub: { percent: null, reasons }, checks, lists, coverage: null, total: 0 };
  }
  if (!judgeable) {
    reasons.push({ code: 'skills_too_few', text: `Not enough information: the posting names only ${checks[0].name} (${q(checks[0].quote)}) and no requirement list.`, points: 0 });
    return { sub: { percent: null, reasons }, checks, lists, coverage: null, total: items.length };
  }
  const coverage = den > 0 ? num / den : 0;
  const percent = pct(coverage * 100);
  const met = checks.filter((c) => c.state === 'met');
  const reqChecks = checks.filter((c) => c.importance === 'required');
  const reqMet = reqChecks.filter((c) => c.state === 'met');
  const share = (c: SkillCheck) => Math.round((weightOf(c.importance) / den) * 100);
  if (reqChecks.length) {
    reasons.push({ code: 'skills_required', text: `You have ${reqMet.length} of the ${reqChecks.length} skills and credentials the posting lists as required${reqMet.length ? `: ${listNames(reqMet.map((c) => c.name))}` : ''}.`, points: reqMet.reduce((s, c) => s + share(c), 0) });
  }
  const others = met.filter((c) => c.importance !== 'required');
  if (others.length) reasons.push({ code: 'skills_matched', text: `You also have ${listNames(others.map((c) => `${c.name} (${c.importance})`))}.`, points: others.reduce((s, c) => s + share(c), 0) });
  const missing = checks.filter((c) => c.state === 'missing');
  if (missing.length) reasons.push({ code: 'skills_missing', text: `Not in your profile: ${listNames(missing.map((c) => `${c.name}${c.importance === 'preferred' ? ' (preferred)' : ''}`))}.`, points: -missing.reduce((s, c) => s + share(c), 0) });
  for (const c of checks.filter((x) => x.state === 'related')) {
    reasons.push({ code: 'skills_related', text: `${c.name} is not in your profile; you have ${c.via}, a related skill, which counts half.`, points: -Math.round(share(c) / 2) });
  }
  for (const c of checks.filter((x) => x.state === 'implied')) {
    reasons.push({ code: 'skills_implied', text: `${c.name}: not in your profile. Your role ${q(c.via ?? '')} suggests it, so it counts half until you add it.`, points: -Math.round(share(c) / 2) });
  }
  if (items.length > cfg.skills.stuffing) {
    reasons.push({ code: 'skills_many', text: `The posting names ${items.length} different skills; each counts once, however often it repeats.`, points: 0 });
  }
  const sources = new Set(met.map((c) => c.heldFrom).filter((x): x is string => !!x && !x.startsWith('your skills list')));
  if (sources.size) reasons.push({ code: 'skills_from_history', text: `Skills not in your skills list were read from ${listNames([...sources], 3)}.`, points: 0 });
  return { sub: { percent, reasons }, checks, lists, coverage, total: items.length };
}

// ---------------------------------------------------------------- Industry Experience

interface IndustryOut { sub: SubScore; matched: string | null; fact: JobFactView }

function scoreIndustry(pf: ProfileFacts, jf: JobFacts, cfg: MatchConfig): IndustryOut {
  const reasons: Reason[] = [];
  const top = jf.industries[0] ?? null;
  const fact: JobFactView = top
    ? { value: industryName(top.industry), text: `${industryName(top.industry)} (${top.source === 'company' ? 'company data' : top.source === 'title' ? 'from the job title' : 'from the posting'})`, quote: top.source === 'posting' ? top.evidence : top.source === 'title' ? jf.job.title : null }
    : { value: null, text: 'not stated', quote: null };
  if (!top) {
    reasons.push({ code: 'industry_not_stated', text: jf.language === 'other' ? 'Not enough information: the posting is not in English.' : 'Not enough information: the posting does not say what industry the employer is in.', points: 0 });
    return { sub: { percent: null, reasons }, matched: null, fact };
  }
  const jobInd = industryName(top.industry);
  const jobEv = top.source === 'posting' ? `the posting says ${q(top.evidence)}` : top.source === 'company' ? `company data: ${top.evidence}` : `the title ${q(jf.job.title)}`;
  if (!pf.industries.size) {
    reasons.push({
      code: pf.hasWork ? 'industry_profile_unknown' : 'industry_no_work',
      text: pf.hasWork ? `Not enough information: the job is in ${jobInd} (${jobEv}), but your roles do not name their industries.` : `Not enough information: the job is in ${jobInd} (${jobEv}); your profile has no work history.`,
      points: 0,
    });
    return { sub: { percent: null, reasons }, matched: null, fact };
  }
  let best = 0, bestInd: string | null = null, bestJob = top.industry;
  for (const ji of jf.industries) {
    for (const [pi] of pf.industries) {
      const r = industryRelatedness(ji.industry, pi) * (ji === top ? 1 : 0.9);
      if (r > best || (r === best && bestInd && pf.industries.get(pi)!.months > pf.industries.get(bestInd)!.months)) { best = r; bestInd = pi; bestJob = ji.industry; }
    }
  }
  if (bestInd && best >= 0.9) {
    const v = pf.industries.get(bestInd)!;
    const m = v.months;
    const percent = m >= 24 ? 100 : m >= 12 ? 90 : m >= 6 ? 80 : 70;
    reasons.push({ code: 'industry_match', text: `The job is in ${industryName(bestJob)} (${jobEv}); you have ${formatMonths(m)} in ${industryName(bestInd)}, as ${v.role} (from ${v.evidence}).`, points: percent - 100 });
    return { sub: { percent, reasons }, matched: industryName(bestInd), fact };
  }
  if (bestInd && best > 0) {
    const v = pf.industries.get(bestInd)!;
    const percent = pct(best * 90);
    reasons.push({ code: 'industry_related', text: `The job is in ${industryName(bestJob)} (${jobEv}); you have worked in ${industryName(bestInd)}, a related industry, as ${v.role} (from ${v.evidence}).`, points: percent - 100 });
    return { sub: { percent, reasons }, matched: null, fact };
  }
  const yours = [...pf.industries.keys()].map(industryName);
  reasons.push({ code: 'industry_other', text: `The job is in ${jobInd} (${jobEv}); your roles are in ${listNames(yours, 4)}.`, points: cfg.industry.unrelated - 100 });
  return { sub: { percent: cfg.industry.unrelated, reasons }, matched: null, fact };
}

// ---------------------------------------------------------------- must-haves

interface MustOut { mustHaves: MustHave[]; blockers: Blocker[]; capBy: Array<{ cap: number; reason: string }> }

function evaluateMustHaves(pf: ProfileFacts, jf: JobFacts, cfg: MatchConfig): MustOut {
  const auth = pf.profile.workAuthorization;
  const mustHaves: MustHave[] = [];
  const blockers: Blocker[] = [];
  const capBy: MustOut['capBy'] = [];
  const block = (kind: Blocker['kind'] | 'licence' | 'degree', m: MustHave, cap: number) => {
    if (m.importance !== 'required') return;
    if (m.state !== 'unmet' && m.state !== 'not_in_profile' && m.state !== 'in_progress') return;
    const state = m.state === 'unmet' ? 'unmet' : 'not_in_profile';
    const b = {
      kind: kind as Blocker['kind'], message: m.message, evidence: { source: 'description' as const, text: m.quote.slice(0, 500) },
      state, requirement: m.requirement, dealBreaker: false,
    } as Blocker;
    blockers.push(b);
    capBy.push({ cap: state === 'unmet' ? cap : cfg.caps.notInProfile, reason: m.message });
  };
  const seen = new Set<string>();
  for (const r of jf.requirements) {
    if (r.kind === 'years') continue; // Experience Level handles years.
    const key = `${r.kind}:${r.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const m: MustHave = { kind: r.kind, requirement: r.label, importance: r.importance, state: 'info', quote: r.quote, message: '' };
    const said = `(${q(r.quote)})`;
    switch (r.kind) {
      case 'sponsorship': {
        if (r.detail.sponsorship === 'yes') { m.state = 'info'; m.message = `The posting says it sponsors visas ${said}.`; mustHaves.push(m); break; }
        const need = auth.needsSponsorship;
        if (need === 'yes') { m.state = 'unmet'; m.message = `The posting says it will not sponsor a visa ${said}. Your profile says you will need visa sponsorship.`; }
        else if (need === 'no') { m.state = 'met'; m.message = `The posting says it will not sponsor a visa ${said}. Your profile says you do not need sponsorship.`; }
        else { m.state = 'not_in_profile'; m.message = `The posting says it will not sponsor a visa ${said}. Whether you need sponsorship is not in your profile.`; }
        mustHaves.push(m);
        block('sponsorship', m, cfg.caps.legal);
        break;
      }
      case 'work_authorization': {
        const c = r.detail.country ?? 'US';
        if (c === 'US') {
          const a = auth.usAuthorized;
          if (a === 'yes') { m.state = 'met'; m.message = `The posting requires authorization to work in the US ${said}. Your profile says you are authorized.`; }
          else if (a === 'no') { m.state = 'unmet'; m.message = `The posting requires authorization to work in the US ${said}. Your profile says you are not authorized to work in the US.`; }
          else { m.state = 'not_in_profile'; m.message = `The posting requires authorization to work in the US ${said}. Whether you are authorized is not in your profile.`; }
        } else {
          const has = auth.authorizedCountries.includes(c) || (c === 'EU' && auth.authorizedCountries.some((x) => EU.has(x)));
          if (has) { m.state = 'met'; m.message = `The posting requires authorization to work in ${r.label.replace('Authorized to work in ', '')} ${said}. Your profile lists it.`; }
          else { m.state = 'not_in_profile'; m.message = `The posting requires authorization to work in ${r.label.replace('Authorized to work in ', '')} ${said}. That is not in your profile.`; }
        }
        mustHaves.push(m);
        block('work_authorization', m, cfg.caps.legal);
        break;
      }
      case 'citizenship': {
        const cit = auth.usCitizen;
        const orPr = r.detail.citizenship === 'citizen_or_pr';
        if (cit === 'yes') { m.state = 'met'; m.message = `The posting requires ${orPr ? 'US citizenship or permanent residence' : 'US citizenship'} ${said}. Your profile says you are a US citizen.`; }
        else if (cit === 'no') {
          if (orPr && auth.needsSponsorship !== 'yes') { m.state = 'not_in_profile'; m.message = `The posting requires US citizenship or permanent residence ${said}. Your profile says you are not a US citizen; whether you are a permanent resident is not in your profile.`; }
          else { m.state = 'unmet'; m.message = `The posting requires ${orPr ? 'US citizenship or permanent residence' : 'US citizenship'} ${said}. Your profile says you are not a US citizen${orPr ? ' and need sponsorship' : ''}.`; }
        } else { m.state = 'not_in_profile'; m.message = `The posting requires ${orPr ? 'US citizenship or permanent residence' : 'US citizenship'} ${said}. Your citizenship is not in your profile.`; }
        if (r.importance === 'preferred') { m.message = m.message.replace('requires', 'prefers'); m.state = m.state === 'met' ? 'met' : 'info'; }
        mustHaves.push(m);
        block('citizenship', m, cfg.caps.legal);
        break;
      }
      case 'clearance': {
        const has = auth.hasSecurityClearance;
        const lvl = r.detail.clearanceLevel ?? 'security';
        if (r.importance === 'obtainable') {
          if (has === 'yes') { m.state = 'met'; m.message = `The posting asks that you can obtain a ${lvl} clearance ${said}. Your profile says you hold a clearance.`; }
          else if (auth.usCitizen === 'no') { m.state = 'unmet'; m.importance = 'required'; m.message = `The posting asks that you can obtain a ${lvl} clearance ${said}. US security clearances require US citizenship, and your profile says you are not a US citizen.`; }
          else if (auth.usCitizen === 'yes') { m.state = 'met'; m.message = `The posting asks that you can obtain a ${lvl} clearance ${said}. Your profile says you are a US citizen, which clearances require.`; }
          else { m.state = 'info'; m.message = `The posting asks that you can obtain a ${lvl} clearance ${said}. Your citizenship is not in your profile.`; }
        } else if (r.importance === 'preferred') {
          m.state = has === 'yes' ? 'met' : 'info';
          m.message = `The posting prefers a ${lvl} clearance ${said}; it is not a must-have.${has === 'yes' ? ' Your profile says you hold a clearance.' : ''}`;
        } else {
          const what = r.label.charAt(0).toLowerCase() + r.label.slice(1);
          if (has === 'yes') { m.state = 'met'; m.message = `The posting requires ${article(what)} ${what} ${said}. Your profile says you hold a security clearance${lvl !== 'security' ? ' (the level is not in your profile)' : ''}.`; }
          else if (has === 'no') { m.state = 'unmet'; m.message = `The posting requires ${article(what)} ${what} ${said}. Your profile says you do not hold a security clearance.`; }
          else { m.state = 'not_in_profile'; m.message = `The posting requires ${article(what)} ${what} ${said}. Whether you hold a clearance is not in your profile.`; }
        }
        mustHaves.push(m);
        block('clearance', m, cfg.caps.legal);
        break;
      }
      case 'licence': {
        const ids = r.detail.credIds ?? [];
        const heldId = ids.find((id) => heldOrBetter(pf, id));
        const impliedId = ids.find((id) => pf.impliedCreds.has(id));
        const name = r.label;
        if (r.importance === 'obtainable') {
          m.state = heldId ? 'met' : 'info';
          m.message = heldId ? `The posting asks for ${name} after hire ${said}; your profile already lists it.` : `The posting asks you to obtain ${name} after hire ${said}; it is not needed to apply.`;
        } else if (heldId) {
          m.state = 'met';
          m.message = `The posting ${r.importance === 'preferred' ? 'prefers' : 'requires'} ${name} ${said}; ${heldFrom(heldOrBetter(pf, heldId)!)} has ${pf.held.has(heldId) ? 'it' : `${skillName(heldOrBetter(pf, heldId)!.id)}, which covers it`}.`;
        } else if (r.importance === 'preferred') {
          m.state = 'info';
          m.message = `The posting prefers ${name} ${said}; it is not in your profile, and it is not a must-have.`;
        } else {
          m.state = 'not_in_profile';
          m.message = impliedId
            ? `The posting requires ${name} ${said}. It is not in your profile; your role ${q(pf.impliedCreds.get(impliedId)!)} suggests you may hold it, so add it to your certifications if you do.`
            : `The posting requires ${name} ${said}. It is not in your profile.`;
          mustHaves.push(m);
          blockers.push({ kind: 'licence' as Blocker['kind'], message: m.message, evidence: { source: 'description', text: r.quote.slice(0, 500) }, state: 'not_in_profile', requirement: name, dealBreaker: false } as Blocker);
          // A licence of the trade itself (RN, CPA, journeyman) not in the profile holds the percent lower than a
          // general one (a driver's licence, CPR) or a licence a past title suggests; both are never Strong.
          const tradeLicence = ids.some((id) => { const d = SKILLS.get(id); return d?.credKind === 'licence' && d.families !== null; });
          capBy.push({ cap: impliedId || !tradeLicence ? cfg.caps.notInProfile : Math.min(cfg.caps.licence, cfg.caps.notInProfile), reason: m.message });
          break;
        }
        mustHaves.push(m);
        break;
      }
      case 'degree': {
        const need = r.detail.degreeRank ?? 3;
        const label = r.detail.degreeLabel ?? 'degree';
        const done = pf.degrees.filter((d) => !d.inProgress);
        const bestDone = done.reduce((b, d) => (d.rank > b ? d.rank : b), 0);
        const bestAny = pf.degrees.reduce((b, d) => (d.rank > b ? d.rank : b), 0);
        const orEq = r.detail.orEquivalent;
        if (r.detail.pursuing) {
          const ok = pf.degrees.some((d) => d.rank >= need);
          m.state = ok ? 'met' : pf.hasEducation ? 'unmet' : 'not_in_profile';
          m.message = ok ? `The posting asks for students pursuing ${article(label)} ${label} ${said}; your profile lists one.` : pf.hasEducation ? `The posting asks for students pursuing ${article(label)} ${label} ${said}; your profile lists none at that level.` : `The posting asks for students pursuing ${article(label)} ${label} ${said}. Your education is not in your profile.`;
          if (m.state === 'unmet') m.state = 'info';
        } else if (bestDone >= need) {
          m.state = 'met';
          m.message = `The posting ${r.importance === 'preferred' ? 'prefers' : 'requires'} ${article(label)} ${label} ${said}; your profile lists ${describeDegree(pf, bestDone)}.`;
        } else if (r.importance === 'preferred') {
          m.state = 'info';
          m.message = `The posting prefers ${article(label)} ${label} ${said}; it is not a must-have.`;
        } else if (orEq) {
          m.state = 'info';
          m.message = `The posting asks for ${article(label)} ${label} or equivalent experience ${said}; experience can stand in for it.`;
        } else if (bestAny >= need) {
          m.state = 'in_progress';
          m.message = `The posting requires ${article(label)} ${label} ${said}; yours is in progress in your profile.`;
        } else if (!pf.hasEducation) {
          m.state = 'not_in_profile';
          m.message = `The posting requires ${article(label)} ${label} ${said}. Your education is not in your profile.`;
        } else {
          m.state = 'unmet';
          m.message = `The posting requires ${article(label)} ${label} ${said}; the highest degree in your profile is ${bestDone ? describeDegree(pf, bestDone) : 'not at that level'}.`;
        }
        mustHaves.push(m);
        block('degree', m, cfg.caps.degree);
        break;
      }
    }
  }
  return { mustHaves, blockers, capBy };
}

const EU = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);

function describeDegree(pf: ProfileFacts, rank: number): string {
  const d = pf.degrees.find((x) => x.rank === rank && !x.inProgress) ?? pf.degrees.find((x) => x.rank === rank);
  if (!d) return 'none';
  return `${article(d.label)} ${d.label}${d.text ? ` (${q(d.text)})` : ''}`;
}

// ---------------------------------------------------------------- deal-breakers

interface DealOut { checks: DealBreakerCheck[]; blockers: Blocker[]; capBy: Array<{ cap: number; reason: string }> }

function formatPay(p: NonNullable<Job['pay']>): string {
  const cur = p.currency === 'USD' ? '$' : `${p.currency} `;
  const f = (v: number) => {
    if (p.period === 'year' && v >= 1000) return `${cur}${Math.round(v / 1000)}K`;
    return `${cur}${v % 1 ? v.toFixed(2) : v.toLocaleString('en-US')}`;
  };
  const per = { hour: 'an hour', day: 'a day', week: 'a week', month: 'a month', year: 'a year' }[p.period];
  if (p.min !== null && p.max !== null && p.min !== p.max) return `${f(p.min)}–${f(p.max)} ${per}`;
  if (p.min !== null) return `${p.max === null ? 'from ' : ''}${f(p.min)} ${per}`;
  if (p.max !== null) return `up to ${f(p.max)} ${per}`;
  return 'stated';
}

function payQuote(job: Job): string | null {
  return verbatim(job, job.evidence?.pay?.text);
}

const TYPE_WORD: Record<string, string> = { full_time: 'full-time', part_time: 'part-time', contract: 'contract', internship: 'an internship', temporary: 'temporary', other: 'another job type' };
const MODEL_WORD: Record<string, string> = { onsite: 'onsite', hybrid: 'hybrid', remote: 'remote' };

function evaluateDealBreakers(pf: ProfileFacts, jf: JobFacts, cfg: MatchConfig, distanceMiles?: ScoreInput['distanceMiles']): DealOut {
  const prefs = pf.profile.preferences;
  const job = jf.job;
  const checks: DealBreakerCheck[] = [];
  const blockers: Blocker[] = [];
  const capBy: DealOut['capBy'] = [];
  const broken = (kind: DealBreakerCheck['kind'], message: string, quote: string | null, source: 'description' | 'location_text' | 'board_field' | 'title') => {
    checks.push({ kind, state: 'broken', message, quote });
    blockers.push({
      kind: (kind === 'work_model' ? 'work_model' : kind) as Blocker['kind'], message,
      evidence: quote ? { source, text: quote.slice(0, 500) } : null, state: 'unmet', requirement: message.split('.')[0], dealBreaker: true,
    } as Blocker);
    capBy.push({ cap: cfg.caps.dealBreaker, reason: message });
  };

  // Work model.
  const wants = prefs.workModels;
  if (wants.length && wants.length < 3) {
    const want = wants.map((w) => MODEL_WORD[w]).join(' or ');
    if (!jf.workModel) checks.push({ kind: 'work_model', state: 'not_stated', message: `The posting does not state whether the job is onsite, hybrid or remote; you want ${want}.`, quote: null });
    else if (!wants.includes(jf.workModel)) {
      const where = jf.workModel !== 'remote' && job.places.length ? ` in ${listNames(job.places.map(placeLabel), 3)}` : '';
      broken('work_model', `This job is ${MODEL_WORD[jf.workModel]}${where} (${q(jf.workModelEvidence ?? jf.workModel)}). You want ${want} ${wants.length === 1 ? 'only' : 'work'}.`, jf.workModelEvidence, jf.workModelEvidence && job.description.includes(jf.workModelEvidence) ? 'description' : 'location_text');
    } else checks.push({ kind: 'work_model', state: 'ok', message: `This job is ${MODEL_WORD[jf.workModel]}, as you want.`, quote: jf.workModelEvidence });
  }

  // Location (only for work that needs presence). A posting that also offers remote work ("Austin, TX or Remote")
  // never breaks a place preference of a person open to remote work.
  const wantPlaces = prefs.places.filter((p) => p.text.trim());
  const wantCountries = prefs.countries;
  const remoteOption = jf.workModel !== 'onsite' && !!job.remoteScope && (!prefs.workModels.length || prefs.workModels.includes('remote'));
  if (jf.workModel !== 'remote' && !remoteOption) {
    const places = job.places.filter((p) => p.city || p.region || p.country);
    if (!places.length) {
      if (wantPlaces.length) checks.push({ kind: 'location', state: 'not_stated', message: 'The posting does not state where the job is.', quote: null });
    } else {
      if (wantCountries.length) {
        const known = places.filter((p) => p.country);
        if (known.length && known.every((p) => !wantCountries.includes(p.country!))) {
          broken('location', `This job is in ${listNames(known.map(placeLabel), 3)} (${q(known[0].text)}), outside the countries you want (${wantCountries.join(', ')}).`, known[0].text, 'location_text');
        }
      }
      if (wantPlaces.length && !checks.some((c) => c.kind === 'location' && c.state === 'broken')) {
        let anyMatch = false, anyUnknown = false;
        for (const jp of places) for (const wp of wantPlaces) {
          const v = comparePlace(jp, wp, distanceMiles);
          if (v === 'match') anyMatch = true;
          else if (v !== 'different') anyUnknown = true;
        }
        const wantText = listNames(wantPlaces.map((p) => p.text + (p.radiusMiles ? ` (within ${p.radiusMiles} miles)` : '')), 3);
        if (anyMatch) checks.push({ kind: 'location', state: 'ok', message: `This job is in ${listNames(places.map(placeLabel), 3)}, in a place you want (${wantText}).`, quote: places[0].text });
        else if (anyUnknown) checks.push({ kind: 'location', state: 'not_stated', message: `This job is in ${listNames(places.map(placeLabel), 3)}; jobleft could not check its distance from ${wantText}.`, quote: places[0].text });
        else if (jf.workModel === 'hybrid' || jf.workModel === 'onsite' || jf.workModel === null) {
          broken('location', `This job is in ${listNames(places.map(placeLabel), 3)} (${q(places[0].text)}). The places you want are ${wantText}.`, places[0].text, 'location_text');
        }
      }
    }
  } else if (remoteOption && jf.workModel !== 'remote') {
    checks.push({ kind: 'location', state: 'ok', message: `This job can be done remotely (${q(job.remoteScope!.text)}).`, quote: job.remoteScope!.text });
  } else if (job.remoteScope && wantCountries.length) {
    const regions = job.remoteScope.regions.map((r) => r.toUpperCase());
    if (regions.length && !regions.includes('WORLDWIDE') && !wantCountries.some((c) => regions.includes(c)) && !(regions.includes('NA') && wantCountries.some((c) => c === 'US' || c === 'CA' || c === 'MX')) && !(regions.includes('EU') && wantCountries.some((c) => EU.has(c)))) {
      broken('location', `This remote job accepts people in ${regions.join(', ')} only (${q(job.remoteScope.text)}); the countries you want are ${wantCountries.join(', ')}.`, job.remoteScope.text, 'location_text');
    }
  }

  // Minimum pay.
  const minPay = prefs.minAnnualPayUsd;
  if (minPay !== null && minPay > 0) {
    const p = job.pay;
    if (!p) checks.push({ kind: 'pay', state: 'not_stated', message: 'The posting does not state the pay.', quote: null });
    else if (p.currency !== 'USD') checks.push({ kind: 'pay', state: 'not_stated', message: `The pay is stated in ${p.currency}; your minimum is in US dollars, so jobleft did not compare them.`, quote: payQuote(job) });
    else {
      const top = p.annualMax ?? p.annualMin;
      const conv = p.period !== 'year' ? ' (converted to a year)' : '';
      if (top !== null && top < minPay) broken('pay', `The posting's pay tops out at ${formatPay(p)}${conv}, below your minimum of $${Math.round(minPay).toLocaleString('en-US')} a year.`, payQuote(job), 'description');
      else checks.push({ kind: 'pay', state: 'ok', message: `The pay (${formatPay(p)}) reaches your minimum of $${Math.round(minPay).toLocaleString('en-US')} a year${conv}.`, quote: payQuote(job) });
    }
  }

  // Job type.
  const types = prefs.employmentTypes;
  if (types.length) {
    if (!jf.employmentType) checks.push({ kind: 'employment_type', state: 'not_stated', message: 'The posting does not state the job type.', quote: null });
    else if (!types.includes(jf.employmentType)) {
      broken('employment_type', `This job is ${TYPE_WORD[jf.employmentType]}${jf.employmentTypeEvidence ? ` (${q(jf.employmentTypeEvidence)})` : ''}. You want ${types.map((t) => TYPE_WORD[t]).join(' or ')} work.`, jf.employmentTypeEvidence, jf.employmentTypeEvidence === job.title ? 'title' : 'description');
    } else checks.push({ kind: 'employment_type', state: 'ok', message: `This job is ${TYPE_WORD[jf.employmentType]}, as you want.`, quote: jf.employmentTypeEvidence });
  }
  return { checks, blockers, capBy };
}

// ---------------------------------------------------------------- why-fit chips

const GROWTH = /\b(tuition (reimbursement|assistance)|career (growth|development|advancement|path|ladder|progression)|professional development|promot(e|ion|ions) from within|advancement opportunit\w*|opportunit\w* (for|to) (advance|grow)|mentorship program|leadership development|paid training|clinical ladder|continuing education|education assistance)\b/i;

function chips(pf: ProfileFacts, jf: JobFacts, company: Company | null, sk: SkillsOut, ex: ExperienceOut, ind: IndustryOut, deal: DealOut): WhyFitChip[] {
  const out: Array<WhyFitChip & { rank: number }> = [];
  const needsSponsor = pf.profile.workAuthorization.needsSponsorship === 'yes';
  const spons = jf.requirements.find((r) => r.kind === 'sponsorship');
  if (spons?.detail.sponsorship === 'no') out.push({ kind: 'post_says_no_sponsorship' as WhyFitChip['kind'], label: 'Post says no visa sponsorship', positive: false, rank: needsSponsor ? 0 : 9 });
  if (spons?.detail.sponsorship === 'yes') out.push({ kind: 'post_says_sponsors', label: 'Post says it sponsors visas', positive: true, rank: needsSponsor ? 0 : 6 });
  if (company?.h1b?.status === 'likely') out.push({ kind: 'h1b_sponsor_likely', label: 'H-1B sponsor likely', positive: true, rank: needsSponsor ? 1 : 7 });
  if (sk.sub.percent !== null && sk.total >= 3 && (sk.coverage ?? 0) >= 0.7) {
    const req = sk.checks.filter((c) => c.importance !== 'preferred');
    const met = req.filter((c) => c.state === 'met').length;
    out.push({ kind: 'skills', label: `Has ${met} of ${req.length} skills`, positive: true, rank: 2 });
  }
  if (ex.levelFit !== null && ex.levelFit >= 90 && jf.level && jf.levelSource !== 'years' && (ex.sub.percent ?? 0) >= 70) out.push({ kind: 'level', label: `Right level: ${LEVEL_WORD[jf.level]}`, positive: true, rank: 3 });
  const pay = jf.job.pay;
  if (pay) {
    const payDeal = deal.checks.find((c) => c.kind === 'pay');
    const label = payDeal?.state === 'ok' ? 'Pay meets your minimum' : `Pay stated: ${formatPay(pay)}`;
    out.push({ kind: 'comp_benefits', label: label.slice(0, 60), positive: payDeal?.state !== 'broken', rank: 4 });
  }
  if (jf.workModel === 'remote') {
    const wants = pf.profile.preferences.workModels;
    const scope = jf.job.remoteScope?.regions.length ? ` (${jf.job.remoteScope.regions.slice(0, 3).join(', ')})` : '';
    out.push({ kind: 'location', label: `Remote${scope}`.slice(0, 60), positive: !wants.length || wants.includes('remote'), rank: 5 });
  } else {
    const loc = deal.checks.find((c) => c.kind === 'location' && c.state === 'ok');
    if (loc && jf.job.places.length) out.push({ kind: 'location', label: `In a place you want: ${placeLabel(jf.job.places[0])}`.slice(0, 60), positive: true, rank: 5 });
  }
  if (ind.matched) out.push({ kind: 'industry', label: `${ind.matched} experience`.slice(0, 60), positive: true, rank: 6 });
  // Growth: only when the posting or the company data says so.
  const growth = GROWTH.exec(jf.text.sentences.filter((s) => !s.ignored).map((s) => s.text).join('\n'));
  if (growth) out.push({ kind: 'growth', label: `Growth: ${growth[0].toLowerCase()}`.slice(0, 60), positive: true, rank: 8 });
  else if (company?.facts?.stage?.value === 'growth') out.push({ kind: 'growth', label: 'Growth-stage company', positive: true, rank: 8 });
  const investors = company?.facts?.investors?.value;
  if (investors?.length) out.push({ kind: 'top_investors', label: `Investors: ${investors.slice(0, 2).join(', ')}`.slice(0, 60), positive: true, rank: 9 });
  out.sort((a, b) => a.rank - b.rank || (a.label < b.label ? -1 : 1));
  return out.map(({ rank: _r, ...c }) => c);
}

// ---------------------------------------------------------------- job facts view

function jobFactsView(jf: JobFacts, ind: IndustryOut): MatchExtras['jobFacts'] {
  const job = jf.job;
  const y = jf.years;
  const spons = jf.requirements.find((r) => r.kind === 'sponsorship');
  const pay = job.pay;
  return {
    level: jf.level
      ? { value: LEVEL_WORD[jf.level], text: `${LEVEL_WORD[jf.level]} (${jf.levelSource === 'years' ? 'from the years it asks for' : jf.levelSource === 'employment_type' ? 'an internship' : 'from the title'})`, quote: jf.levelSource === 'years' ? jf.levelEvidence : job.title }
      : { value: null, text: 'not stated', quote: null },
    years: y
      ? { value: yearsLabel(y.detail.minYears ?? null, y.detail.maxYears ?? null), text: `${yearsLabel(y.detail.minYears ?? null, y.detail.maxYears ?? null)}${y.importance === 'preferred' ? ' (preferred)' : ''}`, quote: y.quote }
      : { value: null, text: 'not stated', quote: null },
    pay: pay ? { value: formatPay(pay), text: `${formatPay(pay)}${pay.period !== 'year' && pay.annualMin ? ' (a year when converted: ' + formatPay({ ...pay, min: pay.annualMin, max: pay.annualMax, period: 'year' }) + ')' : ''}`, quote: payQuote(job) } : { value: null, text: 'not stated', quote: null },
    sponsorship: spons
      ? { value: spons.detail.sponsorship === 'no' ? 'does not sponsor' : 'sponsors', text: spons.detail.sponsorship === 'no' ? 'The posting says it does not sponsor visas' : 'The posting says it sponsors visas', quote: spons.quote }
      : { value: null, text: 'not stated', quote: null },
    industry: ind.fact,
    workModel: jf.workModel ? { value: MODEL_WORD[jf.workModel], text: MODEL_WORD[jf.workModel], quote: jf.workModelEvidence } : { value: null, text: 'not stated', quote: null },
    employmentType: jf.employmentType ? { value: TYPE_WORD[jf.employmentType], text: TYPE_WORD[jf.employmentType], quote: jf.employmentTypeEvidence } : { value: null, text: 'not stated', quote: null },
  };
}

// ---------------------------------------------------------------- the score

const profileCache = new Map<string, ProfileFacts>();

/** Profile facts, kept per scoring view and month (the stored version string is not trusted as a key). */
function factsFor(profile: Profile, now: number): ProfileFacts {
  const key = `${monthOf(now)}|${JSON.stringify(scoringView(profile))}`;
  const hit = profileCache.get(key);
  if (hit) return hit;
  const f = profileFacts(profile, now);
  if (profileCache.size > 32) profileCache.clear();
  profileCache.set(key, f);
  return f;
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number | null {
  if (!a || !b || a.length !== b.length || !a.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return null;
  return dot / Math.sqrt(na * nb);
}

export function computeMatch(input: ScoreInput): FullMatchResult {
  const cfg = resolveConfig(input.config);
  const pf = factsFor(input.profile, input.now);
  const jf = readJob(input.job, input.company);
  const ex = scoreExperience(pf, jf, cfg, input.now);
  const sk = scoreSkills(pf, jf, cfg);
  const ind = scoreIndustry(pf, jf, cfg);
  const must = evaluateMustHaves(pf, jf, cfg);
  const deal = evaluateDealBreakers(pf, jf, cfg, input.distanceMiles);

  const E = ex.sub.percent, S = sk.sub.percent, I = ind.sub.percent;
  const w = cfg.weights;
  let raw = w.intercept + w.experience * (E ?? 0) + w.skills * (S ?? 0) + w.industry * (I ?? 0);
  const overall: Reason[] = [];
  const unknownParts: Part[] = [];
  if (E === null) unknownParts.push('experienceLevel');
  if (S === null) unknownParts.push('skills');
  if (I === null) unknownParts.push('industryExperience');
  const show = (x: number | null) => (x === null ? 'not enough information (adds 0)' : String(x));
  overall.push({
    code: 'formula',
    text: `Overall = ${w.intercept} + ${w.experience} × Experience Level ${show(E)} + ${w.skills} × Skills ${show(S)} + ${w.industry} × Industry Experience ${show(I)} = ${Math.round(raw)}.`,
    points: Math.round(raw),
  });
  if (w.semantic) {
    const cos = input.profileVector && input.jobVector ? cosine(input.profileVector, input.jobVector) : null;
    if (cos !== null) {
      const add = w.semantic * clamp((cos - 0.2) / 0.6, 0, 1) * 100;
      raw += add;
      overall.push({ code: 'semantic', text: `Text similarity between your profile and the posting is ${cos.toFixed(2)}; it adds ${Math.round(add)} points.`, points: Math.round(add) });
    }
  }
  let percent = pct(raw);
  const capBy = [...must.capBy, ...deal.capBy, ...ex.blockers.map((b) => ({ cap: b.kind === 'years' ? cfg.caps.years : cfg.caps.level, reason: b.message })), ...ex.caps];
  let cap: MatchExtras['cap'] = null;
  if (capBy.length) {
    const lowest = capBy.reduce((a, b) => (b.cap < a.cap ? b : a));
    if (percent > lowest.cap) {
      overall.push({ code: 'cap', text: `Held at ${lowest.cap} (from ${percent}) because: ${lowest.reason}`, points: lowest.cap - percent });
      percent = lowest.cap;
      cap = { percent: lowest.cap, reason: lowest.reason };
    }
  }
  const notes: string[] = [];
  const complete = unknownParts.length === 0 && jf.language !== 'other';
  if (jf.language === 'other') notes.push('The posting is not in English. jobleft reads English postings, so parts it could not read show "not enough information" and must-haves were not checked.');
  if (!complete) {
    const names = unknownParts.map((p) => (p === 'experienceLevel' ? 'Experience Level' : p === 'skills' ? 'Skills' : 'Industry Experience'));
    const text = `Incomplete: ${listNames(names)} ${names.length === 1 ? 'has' : 'have'} not enough information, so the percent counts only what could be judged and can only be lower than a full score.`;
    overall.push({ code: 'incomplete', text, points: 0 });
    notes.push(text);
  }
  if (jf.words < 25 && jf.language !== 'other') notes.push('The posting has very little text.');

  const blockers: Blocker[] = [
    ...must.blockers,
    ...ex.blockers.map((b) => ({ kind: b.kind, message: b.message, evidence: { source: b.source, text: b.quote.slice(0, 500) }, state: 'unmet', requirement: b.kind === 'years' ? 'Years of experience' : 'Job level', dealBreaker: false } as Blocker)),
    ...deal.blockers,
  ];
  const engineVersion = ENGINE_BASE_VERSION + configTag(cfg);
  const result: FullMatchResult = {
    jobId: input.job.id,
    profileVersion: pf.version,
    engineVersion,
    percent,
    band: bandFor(percent),
    subScores: { experienceLevel: ex.sub, skills: sk.sub, industryExperience: ind.sub },
    whyFit: chips(pf, jf, input.company, sk, ex, ind, deal),
    blockers,
    reasons: overall,
    skills: sk.lists,
    experienceYearsUsed: ex.yearsUsed,
    computedAt: new Date(Date.UTC(Math.floor(monthOf(input.now) / 12), monthOf(input.now) % 12, 1)).toISOString(),
    complete,
    unknownParts,
    mustHaves: [...must.mustHaves, ...ex.mustHaves],
    dealBreakers: deal.checks,
    jobFacts: jobFactsView(jf, ind),
    experience: ex.detail,
    skillDetail: sk.checks,
    cap,
    notes,
  };
  return result;
}

export { foldTitleWords };
