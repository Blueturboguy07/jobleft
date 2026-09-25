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
    // Added by the match lane (additive): the POSTING says it does not sponsor visas (never from missing data).
    'post_says_no_sponsorship',
  ]),
  label: str({ minLength: 1, maxLength: 60 }),
  /** false = a negative highlight (shown with a dot, never a tick). */
  positive: bool(),
}), 'WhyFitChip');

export const BlockerSchema = named(obj({
  kind: enm([
    'sponsorship', 'work_authorization', 'clearance', 'citizenship', 'location', 'level', 'years', 'employment_type',
    // Added by the match lane (additive).
    'licence', 'degree', 'work_model', 'pay',
  ]),
  message: str({ minLength: 1 }),
  evidence: nullable(FactEvidenceSchema),
}, {
  /** unmet = the profile says it is not met; not_in_profile = the profile has no answer (never assumed). */
  state: enm(['unmet', 'not_in_profile']),
  /** The requirement in plain words ("RN licence", "No visa sponsorship"). */
  requirement: str(),
  /** true = a preference the person set (work model, location, minimum pay, job type), not a posting must-have. */
  dealBreaker: bool(),
}), 'Blocker');

/** One must-have the posting states, with its exact words and whether the profile meets it. */
export const MustHaveSchema = named(obj({
  kind: enm(['sponsorship', 'work_authorization', 'citizenship', 'clearance', 'licence', 'degree', 'years']),
  requirement: str({ minLength: 1 }),
  /** obtainable = to get after hire ("ACLS within 6 months of hire"); not needed to apply. */
  importance: enm(['required', 'preferred', 'obtainable']),
  /** info = stated, but not a must-have for this profile (preferred, "or equivalent experience", sponsors visas). */
  state: enm(['met', 'unmet', 'not_in_profile', 'in_progress', 'info']),
  /** Exact words from the posting. */
  quote: str({ maxLength: 500 }),
  message: str({ minLength: 1 }),
}), 'MustHave');

/** A preference the person set, checked against the posting. */
export const DealBreakerCheckSchema = named(obj({
  kind: enm(['work_model', 'location', 'pay', 'employment_type']),
  state: enm(['ok', 'broken', 'not_stated', 'not_in_profile']),
  message: str({ minLength: 1 }),
  quote: nullable(str({ maxLength: 500 })),
}), 'DealBreakerCheck');

/** One fact of the posting as the score view shows it. value null = the posting does not state it ("not stated"). */
export const JobFactViewSchema = named(obj({
  value: nullable(str()),
  text: str({ minLength: 1 }),
  quote: nullable(str({ maxLength: 500 })),
}), 'JobFactView');

/** One skill or credential the posting names, and whether the profile has it. */
export const SkillCheckSchema = named(obj({
  name: str({ minLength: 1 }),
  importance: enm(['required', 'preferred', 'mentioned']),
  /** related = a related skill is in the profile (half credit); implied = a past title suggests it (half credit). */
  state: enm(['met', 'related', 'implied', 'missing']),
  quote: str(),
  heldFrom: nullable(str()),
  via: nullable(str()),
}), 'SkillCheck');

/** The years of experience the score used and the roles it counted (overlaps counted once). */
export const ExperienceDetailSchema = named(obj({
  totalMonths: nullable(int({ minimum: 0 })),
  text: str(),
  rolesCounted: arr(obj({ title: str(), company: str(), from: str(), to: str(), months: int({ minimum: 0 }) })),
  rolesNotCounted: arr(obj({ title: str(), company: str(), why: str() })),
  relevantMonths: nullable(int({ minimum: 0 })),
  jobYears: nullable(obj({ min: nullable(int({ minimum: 0 })), max: nullable(int({ minimum: 0 })), importance: str(), quote: str() })),
  jobLevel: nullable(str()),
}), 'ExperienceDetail');

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
  /** The years of experience the score used, and where they came from (the person can correct them). */
  experienceYearsUsed: nullable(num({ minimum: 0 })),
  computedAt: IsoDateTimeSchema,
}, {
  // Added by the match lane (additive, optional). Readers that do not know them show nothing.
  /** false = at least one part has "not enough information"; the percent then counts only what could be judged. */
  complete: bool(),
  unknownParts: arr(enm(['experienceLevel', 'skills', 'industryExperience'])),
  mustHaves: arr(MustHaveSchema),
  dealBreakers: arr(DealBreakerCheckSchema),
  /** What the posting states, or "not stated": level, years, pay, sponsorship, industry, work model, job type. */
  jobFacts: obj({
    level: JobFactViewSchema, years: JobFactViewSchema, pay: JobFactViewSchema, sponsorship: JobFactViewSchema,
    industry: JobFactViewSchema, workModel: JobFactViewSchema, employmentType: JobFactViewSchema,
  }),
  experience: ExperienceDetailSchema,
  skillDetail: arr(SkillCheckSchema),
  /** The ceiling a must-have or a deal-breaker put on the percent, when it lowered it. */
  cap: nullable(obj({ percent: int({ minimum: 0, maximum: 100 }), reason: str() })),
  notes: arr(str()),
}), 'MatchResult', 'The match score of one job for the profile');

/** What a job card shows: the percent, the band and up to two chips. */
export const MatchSummarySchema = named(obj({
  percent: int({ minimum: 0, maximum: 100 }),
  band: MatchBandSchema,
  whyFit: arr(WhyFitChipSchema, { maxItems: 2 }),
}, {
  // Added by the match lane (additive): so a card shows the same warning as the detail.
  complete: bool(),
  blockerCount: int({ minimum: 0 }),
  /** The first blocker's message, or null. */
  warning: nullable(str()),
}), 'MatchSummary');

export type MatchBand = Infer<typeof MatchBandSchema>;
export type Reason = Infer<typeof ReasonSchema>;
export type SubScore = Infer<typeof SubScoreSchema>;
export type WhyFitChip = Infer<typeof WhyFitChipSchema>;
export type Blocker = Infer<typeof BlockerSchema>;
export type MatchResult = Infer<typeof MatchResultSchema>;
export type MatchSummary = Infer<typeof MatchSummarySchema>;
export type MustHave = Infer<typeof MustHaveSchema>;
export type DealBreakerCheck = Infer<typeof DealBreakerCheckSchema>;
export type JobFactView = Infer<typeof JobFactViewSchema>;
export type SkillCheck = Infer<typeof SkillCheckSchema>;
export type ExperienceDetail = Infer<typeof ExperienceDetailSchema>;

/** The band for a percent (STRONG 85+, GOOD 70 to 84, FAIR below 70). */
export function bandFor(percent: number): MatchBand {
  if (percent >= MATCH_BANDS.strong) return 'strong';
  if (percent >= MATCH_BANDS.good) return 'good';
  return 'fair';
}

/** The card view of a full result. The card carries the first blocker too, so a warning is never on the detail only. */
export function summarizeMatch(m: MatchResult): MatchSummary {
  const out: MatchSummary = { percent: m.percent, band: m.band, whyFit: m.whyFit.slice(0, 2) };
  // Results from the match engine carry `complete`; older results keep the original three fields.
  if (m.complete !== undefined) {
    out.complete = m.complete;
    out.blockerCount = m.blockers.length;
    out.warning = m.blockers[0]?.message ?? null;
  }
  return out;
}
