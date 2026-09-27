// i-core: the feed the person sees. It sits on top of the interim job index (interim/jobs.ts) and adds:
//   * the posting's full facts on every card (the crawler's contract record: places, remote scope, years, statements,
//     pay ranges), not the narrow stand-in;
//   * the personal order: with a profile, Recommended ranks by the person's preferences (title or job function first,
//     then place and work model, then job type and level, then posted date) and Top Matched by the match engine's
//     percent; each ranked card carries plain reasons (why-fit chips) and the match percent;
//   * the sponsor tag (static-data h1bTagFor: the posting's own words win; filing history only when "likely"; a
//     company with no record gets no tag) with a plain note that names its basis and data date, and a working
//     H-1B filter.
// The same data and the same profile always give the same order and the same scores (ties break by row id).

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  nowMs, type ExperienceLevel, type Job, type JobListItem, type JobSearchRequest, type JobSearchResponse, type Level,
  type MatchResult, type Profile, type WhyFitChip,
} from '@jobleft/contracts';
import { getJobById } from '@jobleft/crawler';
import { ENGINE_VERSION, distanceFromPlaceIndex, scoreMatch, summarize } from '@jobleft/match';
import { h1bTagFor, type H1bIndex, type H1bLookupDetail, type H1bTag } from '@jobleft/static-data';
import { ApiFailure } from '../errors.ts';
import { companyKey } from '../interim/company-key.ts';
import { contractJobId, familiesOfFunction, titleFamily, toSummary, type CandidateRow, type JobsService, type SearchDeps } from '../interim/jobs.ts';
import { STATES, STATE_BY_NAME, STATE_NAME_RE, memo, statesIn } from './places.ts';

export { statesIn };

// ---------------------------------------------------------------- preferences

const LEVEL_WORDS = new Set(['senior', 'sr', 'junior', 'jr', 'lead', 'staff', 'principal', 'intern', 'internship', 'entry', 'mid', 'level', 'i', 'ii', 'iii', 'iv', 'head', 'chief', 'associate']);
const STOP = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'in', 'for', 'to', 'at', 'with', 'remote', 'hybrid', 'onsite', 'full', 'time', 'part', 'us']);
const LEVEL_OF_WORD: Record<string, ExperienceLevel> = {
  senior: 'senior', sr: 'senior', junior: 'entry', jr: 'entry', entry: 'entry', intern: 'intern_new_grad', internship: 'intern_new_grad',
  lead: 'lead_staff', staff: 'lead_staff', principal: 'lead_staff', mid: 'mid', director: 'director_exec', vp: 'director_exec', chief: 'director_exec',
};
const BUCKET: Record<Level, ExperienceLevel> = {
  intern: 'intern_new_grad', entry: 'entry', mid: 'mid', senior: 'senior', staff: 'lead_staff', principal: 'lead_staff', lead: 'lead_staff',
  manager: 'lead_staff', director: 'director_exec', vp: 'director_exec', exec: 'director_exec',
};

/** Title words in one spelling: "RN" = registered nurse, "back-end" = backend, "developer" = engineer, plurals folded. */
export const titleWords = memo(titleWordsRaw);
const titleSet = memo((t: string) => new Set(titleWords(t)));
function titleWordsRaw(text: string): string[] {
  let t = ` ${text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')} `;
  t = t.replace(/[/,;:()|–—]+/g, ' ').replace(/\bsr\.?(?=\s)/g, 'senior').replace(/\bjr\.?(?=\s)/g, 'junior');
  t = t.replace(/\bback[\s-]end\b/g, 'backend').replace(/\bfront[\s-]end\b/g, 'frontend').replace(/\bfull[\s-]stack\b/g, 'fullstack');
  t = t.replace(/\brns?\b/g, 'registered nurse').replace(/\blvn\b|\blpn\b/g, 'licensed practical nurse').replace(/\bswe\b/g, 'software engineer');
  t = t.replace(/-/g, ' ');
  return t.split(/[^a-z0-9+#.]+/).filter(Boolean).map((w) => {
    if (w === 'developer' || w === 'developers' || w === 'engineering' || w === 'engineers') return 'engineer';
    if (w === 'nursing' || w === 'nurses') return 'nurse';
    if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  });
}

interface Target { label: string; words: string[]; weight: number; /** A job function's kinds of work: a title of one of them fits in full. */ families?: string[] }

// Words that name a kind of role in many fields ("engineer", "manager"). They count half, so the distinctive word of a
// target ("backend", "registered") decides the match.
const GENERIC = new Set(['engineer', 'manager', 'specialist', 'associate', 'analyst', 'coordinator', 'representative', 'assistant',
  'technician', 'director', 'officer', 'consultant', 'administrator', 'agent', 'lead', 'worker', 'professional', 'partner']);
const wordWeight = (w: string) => (GENERIC.has(w) ? 0.5 : 1);

