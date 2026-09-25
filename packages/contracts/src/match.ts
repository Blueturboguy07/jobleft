// MatchResult: the match score of one job for the user's profile.
// Format target (UI-SPEC-LOGGED-IN, "MATCH SCORE"): a percent, a band, three sub-scores named
// Experience Level, Skills and Industry Experience, and "why you fit" chips. Ours is deterministic:
// the same profile and the same job always give the same numbers, and every number lists its reasons.

import { FactEvidenceSchema, IdSchema, IsoDateTimeSchema } from './common.ts';
import { arr, bool, enm, int, named, nullable, num, obj, str, type Infer } from './schema.ts';

export const MatchBandSchema = enm(['strong', 'good', 'fair']);

/** Band cut-offs: STRONG 85 and above, GOOD 70 to 84, FAIR below 70. */
export const MATCH_BANDS = { strong: 85, good: 70 } as const;
export const MATCH_BAND_LABELS = { strong: 'STRONG MATCH', good: 'GOOD MATCH', fair: 'FAIR MATCH' } as const;
/** The display names of the three sub-scores, in order. */
export const SUB_SCORE_LABELS = {
  experienceLevel: 'Experience Level', skills: 'Skills', industryExperience: 'Industry Experience',
} as const;

export const ReasonSchema = named(obj({
  /** Stable machine code, e.g. "skill_matched", "level_below", "years_short". */
  code: str({ minLength: 1 }),
  /** One plain sentence that is true for this profile and this job. */
  text: str({ minLength: 1 }),
  /** Signed contribution in score points. */
  points: num(),
}, { evidence: str({ maxLength: 500 }) }), 'Reason');

export const SubScoreSchema = named(obj({
  /** 0 to 100. null = cannot be scored from the facts (for example the posting states no level). Never a default. */
  percent: nullable(int({ minimum: 0, maximum: 100 })),
  reasons: arr(ReasonSchema),
}), 'SubScore');

export const WhyFitChipSchema = named(obj({
  kind: enm([
    'h1b_sponsor_likely', 'post_says_sponsors', 'comp_benefits', 'growth', 'top_investors', 'unicorn',
    'skills', 'level', 'industry', 'location', 'network',
  ]),
  label: str({ minLength: 1, maxLength: 60 }),
  /** false = a negative highlight (shown with a dot, never a tick). */
  positive: bool(),
}), 'WhyFitChip');

export const BlockerSchema = named(obj({
  kind: enm(['sponsorship', 'work_authorization', 'clearance', 'citizenship', 'location', 'level', 'years', 'employment_type']),
  message: str({ minLength: 1 }),
  evidence: nullable(FactEvidenceSchema),
}), 'Blocker');

export const MatchResultSchema = named(obj({
  jobId: IdSchema,
  /** Hash of the profile facts the score used. A new profile version gives a new result. */
  profileVersion: str({ minLength: 1 }),
  /** Version of the scoring rules. */
  engineVersion: str({ minLength: 1 }),
  percent: int({ minimum: 0, maximum: 100 }),
  band: MatchBandSchema,
  subScores: obj({
    experienceLevel: SubScoreSchema,
    skills: SubScoreSchema,
    industryExperience: SubScoreSchema,
  }),
  whyFit: arr(WhyFitChipSchema),
  blockers: arr(BlockerSchema),
  reasons: arr(ReasonSchema),
  skills: obj({ matched: arr(str()), missing: arr(str()), required: arr(str()), preferred: arr(str()) }),
  computedAt: IsoDateTimeSchema,
}), 'MatchResult', 'The match score of one job for the profile');

/** What a job card shows: the percent, the band and up to two chips. */
export const MatchSummarySchema = named(obj({
  percent: int({ minimum: 0, maximum: 100 }),
  band: MatchBandSchema,
  whyFit: arr(WhyFitChipSchema, { maxItems: 2 }),
}), 'MatchSummary');

export type MatchBand = Infer<typeof MatchBandSchema>;
export type Reason = Infer<typeof ReasonSchema>;
export type SubScore = Infer<typeof SubScoreSchema>;
export type WhyFitChip = Infer<typeof WhyFitChipSchema>;
export type Blocker = Infer<typeof BlockerSchema>;
export type MatchResult = Infer<typeof MatchResultSchema>;
export type MatchSummary = Infer<typeof MatchSummarySchema>;

/** The band for a percent (STRONG 85+, GOOD 70 to 84, FAIR below 70). */
export function bandFor(percent: number): MatchBand {
  if (percent >= MATCH_BANDS.strong) return 'strong';
  if (percent >= MATCH_BANDS.good) return 'good';
  return 'fair';
}

/** The card view of a full result. */
export function summarizeMatch(m: MatchResult): MatchSummary {
  return { percent: m.percent, band: m.band, whyFit: m.whyFit.slice(0, 2) };
}
