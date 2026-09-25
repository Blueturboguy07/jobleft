// The in-memory side of search (spike S2): one typed array per filter column, indexed by the row number (rid).
// Filtering 500,000 rows in these arrays takes a few milliseconds; asking SQLite for the same ids takes 70 ms.
// The arrays follow the database through a change number (rev): every write transaction stamps its rows with a
// new rev, and refresh() reads only rows with a larger rev. Writes from another process are picked up the same way.

import type { DatabaseSync } from 'node:sqlite';
import { currentRev, q } from './db.ts';
import { unpackFacets } from './record.ts';

export const F_EXISTS = 1;
export const F_OPEN = 2;
export const F_HIDDEN = 4;
/** The row has at least one place or country fact. */
export const F_HASPLACE = 8;

const HEADER_BYTES = 32;

function grow<T extends Uint8Array | Int8Array | Uint16Array | Uint32Array | Int32Array | Float32Array | Float64Array>(a: T, cap: number, fill?: number): T {
  const Ctor = a.constructor as new (n: number) => T;
  const b = new Ctor(cap);
  b.set(a);
  if (fill !== undefined) b.fill(fill as never, a.length);
  return b;
}

export interface CompanyFacts {
  industries: string[];
  stage: string | null;
  isStaffing: boolean | null;
  h1b: 'likely' | 'some_history' | null;
}

export class MemIndex {
  cap = 0;
  maxRid = 0;
  openCount = 0;
  lastRev = -1;
  loaded = false;

  flags = new Uint8Array(0);
  levelMask = new Uint8Array(0);
  workModel = new Uint8Array(0);
  empType = new Uint8Array(0);
  yearsMin = new Uint8Array(0);
  stmt = new Uint8Array(0);
  roleType = new Uint8Array(0);
  titleLen = new Uint8Array(0);
  payKind = new Uint8Array(0);
  isUs = new Int8Array(0);
  postedMs = new Float64Array(0);
  payLo = new Float32Array(0);
  payHi = new Float32Array(0);
  companyTag = new Int32Array(0);
  tagOff = new Uint32Array(0);
  tagLen = new Uint16Array(0);
  tagPool = new Uint32Array(1 << 16);
  poolUsed = 0;
  poolGarbage = 0;

  tagIdByName = new Map<string, number>();
  tagNameById: string[] = [];
  maxTagId = 0;
  companies = new Map<number, CompanyFacts>();
  /** Bumped on every change, so caches (snapshots, company masks) know when to rebuild. */
  generation = 0;

  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  private ensureCap(rid: number): void {
    if (rid < this.cap) return;
    let cap = Math.max(1024, this.cap);
    while (cap <= rid) cap *= 2;
    this.flags = grow(this.flags, cap);
    this.levelMask = grow(this.levelMask, cap);
    this.workModel = grow(this.workModel, cap);
    this.empType = grow(this.empType, cap);
    this.yearsMin = grow(this.yearsMin, cap, 255);
    this.stmt = grow(this.stmt, cap);
    this.roleType = grow(this.roleType, cap);
    this.titleLen = grow(this.titleLen, cap);
    this.payKind = grow(this.payKind, cap);
    this.isUs = grow(this.isUs, cap, -1);
    this.postedMs = grow(this.postedMs, cap, NaN);
    this.payLo = grow(this.payLo, cap, NaN);
    this.payHi = grow(this.payHi, cap, NaN);
    this.companyTag = grow(this.companyTag, cap, -1);
    this.tagOff = grow(this.tagOff, cap);
    this.tagLen = grow(this.tagLen, cap);
    this.cap = cap;
  }

  private loadTags(): void {
    const rows = q(this.db, 'SELECT id, tag FROM facet_tags WHERE id > ? ORDER BY id').all(this.maxTagId) as Array<{ id: number; tag: string }>;
    for (const r of rows) {
      const id = Number(r.id);
      this.tagIdByName.set(r.tag, id);
      this.tagNameById[id] = r.tag;
      if (id > this.maxTagId) this.maxTagId = id;
    }
  }

  tagId(name: string): number | undefined {
    return this.tagIdByName.get(name);
  }

