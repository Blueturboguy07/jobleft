// Fit indexing: one float16 vector per (job, model), made from the job's embed text. The queue embeds jobs that
// pass the person's hard filters first (newest first), then jobs a Top Matched search asked for, then the rest.
// A job is embedded again only when its embed text changes (embed hash); a timestamp or a tracking field never
// causes new work. Each pass is recorded in fit_runs, so the status shows how many were indexed in the last run.

import type { DatabaseSync } from 'node:sqlite';
import type { Embedder, FitIndexStatus, JobFilter, Profile, Job } from '@jobleft/contracts';
import { nowMs } from '@jobleft/contracts';
import { decodeRecord } from './codec.ts';
import { nextRev, StoreError, tx, q } from './db.ts';
import { MODEL_ID, MODEL_TOTAL_BYTES } from './embed/model.ts';
import { packHalf } from './f16.ts';
import { F_EXISTS, F_OPEN, MemIndex } from './memindex.ts';
import { embedHashOf, embedTextOf } from './record.ts';
import { compileFilter, passesForQueue, type Compiled } from './search.ts';
import { VectorIndex } from './vectors.ts';

// ---------------------------------------------------------------- shared runtime per database connection

export interface Runtime {
  mem: MemIndex;
  vectors: Map<string, VectorIndex>;
  /** Rids a Top Matched search asked for (embedded after the priority rows). */
  requested: Set<number>;
}

const RUNTIMES = new WeakMap<DatabaseSync, Runtime>();

export function runtimeOf(db: DatabaseSync, makeMem: (db: DatabaseSync) => MemIndex): Runtime {
  let rt = RUNTIMES.get(db);
  if (!rt) {
    rt = { mem: makeMem(db), vectors: new Map(), requested: new Set() };
    RUNTIMES.set(db, rt);
  }
  return rt;
}

export function vectorsOf(rt: Runtime, db: DatabaseSync, model: string): VectorIndex {
  let v = rt.vectors.get(model);
  if (!v) { v = new VectorIndex(db, model); rt.vectors.set(model, v); }
  return v;
}

// ---------------------------------------------------------------- profile text

/** The text of the profile that fit indexing embeds: titles, summary, skills, work. No contact details, no EEO answers. */
export function profileTextOf(p: Profile | null): string {
  if (!p) return '';
  const parts: string[] = [];
  const titles = p.preferences.targetTitles.filter(Boolean);
  if (titles.length > 0) parts.push(`Looking for: ${titles.join(', ')}`);
  if (p.preferences.jobFunctions.length > 0) parts.push(`Job functions: ${p.preferences.jobFunctions.join(', ')}`);
  if (p.summary) parts.push(p.summary);
  if (p.skills.length > 0) parts.push(`Skills: ${p.skills.map((s) => s.name).join(', ')}`);
  for (const w of p.work.slice(0, 4)) {
    const line = [w.title, w.summary ?? '', w.bullets.slice(0, 4).join('; ')].filter(Boolean).join('. ');
    if (line) parts.push(line);
  }
  for (const e of p.education.slice(0, 2)) {
    const line = [e.degree, e.major].filter(Boolean).join(' in ');
    if (line) parts.push(line);
  }
  return parts.join('\n').slice(0, 4000);
}

/** The hard filters of the profile (place, work model, level): these jobs are embedded first. */
export function priorityFilterOf(p: Profile | null): JobFilter | null {
  if (!p) return null;
  const f: JobFilter = {};
  const pr = p.preferences;
  if (pr.levels.length > 0) f.levels = pr.levels;
  if (pr.workModels.length > 0) f.workModels = pr.workModels;
  if (pr.countries.length > 0) f.countries = pr.countries;
  if (pr.places.length > 0) f.places = pr.places;
  if (Object.keys(f).length === 0) return null;
  f.includeUnknown = ['place', 'workModel', 'level'];
  return f;
}

// ---------------------------------------------------------------- the fit index

export interface ModelInfo {
  state: 'ready' | 'missing' | 'downloading' | 'failed';
  source: string | null;
  problem?: string | null;
}

export interface FitIndexOptions {
  /** The model id vectors are stored under (default: the embedder's, else bge-small-en-v1.5). */
  model?: string;
  modelInfo?: () => ModelInfo;
  priorityFilter?: () => JobFilter | null;
  now?: () => number;
}

interface Pending { rid: number; hash: string; text: string }

export class FitIndex {
  private embedder: (Embedder & { embedWith?: (t: string[], n: number, s?: AbortSignal) => Promise<Float32Array[]> }) | null;
  readonly model: string;
  readonly vec: VectorIndex;
  private readonly mem: MemIndex;
  private readonly rt: Runtime;
  private running = false;
  private orderCache: { gen: number; requested: number; rids: number[] } | null = null;

