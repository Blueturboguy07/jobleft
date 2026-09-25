// Job search: words (FTS5), every filter of the "All Filters" drawer (typed arrays in RAM), three sort orders, a
// true total, and paging that never repeats or skips a job.
//
// Method (spike S2): the filter runs over typed arrays (a few ms at 500K rows); words come from FTS5 as rowid lists
// (group_concat, parsed in JS); fit order is a brute-force dot product over the candidates' vectors, cached per
// profile. The whole ordered result is kept as a snapshot, so later pages are slices of the same order even while
// new jobs arrive. The cursor names the snapshot and the last job's sort key; when the snapshot is gone (restart,
// eviction) the order is rebuilt and paging continues after that key.

import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  validate, JobSearchRequestSchema,
  type FitState, type Job, type JobFilter, type JobListItem, type JobSearchRequest, type JobSearchResponse, type JobSummary,
  type TrackerStatus,
} from '@jobleft/contracts';
import type { H1bIndex, PlaceIndex } from '@jobleft/static-data';
import { decodeRecord } from './codec.ts';
import { StoreError, q } from './db.ts';
import { F_EXISTS, F_HASPLACE, F_HIDDEN, F_OPEN, type MemIndex } from './memindex.ts';
import {
  companyKeyOf, EMP_TYPE_CODE, LEVEL_BIT, STMT_CITIZEN_YES, STMT_CLEARANCE_YES, STMT_SPONSOR_NO, STMT_SPONSOR_YES,
  WORK_MODEL_CODE,
} from './record.ts';
import { foldPlace, ftsString, indexText, parsePlaceQuery, parseQuery, plainTokens } from './text.ts';
import type { VectorIndex } from './vectors.ts';

export const DEFAULT_LIMIT = 20;
const POSTED_WINDOW_MS: Record<string, number> = { '24h': 86_400_000, '3d': 3 * 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
const EPOCH_2000_MS = Date.UTC(2000, 0, 1);

export interface SearchDeps {
  db: DatabaseSync;
  mem: MemIndex;
  /** Vectors of the current fit model (null when fit indexing is off). */
  vec: VectorIndex | null;
  profileVector: Float32Array | null;
  /** Why fit order cannot run when there is no profile vector. */
  fitUnavailable?: 'needs_profile' | 'not_ready';
  fitModel: string | null;
  /** Open jobs still waiting for fit indexing (global). */
  fitWaiting: number;
  /** Fit model state for the response. */
  fitModelReady: boolean;
  h1b?: H1bIndex | null;
  places?: PlaceIndex | null;
  now: number;
  /** Called with candidates that have no vector yet, so fit indexing does them next. */
  requestFit?: (rids: number[]) => void;
}

// ---------------------------------------------------------------- FTS helpers

/** Row ids that match an FTS5 expression, in ascending order. A bad expression gives an empty list, never an error. */
export function ftsRids(db: DatabaseSync, table: 'job_head_fts' | 'job_body_fts' | 'job_title_fts', match: string): Int32Array {
  let s = '';
  try {
    const r = q(db, `SELECT group_concat(rowid) AS s FROM ${table} WHERE ${table} MATCH ?`).get(match) as { s: string | null };
    s = r.s ?? '';
  } catch {
    return new Int32Array(0);
  }
  if (s === '') return new Int32Array(0);
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 44) n++;
  const out = new Int32Array(n);
  let k = 0, v = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 44) { out[k++] = v; v = 0; } else v = v * 10 + (c - 48);
  }
  out[k] = v;
  return out;
}

// ---------------------------------------------------------------- filter compile

export interface Compiled {
  wantOpen: boolean;
  levelMask: number; incLevel: boolean;
  workModels: number; incWorkModel: boolean; // bit per code
  empTypes: number; incEmpType: boolean;
  maxYears: number; incYears: boolean;
  postedMin: number; incPosted: boolean;
  minPay: number; incPay: boolean;
  placeMask: Uint8Array | null; incPlace: boolean;
  countryMask: Uint8Array | null;
  remoteMask: Uint8Array | null; remoteWorldwide: number; incRemote: boolean;
  skillMask: Uint8Array | null; exSkillMask: Uint8Array | null;
  sourceMask: Uint8Array | null;
  companyInclude: Uint8Array | null; companyExclude: Uint8Array | null;
  companyPass: Uint8Array | null;
  h1b: boolean; h1bLikely: Uint8Array | null;
  exClearance: boolean; exCitizen: boolean;
  roleTypes: number;
  titleExclude: Uint8Array | null;
  functionAllow: Uint8Array | null;
}