  private setRow(rid: number, status: number, facets: Uint8Array): void {
    this.ensureCap(rid);
    const wasOpen = (this.flags[rid]! & (F_EXISTS | F_OPEN)) === (F_EXISTS | F_OPEN);
    const v = new DataView(facets.buffer, facets.byteOffset, facets.byteLength);
    const nTags = v.getUint16(10, true);
    let f = (this.flags[rid]! & F_HIDDEN) | F_EXISTS | (status === 1 ? F_OPEN : 0);
    this.levelMask[rid] = v.getUint8(1);
    this.workModel[rid] = v.getUint8(2);
    this.empType[rid] = v.getUint8(3);
    this.yearsMin[rid] = v.getUint8(4);
    this.stmt[rid] = v.getUint8(5);
    this.roleType[rid] = v.getUint8(6);
    this.titleLen[rid] = v.getUint8(7);
    this.isUs[rid] = v.getInt8(8);
    this.payKind[rid] = v.getUint8(9);
    this.companyTag[rid] = v.getInt32(12, true);
    this.postedMs[rid] = v.getFloat64(16, true);
    this.payLo[rid] = v.getFloat32(24, true);
    this.payHi[rid] = v.getFloat32(28, true);
    // Tags: reuse the old slot when it is big enough, else append to the pool.
    if (nTags > this.tagLen[rid]!) {
      this.poolGarbage += this.tagLen[rid]!;
      if (this.poolUsed + nTags > this.tagPool.length) this.compactOrGrowPool(nTags);
      this.tagOff[rid] = this.poolUsed;
      this.poolUsed += nTags;
    }
    const off = this.tagOff[rid]!;
    let hasPlace = false;
    for (let i = 0; i < nTags; i++) {
      const t = v.getUint32(HEADER_BYTES + i * 4, true);
      this.tagPool[off + i] = t;
      if (!hasPlace) {
        const name = this.tagNameById[t];
        if (name && (name.charCodeAt(0) === 112 /* p */ || name.startsWith('c:'))) hasPlace = true;
      }
    }
    this.tagLen[rid] = nTags;
    if (hasPlace || this.isUs[rid] !== -1) f |= F_HASPLACE;
    this.flags[rid] = f;
    const isOpen = (f & (F_EXISTS | F_OPEN)) === (F_EXISTS | F_OPEN);
    if (isOpen !== wasOpen) this.openCount += isOpen ? 1 : -1;
    if (rid > this.maxRid) this.maxRid = rid;
  }

  private compactOrGrowPool(need: number): void {
    const live = this.poolUsed - this.poolGarbage;
    let size = this.tagPool.length;
    while (live + need > size * 0.7) size *= 2;
    const pool = new Uint32Array(size);
    let used = 0;
    for (let rid = 0; rid <= this.maxRid && rid < this.cap; rid++) {
      const n = this.tagLen[rid]!;
      if (n === 0) continue;
      pool.set(this.tagPool.subarray(this.tagOff[rid]!, this.tagOff[rid]! + n), used);
      this.tagOff[rid] = used;
      used += n;
    }
    this.tagPool = pool;
    this.poolUsed = used;
    this.poolGarbage = 0;
  }

  private removeRow(rid: number): void {
    if (rid >= this.cap) return;
    if ((this.flags[rid]! & (F_EXISTS | F_OPEN)) === (F_EXISTS | F_OPEN)) this.openCount--;
    this.flags[rid] = 0;
    this.poolGarbage += this.tagLen[rid]!;
    this.tagLen[rid] = 0;
  }

  private loadCompany(r: { key: string; industries: string; stage: string | null; is_staffing: number | null; h1b: string | null }): void {
    const id = this.tagIdByName.get(`co:${r.key}`);
    if (id === undefined) return;
    let industries: string[] = [];
    try { const p = JSON.parse(r.industries) as unknown; if (Array.isArray(p)) industries = p.filter((x): x is string => typeof x === 'string'); } catch { /* keep [] */ }
    this.companies.set(id, {
      industries,
      stage: r.stage ?? null,
      isStaffing: r.is_staffing === null || r.is_staffing === undefined ? null : Number(r.is_staffing) === 1,
      h1b: r.h1b === 'likely' || r.h1b === 'some_history' ? r.h1b : null,
    });
  }

