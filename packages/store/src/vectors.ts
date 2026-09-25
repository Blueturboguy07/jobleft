// Fit vectors in RAM (spike S2): float16 in SQLite, float32 in memory, brute-force dot product over the candidates
// that pass the filters. Vectors of one model only: another model's vectors are never loaded into the same ranking.
// A vector counts only while it is "fresh": made from the job's current text (same embed hash). A job whose text
// changed waits for a new vector and is shown as "not scored yet" meanwhile, never with its old score.
//
// Fit score = cos(profile, job) - CENTER_WEIGHT * cos(average job, job). bge vectors of job postings all lean the same
// way (shared boilerplate: "communication skills", benefits, equal opportunity), so a job whose text is mostly
// boilerplate is close to every profile. Taking off part of each job's closeness to the average job (hubness
// reduction by centering) ranks the job whose duties match above the generic one. The average is kept as a running
// float64 sum over the current vectors, so it costs O(dims) per vector change.

import type { DatabaseSync } from 'node:sqlite';
import { currentRev, q } from './db.ts';
import { unpackHalfInto } from './f16.ts';

const CHUNK_ROWS = 16_384;
/** How much of the job's closeness to the average job comes off its fit score (0 = plain cosine). */
export const CENTER_WEIGHT = 0.5;

export class VectorIndex {
  readonly dims: number;
  slot = new Int32Array(0);
  fresh = new Uint8Array(0);
  private chunks: Float32Array[] = [];
  private ridOfSlot = new Int32Array(0);
  private nextSlot = 0;
  private freeSlots: number[] = [];
  lastRev = -1;
  loaded = false;
  generation = 0;
  /** Rids whose vector changed since the score cache was computed. */
  private dirty = new Set<number>();
  private scoreKey = '';
  private scores = new Float32Array(0);
  /** 1 = scores[rid] holds the score for the current profile. */
  private have = new Uint8Array(0);
  /** Running sum and count of the current (fresh) vectors: their average is the centering vector. */
  private sum: Float64Array;
  private count = 0;
  /** The scoring vector for the last profile (profile minus the weighted average), and what it was made from. */
  private queryKey = '';
  private query: Float32Array | null = null;

  private readonly db: DatabaseSync;
  readonly model: string;

  constructor(db: DatabaseSync, model: string, dims = 384) {
    this.db = db;
    this.model = model;
    this.dims = dims;
    this.sum = new Float64Array(dims);
  }

  /** Adds (sign 1) or removes (sign -1) the row's vector from the running sum, when it is a current vector. */
  private account(rid: number, sign: 1 | -1): void {
    if (rid >= this.fresh.length || this.fresh[rid] !== 1) return;
    const v = this.vectorOf(rid);
    if (!v) return;
    for (let i = 0; i < this.dims; i++) this.sum[i]! += sign * v[i]!;
    this.count += sign;
    if (this.count === 0) this.sum.fill(0);
  }

  /** The average current vector (rounded to float32, so the same data gives the same scores after a restart). */
  centroid(): Float32Array {
    const m = new Float32Array(this.dims);
    if (this.count <= 0) return m;
    for (let i = 0; i < this.dims; i++) m[i] = Math.fround(this.sum[i]! / this.count);
    return m;
  }

  /** The vector a profile is scored with: profile - CENTER_WEIGHT * average job (cached per profile and average). */
  private queryFor(profile: Float32Array): Float32Array {
    const mean = this.centroid();
    const key = `${fingerprint(profile)}|${fingerprint(mean)}`;
    if (key === this.queryKey && this.query) return this.query;
    const qv = new Float32Array(this.dims);
    for (let i = 0; i < this.dims; i++) qv[i] = Math.fround(profile[i]! - CENTER_WEIGHT * mean[i]!);
    this.queryKey = key;
    this.query = qv;
    return qv;
  }

  private ensureCap(rid: number): void {
    if (rid < this.slot.length) return;
    let cap = Math.max(1024, this.slot.length);
    while (cap <= rid) cap *= 2;
    const s = new Int32Array(cap).fill(-1);
    s.set(this.slot);
    this.slot = s;
    const f = new Uint8Array(cap);
    f.set(this.fresh);
    this.fresh = f;
    const sc = new Float32Array(cap).fill(NaN);
    sc.set(this.scores);
    this.scores = sc;
    const hv = new Uint8Array(cap);
    hv.set(this.have);
    this.have = hv;
  }

  private allocSlot(rid: number): number {
    let s = this.freeSlots.pop();
    if (s === undefined) {
      s = this.nextSlot++;
      if ((s / CHUNK_ROWS | 0) >= this.chunks.length) {
        this.chunks.push(new Float32Array(CHUNK_ROWS * this.dims));
        const r = new Int32Array(this.chunks.length * CHUNK_ROWS).fill(-1);
        r.set(this.ridOfSlot);
        this.ridOfSlot = r;
      }
    }
    this.ridOfSlot[s] = rid;
    return s;
  }

