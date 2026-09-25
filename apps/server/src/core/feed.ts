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
import { ENGINE_VERSION, scoreMatch, summarize } from '@jobleft/match';
import { h1bTagFor, type H1bIndex, type H1bLookupDetail, type H1bTag } from '@jobleft/static-data';
import { ApiFailure } from '../errors.ts';
import { companyKey } from '../interim/company-key.ts';
import { contractJobId, toSummary, type CandidateRow, type JobsService, type SearchDeps } from '../interim/jobs.ts';

// ---------------------------------------------------------------- preferences

const STATES: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware',
  FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky',
  LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi',
  MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico',
  NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
  RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont',
  VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming', DC: 'district of columbia',
};
const STATE_BY_NAME = new Map(Object.entries(STATES).map(([c, n]) => [n, c]));
const STATE_NAME_RE = new RegExp(`\\b(${[...STATE_BY_NAME.keys()].sort((a, b) => b.length - a.length).join('|')})\\b`, 'gi');
// Big cities whose postings often omit the state.
const CITY_STATE: Record<string, string> = {
  houston: 'TX', dallas: 'TX', austin: 'TX', 'san antonio': 'TX', 'fort worth': 'TX', 'el paso': 'TX', plano: 'TX', irving: 'TX',
  'new york city': 'NY', nyc: 'NY', manhattan: 'NY', brooklyn: 'NY', 'san francisco': 'CA', 'los angeles': 'CA', 'san diego': 'CA',
  'san jose': 'CA', seattle: 'WA', chicago: 'IL', boston: 'MA', atlanta: 'GA', denver: 'CO', miami: 'FL', phoenix: 'AZ',
  philadelphia: 'PA', detroit: 'MI', minneapolis: 'MN', nashville: 'TN', portland: 'OR', 'salt lake city': 'UT',
};
const CITY_RE = new RegExp(`\\b(${Object.keys(CITY_STATE).sort((a, b) => b.length - a.length).join('|')})\\b`, 'gi');

