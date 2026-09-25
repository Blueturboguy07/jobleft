// @jobleft/match: the match score. Deterministic first (no network, no AI, free, offline), explained by reasons.
// Output: MatchResult (percent, band STRONG 85+ / GOOD 70-84 / FAIR <70, sub-scores Experience Level, Skills and
// Industry Experience, why-fit chips, blockers, reasons). The same profile and job always give the same result.
// It never reads protected traits (EEO answers, name, age) and never lets posting text steer the score.
// Status: interface stubs (foundation). Bodies throw until the match lane implements them.
// Interface: docs/INTERFACES.md, section "@jobleft/match".

import type { Company, Job, MatchResult, Profile } from '@jobleft/contracts';
import type { SkillDictionary } from '@jobleft/static-data';

export const PACKAGE_NAME = '@jobleft/match';
/** Bump when the scoring rules change; cached results with another version are recomputed. */
export const ENGINE_VERSION = 'match-0.0.0';

function notImplemented(what: string): never {
  throw new Error(`not implemented yet: ${what} (lane: @jobleft/match)`);
}

export interface MatchInput {
  profile: Profile;
  job: Job;
  company: Company | null;
  skills: SkillDictionary;
  /** ms since the epoch (for years of experience). */
  now: number;
}

/** The match of one job for the profile. Pure and deterministic. */
export function scoreMatch(input: MatchInput): MatchResult { return notImplemented('scoreMatch'); }

/** Hash of the profile facts the score reads (MatchResult.profileVersion). EEO answers are not part of it. */
export function profileVersion(profile: Profile): string { return notImplemented('profileVersion'); }

/** Years of experience from the work dates (overlaps counted once), or null with no dates. */
export function yearsOfExperience(profile: Profile, now: number): number | null { return notImplemented('yearsOfExperience'); }

/** The text of the profile that fit indexing embeds (no contact details, no EEO answers). */
export function profileText(profile: Profile): string { return notImplemented('profileText'); }

/** The text of a job that fit indexing embeds (title, company, skills and the first part of the description). */
export function jobText(job: Job): string { return notImplemented('jobText'); }
