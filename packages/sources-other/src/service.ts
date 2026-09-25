// SourceService: what the server wires to the routes this lane owns (docs/INTERFACES.md section 6.4):
//   listSources     GET    /api/v1/sources                -> list()
//   updateSource    PATCH  /api/v1/sources/:sourceId      -> update(id, { enabled })
//   setSourceKey    PUT    /api/v1/sources/:sourceId/key  -> setKey(id, key)
//   deleteSourceKey DELETE /api/v1/sources/:sourceId/key  -> deleteKey(id)
// plus refresh(), runDue() for the scheduler, and the feed-job reads. Keys live only in the SecretStore
// (SECRET_NAMES.sourceKey(id)); nothing here returns, logs or stores a key anywhere else.

import type { DatabaseSync } from 'node:sqlite';
import { SECRET_NAMES, nowMs } from '@jobleft/contracts';
import type { SecretStore, SourceInfo } from '@jobleft/contracts';
import type { Store } from '@jobleft/crawler';
import { ALL_FEEDS, LISTED_ONLY, keyEnvName } from './catalog.ts';
import { migrateSourcesOther } from './db.ts';
import type { HostPacer } from './http.ts';
import { getState, nextAllowed, setEnabled } from './limits.ts';
import type { RunReason } from './limits.ts';
import { refreshSources } from './runner.ts';
import type { SourceRunResult } from './runner.ts';
import type { JobFeed } from './types.ts';
import { openJobsFor } from './view.ts';

/** Errors with the local API code the server answers (not_found 404, conflict 409, bad_request 400, too_early 425). */
export class SourceServiceError extends Error {
  readonly code: 'not_found' | 'conflict' | 'bad_request' | 'too_early';
  readonly retryAfterSeconds: number | null;
  constructor(code: SourceServiceError['code'], message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'SourceServiceError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface SourceServiceOptions {
  /** The crawler store on the app database; this lane's tables are created in the same file. */
  store: Store;
  secrets: SecretStore;
  feeds?: readonly JobFeed[];
  now?: () => number;
  fetchImpl?: typeof fetch;
  hostMap?: Record<string, string>;
  offline?: boolean;
  pacer?: HostPacer;
  timeoutMs?: number;
}

export interface RefreshReport {
  results: SourceRunResult[];
  /** For a manual refresh that was too soon everywhere: the earliest time any chosen source may run. */
  nextAllowedAt: string | null;
}

export class SourceService {
  readonly db: DatabaseSync;
  private store: Store;
  private secrets: SecretStore;
  private feeds: readonly JobFeed[];
  private now: () => number;
  private opts: SourceServiceOptions;
  private running: Promise<RefreshReport> | null = null;

  constructor(opts: SourceServiceOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.db = opts.store.db;
    this.secrets = opts.secrets;
    this.feeds = opts.feeds ?? ALL_FEEDS;
    this.now = opts.now ?? (() => nowMs());
    migrateSourcesOther(this.db);
  }

  private feed(id: string): JobFeed {
    const f = this.feeds.find((x) => x.id === id);
    if (!f) {
      if (LISTED_ONLY.some((l) => l.id === id)) throw new SourceServiceError('conflict', `${id} is listed for information only and cannot be turned on`);
      throw new SourceServiceError('not_found', `There is no source called "${id}".`);
    }
    return f;
  }

  private async keySet(f: JobFeed): Promise<boolean> {
    if (!f.info.needsKey) return false;
    try { return Boolean((await this.secrets.get(SECRET_NAMES.sourceKey(f.id)))?.trim()); } catch { return false; }
  }

  private async keyProblem(f: JobFeed): Promise<string | null> {
    if (!f.info.needsKey) return null;
    let key: string | null = null;
    try { key = await this.secrets.get(SECRET_NAMES.sourceKey(f.id)); } catch { key = null; }
    if (!key?.trim()) return `Needs a key. ${f.keyHelp ?? ''}`.trim();
    const bad = f.checkKey?.(key) ?? null;
    return bad ? `The saved key does not look right: ${bad}` : null;
  }

  /** One source as the local API shows it. */
  async info(f: JobFeed): Promise<SourceInfo> {
    const st = getState(this.db, f.id);
    const keySet = await this.keySet(f);
    const now = this.now();
    const enabled = f.info.crawled && st.enabled === 1;
    const wait = f.info.crawled ? nextAllowed(this.db, f, now, 'manual') : null;
    const problemAt = st.last_problem_at ? `${st.last_problem_at.slice(0, 19).replace('T', ' ')} UTC: ` : '';
    let state: SourceInfo['status']['state'];
    let lastProblem: string | null = st.last_problem ? `${problemAt}${st.last_problem}` : null;
    const keyProblem = f.info.crawled ? await this.keyProblem(f) : null;
    if (!f.info.crawled) { state = 'off'; lastProblem = null; }
    else if (keyProblem) { state = 'needs_key'; lastProblem = keyProblem; }
    else if (!enabled) state = 'off';
    else if (st.retry_after_until && Date.parse(st.retry_after_until) > now && st.last_error_code === 'rate_limited') state = 'rate_limited';
    else if (st.last_outcome === 'failed') state = 'failing';
    else if (st.last_outcome === 'ok') state = 'ok';
    else state = 'never_run';
    return {
      ...f.info,
      enabled,
      keySet,
      status: {
        state,
        lastSuccessAt: st.last_success_at,
        openJobs: openJobsFor(this.db, f.id),
        lastProblem,
        nextAllowedAt: wait ? new Date(wait.at).toISOString() : null,
      },
    };
  }