function allOrNone<T>(a: T[] | undefined): T[] | null {
  return a && a.length > 0 ? a : null;
}

function ridMask(cap: number, lists: Int32Array[]): Uint8Array {
  const m = new Uint8Array(cap);
  for (const l of lists) for (let i = 0; i < l.length; i++) if (l[i]! < cap) m[l[i]!] = 1;
  return m;
}

/** Builds the set of place tags a PlaceQuery accepts. */
function placeTags(q: { text: string; placeId: string | null; radiusMiles: number | null }, places: PlaceIndex | null | undefined): string[] {
  const out: string[] = [];
  if (q.placeId) {
    out.push(`pid:${q.placeId}`);
    if (places && q.radiusMiles && q.radiusMiles > 0) {
      try { for (const id of places.within(q.placeId, q.radiusMiles)) out.push(`pid:${id}`); } catch { /* place data not available */ }
    }
  }
  const w = parsePlaceQuery(q.text ?? '', q.placeId);
  if (w.city && w.region) out.push(`p:${w.city}|${w.region}`);
  else if (w.city) { out.push(`pc:${w.city}`); out.push(`pt:${w.city}`); }
  else if (w.region) out.push(`pr:${w.region}`);
  else if (w.country) out.push(`c:${w.country}`);
  if (!w.city && !w.region && !w.country && w.text) out.push(`pt:${w.text}`);
  return out;
}

export function compileFilter(f: JobFilter, deps: Pick<SearchDeps, 'db' | 'mem' | 'h1b' | 'places' | 'now'>): Compiled {
  const mem = deps.mem;
  const inc = new Set(f.includeUnknown ?? []);
  const c: Compiled = {
    wantOpen: (f.status ?? 'open') === 'open',
    levelMask: 0, incLevel: inc.has('level'),
    workModels: 0, incWorkModel: inc.has('workModel'),
    empTypes: 0, incEmpType: inc.has('employmentType'),
    maxYears: -1, incYears: inc.has('years'),
    postedMin: NaN, incPosted: inc.has('postedAt'),
    minPay: -1, incPay: inc.has('pay'),
    placeMask: null, incPlace: inc.has('place'), countryMask: null,
    remoteMask: null, remoteWorldwide: -1, incRemote: inc.has('remoteRegion'),
    skillMask: null, exSkillMask: null, sourceMask: null,
    companyInclude: null, companyExclude: null, companyPass: null,
    h1b: f.h1bSponsorship === true, h1bLikely: null,
    exClearance: f.excludeClearanceRequired === true, exCitizen: f.excludeUsCitizenOnly === true,
    roleTypes: 0, titleExclude: null, functionAllow: null,
  };
  for (const l of f.levels ?? []) c.levelMask |= LEVEL_BIT[l] ?? 0;
  for (const w of f.workModels ?? []) c.workModels |= 1 << (WORK_MODEL_CODE[w] ?? 0);
  for (const e of f.employmentTypes ?? []) c.empTypes |= 1 << (EMP_TYPE_CODE[e] ?? 0);
  if (f.maxYearsRequired !== undefined) c.maxYears = f.maxYearsRequired;
  if (f.postedWithin) c.postedMin = deps.now - POSTED_WINDOW_MS[f.postedWithin]!;
  if (f.minAnnualPayUsd !== undefined && f.minAnnualPayUsd > 0) c.minPay = f.minAnnualPayUsd;
  if (f.places && f.places.length > 0) {
    const tags = f.places.flatMap((p) => placeTags({ text: p.text, placeId: p.placeId ?? null, radiusMiles: p.radiusMiles ?? null }, deps.places));
    c.placeMask = mem.tagMask(tags).mask;
  }
  if (f.countries && f.countries.length > 0) c.countryMask = mem.tagMask(f.countries.map((x) => `c:${x.toUpperCase()}`)).mask;
  if (f.remoteRegions && f.remoteRegions.length > 0) {
    c.remoteMask = mem.tagMask([...f.remoteRegions.map((r) => `rr:${r.toUpperCase()}`), 'rr:WORLDWIDE']).mask;
  }
  if (f.skills && f.skills.length > 0) c.skillMask = mem.tagMask(f.skills.map((s) => `k:${foldPlace(s)}`)).mask;
  if (f.excludedSkills && f.excludedSkills.length > 0) c.exSkillMask = mem.tagMask(f.excludedSkills.map((s) => `k:${foldPlace(s)}`)).mask;
  if (f.sources && f.sources.length > 0) c.sourceMask = mem.tagMask(f.sources.map((s) => `s:${s.toLowerCase()}`)).mask;
  const companyTags = (list: string[]) => mem.tagMask(list.flatMap((k) => [`co:${k}`, `co:${companyKeyOf(k)}`])).mask;
  if (f.companies && f.companies.length > 0) c.companyInclude = companyTags(f.companies);
  if (f.excludedCompanies && f.excludedCompanies.length > 0) c.companyExclude = companyTags(f.excludedCompanies);
  for (const r of f.roleTypes ?? []) c.roleTypes |= r === 'manager' ? 2 : 1;

  const wantInd = allOrNone(f.industries)?.map((x) => x.toLowerCase());
  const exInd = allOrNone(f.excludedIndustries)?.map((x) => x.toLowerCase());
  const stages = allOrNone(f.companyStages);
  const exStaff = f.excludeStaffingAgencies === true;
  if (wantInd || exInd || stages || exStaff) {
    const pass = new Uint8Array(mem.maxTagId + 1);
    const byTag = new Map<number, ReturnType<MemIndex['companies']['get']>>();
    for (const [id, facts] of mem.companies) byTag.set(id, facts);
    for (let id = 1; id <= mem.maxTagId; id++) {
      const name = mem.tagNameById[id];
      if (!name || !name.startsWith('co:')) continue;
      const facts = byTag.get(id);
      const ind = (facts?.industries ?? []).map((x) => x.toLowerCase());
      let ok = true;
      if (wantInd && !ind.some((x) => wantInd.includes(x))) ok = false;
      if (ok && exInd && ind.some((x) => exInd.includes(x))) ok = false;
      if (ok && stages && !(facts?.stage && (stages as string[]).includes(facts.stage))) ok = false;
      if (ok && exStaff && facts?.isStaffing === true) ok = false;
      pass[id] = ok ? 1 : 0;
    }
    c.companyPass = pass;
  }
  if (c.h1b) c.h1bLikely = h1bLikelyMask(deps.mem, deps.h1b ?? null);
  if (f.excludedTitles && f.excludedTitles.length > 0) {
    const lists = f.excludedTitles.map((t) => plainTokens(indexText(t))).filter((t) => t.length > 0)
      .map((toks) => ftsRids(deps.db, 'job_head_fts', `title : ${ftsString(toks.join(' '))}`));
    c.titleExclude = ridMask(mem.cap, lists);
  }
  if (f.jobFunctions && f.jobFunctions.length > 0) {
    const lists = f.jobFunctions.map((t) => plainTokens(indexText(t))).filter((t) => t.length > 0)
      .map((toks) => ftsRids(deps.db, 'job_head_fts', `{title extra} : (${toks.map(ftsString).join(' AND ')})`));
    c.functionAllow = ridMask(mem.cap, lists);
  }
  return c;
}

