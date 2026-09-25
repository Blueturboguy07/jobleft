// "Top Matched" order and band buckets, from the percent the person sees. Ties keep one fixed order (the job id), so
// the list is the same on every load. Closed postings and repeats of another posting never appear.

import type { MatchResult } from '@jobleft/contracts';

export type Bucket = 'strong' | 'good' | 'fair' | 'incomplete';

/** The band filter a result belongs to: its band, or "incomplete" when a part has not enough information. */
export function bucketOf(m: MatchResult): Bucket {
  return m.complete === false ? 'incomplete' : m.band;
}

export interface RankedItem<J, M extends MatchResult = MatchResult> {
  job: J;
  match: M;
}

type JobLike = { id: string; status?: string; duplicateOf?: string | null };

/**
 * Sorts by the shown percent, highest first. At equal percent a complete score comes before an incomplete one, then
 * the job id decides. Closed and duplicate postings are left out.
 */
export function rankTopMatched<J extends JobLike, M extends MatchResult>(items: Array<RankedItem<J, M>>): Array<RankedItem<J, M>> {
  return items
    .filter((x) => (x.job.status ?? 'open') === 'open' && !x.job.duplicateOf)
    .slice()
    .sort((a, b) => b.match.percent - a.match.percent
      || Number(b.match.complete !== false) - Number(a.match.complete !== false)
      || (a.job.id < b.job.id ? -1 : a.job.id > b.job.id ? 1 : 0));
}

/** How many results fall in each bucket. strong + good + fair + incomplete = total. */
export function bandCounts(results: MatchResult[]): Record<Bucket, number> & { total: number } {
  const out = { strong: 0, good: 0, fair: 0, incomplete: 0, total: results.length };
  for (const r of results) out[bucketOf(r)]++;
  return out;
}