  /** Every other source: crawled or not, why, and how it is doing (GET /api/v1/sources). */
  async list(): Promise<SourceInfo[]> {
    const out: SourceInfo[] = [];
    for (const f of this.feeds) out.push(await this.info(f));
    for (const l of LISTED_ONLY) {
      out.push({ ...l, enabled: false, keySet: false, status: { state: 'off', lastSuccessAt: null, openJobs: null, lastProblem: null, nextAllowedAt: null } });
    }
    return out;
  }

  async get(id: string): Promise<SourceInfo> { return this.info(this.feed(id)); }

  /** Turns a source on or off (PATCH /api/v1/sources/:id). Off = no request at all; tracked jobs stay tracked. */
  async update(id: string, patch: { enabled: boolean }): Promise<SourceInfo> {
    const f = this.feed(id);
    if (patch.enabled && !f.info.crawled) {
      throw new SourceServiceError('conflict', `${f.info.name} cannot be turned on: ${f.info.reason ?? 'it is not approved'}`);
    }
    setEnabled(this.db, id, patch.enabled);
    return this.info(f);
  }

  /** Saves a key in the secret store (PUT .../key). The answer never holds the key. */
  async setKey(id: string, key: string): Promise<SourceInfo> {
    const f = this.feed(id);
    if (!f.info.needsKey) throw new SourceServiceError('bad_request', `${f.info.name} does not use a key.`);
    const k = key.trim();
    if (!k) throw new SourceServiceError('bad_request', 'The key is empty.');
    const bad = f.checkKey?.(k) ?? null;
    if (bad) throw new SourceServiceError('bad_request', bad);
    await this.secrets.set(SECRET_NAMES.sourceKey(id), k);
    return this.info(f);
  }

  async deleteKey(id: string): Promise<SourceInfo> {
    const f = this.feed(id);
    await this.secrets.delete(SECRET_NAMES.sourceKey(id));
    return this.info(f);
  }

  /** Runs a refresh now and waits for it. A manual refresh that is too soon says when the next one is allowed. */
  async refresh(opts: { ids?: string[]; reason?: RunReason; signal?: AbortSignal } = {}): Promise<RefreshReport> {
    if (opts.ids) for (const id of opts.ids) this.feed(id);
    // One refresh at a time per process: a second call waits for the first and then runs its own (limits decide).
    while (this.running) { try { await this.running; } catch { /* the earlier run reported its own failure */ } }
    const p = (async (): Promise<RefreshReport> => {
      const results = await refreshSources({
        store: this.store,
        keys: async (sid) => { try { return await this.secrets.get(SECRET_NAMES.sourceKey(sid)); } catch { return null; } },
        reason: opts.reason ?? 'manual',
        ids: opts.ids,
        feeds: this.feeds,
        now: this.now,
        fetchImpl: this.opts.fetchImpl,
        hostMap: this.opts.hostMap,
        offline: this.opts.offline,
        pacer: this.opts.pacer,
        timeoutMs: this.opts.timeoutMs,
        signal: opts.signal,
      });
      const waits = results.filter((r) => r.nextAllowedAt).map((r) => Date.parse(r.nextAllowedAt!));
      const ran = results.some((r) => r.outcome !== 'skipped');
      return { results, nextAllowedAt: !ran && waits.length ? new Date(Math.min(...waits)).toISOString() : null };
    })();
    this.running = p;
    try { return await p; } finally { if (this.running === p) this.running = null; }
  }

  /** Starts a refresh without waiting (the UI stays usable). */
  refreshInBackground(opts: { ids?: string[]; reason?: RunReason } = {}): { started: boolean; message: string } {
    if (this.running) return { started: false, message: 'A refresh of other sources is already running.' };
    void this.refresh(opts).catch(() => { /* each source recorded its own problem */ });
    return { started: true, message: 'Refreshing other sources.' };
  }

  /** For the scheduler and the launch catch-up: runs only the sources that are on and due. Safe to call often. */
  async runDue(reason: 'schedule' | 'launch' = 'schedule'): Promise<RefreshReport> {
    const now = this.now();
    const due = this.feeds.filter((f) => f.info.crawled && getState(this.db, f.id).enabled === 1 && !nextAllowed(this.db, f, now, reason)).map((f) => f.id);
    if (!due.length) return { results: [], nextAllowedAt: null };
    return this.refresh({ ids: due, reason });
  }
}

/**
 * A read-only SecretStore over environment variables, for the CLI and tests: the key of source X is read from
 * JOBLEFT_SOURCE_KEY_X. Nothing is ever written to a file; `set` and `delete` refuse.
 */
export function envSecretStore(env: Record<string, string | undefined> = process.env): SecretStore {
  const prefix = 'jobleft.source.';
  return {
    async get(name: string) {
      if (!name.startsWith(prefix) || !name.endsWith('.key')) return null;
      const id = name.slice(prefix.length, -'.key'.length);
      const v = env[keyEnvName(id)];
      return v && v.trim() ? v : null;
    },
    async set() { throw new Error('The command line reads source keys from environment variables (for example JOBLEFT_SOURCE_KEY_THEMUSE); it never saves them.'); },
    async delete() { throw new Error('The command line reads source keys from environment variables; unset the variable instead.'); },
  };
}