const h1bCache = new WeakMap<MemIndex, { gen: number; mask: Uint8Array; lookups: Map<number, boolean> }>();

/** Company tags whose H-1B history says "likely" (from company facts, else from the H-1B index when present). */
function h1bLikelyMask(mem: MemIndex, h1b: H1bIndex | null): Uint8Array {
  let cached = h1bCache.get(mem);
  if (cached && cached.gen === mem.generation && cached.mask.length === mem.maxTagId + 1) return cached.mask;
  const lookups = cached?.lookups ?? new Map<number, boolean>();
  const mask = new Uint8Array(mem.maxTagId + 1);
  for (let id = 1; id <= mem.maxTagId; id++) {
    const name = mem.tagNameById[id];
    if (!name || !name.startsWith('co:')) continue;
    const facts = mem.companies.get(id);
    if (facts?.h1b) { mask[id] = facts.h1b === 'likely' ? 1 : 0; continue; }
    if (!h1b) continue;
    let v = lookups.get(id);
    if (v === undefined) {
      try { const r = h1b.lookup(name.slice(3)); v = r.status === 'found' && r.summary?.status === 'likely'; } catch { v = false; }
      lookups.set(id, v);
    }
    mask[id] = v ? 1 : 0;
  }
  h1bCache.set(mem, { gen: mem.generation, mask, lookups });
  return mask;
}

