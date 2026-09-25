// Scoring weights and limits. Every number the engine uses to turn facts into a percent lives here, so the weights
// can be tuned from labelled data without touching the rules. A result made with other weights carries a different
// engineVersion, so a cache never mixes the two.

import { createHash } from 'node:crypto';

export interface MatchConfig {
  /**
   * overall = intercept + experience x Experience% + skills x Skills% + industry x Industry% (+ semantic term).
   * Starting point: the rough fit of the three shown parts to the overall that one consumer app displays
   * (0.24 / 0.29 / 0.08 / +36, fitted on 18 observations). A part that cannot be judged adds nothing.
   */
  weights: { experience: number; skills: number; industry: number; intercept: number; semantic: number };
  /** Ceilings on the overall percent when a must-have or a deal-breaker is not met. */
  caps: {
    /** Sponsorship, work authorization, citizenship or clearance the profile says it does not meet. */
    legal: number;
    /** A required licence or certification that is not in the profile and no past title suggests. */
    licence: number;
    /** A required degree above the highest degree in the profile. */
    degree: number;
    /** Far fewer years than the posting requires. */
    years: number;
    /** A job two and a half or more levels above the profile (a director role for two years of work). */
    level: number;
    /** A broken deal-breaker: work model, location, minimum pay or job type. */
    dealBreaker: number;
    /** A must-have whose answer is not in the profile: never the Strong band. */
    notInProfile: number;
    /** A clear step down: two or more levels below the profile, a manager for a role that leads nobody. Not a must-have. */
    stepDown: number;
  };
  skills: {
    /** Weight of a skill by where the posting names it. */
    required: number;
    preferred: number;
    /** Named in the duties or the text, not in a requirement list. */
    mentioned: number;
    /** Credit for a related skill (PostgreSQL for MySQL). The skill still shows as missing. */
    related: number;
    /** Credit for a licence that a past title suggests but the profile does not list. */
    implied: number;
    /** Fewer items than this, with none in a requirement list, is "not enough information". */
    minItems: number;
    /** Above this many distinct skills the posting is flagged as listing too many. */
    stuffing: number;
  };
  experience: {
    /** Highest Experience Level percent when the posting states neither a level nor years. */
    noLevelStated: number;
    /** Relevance when no role, target or study in the profile is in the job's kind of work. */
    unrelated: number;
    /** Most relevance a target title alone can give (no past role in that kind of work). */
    targetOnly: number;
    /** Most relevance a field of study alone can give. */
    studyOnly: number;
  };
  industry: {
    /** Industry Experience percent when the profile's industries are known and none is related. */
    unrelated: number;
  };
}

export const DEFAULT_CONFIG: MatchConfig = Object.freeze({
  weights: { experience: 0.24, skills: 0.29, industry: 0.08, intercept: 36, semantic: 0 },
  caps: { legal: 45, licence: 70, degree: 65, years: 65, level: 60, dealBreaker: 60, notInProfile: 84, stepDown: 72 },
  skills: { required: 1, preferred: 0.5, mentioned: 0.6, related: 0.5, implied: 0.5, minItems: 2, stuffing: 40 },
  experience: { noLevelStated: 85, unrelated: 0.12, targetOnly: 0.6, studyOnly: 0.6 },
  industry: { unrelated: 15 },
}) as MatchConfig;

export type MatchConfigInput = {
  [K in keyof MatchConfig]?: Partial<MatchConfig[K]>;
};

export function resolveConfig(input?: MatchConfigInput | null): MatchConfig {
  if (!input) return DEFAULT_CONFIG;
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof MatchConfig>) {
    out[key] = { ...DEFAULT_CONFIG[key], ...(input[key] ?? {}) };
    for (const [k, v] of Object.entries(out[key] as Record<string, unknown>)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`match config ${key}.${k} must be a finite number`);
    }
  }
  return out as unknown as MatchConfig;
}

/** "" for the default weights, else a short hash that joins the engine version. */
export function configTag(cfg: MatchConfig): string {
  if (cfg === DEFAULT_CONFIG) return '';
  const same = JSON.stringify(cfg) === JSON.stringify(DEFAULT_CONFIG);
  if (same) return '';
  return '+cfg-' + createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 8);
}
