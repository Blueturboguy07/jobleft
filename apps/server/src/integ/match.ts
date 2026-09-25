// i-resume: the match score of one job for the profile (the @jobleft/match engine, pure and stable). The same call
// serves the route `getMatch` and the `match` of a job's detail, so the two always agree.

import type { Job, MatchResult, Profile } from '@jobleft/contracts';
import { nowMs } from '@jobleft/contracts';
import { scoreMatch } from '@jobleft/match';

/** null when the engine cannot score this job (never a placeholder score). */
export function matchFor(profile: Profile, job: Job): MatchResult | null {
  try { return scoreMatch({ profile, job, company: null, now: nowMs() }); } catch { return null; }
}