/** Does row `rid` pass every filter? */
function passes(c: Compiled, m: MemIndex, rid: number): boolean {
  const fl = m.flags[rid]!;
  if ((fl & F_EXISTS) === 0 || (fl & F_HIDDEN) !== 0) return false;
  if (c.wantOpen !== ((fl & F_OPEN) !== 0)) return false;
  if (c.levelMask !== 0) {
    const lm = m.levelMask[rid]!;
    if (lm === 0 ? !c.incLevel : (lm & c.levelMask) === 0) return false;
  }
  if (c.workModels !== 0) {
    const w = m.workModel[rid]!;
    if (w === 0 ? !c.incWorkModel : (c.workModels & (1 << w)) === 0) return false;
  }
  if (c.empTypes !== 0) {
    const e = m.empType[rid]!;
    if (e === 0 ? !c.incEmpType : (c.empTypes & (1 << e)) === 0) return false;
  }
  if (c.maxYears >= 0) {
    const y = m.yearsMin[rid]!;
    if (y === 255 ? !c.incYears : y > c.maxYears) return false;
  }
  if (c.postedMin === c.postedMin) {
    const p = m.postedMs[rid]!;
    if (p !== p ? !c.incPosted : p < c.postedMin) return false;
  }
  if (c.minPay >= 0) {
    if (m.payKind[rid] !== 1) { if (!c.incPay) return false; }
    else {
      const hi = m.payHi[rid]!;
      const top = hi === hi ? hi : m.payLo[rid]!;
      if (top !== top) { if (!c.incPay) return false; }
      else if (top < c.minPay) return false;
    }
  }
  if (c.placeMask || c.countryMask) {
    const known = (fl & F_HASPLACE) !== 0;
    if (!known) { if (!c.incPlace) return false; }
    else {
      if (c.placeMask && !m.hasTag(rid, c.placeMask)) return false;
      if (c.countryMask && !m.hasTag(rid, c.countryMask)) return false;
    }
  }
  if (c.remoteMask) {
    const w = m.workModel[rid]!;
    if (w === 0) { if (!c.incRemote) return false; }
    else if (w !== 3) return false;
    else if (!m.hasTag(rid, c.remoteMask)) {
      // Remote with no stated scope is unknown.
      if (!c.incRemote || hasPrefixTag(m, rid, 'rr:')) return false;
    }
  }
  if (c.skillMask && !m.hasTag(rid, c.skillMask)) return false;
  if (c.exSkillMask && m.hasTag(rid, c.exSkillMask)) return false;
  if (c.sourceMask && !m.hasTag(rid, c.sourceMask)) return false;
  const co = m.companyTag[rid]!;
  if (c.companyInclude && (co < 0 || c.companyInclude[co] !== 1)) return false;
  if (c.companyExclude && co >= 0 && c.companyExclude[co] === 1) return false;
  if (c.companyPass && (co < 0 || c.companyPass[co] !== 1)) return false;
  const st = m.stmt[rid]!;
  if (c.h1b) {
    if (st & STMT_SPONSOR_NO) return false;
    if ((st & STMT_SPONSOR_YES) === 0 && !(co >= 0 && c.h1bLikely && c.h1bLikely[co] === 1)) return false;
  }
  if (c.exClearance && (st & STMT_CLEARANCE_YES)) return false;
  if (c.exCitizen && (st & STMT_CITIZEN_YES)) return false;
  if (c.roleTypes !== 0 && (c.roleTypes & (m.roleType[rid] === 1 ? 2 : 1)) === 0) return false;
  if (c.titleExclude && c.titleExclude[rid] === 1) return false;
  if (c.functionAllow && c.functionAllow[rid] !== 1) return false;
  return true;
}

/** The same test for the fit queue's priority filter. */
export function passesForQueue(c: Compiled, m: MemIndex, rid: number): boolean {
  return passes(c, m, rid);
}

function hasPrefixTag(m: MemIndex, rid: number, prefix: string): boolean {
  const off = m.tagOff[rid]!;
  const end = off + m.tagLen[rid]!;
  for (let i = off; i < end; i++) if (m.tagNameById[m.tagPool[i]!]?.startsWith(prefix)) return true;
  return false;
}

// ---------------------------------------------------------------- words

interface WordMatch {
  /** Rows that hold every term somewhere (title, company, skills, department, places or description). */
  all: Uint8Array;
  /** Terms found in the title as the exact word (no stemming). */
  exactTitleTerms: Uint8Array;
  titleTerms: Uint8Array;
  companyTerms: Uint8Array;
  phrase: Uint8Array | null;
}

