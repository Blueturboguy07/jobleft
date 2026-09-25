// Fit vectors in RAM (spike S2): float16 in SQLite, float32 in memory, brute-force dot product over the candidates
// that pass the filters. Vectors of one model only: another model's vectors are never loaded into the same ranking.
// A vector counts only while it is "fresh": made from the job's current text (same embed hash). A job whose text
// changed waits for a new vector and is shown as "not scored yet" meanwhile, never with its old score.

import type { DatabaseSync } from 'node:sqlite';
import { currentRev, q } from './db.ts';
import { unpackHalfInto } from './f16.ts';

const CHUNK_ROWS = 16_384;

export class VectorIndex {
  readonly dims: number;
  slot = new Int32Array(0);
  fresh = new Uint8Array(0);
  private chunks: Float32Array[] = [];
  private nextSlot = 0;
  private freeSlots: number[] = [];
  lastRev = -1;
  loaded = false;
  generation = 0;
  /** Rids whose vector changed since the score cache was computed. */
  private dirty = new Set<number>();
  private scoreKey = '';
  private scores = new Float32Array(0);

  private readonly db: DatabaseSync;
  readonly model: string;

  constructor(db: DatabaseSync, model: string, dims = 384) {
    this.db = db;
    this.model = model;
    this.dims = dims;
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
  }

  private allocSlot(): number {
    const s = this.freeSlots.pop();
    if (s !== undefined) return s;
    const n = this.nextSlot++;
    if ((n / CHUNK_ROWS | 0) >= this.chunks.length) this.chunks.push(new Float32Array(CHUNK_ROWS * this.dims));
    return n;
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
    if (s < 0) { s = this.allocSlot(); this.slot[rid] = s; }
    const c = this.chunks[(s / CHUNK_ROWS) | 0]!;
    if (!unpackHalfInto(bytes, c, (s % CHUNK_ROWS) * this.dims, this.dims)) { this.drop(rid); return; }
    this.fresh[rid] = fresh ? 1 : 0;
    this.dirty.add(rid);
  }

  /** Puts a float32 vector (after this process embedded it). */
  putFloat(rid: number, v: Float32Array, fresh: boolean): void {
    this.ensureCap(rid);
    let s = this.slot[rid]!;
    if (s < 0) { s = this.allocSlot(); this.slot[rid] = s; }
    const c = this.chunks[(s / CHUNK_ROWS) | 0]!;
    c.set(v.subarray(0, this.dims), (s % CHUNK_ROWS) * this.dims);
    this.fresh[rid] = fresh ? 1 : 0;
    this.dirty.add(rid);
  }

  private drop(rid: number): void {
    if (rid >= this.slot.length) return;
    const s = this.slot[rid]!;
    if (s >= 0) this.freeSlots.push(s);
    this.slot[rid] = -1;
    this.fresh[rid] = 0;
    this.dirty.add(rid);
  }

  load(): void {
    const rev = currentRev(this.db);
    const st = q(this.db, `SELECT v.rid, v.vec, v.embed_hash = s.embed_hash FROM job_vectors v JOIN store_jobs s ON s.rid = v.rid WHERE v.model = ?`);
    st.setReturnArrays(true);
    for (const r of st.iterate(this.model) as Iterable<[number, Uint8Array, number]>) this.putHalf(Number(r[0]), r[1], Number(r[2]) === 1);
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
      if (this.fresh[rid] !== f) { this.fresh[rid] = f; this.dirty.add(rid); }
    }
    for (const r of q(this.db, 'SELECT rid FROM job_tombstones WHERE rev > ?').all(this.lastRev) as Array<{ rid: number }>) {
      const rid = Number(r.rid);
      if (!q(this.db, 'SELECT 1 FROM job_vectors WHERE rid = ? AND model = ?').get(rid, this.model)) this.drop(rid);
    }
    this.lastRev = rev;
    this.generation++;
    return true;
  }

  /** Cosine of every fresh vector with the profile vector (vectors are unit length). NaN = not scored. */
  scoresFor(profile: Float32Array): Float32Array {
    const key = fingerprint(profile);
    const d = this.dims;
    if (key !== this.scoreKey) {
      this.scores.fill(NaN);
      for (let rid = 0; rid < this.slot.length; rid++) if (this.fresh[rid] === 1) this.scores[rid] = this.dot(rid, profile, d);
      this.scoreKey = key;
      this.dirty.clear();
    } else if (this.dirty.size > 0) {
      for (const rid of this.dirty) this.scores[rid] = this.fresh[rid] === 1 ? this.dot(rid, profile, d) : NaN;
      this.dirty.clear();
    }
    return this.scores;
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
