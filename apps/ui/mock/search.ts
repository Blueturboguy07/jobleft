// Job search for the mock: the JobFilter rules of packages/contracts/src/filter.ts, exactly.
//   * An absent filter does not restrict.
//   * A job whose fact is unknown FAILS a filter on that fact, unless includeUnknown names that fact.
//   * Exclude filters win over include filters.
//   * Closed, hidden and duplicate jobs never appear or count (status "closed" lists closed jobs instead).
// Paging is keyset-based: the cursor holds the sort key of the last row, so rows that arrive later never shift a page.

import type { Company, JobFilter, JobListItem, JobSearchRequest, JobSearchResponse, JobSort, MatchResult, Profile } from '@jobleft/contracts';
import { summarizeMatch } from '@jobleft/contracts';
import { cityById, distanceMiles, resolveCity } from './cities.ts';
import { toSummary } from './jobs.ts';
import type { JobRec, MockState } from './state.ts';
import { DAY_MS } from './util.ts';

type Unknown = NonNullable<JobFilter['includeUnknown']>[number];

const WINDOW_MS: Record<NonNullable<JobFilter['postedWithin']>, number> = { '24h': DAY_MS, '3d': 3 * DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS };

export function h1bTagOf(rec: JobRec, company: Company | null): JobListItem['h1bTag'] {
  const s = rec.job.statements.sponsorship;
  if (s === 'no') return 'post_says_no';
  if (s === 'yes') return 'post_says_yes';
  if (company?.h1b?.status === 'likely') return 'likely_by_history';
  return null;
}

function lowerSet(list: string[] | undefined): Set<string> | null {
  return list && list.length ? new Set(list.map((x) => x.trim().toLowerCase())) : null;
}

export function roleTypeOf(title: string): 'ic' | 'manager' {
  return /\b(manager|director|head of|vp|vice president|chief)\b/i.test(title) ? 'manager' : 'ic';
}