function matchWords(db: DatabaseSync, cap: number, terms: string[]): WordMatch {
  const count = new Uint8Array(cap);
  const stamp = new Uint8Array(cap);
  const titleTerms = new Uint8Array(cap);
  const exactTitleTerms = new Uint8Array(cap);
  const companyTerms = new Uint8Array(cap);
  terms.forEach((t, ti) => {
    const q = ftsString(t);
    const mark = ti + 1;
    const add = (list: Int32Array) => {
      for (let i = 0; i < list.length; i++) {
        const r = list[i]!;
        if (r < cap && stamp[r] !== mark) { stamp[r] = mark; count[r]!++; }
      }
    };
    add(ftsRids(db, 'job_head_fts', q));
    add(ftsRids(db, 'job_body_fts', q));
    const tl = ftsRids(db, 'job_head_fts', `title : ${q}`);
    for (let i = 0; i < tl.length; i++) if (tl[i]! < cap) titleTerms[tl[i]!]!++;
    const el = ftsRids(db, 'job_title_fts', q);
    for (let i = 0; i < el.length; i++) if (el[i]! < cap) exactTitleTerms[el[i]!]!++;
    const cl = ftsRids(db, 'job_head_fts', `company : ${q}`);
    for (let i = 0; i < cl.length; i++) if (cl[i]! < cap) companyTerms[cl[i]!]!++;
  });
  const k = terms.length;
  const all = new Uint8Array(cap);
  for (let r = 0; r < cap; r++) if (count[r] === k) all[r] = 1;
  let phrase: Uint8Array | null = null;
  if (k > 1) {
    const pl = ftsRids(db, 'job_head_fts', `title : ${ftsString(terms.join(' '))}`);
    phrase = ridMask(cap, [pl]);
  }
  return { all, exactTitleTerms, titleTerms, companyTerms, phrase };
}

// ---------------------------------------------------------------- ordering and snapshots

interface Snapshot {
  id: string;
  hash: string;
  /** Candidates in row order, with their primary sort keys (larger first; ties: smaller rid first). */
  cands: Int32Array;
  keys: Float64Array;
  /** The full order, made on the first request for page 2 or later. */
  sorted: { rids: Int32Array; primary: Float64Array } | null;
  createdAt: number;
  lastUsed: number;
}

function sortedOf(s: Snapshot): { rids: Int32Array; primary: Float64Array } {
  if (!s.sorted) s.sorted = order(s.cands, s.cands.length, s.keys);
  return s.sorted;
}

/** The best k candidates, best first (one pass with a small heap; no full sort for page 1). */
function topK(cands: Int32Array, keys: Float64Array, k: number): { rids: number[]; prim: number[] } {
  const n = cands.length;
  const hk: number[] = [];
  const hr: number[] = [];
  // worse(a, b): a sorts after b.
  const worse = (ka: number, ra: number, kb: number, rb: number) => ka < kb || (ka === kb && ra > rb);
  const down = (i: number) => {
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < hk.length && worse(hk[l]!, hr[l]!, hk[m]!, hr[m]!)) m = l;
      if (r < hk.length && worse(hk[r]!, hr[r]!, hk[m]!, hr[m]!)) m = r;
      if (m === i) return;
      [hk[i], hk[m]] = [hk[m]!, hk[i]!];
      [hr[i], hr[m]] = [hr[m]!, hr[i]!];
      i = m;
    }
  };
  const up = (i: number) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!worse(hk[i]!, hr[i]!, hk[p]!, hr[p]!)) return;
      [hk[i], hk[p]] = [hk[p]!, hk[i]!];
      [hr[i], hr[p]] = [hr[p]!, hr[i]!];
      i = p;
    }
  };
  for (let i = 0; i < n; i++) {
    const key = keys[i]!, rid = cands[i]!;
    if (hk.length < k) { hk.push(key); hr.push(rid); up(hk.length - 1); }
    else if (k > 0 && worse(hk[0]!, hr[0]!, key, rid)) { hk[0] = key; hr[0] = rid; down(0); }
  }
  const idx = hk.map((_, i) => i).sort((a, b) => (hk[b]! - hk[a]!) || (hr[a]! - hr[b]!));
  return { rids: idx.map((i) => hr[i]!), prim: idx.map((i) => hk[i]!) };
}

const SNAPSHOT_MAX = 24;
const SNAPSHOT_TTL_MS = 30 * 60_000;
const snapshots = new WeakMap<MemIndex, Map<string, Snapshot>>();

function snapStore(mem: MemIndex): Map<string, Snapshot> {
  let m = snapshots.get(mem);
  if (!m) { m = new Map(); snapshots.set(mem, m); }
  return m;
}

function putSnapshot(mem: MemIndex, s: Snapshot): void {
  const m = snapStore(mem);
  const now = Date.now();
  for (const [k, v] of m) if (now - v.lastUsed > SNAPSHOT_TTL_MS) m.delete(k);
  while (m.size >= SNAPSHOT_MAX) {
    let oldest: string | null = null, t = Infinity;
    for (const [k, v] of m) if (v.lastUsed < t) { t = v.lastUsed; oldest = k; }
    if (oldest) m.delete(oldest); else break;
  }
  m.set(s.id, s);
}