  /** The vector of a row (a view into the pool), or null. */
  vectorOf(rid: number): Float32Array | null {
    if (rid >= this.slot.length) return null;
    const s = this.slot[rid]!;
    if (s < 0) return null;
    const c = this.chunks[(s / CHUNK_ROWS) | 0]!;
    const off = (s % CHUNK_ROWS) * this.dims;
    return c.subarray(off, off + this.dims);
  }

  private putHalf(rid: number, bytes: Uint8Array, fresh: boolean): void {
    this.ensureCap(rid);
    let s = this.slot[rid]!;
    if (s < 0) { s = this.allocSlot(rid); this.slot[rid] = s; }
    this.account(rid, -1);
    this.fresh[rid] = 0;
    const c = this.chunks[(s / CHUNK_ROWS) | 0]!;
    const off = (s % CHUNK_ROWS) * this.dims;
    if (bytes.byteLength !== this.dims * 2) { this.drop(rid); return; }
    if ((bytes.byteOffset & 1) === 0) c.set(new Float16Array(bytes.buffer, bytes.byteOffset, this.dims), off);
    else if (!unpackHalfInto(bytes, c, off, this.dims)) { this.drop(rid); return; }
    this.fresh[rid] = fresh ? 1 : 0;
    this.account(rid, 1);
    this.dirty.add(rid);
  }

  /** Puts a float32 vector (after this process embedded it). */
  putFloat(rid: number, v: Float32Array, fresh: boolean): void {
    this.ensureCap(rid);
    let s = this.slot[rid]!;
    if (s < 0) { s = this.allocSlot(rid); this.slot[rid] = s; }
    this.account(rid, -1);
    const c = this.chunks[(s / CHUNK_ROWS) | 0]!;
    c.set(v.subarray(0, this.dims), (s % CHUNK_ROWS) * this.dims);
    this.fresh[rid] = fresh ? 1 : 0;
    this.account(rid, 1);
    this.dirty.add(rid);
  }

  private drop(rid: number): void {
    if (rid >= this.slot.length) return;
    this.account(rid, -1);
    const s = this.slot[rid]!;
    if (s >= 0) { this.freeSlots.push(s); this.ridOfSlot[s] = -1; }
    this.slot[rid] = -1;
    this.fresh[rid] = 0;
    this.dirty.add(rid);
  }

  load(): void {
    const rev = currentRev(this.db);
    // Two sequential scans (a join would look up every row: 0.9 s instead of 0.4 s at 500,000 jobs).
    const hashes: string[] = [];
    const hs = q(this.db, 'SELECT rid, embed_hash FROM store_jobs');
    hs.setReturnArrays(true);
    for (const r of hs.iterate() as Iterable<[number, string]>) hashes[Number(r[0])] = r[1];
    const st = q(this.db, 'SELECT rid, vec, embed_hash FROM job_vectors WHERE model = ?');
    st.setReturnArrays(true);
    for (const r of st.iterate(this.model) as Iterable<[number, Uint8Array, string]>) {
      const rid = Number(r[0]);
      const h = hashes[rid];
      if (h === undefined) continue;
      this.putHalf(rid, r[1], h === r[2]);
    }
    this.lastRev = rev;
    this.loaded = true;
    this.generation++;
    this.scoreKey = '';
  }

  refresh(): boolean {
    if (!this.loaded) { this.load(); return true; }
    const rev = currentRev(this.db);
    if (rev === this.lastRev) return false;
    const v = q(this.db, `SELECT v.rid, v.vec, v.embed_hash = s.embed_hash FROM job_vectors v JOIN store_jobs s ON s.rid = v.rid WHERE v.rev > ? AND v.model = ?`);
    v.setReturnArrays(true);
    for (const r of v.iterate(this.lastRev, this.model) as Iterable<[number, Uint8Array, number]>) this.putHalf(Number(r[0]), r[1], Number(r[2]) === 1);
    const rows = q(this.db, `SELECT s.rid, v.embed_hash = s.embed_hash FROM store_jobs s JOIN job_vectors v ON v.rid = s.rid AND v.model = ? WHERE s.rev > ?`);
    rows.setReturnArrays(true);
    for (const r of rows.iterate(this.model, this.lastRev) as Iterable<[number, number]>) {
      const rid = Number(r[0]);
      this.ensureCap(rid);
      const f = Number(r[1]) === 1 ? 1 : 0;
      if (this.fresh[rid] !== f) { this.account(rid, -1); this.fresh[rid] = f; this.account(rid, 1); this.dirty.add(rid); }
    }
    for (const r of q(this.db, 'SELECT rid FROM job_tombstones WHERE rev > ?').all(this.lastRev) as Array<{ rid: number }>) {
      const rid = Number(r.rid);
      if (!q(this.db, 'SELECT 1 FROM job_vectors WHERE rid = ? AND model = ?').get(rid, this.model)) this.drop(rid);
    }
    this.lastRev = rev;
    this.generation++;
    return true;
  }

