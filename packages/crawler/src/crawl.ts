// The crawl engine: fetch -> normalise -> store -> read the board's listing -> close what is confirmed gone.
//
// * Boards run in a pool: several hosts at once, up to `perHostConcurrency` boards per host, and every request to a
//   host goes through one pacer (at least 1 second apart). One hung, slow, huge or broken board holds one slot only.
// * Each board is written in ONE transaction (jobs, reading, health, run progress), so a crash never leaves a board
//   half stored, and a run that was cut short knows exactly which boards are left.
// * A failed, empty, cut-off or strange reply never closes anything. Only a complete, clean reading of a board that
//   lists its whole board in one answer can mark postings missing; a second reading must confirm before any closes.

import { normalizeJob, skipReason } from './job.ts';
import { AbortedError, NotFoundError, NotModifiedError } from './http.ts';
import type { BoardHttp, BoardHttpOptions } from './http.ts';
import { BoardDeadlineError, TooManyJobsError, describeFailure } from './failures.ts';
import type { BoardStatus, ReasonCode } from './failures.ts';
import { loopbackOrigin } from './hosts.ts';
import {
  DEFAULT_SWEEP_GRACE_MS, boardListedAnyPosting, boardQualifies, emptyFeedShouldClose, emptyStats,
} from './lifecycle.ts';
import type { Runs } from './runs.ts';
import { SOURCES, hostFor } from './sources/index.ts';
import type { ClosePolicy, Store } from './store.ts';
import type { Ats, BoardRef, BoardStats, HttpGetter, Job, RawJob, SourceRegistry } from './types.ts';

export type { BoardStatus, ReasonCode } from './failures.ts';

/** A second complete reading this long after the first miss confirms that a posting is gone. */
export const DEFAULT_CONFIRM_GAP_MS = 2 * 3600 * 1000;
/** A board that answers "not found" on 3 checks over this long is gone: its postings close. */
export const DEFAULT_NOT_FOUND_CLOSE_MS = 14 * 24 * 3600 * 1000;
export const DEFAULT_MAX_JOBS_PER_BOARD = 10_000;

export interface BoardResult {
  ats: Ats;
  board: string;
  company: string;
  status: BoardStatus;
  error: string | null;
  /** Raw postings the API listed. */
  listed: number;
  stats: BoardStats;
  elapsedMs: number;
  requests: number;
  bytesDecoded: number;
  bytesWire: number;
  rssMb: number;
  /** Postings closed for this board in this run. */
  closed: number;
  closedReason: string | null;
  closeHeld: string | null;
  // ---- added by the crawler lane ----
  region?: string;
  /** The host key the board ran on (after a board origin or the host map). */
  host?: string;
  reasonCode?: ReasonCode;
  /** A plain sentence for anything that is not a plain success (also a note for an empty or held board). */
  reason?: string | null;
  /** The board answered 304: unchanged since the last proven reading. */
  notModified?: boolean;
  /** Open postings this reading did not list. */
  missing?: number;
  /** A confirming second reading ran in this run. */
  confirmed?: boolean;
  /** Postings the board listed but that could not be stored, by reason. */
  skipReasons?: Record<string, number>;
}

export interface RunReport {
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  graceMs: number;
  boards: BoardResult[];
  totals: BoardStats & { listed: number; closed: number };
  peakRssMb: number;
  /** Board entries listed more than once (crawled once). */
  duplicatesDropped?: number;
  /** True when the run was stopped (signal) before every board finished. */
  stopped?: boolean;
}

export interface HttpMetrics extends HttpGetter {
  snapshot?(host?: string): { requests: number; bytesDecoded: number; bytesWire: number };
  isTripped?(host: string): boolean;
  hostKey?(hostOrUrl: string, origin?: string | null): string;
  forBoard?(opts: BoardHttpOptions): BoardHttp;
  readonly budgetLeft?: number;
}