/** The place dictionary calls the feed needs (the PlaceIndex of @jobleft/static-data). */
export interface FeedPlaces {
  resolve(text: string): { places: Array<{ placeId: string | null }>; notACity: boolean };
  within(placeId: string, radiusMiles: number): Set<string>;
}

/**
 * One place the person wants, as the feed checks it: a whole US state, the places within the radius of the chosen
 * place (from its place id), or, with no place data, the city name the posting must state (and its state, when given).
 */
interface PlaceWant { label: string; state: string | null; near: Set<string> | null; city: RegExp | null; cityState: string | null }

export interface PrefModel {
  version: string;
  targets: Target[];
  states: Set<string>;
  places: PlaceWant[];
  placeLabel: string | null;
  usOnly: boolean;
  /** false when the person chose countries and the US is not one of them. */
  wantsUs: boolean;
  /** The place ids a posting's location text resolves to (cached per text). */
  placeIdsOf: (location: string) => string[];
  workModels: Set<string>;
  employment: Set<string>;
  levels: Set<ExperienceLevel>;
  empty: boolean;
}

/** US state codes the text names in words or codes ("TX", "Texas"), never guessed from a city name. */
function namedStates(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[,(/;|\s-])([A-Z]{2})(?=$|[\s,)/;|.-])/g)) if (STATES[m[1]!]) out.add(m[1]!);
  for (const m of text.matchAll(STATE_NAME_RE)) out.add(STATE_BY_NAME.get(m[1]!.toLowerCase())!);
  return out;
}

const placeIdCache = new WeakMap<FeedPlaces, Map<string, string[]>>();
function placeIdsWith(places: FeedPlaces | null): (location: string) => string[] {
  if (!places) return () => [];
  let cache = placeIdCache.get(places);
  if (!cache) { cache = new Map(); placeIdCache.set(places, cache); }
  const c = cache;
  return (location: string) => {
    let ids = c.get(location);
    if (ids === undefined) {
      try {
        const r = places.resolve(location);
        ids = r.notACity ? [] : r.places.map((x) => x.placeId).filter((x): x is string => !!x);
      } catch { ids = []; }
      if (c.size >= 100_000) c.clear();
      c.set(location, ids);
    }
    return ids;
  };
}

/** The first place the person wants that this posting's location is in, or null. */
function placeFit(m: PrefModel, location: string): PlaceWant | null {
  if (!location) return null;
  for (const w of m.places) {
    if (w.state) { if (statesIn(location).has(w.state)) return w; continue; }
    if (w.near) { if (m.placeIdsOf(location).some((id) => w.near!.has(id))) return w; continue; }
    if (w.city?.test(location) && (!w.cityState || statesIn(location).has(w.cityState))) return w;
  }
  return null;
}

