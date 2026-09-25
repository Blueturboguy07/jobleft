// The speed check behind store O4 and O11: a mixed set of searches, timed one by one, in this process.
// It can build its own synthetic store in memory (nothing is written to disk) or run on an existing data file.

import type { DatabaseSync } from 'node:sqlite';
import type { JobFilter, JobSearchRequest } from '@jobleft/contracts';
import { nextRev, tx } from './db.ts';
import { packHalf } from './f16.ts';
import { FitIndex } from './fit.ts';
import { JobStore } from './jobstore.ts';
import { MODEL_ID } from './embed/model.ts';
import { prng } from './synth.ts';

export interface BenchResult {
  rows: number;
  queries: number;
  firstMs: number;
  p50: number;
  p95: number;
  max: number;
  byKind: Record<string, { n: number; p50: number; p95: number; max: number }>;
  slowest: Array<{ kind: string; ms: number; total: number }>;
}

function pct(a: number[], p: number): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
}

/** Random unit vectors for every open job (speed tests only; only ever written to an in-memory database). */
export function fakeVectors(db: DatabaseSync, seed = 11): number {
  const rnd = prng(seed);
  const rows = db.prepare('SELECT rid, embed_hash FROM store_jobs WHERE status = 1').all() as Array<{ rid: number; embed_hash: string }>;
  tx(db, () => {
    const rev = nextRev(db);
    const st = db.prepare('INSERT OR REPLACE INTO job_vectors (rid, model, embed_hash, vec, rev) VALUES (?, ?, ?, ?, ?)');
    const v = new Float32Array(384);
    for (const r of rows) {
      let n = 0;
      for (let i = 0; i < 384; i++) { const x = rnd() - 0.5; v[i] = x; n += x * x; }
      n = Math.sqrt(n);
      for (let i = 0; i < 384; i++) v[i]! /= n;
      st.run(r.rid, MODEL_ID, r.embed_hash, packHalf(v), rev);
    }
  });
  return rows.length;
}

const WORDS_COMMON = ['engineer', 'manager', 'senior', 'accountant', 'nurse', 'sales', 'data', 'python', 'customer', 'team', 'experience', 'analyst'];
const WORDS_RARE = ['C++ developer', 'C#', '.NET', 'Node.js', '401(k)', 'kubernetes', 'forklift', 'paralegal', 'epic', 'ACLS', 'dbt', 'Figma'];
const WORDS_PAIR = ['software engineer', 'registered nurse', 'account executive', 'data scientist', 'product manager', 'staff accountant', 'warehouse associate', 'technical recruiter'];

export function benchQueries(n: number, seed = 3): Array<{ kind: string; req: JobSearchRequest; pages?: number }> {
  const rnd = prng(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const broad: JobFilter = { countries: ['US'], includeUnknown: ['place'] };
  const filters: JobFilter[] = [
    { workModels: ['remote', 'hybrid'], levels: ['senior', 'mid'] },
    { postedWithin: '7d', minAnnualPayUsd: 100_000 },
    { places: [{ text: 'Austin, TX', placeId: null, radiusMiles: null }], employmentTypes: ['full_time'] },
    { levels: ['entry', 'intern_new_grad'], postedWithin: '30d' },
    { skills: ['Python', 'SQL'], excludedCompanies: ['kalo'] },
    { h1bSponsorship: true, workModels: ['onsite'] },
  ];
  const narrow: JobFilter = { workModels: ['remote'], levels: ['director_exec'], postedWithin: '24h', minAnnualPayUsd: 200_000, employmentTypes: ['contract'] };
  const out: Array<{ kind: string; req: JobSearchRequest; pages?: number }> = [];
  const kinds = ['words', 'filters', 'words+filters', 'fit+filters', 'broad', 'narrow', 'page20', 'rare-words'];
  for (let i = 0; i < n; i++) {
    const kind = kinds[i % kinds.length]!;
    const sort = pick(['recommended', 'most_recent'] as const);
    switch (kind) {
      case 'words': out.push({ kind, req: { sort: 'recommended', q: rnd() < 0.5 ? pick(WORDS_COMMON) : pick(WORDS_PAIR) } }); break;
      case 'rare-words': out.push({ kind, req: { sort, q: pick(WORDS_RARE) } }); break;
      case 'filters': out.push({ kind, req: { sort, filter: pick(filters) } }); break;
      case 'words+filters': out.push({ kind, req: { sort, q: pick([...WORDS_COMMON, ...WORDS_PAIR]), filter: pick(filters) } }); break;
      case 'fit+filters': out.push({ kind, req: { sort: 'top_matched', filter: pick(filters), ...(rnd() < 0.3 ? { q: pick(WORDS_COMMON) } : {}) } }); break;
      case 'broad': out.push({ kind, req: { sort: pick(['recommended', 'most_recent', 'top_matched'] as const), filter: broad } }); break;
      case 'narrow': out.push({ kind, req: { sort, filter: narrow } }); break;
      case 'page20': out.push({ kind, req: { sort: pick(['recommended', 'most_recent', 'top_matched'] as const), filter: broad, limit: 20 }, pages: 20 }); break;
    }
  }
  return out;
}

/** Runs the query mix. Each timed call is one search request (page 20 = the 20th request of a paging run). */
export function runBench(store: JobStore, fit: FitIndex | null, profileVector: Float32Array | null, n = 300, now = Date.now()): BenchResult {
  const qs = benchQueries(n);
  const times: number[] = [];
  const byKind: Record<string, number[]> = {};
  const slow: Array<{ kind: string; ms: number; total: number }> = [];
  let firstMs = -1;
  const ctx = { profileVector, h1b: null, places: null, now, fit };
  for (const { kind, req, pages } of qs) {
    if (req.sort === 'top_matched' && !profileVector) req.sort = 'recommended';
    const t0 = performance.now();
    let r = store.search(req, ctx);
    let ms = performance.now() - t0;
    if (firstMs < 0) firstMs = ms;
    if (pages) {
      for (let p = 1; p < pages && r.nextCursor; p++) {
        const t = performance.now();
        r = store.search({ ...req, cursor: r.nextCursor }, ctx);
        ms = performance.now() - t;
      }
    }
    times.push(ms);
    (byKind[kind] ??= []).push(ms);
    slow.push({ kind, ms, total: r.total });
  }
  const kinds: BenchResult['byKind'] = {};
  for (const [k, a] of Object.entries(byKind)) kinds[k] = { n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), max: Math.max(...a) };
  return {
    rows: store.mem.openCount, queries: times.length, firstMs, p50: pct(times, 0.5), p95: pct(times, 0.95), max: Math.max(...times),
    byKind: kinds, slowest: slow.sort((a, b) => b.ms - a.ms).slice(0, 5),
  };
}