export interface CrawlOptions {
  store: Store;
  http: HttpMetrics;
  sources?: SourceRegistry;
  /** The crawl clock (stored times). Pacing and timeouts use real time. */
  now?: () => number;
  /** A posting not seen for this long closes on a confirmed miss inside one run. Default 48 h. */
  graceMs?: number;
  /** Close all of a board's postings once it has listed nothing for this long. Default 7 days. */
  emptyFeedMs?: number;
  onBoard?: (r: BoardResult) => void;
  /** Readings at least this far apart confirm a removal. Default 2 h. */
  confirmGapMs?: number;
  /** Real milliseconds between a reading that found postings missing and its in-run confirming reading. Default 0. */
  confirmDelayMs?: number;
  /** Boards of one host in flight at once (requests still start at most once a second). Default 3. */
  perHostConcurrency?: number;
  /** Boards in flight at once over all hosts. Default 8. */
  globalConcurrency?: number;
  /** A board that lists more postings is refused as a whole. Default 10,000. */
  maxJobsPerBoard?: number;
  /** One board may not take longer than this (real time). Default 300 s. */
  boardDeadlineMs?: number;
  /** Try boards that are in back-off after failures (never skips robots.txt, pacing or a host's own wait). */
  force?: boolean;
  /** Record each board in this run (crawler_run_boards), in the same transaction as its jobs. */
  runs?: Runs;
  runId?: number | null;
  /** Stop starting boards and abort requests in flight; unfinished boards stay pending in the run. */
  signal?: AbortSignal;
  /** Not-found for this long (and 3 checks) closes a board's postings. Default 14 days. */
  notFoundCloseMs?: number;
  onProgress?: (done: number, total: number, r: BoardResult) => void;
}

function rssMb(): number { return Math.round(process.memoryUsage().rss / 1048576); }

interface Task { idx: number; board: BoardRef; host: string; mode: 'first' | 'confirm'; notBefore: number }

/** Runs tasks with a per-host and a global limit. Tasks may be added while it runs. */
async function runPool(tasks: Task[], exec: (t: Task) => Promise<void>, perHost: number, global: number, signal?: AbortSignal): Promise<void> {
  const inHost = new Map<string, number>();
  const running = new Set<Promise<void>>();
  let wake: (() => void) | null = null;
  const nudge = () => { const w = wake; wake = null; w?.(); };
  while (tasks.length > 0 || running.size > 0) {
    if (signal?.aborted) {
      // Nothing new starts; tasks still waiting are reported by the caller as left pending.
      tasks.length = 0;
      if (running.size === 0) break;
    }
    const now = Date.now();
    let nextAt = Infinity;
    for (let i = 0; i < tasks.length && running.size < global;) {
      const t = tasks[i]!;
      if ((inHost.get(t.host) ?? 0) >= perHost) { i++; continue; }
      if (t.notBefore > now) { nextAt = Math.min(nextAt, t.notBefore); i++; continue; }
      tasks.splice(i, 1);
      inHost.set(t.host, (inHost.get(t.host) ?? 0) + 1);
      const p: Promise<void> = exec(t).catch(() => { /* exec records its own failures */ }).finally(() => {
        inHost.set(t.host, (inHost.get(t.host) ?? 1) - 1);
        running.delete(p);
        nudge();
      });
      running.add(p);
    }
    if (tasks.length === 0 && running.size === 0) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
      if (Number.isFinite(nextAt)) setTimeout(resolve, Math.max(5, nextAt - Date.now()));
      else if (running.size === 0) setTimeout(resolve, 50);
    });
    wake = null;
  }
}

function boardKey(b: BoardRef): string { return `${b.ats}\u0000${b.board.toLowerCase()}\u0000${b.region ?? ''}`; }