export function prefModel(p: Profile, placeData: FeedPlaces | null = null): PrefModel {
  const pr = p.preferences;
  const targets: Target[] = [];
  const levels = new Set<ExperienceLevel>(pr.levels);
  // A target title counts in full; a broad job function ("Nursing") a little less, so an exact title ranks first.
  for (const [t, weight] of [...pr.targetTitles.map((x) => [x, 1] as const), ...pr.jobFunctions.map((x) => [x, 0.8] as const)]) {
    const all = titleWords(t);
    for (const w of all) if (LEVEL_OF_WORD[w] && pr.levels.length === 0) levels.add(LEVEL_OF_WORD[w]!);
    const words = [...new Set(all.filter((w) => !LEVEL_WORDS.has(w) && !STOP.has(w)))];
    const families = weight < 1 ? familiesOfFunction(t) : null;
    if (words.length) targets.push({ label: t.trim(), words, weight, ...(families ? { families } : {}) });
  }
  // Places: a chosen city counts only within its radius of THAT city (its place id), never the whole state it is in
  // and never another city of the same name (JL-onboarding-17).
  const states = new Set<string>();
  const labels: string[] = [];
  const places: PlaceWant[] = [];
  for (const q of pr.places) {
    const text = q.text.trim();
    if (!text) continue;
    const parts = text.split(',').map((x) => x.trim()).filter(Boolean);
    const city = parts[0] ?? text;
    // A whole state: picked as a region, or typed as the state's name or code with no place id.
    const typed = !q.placeId && parts.length === 1 ? (STATES[city.toUpperCase()] ? city.toUpperCase() : STATE_BY_NAME.get(city.toLowerCase()) ?? null) : null;
    const region = /^region:US-([A-Z]{2})$/.exec(q.placeId ?? '')?.[1] ?? typed;
    if (region) {
      places.push({ label: `In ${text}`, state: region, near: null, city: null, cityState: null });
      states.add(region); labels.push(text);
      continue;
    }
    const radius = q.radiusMiles ?? 0;
    const label = radius > 0 ? `Within ${radius} mi of ${city}` : `In ${city}`;
    let near: Set<string> | null = null;
    if (q.placeId && placeData) {
      try { near = placeData.within(q.placeId, Math.max(radius, 10)); } catch { near = null; }
      if (near && !near.size) near = null;
    }
    const cityState = [...namedStates(parts.slice(1).join(', '))][0] ?? null;
    if (near) places.push({ label, state: null, near, city: null, cityState: null });
    else places.push({ label: `In ${city}`, state: null, near: null, city: new RegExp(`(^|[^\\p{L}])${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'iu'), cityState });
    if (cityState) states.add(cityState);
    labels.push(text);
  }
  const usOnly = pr.countries.includes('US') || states.size > 0;
  const wantsUs = !pr.countries.length || pr.countries.includes('US');
  const placeKey = pr.places.map((q) => [q.text.trim(), q.placeId, q.radiusMiles]);
  return {
    version: createHash('sha256').update(JSON.stringify([targets, [...states], placeKey, usOnly, wantsUs, pr.workModels, pr.employmentTypes, [...levels]])).digest('hex').slice(0, 12),
    targets, states, places, placeLabel: labels.join(', ') || null, usOnly, wantsUs, placeIdsOf: placeIdsWith(placeData),
    workModels: new Set(pr.workModels), employment: new Set(pr.employmentTypes), levels,
    empty: targets.length === 0 && places.length === 0 && pr.workModels.length === 0 && pr.employmentTypes.length === 0 && levels.size === 0 && !usOnly,
  };
}

interface Scored { score: number; chips: WhyFitChip[] }

/** The preference score of one job (higher is better) and the plain reasons behind it. */
export function scoreRow(m: PrefModel, r: CandidateRow): Scored {
  const chips: WhyFitChip[] = [];
  let title = 0;
  let bestLabel = '';
  if (m.targets.length) {
    const have = titleSet(r.title);
    let full = false;
    for (const t of m.targets) {
      const total = t.words.reduce((a, w) => a + wordWeight(w), 0);
      const frac = t.families?.includes(titleFamily(r.title)) ? 1 : t.words.filter((w) => have.has(w)).reduce((a, w) => a + wordWeight(w), 0) / total;
      const hit = frac * t.weight;
      if (hit > title) { title = hit; bestLabel = t.label; full = frac >= 0.999; }
    }
    if (full) chips.push({ kind: 'skills', label: clip(`Title fits "${bestLabel}"`), positive: true });
    else if (title >= 0.5) chips.push({ kind: 'skills', label: clip(`Title close to "${bestLabel}"`), positive: true });
  }
  const remote = r.work_mode === 'remote' || (r.work_mode === '' && r.remote === 1);
  const wm = r.work_mode || (r.remote === 1 ? 'remote' : '');
  let place = 0;
  // A remote job open in the US is a plus only for a person who wants the US (no countries chosen, or the US among
  // them); for anyone else it is a warning (JL-onboarding-18).
  const usRemote = (): void => {
    if (m.wantsUs) { place = 1; chips.push({ kind: 'location', label: 'Remote, open in the US', positive: true }); }
    else chips.push({ kind: 'location', label: 'Remote in the US; you chose other countries', positive: false });
  };
  if (m.places.length) {
    const fit = placeFit(m, r.location);
    if (fit && !(remote && !m.workModels.has('remote'))) { place = 1; chips.push({ kind: 'location', label: clip(fit.label), positive: true }); }
    else if (remote && m.workModels.has('remote') && r.is_us !== 0) usRemote();
  } else if (m.workModels.size && [...m.workModels].every((w) => w === 'remote')) {
    if (remote && r.is_us === 1) { if (m.wantsUs) { place = 1; chips.push({ kind: 'location', label: 'Remote, open in the US', positive: true }); } else usRemote(); }
    else if (remote && r.is_us !== 0) { place = m.usOnly ? 0.7 : 1; chips.push({ kind: 'location', label: 'Remote', positive: true }); }
  } else if (m.usOnly) {
    if (r.is_us === 1) place = 1;
  }
  let work = 0;
  if (m.workModels.size) work = wm ? (m.workModels.has(wm) ? 1 : 0) : 0.3;
  let emp = 0;
  if (m.employment.size) emp = r.employment_type ? (m.employment.has(r.employment_type) ? 1 : 0) : 0.5;
  let lvl = 0;
  if (m.levels.size) {
    const b = r.level ? BUCKET[r.level as Level] : undefined;
    lvl = b ? (m.levels.has(b) ? 1 : 0) : 0.4;
    if (b && m.levels.has(b)) chips.push({ kind: 'level', label: clip(`Level fits (${r.level})`), positive: true });
  }
  return { score: 100 * title + 50 * place + 15 * work + 10 * emp + 10 * lvl, chips };
}

function clip(s: string): string { return s.length <= 60 ? s : s.slice(0, 59) + '…'; }

// ---------------------------------------------------------------- the service

interface Ranked {
  ids: number[]; scores: Map<number, Scored>; fit: Map<number, number>; at: number;
  /** Top Matched: jobs not scored yet (they follow the scored ones), and the fit index generation the order used. */
  waiting: number; gen: number;
}
/**
 * Match percents of the open jobs for one profile (Top Matched). Keyed by crawler row id; `h` is the posting's content
 * hash, so a changed posting is scored again. `p` null = the job could not be scored.
 */
interface FitIndex { version: string; pct: Map<number, { h: string; p: number | null }>; gen: number; running: boolean }
interface PCursor { p: 1; h: string; o: number }

export interface FeedDeps {
  db: DatabaseSync;
  jobs: JobsService;
  profile: () => Profile | null;
  h1b: () => H1bIndex | null;
  /** The place dictionary (radius checks of the places a person wants); null when it is not available. */
  places?: () => (FeedPlaces & PlaceDistance) | null;
}

type PlaceDistance = Parameters<typeof distanceFromPlaceIndex>[0];

const TOP_MATCHED_POOL = 200;
/** Top Matched: after the first TOP_MATCHED_POOL jobs, a search scores more jobs itself for at most this long. */
const TOP_MATCHED_SYNC_MS = 250;
/** The background fit index scores jobs in slices of this length, so other requests are served in between. */
const FIT_SLICE_MS = 40;
const EMPLOYER_CAP = 3;
const EMPLOYER_WINDOW = 20;
const EMPLOYER_LOOKAHEAD = 400;

/**
 * Re-orders a ranked list so that no employer has more than EMPLOYER_CAP jobs in any run of EMPLOYER_WINDOW results.
 * A job that would break the cap waits; the next job (looking at most EMPLOYER_LOOKAHEAD ahead) from another employer
 * takes its place. Every job keeps its place relative to the other jobs of its own employer. Pure and deterministic.
 */
export function spreadEmployers(ids: number[], companyOf: Map<number, string>, cap = EMPLOYER_CAP, window = EMPLOYER_WINDOW): number[] {
  const pending = [...ids];
  const out: number[] = [];
  let counts = new Map<string, number>();
  const keyOf = (id: number) => (companyOf.get(id) ?? '').trim().toLowerCase();
  while (pending.length) {
    let pick = 0;
    if ((counts.get(keyOf(pending[0]!)) ?? 0) >= cap) {
      // The first job under the cap wins; when every employer ahead is at the cap (few employers in the store), the
      // least-represented one in this window goes next, so the window stays as mixed as the store allows.
      const limit = Math.min(pending.length, EMPLOYER_LOOKAHEAD);
      let found = -1;
      let least = 0;
      let leastCount = counts.get(keyOf(pending[0]!)) ?? 0;
      for (let i = 1; i < limit; i++) {
        const c = counts.get(keyOf(pending[i]!)) ?? 0;
        if (c < cap) { found = i; break; }
        if (c < leastCount) { least = i; leastCount = c; }
      }
      pick = found === -1 ? least : found;
    }
    const id = pending.splice(pick, 1)[0]!;
    out.push(id);
    const k = keyOf(id);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (out.length % window === 0) counts = new Map();
  }
  return out;
}

export class FeedService {
  private readonly d: FeedDeps;
  private readonly ranked = new Map<string, Ranked>();
  /** The key of the newest order for a search (Top Matched keeps one order per fit index generation while scoring). */
  private readonly latest = new Map<string, string>();
  /** The cache key of the plain Recommended feed, never evicted. */
  private baseKey: string | null = null;
  private readonly matches = new Map<string, MatchResult>();
  private readonly h1bCache = new Map<string, H1bLookupDetail>();
  private h1bSet: { stamp: string; ids: number[] } | null = null;
  private fitIdx: FitIndex | null = null;
  private stopped = false;

  constructor(d: FeedDeps) { this.d = d; }

  /** Stops the background fit index (the app is closing). */
  stop(): void { this.stopped = true; }

  /** Changes whenever an open job is added, closed or merged, or a board leaves or rejoins the feed (the rank cache key). */
  private stamp(): string {
    const r = this.d.db.prepare('SELECT count(*) AS n, max(id) AS m, total(id) AS s FROM srv_job_index').get() as { n: number; m: number | null; s: number };
    // JL-settings-27: the jobs of an unfollowed, hidden or turned-off board are not in the feed.
    const off = this.d.db.prepare('SELECT group_concat(id) AS ids FROM (SELECT id FROM srv_boards WHERE followed = 0 OR hidden = 1 OR disabled = 1 ORDER BY id)').get() as { ids: string | null };
    return `${r.n}:${r.m ?? 0}:${r.s}:${off.ids ?? ''}`;
  }

  /** The contract job with every fact the crawler stored (places, remote scope, years, statements, pay ranges). */
  job(id: string): Job | null {
    if (!id.startsWith('external:')) {
      try {
        const j = getJobById(this.d.db, id, { companyKey });
        if (j) return j as Job;
      } catch { /* fall back to the narrow record */ }
    }
    return this.d.jobs.get(id);
  }

  h1bLookup(company: string): H1bLookupDetail | null {
    const idx = this.d.h1b();
    if (!idx) return null;
    const k = company.toLowerCase();
    let r = this.h1bCache.get(k);
    if (!r) {
      try { r = idx.lookup(company); } catch { return null; }
      if (this.h1bCache.size > 20_000) this.h1bCache.clear();
      this.h1bCache.set(k, r);
    }
    return r;
  }

  /**
   * The sponsor tag of a job and its plain note (basis and data date). H-1B is a US visa: US filing history gives no
   * tag to a job whose places are all outside the US (JL-feed-21); the posting's own words still do.
   */
  h1b(job: Pick<Job, 'company' | 'statements'> & { isUs?: boolean | null }): { tag: H1bTag | null; note: string | null } {
    const look = job.isUs === false ? null : this.h1bLookup(job.company);
    const summary = look?.status === 'found' ? look.summary : null;
    const t = h1bTagFor(job.statements ?? null, summary);
    if (!t.tag) return { tag: null, note: null };
    if (t.tag === 'likely_by_history' && summary) {
      const w = summary.window;
      return { tag: t.tag, note: `${t.label}: ${summary.certifiedFilings.toLocaleString('en-US')} certified H-1B filings from ${monthYear(w.from)} to ${monthYear(w.to)} (US Department of Labor LCA data, through ${monthYear(summary.dataThrough)}). Past filings do not promise sponsorship for this role.` };
    }
    return { tag: t.tag, note: `${t.label} (from the posting's own words).` };
  }

  /** Crawler row ids of open jobs with a positive sponsor tag (the H-1B filter). */
  private h1bIds(): number[] {
    const stamp = this.stamp();
    if (this.h1bSet?.stamp === stamp) return this.h1bSet.ids;
    const likely = new Set<string>();
    for (const r of this.d.db.prepare('SELECT DISTINCT company FROM srv_job_index').all() as Array<{ company: string }>) {
      const l = this.h1bLookup(r.company);
      if (l?.status === 'found' && l.summary?.status === 'likely') likely.add(r.company);
    }
    const cand = new Set<number>();
    const byCo = this.d.db.prepare('SELECT id FROM srv_job_index WHERE company = ?');
    for (const c of likely) for (const r of byCo.all(c) as Array<{ id: number }>) cand.add(Number(r.id));
    try {
      for (const r of this.d.db.prepare(`SELECT rowid AS id FROM jobs_fts WHERE jobs_fts MATCH 'sponsor* OR visa OR h1b OR "h 1b"'`).all() as Array<{ id: number }>) cand.add(Number(r.id));
    } catch { /* no FTS: filing history only */ }
    const ids: number[] = [];
    const st = this.d.db.prepare('SELECT j.company AS company, j.statements_json AS s, j.is_us AS is_us FROM jobs j WHERE j.id = ? AND j.closed_at IS NULL AND j.duplicate_of IS NULL');
    for (const id of [...cand].sort((a, b) => a - b)) {
      const r = st.get(id) as { company: string; s: string | null; is_us: number | null } | undefined;
      if (!r) continue;
      let statements: Job['statements'] | null = null;
      try { statements = r.s ? JSON.parse(r.s) : null; } catch { statements = null; }
      const t = this.h1b({ company: r.company, statements: statements as Job['statements'], isUs: r.is_us === null ? null : r.is_us === 1 }).tag;
      if (t === 'likely_by_history' || t === 'post_says_yes') ids.push(id);
    }
    this.h1bSet = { stamp, ids };
    return ids;
  }

  private placeData(): (FeedPlaces & PlaceDistance) | null {
    try { return this.d.places?.() ?? null; } catch { return null; }
  }

  /** Distances from the places a person wants, measured from the chosen place (its place id), not its name alone. */
  private distance(): ReturnType<typeof distanceFromPlaceIndex> | undefined {
    const idx = this.placeData();
    if (!idx) return undefined;
    if (this.distanceFn?.idx !== idx) this.distanceFn = { idx, fn: distanceFromPlaceIndex(idx) };
    return this.distanceFn.fn;
  }
  private distanceFn: { idx: PlaceDistance; fn: ReturnType<typeof distanceFromPlaceIndex> } | null = null;

  /** The match of one job for the profile (cached per profile version and posting content). */
  match(profile: Profile, job: Job): MatchResult | null {
    const key = `${profile.version}|${job.id}|${job.contentHash}`;
    let m = this.matches.get(key);
    if (!m) {
      m = this.scoreOne(profile, job) ?? undefined;
      if (!m) return null;
      if (this.matches.size > 50_000) this.matches.clear();
      this.matches.set(key, m);
    }
    return m;
  }

  /**
   * One match of the engine, with the same inputs everywhere (the card, the detail and the Top Matched fit index), so
   * the percent a job is ordered by is the percent it shows. Null when the job cannot be scored.
   */
  private scoreOne(profile: Profile, job: Job): MatchResult | null {
    const places = profile.preferences.places.length ? this.distance() : undefined;
    try { return scoreMatch({ profile, job, company: null, now: nowMs(), ...(places ? { distanceMiles: places } : {}) }) as MatchResult; } catch { return null; }
  }

  search(req: JobSearchRequest, deps: SearchDeps): JobSearchResponse {
    // Text with no letter or digit (a lone "*", quotes, dashes) is no search at all: the plain feed answers, instead
    // of an every-row scan that a wildcard would start (sys-perf O1, gate 9).
    if (req.q !== undefined && !/[\p{L}\p{N}]/u.test(req.q)) req = { ...req, q: undefined };
    const t0 = performance.now();
    const restrict = req.filter?.h1bSponsorship ? this.h1bIds() : null;
    const profile = deps.hasProfile() ? this.d.profile() : null;
    const personal = profile !== null && req.sort !== 'most_recent' && req.filter?.status !== 'closed';
    let res: JobSearchResponse;
    let ranked: Ranked | null = null;
    if (personal) {
      const out = this.personal(req, deps, profile!, restrict);
      res = out.res; ranked = out.ranked;
    } else {
      res = this.d.jobs.search(req, deps, restrict);
    }
    res.items = res.items.map((it) => this.decorate(it, profile, ranked));
    if (personal) {
      const waiting = ranked?.waiting ?? 0;
      res.fit = { state: waiting > 0 ? 'indexing' : 'ready', waiting, model: `jobleft-match ${ENGINE_VERSION}` };
    }
    res.tookMs = Math.round(performance.now() - t0);
    return res;
  }

  private personal(req: JobSearchRequest, deps: SearchDeps, profile: Profile, restrict: number[] | null): { res: JobSearchResponse; ranked: Ranked } {
    const m = prefModel(profile, profile.preferences.places.some((q) => q.placeId) ? this.placeData() : null);
    const { cursor, limit: _l, ...rest } = req;
    const key = createHash('sha256').update(JSON.stringify([rest, profile.version, m.version])).digest('hex').slice(0, 20);
    let offset = 0;
    let h = key;
    if (cursor) {
      let c: PCursor | null = null;
      try { c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as PCursor; } catch { c = null; }
      if (!c || c.p !== 1 || typeof c.o !== 'number' || typeof c.h !== 'string' || !c.h.startsWith(key)) {
        throw new ApiFailure('bad_request', 'The cursor belongs to another search. Start again from the first page.');
      }
      offset = Math.max(0, Math.floor(c.o));
      h = c.h;
    }
    // First page: a fresh order for the current data. Later pages: the order the first page used (kept in memory), so
    // paging never repeats or skips a job while a crawl adds jobs.
    // Hidden jobs never appear and never count (JL-feed-11): the set of hidden jobs is part of the cached order's key,
    // so a hide or an unhide gives a fresh order at once; a later page of an older order skips jobs hidden since.
    const hidden = this.d.jobs.hiddenRowIds().sort((a, b) => a - b);
    const hiddenKey = hidden.length ? createHash('sha256').update(hidden.join(',')).digest('hex').slice(0, 12) : '-';
    let ranked = cursor ? this.ranked.get(h) : undefined;
    if (!ranked) {
      const base = `${key}:${this.stamp()}:${hiddenKey}`;
      let full = this.latest.get(base) ?? base;
      ranked = this.ranked.get(full);
      // Top Matched while the fit index is still scoring: a first page takes the newer scores into its order (under
      // a new key, so the pages of the older order keep their order).
      if (ranked && ranked.waiting > 0 && ranked.gen !== (this.fitIdx?.gen ?? 0)) ranked = undefined;
      if (!ranked) {
        ranked = this.rank(req, profile, m, restrict);
        full = ranked.waiting > 0 || this.latest.has(base) ? `${base}:${ranked.gen}` : base;
        if (this.latest.size > 256) this.latest.clear();
        this.latest.set(base, full);
        this.ranked.set(full, ranked);
        // The plain Recommended feed (no words, no filters) is the order every visit comes back to; a burst of
        // searches must not push it out (a re-rank of 100,000 jobs costs about 0.2 s; gate 9).
        const isBase = !rest.q && Object.keys(rest.filter ?? {}).length === 0 && (rest.sort ?? 'recommended') === 'recommended';
        if (isBase) this.baseKey = full;
        if (this.ranked.size > 24) { for (const k of this.ranked.keys()) { if (k !== this.baseKey) { this.ranked.delete(k); break; } } }
      }
      h = full;
    }
    const limit = req.limit ?? 20;
    const hiddenNow = new Set(hidden);
    const page = ranked.ids.slice(offset, offset + limit).filter((id) => !hiddenNow.has(id));
    const items = this.d.jobs.itemsFor(page, deps);
    const next = offset + limit < ranked.ids.length ? Buffer.from(JSON.stringify({ p: 1, h, o: offset + limit } satisfies PCursor)).toString('base64url') : null;
    const total = hiddenNow.size ? ranked.ids.reduce((n, id) => n + (hiddenNow.has(id) ? 0 : 1), 0) : ranked.ids.length;
    return { res: { items, total, nextCursor: next, fit: { state: 'ready', waiting: 0, model: null }, tookMs: 0 }, ranked };
  }

  private rank(req: JobSearchRequest, profile: Profile, m: PrefModel, restrict: number[] | null): Ranked {
    const rows = this.d.jobs.candidates(req, restrict);
    const scores = new Map<number, Scored>();
    for (const r of rows) scores.set(r.id, scoreRow(m, r));
    const rec = new Map(rows.map((r) => [r.id, r.sort_rec ?? -1]));
    const byPref = (a: number, b: number) => (scores.get(b)!.score - scores.get(a)!.score) || (rec.get(b)! - rec.get(a)!) || (a - b);
    let ids = rows.map((r) => r.id).sort(byPref);
    // The match engine scores the best preference candidates. Top Matched orders them by the match percent (the rest
    // follow, marked "not scored"); Recommended adds 0.3 x the percent to the preference score, so a better match
    // wins among jobs that fit the preferences alike, while a firm preference (title, place) still decides first.
    if (req.sort === 'top_matched') return this.rankTopMatched(ids, scores, byPref, profile);
    const fit = new Map<number, number>();
    const pool = ids.slice(0, TOP_MATCHED_POOL);
    const idOf = this.d.db.prepare('SELECT ats, board, job_id FROM jobs WHERE id = ?');
    for (const id of pool) {
      const r = idOf.get(id) as { ats: string; board: string; job_id: string } | undefined;
      const job = r ? this.job(contractJobId(r)) : null;
      const res = job ? this.match(profile, job) : null;
      if (res) fit.set(id, res.percent);
    }
    const inPool = new Set(pool);
    const rest = ids.filter((id) => !inPool.has(id));
    const key = (id: number) => scores.get(id)!.score + 0.3 * (fit.get(id) ?? 0);
    ids = [...[...pool].sort((a, b) => (key(b) - key(a)) || byPref(a, b)), ...rest];
    fit.clear();
    // One employer never fills a screen: the top of the feed used to be six near-identical postings from one company
    // (gate 7 note; the founder's review on 2026-09-27). At most EMPLOYER_CAP jobs of one employer in every run of
    // EMPLOYER_WINDOW results; its other jobs keep their order further down.
    ids = spreadEmployers(ids, new Map(rows.map((r) => [r.id, r.company])));
    return { ids, scores, fit, at: nowMs(), waiting: 0, gen: 0 };
  }

  /**
   * Top Matched (JL-feed-6): every matching job in the order of its match percent, highest first, across all pages
   * (ties by preference, then row id). The percent is the one the card and the detail show. Jobs the fit index has not
   * scored yet follow the scored ones in preference order and are counted as `waiting`; the index scores them in the
   * background, and the next first page puts them in their place. No employer spreading here: it would break the order.
   */
  private rankTopMatched(prefOrder: number[], scores: Map<number, Scored>, byPref: (a: number, b: number) => number, profile: Profile): Ranked {
    const idx = this.fitIndexFor(profile);
    const hashes = this.contentHashes();
    const fit = new Map<number, number>();
    const unscorable = new Set<number>();
    const missing: number[] = [];
    for (const id of prefOrder) {
      const e = idx.pct.get(id);
      if (e && e.h === hashes.get(id)) { if (e.p === null) unscorable.add(id); else fit.set(id, e.p); } else missing.push(id);
    }
    // The best preference candidates are scored now, then more while the time allows; the rest in the background.
    const t0 = performance.now();
    let k = 0;
    for (; k < missing.length; k++) {
      if (k >= TOP_MATCHED_POOL && performance.now() - t0 > TOP_MATCHED_SYNC_MS) break;
      const id = missing[k]!;
      const p = this.scoreInto(idx, profile, id, hashes.get(id) ?? '');
      if (p === null) unscorable.add(id); else fit.set(id, p);
    }
    const waiting = missing.length - k;
    if (waiting > 0) this.startFitIndex(profile);
    const scored = prefOrder.filter((id) => fit.has(id)).sort((a, b) => (fit.get(b)! - fit.get(a)!) || byPref(a, b));
    const ids = [...scored, ...prefOrder.filter((id) => !fit.has(id) && !unscorable.has(id)), ...prefOrder.filter((id) => unscorable.has(id))];
    return { ids, scores, fit, at: nowMs(), waiting, gen: idx.gen };
  }

  /** The fit index of this profile (a new one when the profile or the month changes: the score counts months). */
  private fitIndexFor(profile: Profile): FitIndex {
    const version = `${profile.version}|${new Date(nowMs()).toISOString().slice(0, 7)}`;
    if (!this.fitIdx || this.fitIdx.version !== version) this.fitIdx = { version, pct: new Map(), gen: (this.fitIdx?.gen ?? 0) + 1, running: false };
    return this.fitIdx;
  }

  /** Content hash of every open job (crawler row id -> hash). */
  private contentHashes(): Map<number, string> {
    const out = new Map<number, string>();
    for (const r of this.d.db.prepare('SELECT j.id AS id, j.content_hash AS h FROM srv_job_index x JOIN jobs j ON j.id = x.id').all() as Array<{ id: number; h: string }>) out.set(Number(r.id), String(r.h));
    return out;
  }

  /** Scores one job for the profile and keeps only its percent in the index (null when it cannot be scored). */
  private scoreInto(idx: FitIndex, profile: Profile, id: number, hash: string): number | null {
    const r = this.d.db.prepare('SELECT ats, board, job_id FROM jobs WHERE id = ?').get(id) as { ats: string; board: string; job_id: string } | undefined;
    const job = r ? this.job(contractJobId(r)) : null;
    let p: number | null = null;
    if (job) {
      const cached = this.matches.get(`${profile.version}|${job.id}|${job.contentHash}`);
      if (cached) p = cached.percent;
      else p = this.scoreOne(profile, job)?.percent ?? null;
    }
    idx.pct.set(id, { h: hash || job?.contentHash || '', p });
    return p;
  }

  /** Scores the open jobs the index lacks, in short slices between other requests, until all are done. */
  private startFitIndex(profile: Profile): void {
    const idx = this.fitIndexFor(profile);
    if (idx.running || this.stopped) return;
    idx.running = true;
    let todo: Array<[number, string]> | null = null;
    let at = 0;
    const slice = () => {
      try {
        if (this.stopped || this.fitIdx !== idx) { idx.running = false; return; }
        const cur = this.d.profile();
        if (!cur || cur.version !== profile.version) { idx.running = false; return; }
        if (!todo) todo = [...this.contentHashes()].filter(([id, h]) => idx.pct.get(id)?.h !== h);
        const t0 = performance.now();
        while (at < todo.length && performance.now() - t0 < FIT_SLICE_MS) {
          const [id, h] = todo[at++]!;
          if (idx.pct.get(id)?.h !== h) this.scoreInto(idx, profile, id, h);
        }
        idx.gen++;
        if (at < todo.length) { setTimeout(slice, 0).unref?.(); return; }
        idx.running = false;
      } catch {
        idx.running = false; // the database closed (restore, delete-all, shutdown): the next search starts again
      }
    };
    setTimeout(slice, 0).unref?.();
  }

  /** Full facts, the match percent with its reasons, and the sponsor tag on one card. */
  private decorate(it: JobListItem, profile: Profile | null, ranked: Ranked | null): JobListItem {
    const job = this.job(it.job.id);
    if (!job) return it;
    const out: JobListItem = { ...it, job: toSummary(job) };
    const h = this.h1b(job);
    out.h1bTag = h.tag;
    if (h.note) out.h1bNote = h.note; else delete out.h1bNote;
    if (profile) {
      const res = this.match(profile, job);
      const rowId = this.rowId(job.id);
      const pref = ranked && rowId !== null ? ranked.scores.get(rowId) : undefined;
      if (res) {
        const idx = this.fitIdx;
        if (idx && rowId !== null && idx.version.startsWith(`${profile.version}|`) && idx.pct.get(rowId)?.h !== job.contentHash) idx.pct.set(rowId, { h: job.contentHash, p: res.percent });
        const sum = summarize(res);
        const chips = [...(pref?.chips ?? []), ...sum.whyFit.filter((c) => !(pref?.chips ?? []).some((p) => p.kind === c.kind))];
        out.match = { ...sum, whyFit: chips.slice(0, 2) };
        if (ranked && rowId !== null && ranked.fit.has(rowId)) out.fitScore = Math.round(ranked.fit.get(rowId)!) / 100;
      }
    }
    return out;
  }

  private rowId(id: string): number | null {
    const r = this.d.jobs.getRow(id);
    return r ? Number(r.id) : null;
  }
}

function monthYear(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : iso;
}
