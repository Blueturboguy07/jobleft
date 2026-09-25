// @jobleft/match: the match score. Deterministic first (no network, no AI, free, offline), explained by reasons.
// Output: MatchResult (percent, band STRONG 85+ / GOOD 70-84 / FAIR <70, sub-scores Experience Level, Skills and
// Industry Experience, why-fit chips, blockers, reasons) plus the optional score-view fields (must-haves with the
// posting's own words, deal-breakers, "not stated" facts, the years and roles counted, the skill checks).
// The same profile and job always give the same result. It never reads protected traits (equal-employment answers,
// name, contact details, photo) and never lets posting text steer the score.
// Interface: docs/INTERFACES.md, section "@jobleft/match". Commands: packages/match/README.md.

import type { Company, Job, MatchResult, MatchSummary, Place, PlaceQuery, Profile } from '@jobleft/contracts';
import { summarizeMatch } from '@jobleft/contracts';
import type { SkillDictionary } from '@jobleft/static-data';
import type { MatchConfigInput } from './config.ts';
import { analyzeText, liveText } from './text.ts';
import { profileFacts, profileVersionOf } from './profile.ts';
import { computeMatch, ENGINE_BASE_VERSION, type FullMatchResult } from './score.ts';
import { matchSkillDictionary, scanSkills, skillName } from './taxonomy.ts';

export const PACKAGE_NAME = '@jobleft/match';
/** Bump when the scoring rules change; cached results with another version are recomputed. */
export const ENGINE_VERSION = ENGINE_BASE_VERSION;

export interface MatchInput {
  profile: Profile;
  job: Job;
  company: Company | null;
  /**
   * Accepted for compatibility with the foundation interface and not read: the engine uses its own skill taxonomy
   * (packages/match/data), exported as `matchSkillDictionary` so other packages can use the same names.
   */
  skills?: SkillDictionary;
  /** ms since the epoch (for years of experience). Only the month is used. */
  now: number;
  /** Optional fit-model vectors (bge-small). Used only when `config.weights.semantic` is above 0 (default 0). */
  profileVector?: Float32Array | ArrayLike<number> | null;
  jobVector?: Float32Array | ArrayLike<number> | null;
  /** Optional weights and limits (see DEFAULT_CONFIG). Other weights give another engineVersion. */
  config?: MatchConfigInput | null;
  /** Optional distance in miles between a posting's place and a wanted place (a place dictionary). */
  distanceMiles?: (a: Place, b: PlaceQuery) => number | null;
}

/** The match of one job for the profile. Pure and deterministic. */
export function scoreMatch(input: MatchInput): FullMatchResult {
  return computeMatch(input);
}

/** Hash of the profile facts the score reads (MatchResult.profileVersion). EEO answers are not part of it. */
export function profileVersion(profile: Profile): string {
  return profileVersionOf(profile);
}

/**
 * Years of experience from the work dates (overlaps counted once, a current role up to this month), or null with no
 * dates. A profile with education and no work entries counts as 0.
 */
export function yearsOfExperience(profile: Profile, now: number): number | null {
  const m = profileFacts(profile, now).totalMonths;
  return m === null ? null : Math.round((m / 12) * 100) / 100;
}

/** The text of the profile that fit indexing embeds (no contact details, no EEO answers). */
export function profileText(profile: Profile): string {
  const p = profile;
  const parts: string[] = [];
  if (p.preferences.targetTitles.length) parts.push(`Target: ${p.preferences.targetTitles.join(', ')}`);
  if (p.summary) parts.push(p.summary);
  for (const w of p.work) parts.push([`${w.title} at ${w.company}`, w.summary ?? '', ...w.bullets.slice(0, 4)].filter(Boolean).join('. '));
  if (p.skills.length) parts.push(`Skills: ${p.skills.map((s) => s.name).join(', ')}`);
  if (p.certifications.length) parts.push(`Certifications: ${p.certifications.map((c) => c.name).join(', ')}`);
  for (const e of p.education) parts.push([e.degree, e.major, e.school].filter(Boolean).join(', '));
  return parts.join('\n').slice(0, 4000);
}

/** The text of a job that fit indexing embeds (title, company, skills and the first part of the description). */
export function jobText(job: Job): string {
  const a = analyzeText(job.description ?? '');
  const desc = liveText(a).replace(/\s+/g, ' ').trim();
  const skills = [...new Set(scanSkills(a.live).map((m) => skillName(m.id)))];
  return [job.title, job.company, skills.length ? `Skills: ${skills.join(', ')}` : '', desc.slice(0, 1500)].filter(Boolean).join('\n');
}

/** The card view of a result: the percent, the band, two chips, and the first warning (never the detail only). */
export function summarize(result: MatchResult): MatchSummary {
  return summarizeMatch(result);
}

export { DEFAULT_CONFIG, resolveConfig } from './config.ts';
export type { MatchConfig, MatchConfigInput } from './config.ts';
export type { FullMatchResult, MatchExtras, MustHave, DealBreakerCheck, SkillCheck, ExperienceDetail, JobFactView, Part } from './score.ts';
export { matchSkillDictionary };
export { taxonomyStats } from './taxonomy.ts';
export { bucketOf, bandCounts, rankTopMatched, type Bucket, type RankedItem } from './rank.ts';
export { cardText, detailText } from './views.ts';
export { narrativeBrief, checkNarrative, AI_TEXT_LABEL, type NarrativeBrief, type NarrativeIssue } from './narrative.ts';
export { setSkillClaim, undoSkillClaim, type SkillClaimChange } from './claims.ts';
export { looseJob, type LooseJob } from './loose.ts';
