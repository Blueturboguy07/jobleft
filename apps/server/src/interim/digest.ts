// The daily summary: the jobs jobleft found since the last one that fit the profile, best first (ranked as the feed
// ranks them), from the boards and from web searches, and what is due today. Once a day at the hour in Settings >
// Notifications (or the first time jobleft runs after it) it becomes one notification; the dashboard shows it too.
// Made on this computer from the person's own data.

import type { Digest, JobFilter, JobListItem, Profile } from '@jobleft/contracts';

export interface DigestDeps {
  profile: () => Profile | null;
  /** Row ids of the open jobs first seen after `iso`, from web searches or from the boards. */
  freshIds: (iso: string, web: boolean) => number[];
  /** The feed's search, restricted to the given row ids. */
  rank: (filter: JobFilter, ids: number[], limit: number) => { items: JobListItem[]; total: number };
  remindersDueBy: (iso: string) => number;
  followUpsDue: () => number;
}

/** The profile's own choices as a filter, keeping jobs that do not state a fact (as the feed's first filter does). */
export function profileFilter(p: Profile | null): JobFilter {
  if (!p) return {};
  const pr = p.preferences;
  const f: JobFilter = {};
  if (pr.jobFunctions.length) f.jobFunctions = pr.jobFunctions;
  if (pr.employmentTypes.length) f.employmentTypes = pr.employmentTypes;
  if (pr.workModels.length) f.workModels = pr.workModels;
  if (pr.levels.length) f.levels = pr.levels;
  if (pr.countries.length) f.countries = pr.countries;
  if (pr.places.length) f.places = pr.places;
  if (Object.keys(f).length) f.includeUnknown = ['place', 'workModel', 'employmentType', 'level', 'years', 'postedAt', 'pay', 'remoteRegion'];
  return f;
}

export function buildDigest(d: DigestDeps, since: Date, until: Date, endOfDay: Date, top = 5): Digest {
  const profile = d.profile();
  const filter = profileFilter(profile);
  const part = (web: boolean) => {
    const ids = d.freshIds(since.toISOString(), web);
    if (!ids.length) return { total: 0, top: [] };
    // Web jobs: in the profile's countries, if it names any; the profile's other choices are for the boards' feed.
    const f: JobFilter = web
      ? { sources: ['external:web'], ...(profile?.preferences.countries.length ? { countries: profile.preferences.countries, includeUnknown: ['place'] } : {}) }
      : filter;
    const r = d.rank(f, ids, top);
    return { total: r.total, top: r.items };
  };
  return {
    since: since.toISOString(), until: until.toISOString(),
    boards: part(false), web: part(true),
    remindersDue: d.remindersDueBy(endOfDay.toISOString()), followUpsDue: d.followUpsDue(),
  };
}

const jobsText = (n: number) => `${n} new job${n === 1 ? '' : 's'}`;

/** The notification for a summary, or null when there is nothing new and nothing due. */
export function digestText(g: Digest): { title: string; body: string } | null {
  const n = g.boards.total + g.web.total;
  const parts: string[] = [];
  const best = [...g.boards.top, ...g.web.top].sort((a, b) => (b.match?.percent ?? -1) - (a.match?.percent ?? -1))[0];
  if (best) parts.push(`Best fit: ${best.job.title} at ${best.job.company}${best.match ? ` (${best.match.percent}%)` : ''}.`);
  if (g.web.total && g.boards.total) parts.push(`${g.web.total} of them from web searches.`);
  else if (g.web.total) parts.push('All from web searches.');
  if (g.remindersDue) parts.push(`${g.remindersDue} reminder${g.remindersDue === 1 ? '' : 's'} due today.`);
  if (g.followUpsDue) parts.push(`${g.followUpsDue} follow-up${g.followUpsDue === 1 ? '' : 's'} due.`);
  if (!n && !parts.length) return null;
  const title = n ? `Today in jobleft: ${jobsText(n)} for you` : 'Today in jobleft: nothing new, but things are due';
  return { title, body: parts.join(' ') || 'Open jobleft to see them.' };
}

/** The day `now` is in, on this computer's clock ("2026-10-12"). */
export function localDay(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Whether the daily summary is due at `now`, and from when it counts: from the last one (at most a week back), or the
 * last 24 hours for the first. null: off, before the hour, or already made today.
 */
export function digestDue(now: Date, n: { digest?: boolean; digestHour?: number }, last: { date: string; at: string } | null): Date | null {
  if (n.digest === false || now.getHours() < (n.digestHour ?? 8)) return null;
  if (last?.date === localDay(now)) return null;
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const at = last ? Date.parse(last.at) : NaN;
  return new Date(Number.isFinite(at) ? Math.max(at, weekAgo) : now.getTime() - 86_400_000);
}