  private readonly db: DatabaseSync;
  private readonly opts: FitIndexOptions;

  constructor(db: DatabaseSync, embedder: Embedder | null, opts: FitIndexOptions = {}) {
    this.db = db;
    this.opts = opts;
    this.embedder = embedder;
    this.model = opts.model ?? embedder?.model ?? MODEL_ID;
    this.rt = runtimeOf(db, (d) => new MemIndex(d));
    this.mem = this.rt.mem;
    this.vec = vectorsOf(this.rt, db, this.model);
  }

  setEmbedder(e: Embedder | null): void {
    if (e && e.model !== this.model) throw new Error(`embedder model ${e.model} does not match the index model ${this.model}`);
    this.embedder = e;
  }

  hasEmbedder(): boolean { return this.embedder !== null; }

  private now(): number { return (this.opts.now ?? nowMs)(); }

  refresh(): void {
    this.mem.refresh();
    this.vec.refresh();
  }

  /** Open jobs with and without a current vector. */
  counts(): { indexed: number; waiting: number } {
    this.refresh();
    const m = this.mem;
    let indexed = 0, waiting = 0;
    for (let rid = 1; rid <= m.maxRid; rid++) {
      if ((m.flags[rid]! & (F_EXISTS | F_OPEN)) !== (F_EXISTS | F_OPEN)) continue;
      if (rid < this.vec.fresh.length && this.vec.fresh[rid] === 1) indexed++; else waiting++;
    }
    return { indexed, waiting };
  }

  status(): FitIndexStatus {
    const { indexed, waiting } = this.counts();
    const info = this.opts.modelInfo?.() ?? { state: this.embedder ? 'ready' : 'missing', source: null };
    let state: FitIndexStatus['state'];
    if (this.embedder) state = this.running || waiting > 0 ? 'indexing' : 'ready';
    else state = info.state === 'downloading' ? 'downloading' : info.state === 'failed' ? 'failed' : info.state === 'ready' ? (waiting > 0 ? 'indexing' : 'ready') : 'model_missing';
    const last = q(this.db, 'SELECT indexed, started_at, finished_at FROM fit_runs WHERE model = ? ORDER BY id DESC LIMIT 1').get(this.model) as
      { indexed: number; started_at: string; finished_at: string | null } | undefined;
    return {
      state,
      model: this.model,
      modelBytes: MODEL_TOTAL_BYTES,
      modelSource: info.source && /^https?:\/\//.test(info.source) ? info.source : null,
      indexed,
      waiting,
      lastRun: last ? { indexed: Number(last.indexed), startedAt: last.started_at, finishedAt: last.finished_at } : null,
    };
  }

  /** Asks for these rows to be embedded soon (a Top Matched search found them without a vector). */
  request(rids: number[]): void {
    for (const r of rids) if (this.rt.requested.size < 200_000) this.rt.requested.add(r);
  }

  /** Waiting rows in queue order. */
  queue(): number[] {
    this.refresh();
    if (this.orderCache && this.orderCache.gen === this.mem.generation && this.orderCache.requested === this.rt.requested.size) {
      // Same data: the cached order minus the rows indexed since.
      const fresh = this.vec.fresh;
      const out: number[] = [];
      for (const rid of this.orderCache.rids) if (!(rid < fresh.length && fresh[rid] === 1)) out.push(rid);
      this.orderCache.rids = out;
      return out;
    }
    const m = this.mem;
    const pf = this.opts.priorityFilter?.() ?? null;
    const compiled = pf ? compileFilter(pf, { db: this.db, mem: m, now: this.now() }) : null;
    const buckets: number[][] = [[], [], []];
    for (let rid = 1; rid <= m.maxRid; rid++) {
      if ((m.flags[rid]! & (F_EXISTS | F_OPEN)) !== (F_EXISTS | F_OPEN)) continue;
      if (rid < this.vec.fresh.length && this.vec.fresh[rid] === 1) continue;
      let b = 2;
      if (compiled && passesPriority(compiled, m, rid)) b = 0;
      else if (this.rt.requested.has(rid)) b = 1;
      buckets[b]!.push(rid);
    }
    const byNewest = (a: number, b: number) => {
      const pa = m.postedMs[a]!, pb = m.postedMs[b]!;
      const ka = pa === pa ? pa : -Infinity, kb = pb === pb ? pb : -Infinity;
      return kb - ka || b - a;
    };
    for (const b of buckets) b.sort(byNewest);
    const rids = [...buckets[0]!, ...buckets[1]!, ...buckets[2]!];
    this.orderCache = { gen: this.mem.generation, requested: this.rt.requested.size, rids };
    return rids;
  }

