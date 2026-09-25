// Orchestrator: fetch -> normalise -> dedupe -> save -> record health -> sweep. Mirrors freehire
// pipeline.Runner + cmd/ingest, minus everything that needs a server (Postgres outboxes, Meilisearch, Redis).
// Hosts run in parallel; boards on one host run in series, and the pacer spaces requests to 1 per second per host.

import { normalizeJob } from './job.ts';
import { HostTrippedError, BlockedError, BudgetError, NotFoundError, HttpError, RobotsError, DeniedHostError } from './http.ts';
import {
  DEFAULT_SWEEP_GRACE_MS, boardListedAnyPosting, closeTooBroad, emptyFeedShouldClose, emptyStats, sweepableBoards,
} from './lifecycle.ts';
import type { SweepCandidate } from './lifecycle.ts';
import { dedupeBatch } from './normalize.ts';
import { SOURCES, hostFor } from './sources/index.ts';
import type { Store } from './store.ts';
import type { Ats, BoardRef, BoardStats, HttpGetter, Job, Source } from './types.ts';

export type BoardStatus = 'ok' | 'failed' | 'cooled' | 'blocked' | 'host-skipped';

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
  /** Postings closed by the sweep for this board (filled after the sweep phase). */
  closed: number;
  closedReason: string | null;
  closeHeld: string | null;
}

export interface RunReport {
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  graceMs: number;
  boards: BoardResult[];
  totals: BoardStats & { listed: number; closed: number };
  peakRssMb: number;
}

export interface HttpMetrics extends HttpGetter {
  snapshot?(host?: string): { requests: number; bytesDecoded: number; bytesWire: number };
  isTripped?(host: string): boolean;
}

export interface CrawlOptions {
  store: Store;
  http: HttpMetrics;
  sources?: Record<Ats, Source>;
  now?: () => number;
  graceMs?: number;
  /** Close all of a board's postings once it has listed nothing for this long. Default 7 days. */
  emptyFeedMs?: number;
  onBoard?: (r: BoardResult) => void;
}

function rssMb(): number { return Math.round(process.memoryUsage().rss / 1048576); }

function classify(e: unknown): { status: BoardStatus; message: string } {
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (e instanceof BlockedError) return { status: 'blocked', message };
  return { status: 'failed', message };
}

