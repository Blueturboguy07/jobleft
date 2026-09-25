// One opened store: the database, the job store, the fit index, the person's records and the fit model.
// The CLI and the loopback test server both use it. The model is loaded only when fit work needs it, and it is
// downloaded only when it is missing and downloads are allowed. Nothing here contacts the network otherwise.

import type { DatabaseSync } from 'node:sqlite';
import { nowMs } from '@jobleft/contracts';
import { migrate, openDatabase } from './db.ts';
import { checkModel, defaultModelSource, ensureModel, modelDirIn, MODEL_FILES, type ModelSource } from './embed/model.ts';
import type { LocalEmbedder } from './embed/onnx.ts';
import { packHalf, unpackHalf } from './f16.ts';
import { createWorkerEmbedder } from './embed/worker.ts';
import { FitIndex, priorityFilterOf, profileTextOf, type ModelInfo } from './fit.ts';
import { ensureHome, storeHome, type StoreHome } from './home.ts';
import { JobStore, type SearchContext } from './jobstore.ts';
import { FilterStore, ProfileStore, SettingsStore, TrackerStore, NotificationStore, ChatStore } from './userdata.ts';
import type { JobFilter } from '@jobleft/contracts';

export interface ServiceOptions {
  /** Refuse every network request (JOBLEFT_OFFLINE=1). */
  offline?: boolean;
  modelSource?: ModelSource;
  threads?: number;
  /** Open an in-memory database instead of the data file (benchmarks). */
  memory?: boolean;
  /** Open an explicit database file instead of <home>/data/jobleft.db. */
  dbPath?: string;
}

export class StoreService {
  readonly h: StoreHome;
  readonly db: DatabaseSync;
  readonly jobs: JobStore;
  readonly fit: FitIndex;
  readonly tracker: TrackerStore;
  readonly filters: FilterStore;
  readonly profiles: ProfileStore;
  readonly settings: SettingsStore;
  readonly notifications: NotificationStore;
  readonly chats: ChatStore;
  readonly modelDir: string;
  readonly source: ModelSource;
  readonly offline: boolean;
  readonly dbPath: string;
  private readonly threads: number | undefined;
  modelState: ModelInfo['state'] = 'missing';
  modelProblem: string | null = null;
  downloadProgress: { done: number; total: number } | null = null;
  private embedder: LocalEmbedder | null = null;
  private loading: Promise<LocalEmbedder | null> | null = null;
  private profileVec: { version: string; vec: Float32Array | null } | null = null;

  constructor(home: string, opts: ServiceOptions = {}) {
    this.h = storeHome(home);
    if (!opts.memory) ensureHome(this.h);
    this.dbPath = opts.memory ? ':memory:' : opts.dbPath ?? this.h.db;
    this.db = openDatabase(this.dbPath);
    migrate(this.db);
    this.jobs = new JobStore(this.db);
    this.tracker = new TrackerStore(this.db);
    this.filters = new FilterStore(this.db);
    this.profiles = new ProfileStore(this.db);
    this.settings = new SettingsStore(this.db);
    this.notifications = new NotificationStore(this.db);
    this.chats = new ChatStore(this.db);
    this.offline = opts.offline ?? process.env.JOBLEFT_OFFLINE === '1';
    this.source = opts.modelSource ?? defaultModelSource();
    this.threads = opts.threads;
    this.modelDir = modelDirIn(this.h.models);
    this.fit = new FitIndex(this.db, null, {
      modelInfo: () => ({ state: this.modelState, source: this.source.base, problem: this.modelProblem }),
      priorityFilter: () => this.priorityFilter(),
      onEmbed: () => { this.lastEmbedUse = Date.now(); },
    });
  }

  /** The hard filters fit indexing does first: the default saved filter, else the profile preferences. */
  priorityFilter(): JobFilter | null {
    const id = this.settings.getJson<string>('store.defaultFilterId');
    if (id) {
      const f = this.filters.get(id);
      if (f) return f.filter;
    }
    const p = this.profiles.get();
    return priorityFilterOf(p.version ? p : null);
  }

  /** Quick check of the model files (sizes only; the full checksum runs before the model is used). */
  async refreshModelState(): Promise<ModelInfo['state']> {
    if (this.embedder) return (this.modelState = 'ready');
    if (this.modelState === 'downloading') return this.modelState;
    const c = await checkModel(this.modelDir, MODEL_FILES, false);
    this.modelState = c.state === 'ready' ? 'ready' : c.state === 'damaged' ? 'failed' : 'missing';
    this.modelProblem = c.problems[0] ?? null;
    return this.modelState;
  }