/** Sorts candidates by primary key (larger first), ties by rid (smaller first). */
function order(cands: Int32Array, n: number, primary: Float64Array): { rids: Int32Array; primary: Float64Array } {
  let bits = 1;
  while ((1 << bits) <= n) bits++;
  const span = 2 ** bits;
  const packed = new Float64Array(n);
  let maxP = 0;
  for (let i = 0; i < n; i++) if (primary[i]! > maxP) maxP = primary[i]!;
  if (maxP * span + span > Number.MAX_SAFE_INTEGER) {
    // Never expected (keys are < 2^31); keep a correct order anyway.
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => (primary[b]! - primary[a]!) || (cands[a]! - cands[b]!));
    return { rids: Int32Array.from(idx, (i) => cands[i]!), primary: Float64Array.from(idx, (i) => primary[i]!) };
  }
  for (let i = 0; i < n; i++) packed[i] = primary[i]! * span + (span - 1 - i);
  packed.sort();
  const rids = new Int32Array(n);
  const prim = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const p = packed[n - 1 - k]!;
    const low = p % span;
    const i = span - 1 - low;
    rids[k] = cands[i]!;
    prim[k] = (p - low) / span;
  }
  return { rids, primary: prim };
}

interface Cursor { v: 1; s: string; p: number; h: string; k: [number, number] }

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(s: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor;
    if (c.v !== 1 || typeof c.s !== 'string' || typeof c.p !== 'number' || typeof c.h !== 'string' || !Array.isArray(c.k)) return null;
    return c;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the search

function dayOf(ms: number): number {
  return ms === ms ? Math.max(0, Math.floor((ms - EPOCH_2000_MS) / 86_400_000)) + 1 : 0;
}

function snippetOf(desc: string, terms: string[]): string {
  const flat = desc.replace(/\s+/g, ' ').trim();
  if (flat.length <= 400) return flat;
  if (terms.length > 0) {
    const lower = flat.toLowerCase();
    let at = -1;
    for (const t of terms) {
      const i = lower.indexOf(t);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    if (at > 200) {
      const start = flat.lastIndexOf(' ', at - 120);
      const s = start > 0 ? start + 1 : at - 120;
      return `…${flat.slice(s, s + 397)}`.slice(0, 400);
    }
  }
  return `${flat.slice(0, 399)}…`;
}

interface TrackerRow { job_id: string; liked: number; hidden: number; status: string | null }

/** The h1b tag to show (never "no" from a missing company). */
export function h1bTagOf(stmt: number, likely: boolean): JobListItem['h1bTag'] {
  if (stmt & STMT_SPONSOR_NO) return 'post_says_no';
  if (stmt & STMT_SPONSOR_YES) return 'post_says_yes';
  return likely ? 'likely_by_history' : null;
}

export function search(reqIn: JobSearchRequest, deps: SearchDeps): JobSearchResponse {
  const t0 = performance.now();
  const v = validate(JobSearchRequestSchema, reqIn);
  if (!v.ok) throw new StoreError('bad_request', `The search request is not valid (${v.issues[0]!.path || 'body'}: ${v.issues[0]!.message}).`);
  const req = v.value;
  const { db, mem } = deps;
  const sort = req.sort;
  const limit = req.limit ?? DEFAULT_LIMIT;
  const filter = req.filter ?? {};
  if (sort === 'top_matched' && !deps.profileVector) {
    if (deps.fitUnavailable === 'not_ready') throw new StoreError('not_ready', 'Top Matched is not ready yet: the fit model has not been downloaded.');
    throw new StoreError('needs_profile', 'Top Matched needs a profile. Add your profile to see jobs ranked by fit.');
  }
  mem.refresh();
  deps.vec?.refresh();
  const parsed = parseQuery(req.q);
  const terms = parsed.terms;
  const scores = sort === 'top_matched' && deps.vec && deps.profileVector ? deps.vec.begin(deps.profileVector) : null;
  const hash = createHash('sha1').update(JSON.stringify([terms, filter, sort, sort === 'top_matched' && deps.profileVector ? fpOf(deps.profileVector) : ''])).digest('base64url').slice(0, 16);

  let cursor: Cursor | null = null;
  if (req.cursor) {
    cursor = decodeCursor(req.cursor);
    if (!cursor) throw new StoreError('bad_request', 'The page cursor is not valid. Start the search again.');
    if (cursor.h !== hash) throw new StoreError('bad_request', 'This page cursor belongs to a different search or an older profile. Start the search again.');
  }

  let snap = cursor ? snapStore(mem).get(cursor.s) ?? null : null;
  const wantOpen = (filter.status ?? 'open') === 'open';
  const visible = (rid: number) => {
    const fl = mem.flags[rid]!;
    return (fl & F_EXISTS) !== 0 && (fl & F_HIDDEN) === 0 && ((fl & F_OPEN) !== 0) === wantOpen;
  };
  let page: number[] = [];
  let pagePrim: number[] = [];
  let p = 0;
  let total = 0;
  let more = false;
  if (!cursor) {
    // Page 1: every candidate is visible right now; take the best `limit` without sorting the rest.
    snap = buildSnapshot(deps, filter, terms, sort, scores, hash);
    const top = topK(snap.cands, snap.keys, limit);
    page = top.rids;
    pagePrim = top.prim;
    p = page.length;
    total = snap.cands.length;
    more = total > page.length;
  } else {
    let start: number;
    if (!snap) {
      snap = buildSnapshot(deps, filter, terms, sort, scores, hash);
      start = positionAfter(sortedOf(snap), cursor.k[0], cursor.k[1]);
    } else start = cursor.p;
    const s = sortedOf(snap);
    // The next `limit` rows that are still visible (a job closed or hidden meanwhile is skipped).
    p = start;
    while (p < s.rids.length && page.length < limit) {
      const rid = s.rids[p]!;
      if (visible(rid)) { page.push(rid); pagePrim.push(s.primary[p]!); }
      p++;
    }
    for (let i = 0; i < snap.cands.length; i++) if (visible(snap.cands[i]!)) total++;
    for (let i = p; i < s.rids.length; i++) if (visible(s.rids[i]!)) { more = true; break; }
  }
  snap.lastUsed = Date.now();
  const nextCursor = more && page.length > 0 ? encodeCursor({ v: 1, s: snap.id, p, h: hash, k: [pagePrim[pagePrim.length - 1]!, page[page.length - 1]!] }) : null;

  const items = materialize(deps, page, terms, scores);
  const fit: FitState = {
    state: !deps.profileVector ? (deps.fitUnavailable === 'not_ready' ? 'not_ready' : 'needs_profile')
      : !deps.fitModelReady ? 'not_ready' : deps.fitWaiting > 0 ? 'indexing' : 'ready',
    waiting: deps.fitWaiting,
    model: deps.fitModel,
  };
  return { items, total, nextCursor, fit, tookMs: Math.round(performance.now() - t0) };
}

function fpOf(v: Float32Array): string {
  let h = 0;
  const u = new Uint32Array(v.buffer, v.byteOffset, v.length);
  for (let i = 0; i < u.length; i++) h = (Math.imul(h, 31) + u[i]!) | 0;
  return String(h);
}

function positionAfter(s: { rids: Int32Array; primary: Float64Array }, prim: number, rid: number): number {
  // Order: primary descending, then rid ascending. First position strictly after (prim, rid).
  let lo = 0, hi = s.rids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const mp = s.primary[mid]!;
    const after = mp < prim || (mp === prim && s.rids[mid]! > rid);
    if (after) hi = mid; else lo = mid + 1;
  }
  return lo;
}

function buildSnapshot(deps: SearchDeps, filter: JobFilter, terms: string[], sort: JobSearchRequest['sort'], scores: Float32Array | null, hash: string): Snapshot {
  const { db, mem } = deps;
  const c = compileFilter(filter, deps);
  const words = terms.length > 0 ? matchWords(db, mem.cap, terms) : null;
  const cands = new Int32Array(mem.maxRid + 1);
  const prim = new Float64Array(mem.maxRid + 1);
  let n = 0;
  const unscored: number[] = [];
  const k = terms.length;
  for (let rid = 1; rid <= mem.maxRid; rid++) {
    if (words && words.all[rid] !== 1) continue;
    if (!passes(c, mem, rid)) continue;
    let key: number;
    const posted = mem.postedMs[rid]!;
    if (sort === 'most_recent') {
      key = posted === posted ? Math.max(0, Math.floor((posted - EPOCH_2000_MS) / 1000)) + 1 : 0;
    } else if (sort === 'top_matched') {
      const s = scores && deps.vec && deps.profileVector ? deps.vec.scoreOne(rid, deps.profileVector) : NaN;
      if (s === s) key = 2 ** 21 + Math.round(((Math.max(-1, Math.min(1, s)) + 1) / 2) * (2 ** 21 - 1));
      else { key = dayOf(posted); unscored.push(rid); }
    } else if (words) {
      // Word tiers: exact title words, then stemmed title words, the words in order, share of the title they
      // cover, words in the company name; then freshness.
      const et = Math.min(15, words.exactTitleTerms[rid]!);
      const tt = Math.min(15, words.titleTerms[rid]!);
      const ph = words.phrase && words.phrase[rid] === 1 ? 1 : 0;
      const tl = Math.max(1, mem.titleLen[rid]!);
      const coverage = Math.min(31, Math.round((Math.min(Math.max(tt, et), k) / Math.max(tl, k)) * 31));
      const ct = Math.min(15, words.companyTerms[rid]!);
      key = (((((et * 16 + tt) * 2 + ph) * 32 + coverage) * 16 + ct) * 32768) + dayOf(posted);
    } else {
      // Recommended without words: freshness by day, then how many facts the posting states.
      const quality = (mem.payKind[rid]! > 0 ? 4 : 0) + (mem.workModel[rid]! > 0 ? 2 : 0) + (mem.levelMask[rid]! > 0 ? 1 : 0) + ((mem.flags[rid]! & F_HASPLACE) ? 1 : 0);
      key = dayOf(posted) * 16 + quality;
    }
    cands[n] = rid;
    prim[n] = key;
    n++;
  }
  if (unscored.length > 0 && deps.requestFit) deps.requestFit(unscored.slice(0, 20_000));
  const snap: Snapshot = { id: randomBytes(9).toString('base64url'), hash, cands: cands.slice(0, n), keys: prim.slice(0, n), sorted: null, createdAt: Date.now(), lastUsed: Date.now() };
  putSnapshot(mem, snap);
  return snap;
}

function materialize(deps: SearchDeps, rids: number[], terms: string[], scores: Float32Array | null): JobListItem[] {
  if (rids.length === 0) return [];
  const { db, mem } = deps;
  const rows = q(db, `SELECT s.rid AS rid, s.id AS id, s.status AS status, s.closed_at AS closed_at, s.closed_reason AS closed_reason, s.first_seen AS first_seen, s.last_seen AS last_seen, d.doc AS doc FROM store_jobs s JOIN job_docs d ON d.rid = s.rid WHERE s.rid IN (${rids.map(() => '?').join(',')})`)
    .all(...rids) as Array<{ rid: number; id: string; status: number; closed_at: string | null; closed_reason: string | null; first_seen: string; last_seen: string; doc: Uint8Array }>;
  const byRid = new Map(rows.map((r) => [Number(r.rid), r]));
  const ids = rows.map((r) => r.id);
  const tracker = ids.length === 0 ? [] : q(db, `SELECT job_id, liked, hidden, status FROM tracker WHERE job_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as TrackerRow[];
  const tByJob = new Map(tracker.map((t) => [t.job_id, t]));
  const likelyMask = h1bLikelyMask(mem, deps.h1b ?? null);
  const out: JobListItem[] = [];
  for (const rid of rids) {
    const r = byRid.get(rid);
    if (!r) continue;
    const job = overlay(decodeRecord<Job>(r.doc), r);
    const { description, ...rest } = job;
    const summary: JobSummary = { ...rest, snippet: snippetOf(description, terms) };
    const t = tByJob.get(r.id);
    const co = mem.companyTag[rid]!;
    const s = scores ? scores[rid]! : NaN;
    out.push({
      job: summary,
      match: null,
      liked: t ? Number(t.liked) === 1 : false,
      hidden: t ? Number(t.hidden) === 1 : false,
      trackerStatus: (t?.status ?? null) as TrackerStatus | null,
      networkCount: null,
      h1bTag: h1bTagOf(mem.stmt[rid]!, co >= 0 && likelyMask[co] === 1),
      fitScore: scores ? (s === s ? Math.round(s * 1e6) / 1e6 : null) : null,
    });
  }
  return out;
}

/** The columns are the truth for status and seen times; the stored record carries the rest. */
export function overlay(job: Job, r: { id: string; status: number; closed_at: string | null; closed_reason: string | null; first_seen: string; last_seen: string }): Job {
  job.id = r.id;
  job.status = Number(r.status) === 1 ? 'open' : 'closed';
  job.closedAt = job.status === 'closed' ? r.closed_at : null;
  job.closedReason = job.status === 'closed' ? (r.closed_reason as Job['closedReason']) : null;
  job.firstSeenAt = r.first_seen;
  job.lastSeenAt = r.last_seen;
  return job;
}