  private pending(rids: number[]): Pending[] {
    if (rids.length === 0) return [];
    const rows = q(this.db, `SELECT s.rid AS rid, s.embed_hash AS embed_hash, d.doc AS doc FROM store_jobs s JOIN job_docs d ON d.rid = s.rid WHERE s.status = 1 AND s.rid IN (${rids.map(() => '?').join(',')})`).all(...rids) as Array<{ rid: number; embed_hash: string; doc: Uint8Array }>;
    return rows.map((r) => {
      const job = decodeRecord<Job>(r.doc);
      const text = embedTextOf(job);
      return { rid: Number(r.rid), hash: embedHashOf(text), text };
    });
  }

  private async embedBatch(rids: number[], signal?: AbortSignal): Promise<number> {
    if (!this.embedder) throw new StoreError('not_ready', 'Fit indexing is not ready: the fit model has not been downloaded.');
    const items = this.pending(rids);
    if (items.length === 0) return 0;
    const vecs = await this.embedder.embed(items.map((i) => i.text), signal);
    tx(this.db, () => {
      const rev = nextRev(this.db);
      const st = q(this.db, `INSERT INTO job_vectors (rid, model, embed_hash, vec, rev) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (rid, model) DO UPDATE SET embed_hash = excluded.embed_hash, vec = excluded.vec, rev = excluded.rev`);
      items.forEach((it, k) => st.run(it.rid, this.model, it.hash, packHalf(vecs[k]!), rev));
    });
    for (const it of items) this.rt.requested.delete(it.rid);
    this.vec.refresh();
    return items.length;
  }

  /** Embeds up to `limit` waiting jobs (newest first, those that pass the person's hard filters first). One run. */
  async runOnce(limit = 256, signal?: AbortSignal): Promise<{ indexed: number }> {
    return this.runAll(signal, undefined, limit);
  }

  /**
   * One indexing run: embeds waiting jobs in batches until none wait (or `limit` is reached, or `signal` aborts).
   * The run is recorded even when nothing waits (indexed 0), and its count is saved after every batch.
   */
  async runAll(signal?: AbortSignal, onBatch?: (done: number, left: number) => void, limit = Infinity): Promise<{ indexed: number }> {
    if (this.running) return { indexed: 0 };
    this.running = true;
    const started = new Date(this.now()).toISOString();
    const runId = Number((q(this.db, 'INSERT INTO fit_runs (model, started_at, indexed) VALUES (?, ?, 0) RETURNING id').get(this.model, started) as { id: number }).id);
    let done = 0;
    try {
      for (;;) {
        if (signal?.aborted) break;
        const queue = this.queue();
        if (queue.length === 0 || done >= limit) break;
        if (!this.embedder) throw new StoreError('not_ready', 'Fit indexing is not ready: the fit model has not been downloaded.');
        const take = Math.min(64, limit - done);
        const n = await this.embedBatch(queue.slice(0, take), signal);
        if (n === 0) {
          // The rows changed under us (closed or deleted): drop them from this pass.
          this.orderCache = null;
          for (const r of queue.slice(0, take)) this.rt.requested.delete(r);
          if (this.queue().length === queue.length) break;
          continue;
        }
        done += n;
        q(this.db, 'UPDATE fit_runs SET indexed = ? WHERE id = ?').run(done, runId);
        onBatch?.(done, Math.max(0, queue.length - n));
      }
    } finally {
      q(this.db, 'UPDATE fit_runs SET indexed = ?, finished_at = ? WHERE id = ?').run(done, new Date(this.now()).toISOString(), runId);
      this.running = false;
    }
    return { indexed: done };
  }

  /** Embeds the profile text for Top Matched. */
  async profileVector(text: string): Promise<Float32Array> {
    if (!this.embedder) throw new StoreError('not_ready', 'Top Matched is not ready yet: the fit model has not been downloaded.');
    if (!text.trim()) throw new StoreError('needs_profile', 'Top Matched needs a profile. Add your profile to see jobs ranked by fit.');
    const e = this.embedder;
    const [v] = e.embedWith ? await e.embedWith([text], 512) : await e.embed([text]);
    return v!;
  }
}

function passesPriority(c: Compiled, m: MemIndex, rid: number): boolean {
  // The priority filter uses the same rules as search (unknown place, work model and level pass).
  return passesForQueue(c, m, rid);
}