  /**
   * The fit model, ready to embed. Downloads it first when it is missing and `download` is true (never offline).
   * Returns null when it cannot be had now; the reason is in modelState and modelProblem.
   */
  async loadModel(opts: { download: boolean; onProgress?: (done: number, total: number) => void } = { download: false }): Promise<LocalEmbedder | null> {
    if (this.embedder) return this.embedder;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        let c = await checkModel(this.modelDir, MODEL_FILES, true);
        if (c.state !== 'ready') {
          const local = !/^https?:\/\//i.test(this.source.base);
          if (!opts.download || (this.offline && !local)) {
            this.modelState = c.state === 'damaged' ? 'failed' : 'missing';
            this.modelProblem = c.problems[0] ?? (this.offline ? 'The app is offline and the fit model is not downloaded yet.' : null);
            return null;
          }
          this.modelState = 'downloading';
          this.downloadProgress = { done: c.haveBytes, total: c.totalBytes };
          await ensureModel(this.modelDir, this.source, {
            offline: this.offline,
            onProgress: (p) => { this.downloadProgress = { done: p.doneBytes, total: p.totalBytes }; opts.onProgress?.(p.doneBytes, p.totalBytes); },
          });
          c = await checkModel(this.modelDir, MODEL_FILES, true);
          if (c.state !== 'ready') throw new Error(c.problems[0] ?? 'The fit model did not verify.');
        }
        const e = await createWorkerEmbedder({ modelDir: this.modelDir, threads: this.threads });
        this.embedder = e;
        this.lastEmbedUse = Date.now();
        this.fit.setEmbedder(e);
        this.modelState = 'ready';
        this.modelProblem = null;
        this.downloadProgress = null;
        return e;
      } catch (err) {
        this.modelState = 'failed';
        this.modelProblem = err instanceof Error ? err.message : String(err);
        return null;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  hasModel(): boolean { return this.embedder !== null; }

  /** When the model was last used (indexing or a profile vector). */
  lastEmbedUse = 0;

  /**
   * Frees the model (about 300 MB) when it has not been used for `idleMs`. The files stay; the next fit step loads
   * it again in about a second. Keeps memory flat and the CPU idle when there is nothing to index.
   */
  async unloadIfIdle(idleMs: number): Promise<boolean> {
    if (!this.embedder || this.loading || this.fit.isRunning()) return false;
    if (Date.now() - this.lastEmbedUse < idleMs) return false;
    const e = this.embedder;
    this.embedder = null;
    this.fit.setEmbedder(null);
    await e.close();
    return true;
  }

  /** The profile vector (cached per profile version), or why there is none. */
  async profileVector(): Promise<{ vector: Float32Array | null; reason?: 'needs_profile' | 'not_ready' }> {
    const p = this.profiles.get();
    const text = profileTextOf(p.version ? p : null);
    if (!text.trim()) return { vector: null, reason: 'needs_profile' };
    if (this.profileVec && this.profileVec.version === p.version && this.profileVec.vec) return { vector: this.profileVec.vec };
    // The vector of this profile version, kept from an earlier run (no model needed to use it again).
    const kept = this.settings.getJson<{ version: string; model: string; vec: string }>('store.profileVector');
    if (kept && kept.version === p.version && kept.model === this.fit.model) {
      const vec = unpackHalf(Buffer.from(kept.vec, 'base64'));
      if (vec.length === 384) { this.profileVec = { version: p.version, vec }; return { vector: vec }; }
    }
    if (!this.embedder) {
      // The model files are on disk (or loading): wait for the model rather than answer "not ready".
      if (this.modelState === 'missing' || this.modelState === 'failed') await this.refreshModelState();
      if (this.modelState === 'ready' || this.loading) await this.loadModel({ download: false });
      if (!this.embedder) return { vector: null, reason: 'not_ready' };
    }
    this.lastEmbedUse = Date.now();
    // Round through float16 now, so this session scores with exactly the vector a later session reads back from disk
    // (otherwise every fit score moves by about 1e-4 after a restart and near ties swap).
    const packed = packHalf(await this.fit.profileVector(text));
    const vec = unpackHalf(packed);
    this.profileVec = { version: p.version, vec };
    this.settings.setJson('store.profileVector', { version: p.version, model: this.fit.model, vec: Buffer.from(packed).toString('base64') });
    return { vector: vec };
  }

  /** Makes the profile vector and scores every indexed job for it, so the first Top Matched search is quick. */
  async warmFit(): Promise<void> {
    const pv = await this.profileVector();
    if (pv.vector) { this.fit.refresh(); this.fit.vec.scoresFor(pv.vector); }
  }

  async searchContext(now = nowMs()): Promise<SearchContext> {
    const pv = await this.profileVector();
    return { profileVector: pv.vector, fitUnavailable: pv.reason, h1b: null, places: null, now, fit: this.fit };
  }

  async close(): Promise<void> {
    if (this.embedder) await this.embedder.close();
    this.db.close();
  }
}