export async function crawl(input: BoardRef[], opts: CrawlOptions): Promise<RunReport> {
  const { store, http } = opts;
  const sources = opts.sources ?? SOURCES;
  const nowMs = opts.now ?? (() => Date.now());
  const graceMs = opts.graceMs ?? DEFAULT_SWEEP_GRACE_MS;
  const emptyFeedMs = opts.emptyFeedMs ?? 7 * 24 * 3600 * 1000;
  const policy: ClosePolicy = { confirmGapMs: opts.confirmGapMs ?? DEFAULT_CONFIRM_GAP_MS, graceMs };
  const maxJobs = opts.maxJobsPerBoard ?? DEFAULT_MAX_JOBS_PER_BOARD;
  const deadlineMs = opts.boardDeadlineMs ?? 300_000;
  const notFoundCloseMs = opts.notFoundCloseMs ?? DEFAULT_NOT_FOUND_CLOSE_MS;
  const runs = opts.runs && opts.runId ? opts.runs : null;
  const runId = opts.runId ?? null;
  const started = nowMs();
  const perf0 = performance.now();
  let peakRss = rssMb();

  // The same board listed twice is crawled once.
  const boards: BoardRef[] = [];
  const seenKeys = new Set<string>();
  for (const b of input) {
    const k = boardKey(b);
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    boards.push(b);
  }
  // A board name under two regions is ambiguous: its absence proves nothing (freehire rule).
  const regionsPer = new Map<string, number>();
  for (const b of boards) regionsPer.set(`${b.ats}\u0000${b.board}`, (regionsPer.get(`${b.ats}\u0000${b.board}`) ?? 0) + 1);

  store.transaction(() => {
    for (const b of boards) store.ensureBoard(b.ats, b.board, b.company, b.region ?? '', b.origin ?? null);
  });

  const hostOf = (b: BoardRef): string => {
    const real = sources[b.ats]?.host?.(b) ?? hostFor(b.ats, b.region);
    if (http.hostKey) return http.hostKey(real, b.origin ?? null);
    const o = b.origin ? loopbackOrigin(b.origin) : null;
    return o ? new URL(o).host : real;
  };

  const results: Array<BoardResult | undefined> = new Array(boards.length);
  const tasks: Task[] = boards.map((b, idx) => ({ idx, board: b, host: hostOf(b), mode: 'first' as const, notBefore: 0 }));
  let done = 0;

  const blank = (b: BoardRef, host: string): BoardResult => ({
    ats: b.ats, board: b.board, company: b.company, status: 'ok', error: null, listed: 0, stats: emptyStats(),
    elapsedMs: 0, requests: 0, bytesDecoded: 0, bytesWire: 0, rssMb: 0, closed: 0, closedReason: null, closeHeld: null,
    region: b.region, host, reasonCode: 'ok', reason: null, notModified: false, missing: 0, confirmed: false, skipReasons: {},
  });

  const outcome = (r: BoardResult, doneFlag: boolean) => ({
    status: r.status, reasonCode: r.reasonCode ?? 'ok', reason: r.reason ?? null, listed: r.listed,
    inserted: r.stats.inserted, updated: r.stats.updated, unchanged: r.stats.unchanged, skipped: r.stats.skipped,
    closed: r.closed, missing: r.missing ?? 0, closeHeld: r.closeHeld, requests: r.requests, bytes: r.bytesDecoded,
    notModified: r.notModified ?? false, done: doneFlag,
  });

  const finish = (r: BoardResult, b: BoardRef, nowIso: string, doneFlag = true) => {
    store.recordOutcome(b.ats, b.board, { status: r.status, code: r.reasonCode ?? 'ok', reason: r.reason ?? null, listed: r.status === 'ok' ? r.listed : null, runId, nowIso });
    if (runs && runId) runs.boardDone(runId, b, outcome(r, doneFlag), nowIso);
  };

  async function fetchWithDeadline(source: NonNullable<SourceRegistry[Ats]>, b: BoardRef, bh: BoardHttp | null, ac: AbortController): Promise<RawJob[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new BoardDeadlineError(deadlineMs)); ac.abort(); }, deadlineMs);
    });
    try {
      return await Promise.race([source.fetchBoard(b, bh ?? http), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function exec(t: Task): Promise<void> {
    const b = t.board;
    const confirm = t.mode === 'confirm';
    const r = confirm ? blank(b, t.host) : blank(b, t.host);
    const source = sources[b.ats];
    const nowIsoAt = () => new Date(nowMs()).toISOString();
    const settle = (res: BoardResult) => {
      if (confirm) {
        const main = results[t.idx]!;
        main.closed += res.closed;
        if (res.closed > 0 && !main.closedReason) main.closedReason = res.closedReason;
        main.requests += res.requests;
        main.bytesDecoded += res.bytesDecoded;
        main.bytesWire += res.bytesWire;
        main.confirmed = true;
        if (res.missing !== undefined) main.missing = res.missing;
        if (runs && runId) runs.addCloses(runId, b, res.closed, res.requests);
        return;
      }
      res.rssMb = rssMb();
      peakRss = Math.max(peakRss, res.rssMb);
      results[t.idx] = res;
      done++;
      opts.onBoard?.(res);
      opts.onProgress?.(done, boards.length, res);
    };

    if (!source) {
      r.status = 'failed'; r.reasonCode = 'no_adapter'; r.error = `no adapter for ATS "${b.ats}"`;
      r.reason = `jobleft has no reader for ${b.ats} boards; nothing was sent`; r.stats.failed = 1;
      store.transaction(() => finish(r, b, nowIsoAt()));
      return settle(r);
    }
    if (b.origin && !loopbackOrigin(b.origin)) {
      r.status = 'forbidden'; r.reasonCode = 'bad_origin';
      r.reason = `the board origin ${b.origin} is not a mock server on this computer; nothing was sent`; r.error = r.reason;
      store.transaction(() => finish(r, b, nowIsoAt()));
      return settle(r);
    }
    if (b.origin && !http.forBoard) {
      r.status = 'forbidden'; r.reasonCode = 'bad_origin'; r.reason = 'this HTTP client cannot send a board to a mock origin'; r.error = r.reason;
      store.transaction(() => finish(r, b, nowIsoAt()));
      return settle(r);
    }
    if (!confirm) {
      if (http.isTripped?.(t.host)) {
        r.status = 'host-skipped'; r.reasonCode = 'host_skipped'; r.error = 'host tripped earlier in this run';
        r.reason = 'the host refused two requests in a row earlier in this run; the board waits for a later run';
        store.transaction(() => finish(r, b, nowIsoAt()));
        return settle(r);
      }
      if (!opts.force && store.isCooledDown(b.ats, b.board, nowMs())) {
        const row = store.getBoard(b.ats, b.board);
        r.status = 'cooled'; r.reasonCode = 'cooldown'; r.error = 'board is in cooldown';
        r.reason = `in back-off after ${row?.consecutive_failures ?? 0} failed checks in a row, until ${row?.cooldown_until ?? '?'}; last failure: ${row?.last_error ?? 'unknown'}`;
        store.transaction(() => finish(r, b, nowIsoAt()));
        return settle(r);
      }
      if (http.budgetLeft !== undefined && http.budgetLeft <= 0) {
        r.status = 'deferred'; r.reasonCode = 'budget'; r.error = 'request budget used up';
        r.reason = 'the request budget of this run is used up; the board waits for the next run';
        store.transaction(() => finish(r, b, nowIsoAt()));
        return settle(r);
      }
    }

    const t0 = Date.now();
    const snap0 = http.snapshot?.(t.host) ?? { requests: 0, bytesDecoded: 0, bytesWire: 0 };
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    opts.signal?.addEventListener('abort', onAbort);
    const validators = !confirm && source.conditional ? store.getValidators(b.ats, b.board) : null;
    const bh = http.forBoard ? http.forBoard({ origin: b.origin ?? null, validators, signal: ac.signal }) : null;
    const measure = () => {
      r.elapsedMs = Date.now() - t0;
      if (bh) { r.requests = bh.requests; r.bytesDecoded = bh.bytes; r.bytesWire = bh.bytes; }
      else {
        const s1 = http.snapshot?.(t.host) ?? snap0;
        r.requests = s1.requests - snap0.requests; r.bytesDecoded = s1.bytesDecoded - snap0.bytesDecoded; r.bytesWire = s1.bytesWire - snap0.bytesWire;
      }
    };
    try {
      let raw: RawJob[];
      try {
        raw = await fetchWithDeadline(source, b, bh, ac);
        if (raw.length > maxJobs) throw new TooManyJobsError(raw.length, maxJobs);
      } finally {
        opts.signal?.removeEventListener('abort', onAbort);
        measure();
      }
      // ---------------------------------------------------------------- a reply with a job list
      r.listed = raw.length;
      const jobs: Job[] = [];
      const listedIds: string[] = [];
      const seenIds = new Set<string>();
      for (const x of raw) {
        const id = String(x.externalId ?? '').trim();
        if (id) listedIds.push(id);
        if (x.unreadable) { r.stats.unreadable++; continue; }
        const j = normalizeJob(b, x);
        if (!j) {
          r.stats.skipped++;
          const why = skipReason(x) ?? 'the posting could not be read';
          r.skipReasons![why] = (r.skipReasons![why] ?? 0) + 1;
          continue;
        }
        if (seenIds.has(j.jobId)) continue; // the same posting listed twice in one answer
        seenIds.add(j.jobId);
        jobs.push(j);
      }
      const nowIso = nowIsoAt();
      let newlyMissing = 0;
      store.transaction(() => {
        for (const j of jobs) {
          const res = store.upsertJob(j, nowIso);
          if (res.status === 'dupUrl') { r.stats.dupUrl++; continue; }
          r.stats.ingested++;
          if (res.status === 'inserted') r.stats.inserted++;
          else if (res.status === 'updated') r.stats.updated++;
          else r.stats.unchanged++;
          if (res.dupRole) r.stats.dupRole++;
        }
        if (!confirm) store.recordSuccess(b.ats, b.board, r.stats.ingested, boardListedAnyPosting(r.stats), nowIso);
        const ambiguous = (regionsPer.get(`${b.ats}\u0000${b.board}`) ?? 0) > 1;
        const proven = source.fullBoardListing && !ambiguous && boardQualifies(b.board, r.stats) && r.stats.ingested > 0;
        if (proven) {
          const reading = store.recordReading(b.ats, b.board, listedIds, nowIso, policy);
          r.closed += reading.closed;
          if (reading.closed > 0) r.closedReason = 'unseen';
          r.closeHeld = reading.held;
          r.missing = reading.missing;
          newlyMissing = reading.newlyMissing;
          if (!confirm) store.setValidators(b.ats, b.board, bh && source.conditional && !reading.held ? bh.validators : null);
        } else {
          if (!confirm) store.setValidators(b.ats, b.board, null);
          if (!confirm && !boardListedAnyPosting(r.stats)) {
            // Clean answer with zero postings. It proves nothing on its own, but a board silent for long enough is gone.
            const row = store.getBoard(b.ats, b.board);
            if (row && emptyFeedShouldClose(row.last_yield_at, nowMs(), emptyFeedMs, row.empty_streak)) {
              r.closed += store.closeBoardEmpty(b.ats, b.board, nowIso);
              if (r.closed > 0) r.closedReason = 'board_empty';
            }
          }
        }
        if (!confirm) {
          const notes: string[] = [];
          if (r.listed === 0) { r.reasonCode = 'empty'; notes.push('the board listed 0 jobs; nothing was closed because an empty answer proves nothing'); }
          if (r.stats.skipped > 0) notes.push(`${r.stats.skipped} listed posting(s) could not be stored: ${Object.entries(r.skipReasons!).map(([k, n]) => `${n} x ${k}`).join('; ')}`);
          if (r.stats.unreadable > 0) notes.push(`${r.stats.unreadable} listed posting(s) could not be read`);
          if (r.closeHeld) notes.push(`close held: ${r.closeHeld}`);
          if (!proven && r.listed > 0 && r.stats.ingested > 0 && !source.fullBoardListing) notes.push('this board type is read in parts, so absence closes nothing');
          r.reason = notes.length ? notes.join('. ') : null;
          finish(r, b, nowIso);
        }
      });
      if (!confirm && newlyMissing > 0 && !r.closeHeld) {
        tasks.push({ idx: t.idx, board: b, host: t.host, mode: 'confirm', notBefore: Date.now() + (opts.confirmDelayMs ?? 0) });
      }
    } catch (e) {
      if (e instanceof NotModifiedError && !confirm) {
        // ---------------------------------------------------------------- 304: same listing as the last proven reading
        const nowIso = nowIsoAt();
        store.transaction(() => {
          const reading = store.recordNotModified(b.ats, b.board, nowIso, policy);
          store.recordUnchanged(b.ats, b.board, nowIso);
          const row = store.getBoard(b.ats, b.board);
          r.notModified = true;
          r.reasonCode = 'not_modified';
          r.listed = row?.last_listed ?? 0;
          r.stats.unchanged = reading.open - reading.missing;
          r.stats.ingested = r.stats.unchanged;
          r.closed += reading.closed;
          if (reading.closed > 0) r.closedReason = 'unseen';
          r.missing = reading.missing;
          r.reason = 'unchanged since the last reading (HTTP 304, a small reply)';
          finish(r, b, nowIso);
        });
        return settle(r);
      }
      if (confirm) return settle(r); // a failed confirming reading changes nothing: the misses wait for the next reading
      const f = describeFailure(e);
      r.status = f.status;
      r.reasonCode = f.code;
      r.reason = f.message;
      r.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      if (f.status !== 'deferred' && f.status !== 'host-skipped') r.stats.failed = 1;
      const nowIso = nowIsoAt();
      const stopped = e instanceof AbortedError && opts.signal?.aborted === true;
      store.transaction(() => {
        if (!f.blameless) {
          store.recordFailure(b.ats, b.board, f.message, nowIso, { cooldownMs: f.cooldownMs, notFound: e instanceof NotFoundError });
          if (e instanceof NotFoundError) {
            const row = store.getBoard(b.ats, b.board);
            if (row && (row.notfound_streak ?? 0) >= 3 && row.notfound_since && Date.parse(nowIso) - Date.parse(row.notfound_since) >= notFoundCloseMs) {
              r.closed += store.closeBoardEmpty(b.ats, b.board, nowIso, 'board_gone');
              if (r.closed > 0) { r.closedReason = 'board_gone'; r.reason += `; the board has been gone since ${row.notfound_since}, so its ${r.closed} open postings were closed`; }
            }
          }
        }
        finish(r, b, nowIso, !stopped);
      });
      return settle(r);
    }
    return settle(r);
  }

  await runPool(tasks, exec, Math.max(1, opts.perHostConcurrency ?? 3), Math.max(1, opts.globalConcurrency ?? 8), opts.signal);

  const finished = nowMs();
  const list = results.filter((x): x is BoardResult => x !== undefined);
  const totals = { ...emptyStats(), listed: 0, closed: 0 };
  for (const r of list) {
    totals.listed += r.listed; totals.closed += r.closed;
    for (const k of Object.keys(r.stats) as Array<keyof BoardStats>) totals[k] += r.stats[k];
  }
  return {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    wallMs: Math.round(performance.now() - perf0),
    graceMs,
    boards: list,
    totals,
    peakRssMb: peakRss,
    duplicatesDropped: input.length - boards.length,
    stopped: opts.signal?.aborted === true && list.length < boards.length,
  };
}