  /**
   * Starts scoring for a profile vector and returns the score array (NaN = not scored). Scores are made per row on
   * demand (scoreOne) and kept until the profile or the row's vector changes, so a narrow filter scores few rows.
   */
  begin(profile: Float32Array): Float32Array {
    this.queryFor(profile);
    // The key covers the average too: a changed average changes every score.
    const key = this.queryKey;
    if (key !== this.scoreKey) {
      this.have.fill(0);
      this.scores.fill(NaN);
      this.scoreKey = key;
      this.dirty.clear();
    } else if (this.dirty.size > 0) {
      for (const rid of this.dirty) { if (rid < this.have.length) { this.have[rid] = 0; this.scores[rid] = NaN; } }
      this.dirty.clear();
    }
    return this.scores;
  }

  /** The score of one row for the profile given to begin() (NaN when the row has no current vector). Call begin() first. */
  scoreOne(rid: number, profile: Float32Array): number {
    if (rid >= this.have.length) return NaN;
    if (this.have[rid] === 1) return this.scores[rid]!;
    const v = this.fresh[rid] === 1 ? this.dot(rid, this.query ?? this.queryFor(profile), this.dims) : NaN;
    this.scores[rid] = v;
    this.have[rid] = 1;
    return v;
  }

  /** Scores every row with a current vector (one contiguous pass; spike S2: about 80 to 110 ms at 500K). */
  scoresFor(profile: Float32Array): Float32Array {
    const scores = this.begin(profile);
    profile = this.queryFor(profile);
    const d = this.dims;
    const fresh = this.fresh;
    const have = this.have;
    for (let ci = 0; ci < this.chunks.length; ci++) {
      const c = this.chunks[ci]!;
      const base = ci * CHUNK_ROWS;
      const end = Math.min(CHUNK_ROWS, this.nextSlot - base);
      for (let s = 0; s < end; s++) {
        const rid = this.ridOfSlot[base + s]!;
        if (rid < 0 || have[rid] === 1) continue;
        have[rid] = 1;
        if (fresh[rid] !== 1) { scores[rid] = NaN; continue; }
        let off = s * d;
        let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
        for (let i = 0; i < d; i += 4, off += 4) {
          a0 += c[off]! * profile[i]!;
          a1 += c[off + 1]! * profile[i + 1]!;
          a2 += c[off + 2]! * profile[i + 2]!;
          a3 += c[off + 3]! * profile[i + 3]!;
        }
        scores[rid] = a0 + a1 + a2 + a3;
      }
    }
    return scores;
  }

  private dot(rid: number, p: Float32Array, d: number): number {
    const s = this.slot[rid]!;
    if (s < 0) return NaN;
    const c = this.chunks[(s / CHUNK_ROWS) | 0]!;
    let off = (s % CHUNK_ROWS) * d;
    let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
    let i = 0;
    for (; i + 3 < d; i += 4, off += 4) {
      a0 += c[off]! * p[i]!;
      a1 += c[off + 1]! * p[i + 1]!;
      a2 += c[off + 2]! * p[i + 2]!;
      a3 += c[off + 3]! * p[i + 3]!;
    }
    for (; i < d; i++, off++) a0 += c[off]! * p[i]!;
    return a0 + a1 + a2 + a3;
  }

  /** Number of fresh vectors. */
  freshCount(): number {
    let n = 0;
    for (let i = 0; i < this.fresh.length; i++) n += this.fresh[i]!;
    return n;
  }

  bytes(): number {
    return this.chunks.length * CHUNK_ROWS * this.dims * 4 + this.slot.byteLength * 2 + this.scores.byteLength;
  }
}

/** A short fingerprint of a vector (the score cache key). */
export function fingerprint(v: Float32Array): string {
  let h1 = 0x811c9dc5, h2 = 0;
  const u = new Uint32Array(v.buffer, v.byteOffset, v.length);
  for (let i = 0; i < u.length; i++) { h1 = Math.imul(h1 ^ u[i]!, 16777619); h2 = (h2 + u[i]! * (i + 1)) >>> 0; }
  return `${v.length}:${(h1 >>> 0).toString(16)}:${h2.toString(16)}`;
}