  /** Full load (at start). */
  load(): void {
    const rev = currentRev(this.db);
    this.loadTags();
    const st = q(this.db, 'SELECT rid, status, facets FROM store_jobs');
    st.setReturnArrays(true);
    for (const row of st.iterate() as Iterable<[number, number, Uint8Array]>) this.setRow(Number(row[0]), Number(row[1]), row[2]);
    this.loadHidden(-1);
    for (const r of q(this.db, 'SELECT key, industries, stage, is_staffing, h1b FROM companies').all() as Array<{ key: string; industries: string; stage: string | null; is_staffing: number | null; h1b: string | null }>) this.loadCompany(r);
    this.lastRev = rev;
    this.loaded = true;
    this.generation++;
  }

  private loadHidden(sinceRev: number): number {
    const rows = q(this.db,
      `SELECT k.rid AS rid, t.hidden AS hidden FROM tracker t JOIN job_keys k ON k.key = 'id:' || t.job_id WHERE t.rev > ?`,
    ).all(sinceRev) as Array<{ rid: number; hidden: number }>;
    for (const r of rows) {
      const rid = Number(r.rid);
      this.ensureCap(rid);
      if (Number(r.hidden) === 1) this.flags[rid]! |= F_HIDDEN;
      else this.flags[rid]! &= ~F_HIDDEN;
    }
    return rows.length;
  }

  /** Applies every change committed since the last load or refresh. Returns true when something changed. */
  refresh(): boolean {
    if (!this.loaded) { this.load(); return true; }
    const rev = currentRev(this.db);
    if (rev === this.lastRev) return false;
    this.loadTags();
    let changes = 0;
    const st = q(this.db, 'SELECT rid, status, facets FROM store_jobs WHERE rev > ?');
    st.setReturnArrays(true);
    for (const row of st.iterate(this.lastRev) as Iterable<[number, number, Uint8Array]>) { this.setRow(Number(row[0]), Number(row[1]), row[2]); changes++; }
    for (const r of q(this.db, 'SELECT rid FROM job_tombstones WHERE rev > ?').all(this.lastRev) as Array<{ rid: number }>) {
      const rid = Number(r.rid);
      const still = q(this.db, 'SELECT 1 FROM store_jobs WHERE rid = ?').get(rid);
      if (!still) { this.removeRow(rid); changes++; }
    }
    changes += this.loadHidden(this.lastRev);
    for (const r of q(this.db, 'SELECT key, industries, stage, is_staffing, h1b FROM companies WHERE rev > ?').all(this.lastRev) as Array<{ key: string; industries: string; stage: string | null; is_staffing: number | null; h1b: string | null }>) { this.loadCompany(r); changes++; }
    this.lastRev = rev;
    // A change number that only carried fit vectors changes nothing here (caches stay valid).
    if (changes > 0) this.generation++;
    return changes > 0;
  }

  /** Open, not hidden. */
  isVisible(rid: number): boolean {
    return rid < this.cap && (this.flags[rid]! & (F_EXISTS | F_OPEN | F_HIDDEN)) === (F_EXISTS | F_OPEN);
  }

  hasTag(rid: number, mask: Uint8Array): boolean {
    const off = this.tagOff[rid]!;
    const end = off + this.tagLen[rid]!;
    for (let i = off; i < end; i++) if (mask[this.tagPool[i]!] === 1) return true;
    return false;
  }

  /** A 0/1 mask over tag ids for the given tag names (unknown names are skipped). */
  tagMask(names: Iterable<string>): { mask: Uint8Array; any: boolean } {
    const mask = new Uint8Array(this.maxTagId + 1);
    let any = false;
    for (const n of names) {
      const id = this.tagIdByName.get(n);
      if (id !== undefined) { mask[id] = 1; any = true; }
    }
    return { mask, any };
  }

  /** Approximate bytes held by the arrays (for the storage report and tests). */
  bytes(): number {
    return this.cap * (13 + 1 + 8 + 4 + 4 + 4 + 4 + 2) + this.tagPool.byteLength;
  }
}