export async function crawl(boards: BoardRef[], opts: CrawlOptions): Promise<RunReport> {
  const { store, http } = opts;
  const sources = opts.sources ?? SOURCES;
  const nowMs = opts.now ?? (() => Date.now());
  const graceMs = opts.graceMs ?? DEFAULT_SWEEP_GRACE_MS;
  const emptyFeedMs = opts.emptyFeedMs ?? 7 * 24 * 3600 * 1000;
  const started = nowMs();
  const perf0 = performance.now();
  const results: BoardResult[] = [];
  let peakRss = rssMb();

  for (const b of boards) store.ensureBoard(b.ats, b.board, b.company, b.region ?? '');

  async function crawlOne(b: BoardRef): Promise<BoardResult> {
    const stats = emptyStats();
    const base: BoardResult = {
      ats: b.ats, board: b.board, company: b.company, status: 'ok', error: null, listed: 0, stats,
      elapsedMs: 0, requests: 0, bytesDecoded: 0, bytesWire: 0, rssMb: 0, closed: 0, closedReason: null, closeHeld: null,
    };
    const host = hostFor(b.ats, b.region);
    if (http.isTripped?.(host)) { base.status = 'host-skipped'; base.error = 'host tripped earlier in this run'; return base; }
    if (store.isCooledDown(b.ats, b.board, nowMs())) { base.status = 'cooled'; base.error = 'board is in cooldown'; return base; }

    const t0 = Date.now();
    const snap0 = http.snapshot?.(host) ?? { requests: 0, bytesDecoded: 0, bytesWire: 0 };
    const nowIso = new Date(nowMs()).toISOString();
    try {
      const raw = await sources[b.ats].fetchBoard(b, http);
      base.listed = raw.length;
      const jobs: Job[] = [];
      for (const r of raw) {
        if (r.unreadable) { stats.unreadable++; continue; }
        const j = normalizeJob(b, r);
        if (!j) { stats.skipped++; continue; }
        jobs.push(j);
      }
      // Layer 1 inside the batch: identical canonical URL collapses. Role-hash dupes are flagged by the store instead.
      const items = jobs.map((j) => ({ ...j, sourceTrust: 1 }));
      const unique = dedupeBatch(items, { byHash: false });
      stats.dupUrl += items.length - unique.length;
      store.transaction(() => {
        for (const j of unique) {
          const res = store.upsertJob(j, nowIso);
          if (res.status === 'dupUrl') { stats.dupUrl++; continue; }
          stats.ingested++;
          if (res.status === 'inserted') stats.inserted++;
          else if (res.status === 'updated') stats.updated++;
          else stats.unchanged++;
          if (res.dupRole) stats.dupRole++;
        }
      });
      store.recordSuccess(b.ats, b.board, stats.ingested, boardListedAnyPosting(stats), nowIso);
    } catch (e) {
      const c = classify(e);
      base.status = c.status;
      base.error = c.message;
      stats.failed = 1;
      // Budget and robots problems are not the board's fault and must not push it towards a cooldown.
      const blameless = e instanceof BudgetError || e instanceof HostTrippedError || e instanceof DeniedHostError || e instanceof RobotsError;
      if (!blameless) store.recordFailure(b.ats, b.board, c.message, nowIso);
      if (e instanceof NotFoundError || e instanceof HttpError) { /* status already in message */ }
    }
    const snap1 = http.snapshot?.(host) ?? snap0;
    base.elapsedMs = Date.now() - t0;
    base.requests = snap1.requests - snap0.requests;
    base.bytesDecoded = snap1.bytesDecoded - snap0.bytesDecoded;
    base.bytesWire = snap1.bytesWire - snap0.bytesWire;
    base.rssMb = rssMb();
    peakRss = Math.max(peakRss, base.rssMb);
    return base;
  }

  // One queue per host, run in parallel.
  const queues = new Map<string, BoardRef[]>();
  for (const b of boards) {
    const h = hostFor(b.ats, b.region);
    let q = queues.get(h);
    if (!q) { q = []; queues.set(h, q); }
    q.push(b);
  }
  await Promise.all([...queues.values()].map(async (q) => {
    for (const b of q) {
      const r = await crawlOne(b);
      results.push(r);
      opts.onBoard?.(r);
    }
  }));

  // ---- sweep phase (freehire post-run sweep): close by absence only where coverage was proven ----
  const nowIso = new Date(nowMs()).toISOString();
  const cutoff = new Date(nowMs() - graceMs).toISOString();
  const cands: SweepCandidate[] = results
    .filter((r) => r.status === 'ok')
    .map((r) => ({ ats: r.ats, board: r.board, stats: r.stats, fullBoardListing: sources[r.ats].fullBoardListing }));
  const allowed = new Set(sweepableBoards(cands).map((c) => `${c.ats}\u0000${c.board}`));
  for (const r of results) {
    if (r.status !== 'ok') continue;
    const key = `${r.ats}\u0000${r.board}`;
    if (allowed.has(key)) {
      const { open, unseen } = store.countUnseenForBoard(r.ats, r.board, cutoff);
      if (closeTooBroad(open, unseen)) {
        r.closeHeld = `would close ${unseen} of ${open} open jobs (over 50%); held for review`;
        continue;
      }
      r.closed = store.closeUnseenForBoard(r.ats, r.board, cutoff, nowIso);
      if (r.closed > 0) r.closedReason = 'unseen';
    } else if (!boardListedAnyPosting(r.stats)) {
      // Clean answer with zero postings. It proves nothing on its own, but a board silent for long enough is gone.
      const row = store.getBoard(r.ats, r.board);
      if (row && emptyFeedShouldClose(row.last_yield_at, nowMs(), emptyFeedMs, row.empty_streak)) {
        r.closed = store.closeBoardEmpty(r.ats, r.board, nowIso);
        if (r.closed > 0) r.closedReason = 'board_empty';
      }
    }
  }

  const totals = { ...emptyStats(), listed: 0, closed: 0 };
  for (const r of results) {
    totals.listed += r.listed; totals.closed += r.closed;
    for (const k of Object.keys(r.stats) as Array<keyof BoardStats>) totals[k] += r.stats[k];
  }
  const finished = nowMs();
  return {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    wallMs: Math.round(performance.now() - perf0),
    graceMs,
    boards: results,
    totals,
    peakRssMb: peakRss,
  };
}