/** Tokens of a search: words split on spaces; punctuation inside words (C++, C#, .NET, 401(k)) is kept. */
export function tokens(q: string | undefined): string[] {
  if (!q) return [];
  return q.toLowerCase().split(/\s+/).map((t) => t.replace(/^["'(]+|["')]+$/g, '')).filter((t) => t.length > 0);
}

export interface Matcher {
  (rec: JobRec): boolean;
}

export function buildMatcher(state: MockState, filter: JobFilter, q: string | undefined, now: number): Matcher {
  const unk = new Set<Unknown>(filter.includeUnknown ?? []);
  const words = tokens(q);
  const status = filter.status ?? 'open';
  const countries = filter.countries?.length ? new Set(filter.countries) : null;
  const workModels = filter.workModels?.length ? new Set(filter.workModels) : null;
  const types = filter.employmentTypes?.length ? new Set(filter.employmentTypes) : null;
  const levels = filter.levels?.length ? new Set(filter.levels) : null;
  const remoteRegions = filter.remoteRegions?.length ? new Set(filter.remoteRegions) : null;
  const fns = lowerSet(filter.jobFunctions);
  const exTitles = lowerSet(filter.excludedTitles);
  const inds = lowerSet(filter.industries);
  const exInds = lowerSet(filter.excludedIndustries);
  const skills = lowerSet(filter.skills);
  const exSkills = lowerSet(filter.excludedSkills);
  const roles = filter.roleTypes?.length ? new Set(filter.roleTypes) : null;
  const comps = filter.companies?.length ? new Set(filter.companies) : null;
  const exComps = filter.excludedCompanies?.length ? new Set(filter.excludedCompanies) : null;
  const stages = filter.companyStages?.length ? new Set(filter.companyStages) : null;
  const sources = filter.sources?.length ? new Set(filter.sources) : null;
  const since = filter.postedWithin ? now - WINDOW_MS[filter.postedWithin] : null;
  const placeQueries = (filter.places ?? []).map((pq) => {
    const city = (pq.placeId && cityById(pq.placeId)) || resolveCity(pq.text)[0] || null;
    return { pq, city };
  });
  const tracker = state.data.tracker;

  return (rec) => {
    const j = rec.job;
    if (j.status !== status) return false;
    if (j.duplicateOf) return false;
    if (tracker[j.id]?.hidden) return false;
    const company = state.companies.get(j.companyKey) ?? null;

    // excludes first
    if (exComps && exComps.has(j.companyKey)) return false;
    if (exTitles && [...exTitles].some((t) => j.title.toLowerCase().includes(t))) return false;
    if (filter.excludeClearanceRequired && j.statements.clearanceRequired === true) return false;
    if (filter.excludeUsCitizenOnly && j.statements.usCitizenOnly === true) return false;
    if (filter.excludeStaffingAgencies && company?.isStaffingAgency === true) return false;
    const jobInds = company?.facts.industries?.value.map((x) => x.toLowerCase()) ?? null;
    if (exInds && jobInds && jobInds.some((i) => exInds.has(i))) return false;
    if (exSkills && j.skills.some((s) => exSkills.has(s.toLowerCase()))) return false;

    // words
    if (words.length && !words.every((w) => rec.hay.includes(w))) return false;

    // countries
    if (countries) {
      const jc = new Set<string>();
      for (const p of j.places) if (p.country) jc.add(p.country);
      if (j.remoteScope) for (const r of j.remoteScope.regions) if (/^[A-Z]{2}$/.test(r)) jc.add(r);
      if (j.isUs === true) jc.add('US');
      if (jc.size === 0) { if (!unk.has('place')) return false; }
      else if (![...jc].some((c) => countries.has(c as never))) return false;
    }

    // places within a radius (remote jobs open to the query's country count as nearby)
    if (placeQueries.length) {
      if (j.places.length === 0 && j.workModel !== 'remote') { if (!unk.has('place')) return false; }
      else {
        const hit = placeQueries.some(({ pq, city }) => {
          if (j.workModel === 'remote') {
            const regions = j.remoteScope?.regions ?? [];
            return city ? regions.includes(city.country) || (regions.includes('NA') && (city.country === 'US' || city.country === 'CA')) : false;
          }
          return j.places.some((p) => {
            if (city && p.placeId) {
              if (p.placeId === city.id) return true;
              const pc = cityById(p.placeId);
              return pc ? distanceMiles(pc, city) <= (pq.radiusMiles ?? 0) : false;
            }
            return p.text.toLowerCase().includes(pq.text.trim().toLowerCase());
          });
        });
        if (!hit) return false;
      }
    }

    if (workModels) { if (j.workModel === null) { if (!unk.has('workModel')) return false; } else if (!workModels.has(j.workModel)) return false; }
    if (remoteRegions && j.workModel === 'remote') {
      if (!j.remoteScope) { if (!unk.has('remoteRegion')) return false; }
      else if (!j.remoteScope.regions.some((r) => remoteRegions.has(r) || r === 'WORLDWIDE')) return false;
    }
    if (types) { if (j.employmentType === null) { if (!unk.has('employmentType')) return false; } else if (!types.has(j.employmentType)) return false; }
    if (levels) { if (j.levels.length === 0) { if (!unk.has('level')) return false; } else if (!j.levels.some((l) => levels.has(l))) return false; }
    if (filter.maxYearsRequired !== undefined) {
      const min = j.yearsRequired?.min ?? null;
      if (min === null) { if (!unk.has('years')) return false; } else if (min > filter.maxYearsRequired) return false;
    }
    if (since !== null) { if (rec.postedMs === null) { if (!unk.has('postedAt')) return false; } else if (rec.postedMs < since) return false; }
    if (filter.minAnnualPayUsd !== undefined) {
      const p = j.pay;
      const top = p && p.currency === 'USD' ? (p.annualMax ?? p.annualMin) : null;
      if (top === null) { if (!unk.has('pay')) return false; } else if (top < filter.minAnnualPayUsd) return false;
    }
    if (filter.h1bSponsorship) {
      const tag = h1bTagOf(rec, company);
      if (tag !== 'likely_by_history' && tag !== 'post_says_yes') return false;
    }
    if (fns) {
      const title = j.title.toLowerCase();
      const ok = (rec.fn && fns.has(rec.fn.toLowerCase())) || [...fns].some((f) => title.includes(f));
      if (!ok) return false;
    }
    if (inds) { if (!jobInds || !jobInds.some((i) => inds.has(i))) return false; }
    if (skills && !j.skills.some((s) => skills.has(s.toLowerCase()))) return false;
    if (roles && !roles.has(roleTypeOf(j.title))) return false;
    if (comps && !comps.has(j.companyKey)) return false;
    if (stages) { const st = company?.facts.stage?.value ?? null; if (!st || !stages.has(st)) return false; }
    if (sources && !j.sources.some((s) => sources.has(s.sourceId))) return false;
    return true;
  };
}

// ---------------------------------------------------------------- sorting and paging

type Key = [number, string];

function keyOf(sort: JobSort, rec: JobRec, match: MatchResult | null, now: number): Key {
  if (sort === 'most_recent') return [-(rec.postedMs ?? -1e15), rec.job.id];
  if (sort === 'top_matched') return [-(match ? match.percent : -1), rec.job.id];
  // recommended: fit, freshness and completeness, fixed per job (same order on every reload)
  const ageDays = rec.postedMs === null ? 30 : Math.max(0, (now - rec.postedMs) / DAY_MS);
  const fresh = Math.exp(-ageDays / 14) * 30;
  const quality = (rec.job.pay ? 6 : 0) + (rec.job.description.length > 400 ? 4 : 0);
  const fit = match ? match.percent * 0.6 : 30;
  // round so the order does not change within a day as "now" moves
  return [-Math.round((fit + quality + fresh) * 10) / 10, rec.job.id];
}

function cmp(a: Key, b: Key): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

function encodeCursor(k: Key, sort: JobSort): string {
  return Buffer.from(JSON.stringify([sort, k[0], k[1]])).toString('base64url');
}

function decodeCursor(c: string): { sort: JobSort; key: Key } | null {
  try {
    const [sort, a, b] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as [JobSort, number, string];
    return typeof a === 'number' && typeof b === 'string' ? { sort, key: [a, b] } : null;
  } catch {
    return null;
  }
}

export interface SearchDeps {
  state: MockState;
  profile: Profile | null;
  matchFor: (rec: JobRec) => MatchResult | null;
  now: number;
}

export function search(deps: SearchDeps, req: JobSearchRequest): JobSearchResponse | { error: string } {
  const t0 = performance.now();
  const { state, now } = deps;
  const limit = req.limit ?? 30;
  const sort = req.sort;
  const matcher = buildMatcher(state, req.filter ?? {}, req.q, now);
  const rows: Array<{ rec: JobRec; key: Key; match: MatchResult | null }> = [];
  for (const rec of state.jobs.values()) {
    if (!matcher(rec)) continue;
    // "most recent" orders by time only: the match is worked out for the page's jobs, not for every job that passes the filter
    const match = deps.profile && sort !== 'most_recent' ? deps.matchFor(rec) : null;
    rows.push({ rec, key: keyOf(sort === 'top_matched' && !deps.profile ? 'recommended' : sort, rec, match, now), match });
  }
  rows.sort((a, b) => cmp(a.key, b.key));
  let start = 0;
  if (req.cursor) {
    const c = decodeCursor(req.cursor);
    if (!c || c.sort !== sort) return { error: 'The page cursor does not belong to this search. Start from the first page.' };
    let lo = 0, hi = rows.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cmp(rows[mid]!.key, c.key) <= 0) lo = mid + 1; else hi = mid; }
    start = lo;
  }
  const page = rows.slice(start, start + limit);
  const items: JobListItem[] = page.map(({ rec, match: m0 }) => {
    const match = m0 ?? (deps.profile ? deps.matchFor(rec) : null);
    const t = state.data.tracker[rec.job.id];
    const company = state.companies.get(rec.job.companyKey) ?? null;
    return {
      job: toSummary(rec.job),
      match: match ? summarizeWithExtras(match) : null,
      liked: t?.liked ?? false,
      hidden: t?.hidden ?? false,
      trackerStatus: t?.status ?? null,
      networkCount: state.networkCount(rec.job.companyKey),
      h1bTag: h1bTagOf(rec, company),
      fitScore: match ? match.percent / 100 : null,
    };
  });
  const last = page.at(-1);
  return {
    items,
    total: rows.length,
    nextCursor: last && start + limit < rows.length ? encodeCursor(last.key, sort) : null,
    fit: { state: sort === 'top_matched' && !deps.profile ? 'needs_profile' : 'ready', waiting: 0, model: 'mock-fit' },
    tookMs: Math.round(performance.now() - t0),
  };
}

/** The card summary, plus the optional fields the match lane adds (complete, warning), so card and detail agree. */
export function summarizeWithExtras(m: MatchResult): ReturnType<typeof summarizeMatch> {
  const s = summarizeMatch(m) as ReturnType<typeof summarizeMatch> & Record<string, unknown>;
  const x = m as MatchResult & { complete?: boolean };
  if (x.complete !== undefined) {
    s.complete = x.complete;
    s.blockerCount = m.blockers.length;
    s.warning = m.blockers[0]?.message ?? null;
  }
  return s;
}