/** US state codes a place text names ("Austin, TX", "Dallas, Texas", "Houston"). */
export function statesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[,(/;|\s-])([A-Z]{2})(?=$|[\s,)/;|.-])/g)) if (STATES[m[1]!]) out.add(m[1]!);
  for (const m of text.matchAll(STATE_NAME_RE)) out.add(STATE_BY_NAME.get(m[1]!.toLowerCase())!);
  for (const m of text.matchAll(CITY_RE)) out.add(CITY_STATE[m[1]!.toLowerCase()]!);
  // "Washington, DC" is DC, not the state.
  if (/washington,?\s*d\.?c\.?/i.test(text)) { out.add('DC'); if (!/washington state|, wa\b/i.test(text)) out.delete('WA'); }
  return out;
}

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
export function titleWords(text: string): string[] {
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

interface Target { label: string; words: string[] }

export interface PrefModel {
  version: string;
  targets: Target[];
  states: Set<string>;
  placeLabel: string | null;
  usOnly: boolean;
  workModels: Set<string>;
  employment: Set<string>;
  levels: Set<ExperienceLevel>;
  empty: boolean;
}

export function prefModel(p: Profile): PrefModel {
  const pr = p.preferences;
  const targets: Target[] = [];
  const levels = new Set<ExperienceLevel>(pr.levels);
  for (const t of [...pr.targetTitles, ...pr.jobFunctions]) {
    const all = titleWords(t);
    for (const w of all) if (LEVEL_OF_WORD[w] && pr.levels.length === 0) levels.add(LEVEL_OF_WORD[w]!);
    const words = [...new Set(all.filter((w) => !LEVEL_WORDS.has(w) && !STOP.has(w)))];
    if (words.length) targets.push({ label: t.trim(), words });
  }
  const states = new Set<string>();
  const labels: string[] = [];
  for (const q of pr.places) {
    const s = statesIn(q.text);
    const m = /^region:US-([A-Z]{2})$/.exec(q.placeId ?? '');
    if (m) s.add(m[1]!);
    if (s.size) { for (const x of s) states.add(x); labels.push(q.text.trim()); }
  }
  const usOnly = pr.countries.includes('US') || states.size > 0;
  return {
    version: createHash('sha256').update(JSON.stringify([targets, [...states], usOnly, pr.workModels, pr.employmentTypes, [...levels]])).digest('hex').slice(0, 12),
    targets, states, placeLabel: labels.join(', ') || null, usOnly,
    workModels: new Set(pr.workModels), employment: new Set(pr.employmentTypes), levels,
    empty: targets.length === 0 && states.size === 0 && pr.workModels.length === 0 && pr.employmentTypes.length === 0 && levels.size === 0 && !usOnly,
  };
}

interface Scored { score: number; chips: WhyFitChip[] }

/** The preference score of one job (higher is better) and the plain reasons behind it. */
export function scoreRow(m: PrefModel, r: CandidateRow): Scored {
  const chips: WhyFitChip[] = [];
  let title = 0;
  let bestLabel = '';
  if (m.targets.length) {
    const have = new Set(titleWords(r.title));
    for (const t of m.targets) {
      const hit = t.words.filter((w) => have.has(w)).length / t.words.length;
      if (hit > title) { title = hit; bestLabel = t.label; }
    }
    if (title >= 0.999) chips.push({ kind: 'skills', label: clip(`Title fits "${bestLabel}"`), positive: true });
    else if (title >= 0.5) chips.push({ kind: 'skills', label: clip(`Title close to "${bestLabel}"`), positive: true });
  }
  const remote = r.work_mode === 'remote' || (r.work_mode === '' && r.remote === 1);
  const wm = r.work_mode || (r.remote === 1 ? 'remote' : '');
  let place = 0;
  if (m.states.size) {
    const js = statesIn(r.location);
    const inPlace = [...js].some((s) => m.states.has(s));
    if (inPlace && !(remote && !m.workModels.has('remote'))) { place = 1; chips.push({ kind: 'location', label: clip(`In ${m.placeLabel}`), positive: true }); }
    else if (remote && m.workModels.has('remote') && r.is_us !== 0) { place = 1; chips.push({ kind: 'location', label: 'Remote, open in the US', positive: true }); }
  } else if (m.workModels.size && [...m.workModels].every((w) => w === 'remote')) {
    if (remote && r.is_us !== 0) { place = m.usOnly && r.is_us !== 1 ? 0.7 : 1; chips.push({ kind: 'location', label: r.is_us === 1 ? 'Remote, open in the US' : 'Remote', positive: true }); }
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

interface Ranked { ids: number[]; scores: Map<number, Scored>; fit: Map<number, number>; at: number }
interface PCursor { p: 1; h: string; o: number }

export interface FeedDeps {
  db: DatabaseSync;
  jobs: JobsService;
  profile: () => Profile | null;
  h1b: () => H1bIndex | null;
}

const TOP_MATCHED_POOL = 200;

export class FeedService {
  private readonly d: FeedDeps;
  private readonly ranked = new Map<string, Ranked>();
  private readonly matches = new Map<string, MatchResult>();
  private readonly h1bCache = new Map<string, H1bLookupDetail>();
  private h1bSet: { stamp: string; ids: number[] } | null = null;

  constructor(d: FeedDeps) { this.d = d; }

  /** Changes whenever an open job is added, closed or merged (the rank cache key). */
  private stamp(): string {
    const r = this.d.db.prepare('SELECT count(*) AS n, max(id) AS m, total(id) AS s FROM srv_job_index').get() as { n: number; m: number | null; s: number };
    return `${r.n}:${r.m ?? 0}:${r.s}`;
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

  /** The sponsor tag of a job and its plain note (basis and data date). */
  h1b(job: Pick<Job, 'company' | 'statements'>): { tag: H1bTag | null; note: string | null } {
    const look = this.h1bLookup(job.company);
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
    const st = this.d.db.prepare('SELECT j.company AS company, j.statements_json AS s FROM jobs j WHERE j.id = ? AND j.closed_at IS NULL AND j.duplicate_of IS NULL');
    for (const id of [...cand].sort((a, b) => a - b)) {
      const r = st.get(id) as { company: string; s: string | null } | undefined;
      if (!r) continue;
      let statements: Job['statements'] | null = null;
      try { statements = r.s ? JSON.parse(r.s) : null; } catch { statements = null; }
      const t = this.h1b({ company: r.company, statements: statements as Job['statements'] }).tag;
      if (t === 'likely_by_history' || t === 'post_says_yes') ids.push(id);
    }
    this.h1bSet = { stamp, ids };
    return ids;
  }

  /** The match of one job for the profile (cached per profile version and posting content). */
  match(profile: Profile, job: Job): MatchResult | null {
    const key = `${profile.version}|${job.id}|${job.contentHash}`;
    let m = this.matches.get(key);
    if (!m) {
      try { m = scoreMatch({ profile, job, company: null, now: nowMs() }) as MatchResult; } catch { return null; }
      if (this.matches.size > 50_000) this.matches.clear();
      this.matches.set(key, m);
    }
    return m;
  }

  search(req: JobSearchRequest, deps: SearchDeps): JobSearchResponse {
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
    if (personal) res.fit = { state: 'ready', waiting: 0, model: `jobleft-match ${ENGINE_VERSION}` };
    res.tookMs = Math.round(performance.now() - t0);
    return res;
  }

  private personal(req: JobSearchRequest, deps: SearchDeps, profile: Profile, restrict: number[] | null): { res: JobSearchResponse; ranked: Ranked } {
    const m = prefModel(profile);
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
    let ranked = cursor ? this.ranked.get(h) : undefined;
    if (!ranked) {
      const full = `${key}:${this.stamp()}`;
      ranked = this.ranked.get(full);
      if (!ranked) {
        ranked = this.rank(req, profile, m, restrict);
        this.ranked.set(full, ranked);
        if (this.ranked.size > 24) this.ranked.delete(this.ranked.keys().next().value!);
      }
      h = full;
    }
    const limit = req.limit ?? 20;
    const page = ranked.ids.slice(offset, offset + limit);
    const items = this.d.jobs.itemsFor(page, deps);
    const next = offset + limit < ranked.ids.length ? Buffer.from(JSON.stringify({ p: 1, h, o: offset + limit } satisfies PCursor)).toString('base64url') : null;
    return { res: { items, total: ranked.ids.length, nextCursor: next, fit: { state: 'ready', waiting: 0, model: null }, tookMs: 0 }, ranked };
  }

  private rank(req: JobSearchRequest, profile: Profile, m: PrefModel, restrict: number[] | null): Ranked {
    const rows = this.d.jobs.candidates(req, restrict);
    const scores = new Map<number, Scored>();
    for (const r of rows) scores.set(r.id, scoreRow(m, r));
    const rec = new Map(rows.map((r) => [r.id, r.sort_rec ?? -1]));
    const byPref = (a: number, b: number) => (scores.get(b)!.score - scores.get(a)!.score) || (rec.get(b)! - rec.get(a)!) || (a - b);
    let ids = rows.map((r) => r.id).sort(byPref);
    const fit = new Map<number, number>();
    if (req.sort === 'top_matched') {
      // The match engine scores the best preference candidates; the rest follow, marked "not scored".
      const pool = ids.slice(0, TOP_MATCHED_POOL);
      const idOf = this.d.db.prepare('SELECT ats, board, job_id FROM jobs WHERE id = ?');
      for (const id of pool) {
        const r = idOf.get(id) as { ats: string; board: string; job_id: string } | undefined;
        const job = r ? this.job(contractJobId(r)) : null;
        const res = job ? this.match(profile, job) : null;
        if (res) fit.set(id, res.percent);
      }
      const scored = pool.filter((id) => fit.has(id)).sort((a, b) => (fit.get(b)! - fit.get(a)!) || byPref(a, b));
      const unscored = ids.filter((id) => !fit.has(id));
      ids = [...scored, ...unscored];
    }
    return { ids, scores, fit, at: nowMs() };
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
