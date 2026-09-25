// The scheduler: when each board is read again, one run at a time, resumable.
//
//   * a board that answered well is read again after the refresh period (default 24 h), spread by a small per-board
//     offset so boards never all start at the same moment;
//   * a board that stopped listing postings is read again after the confirm gap (default 2 h), so a removal is
//     confirmed and closed well inside 48 hours;
//   * a failing board is asked less and less often: 1 h, 4 h, 12 h, 1 day, 2 days, 4 days, then once a week, until it
//     answers well again (all scaled to the refresh period);
//   * a host that asked to wait (Retry-After, repeated 403/429) is left alone until the time it named;
//   * on launch, every board that is due (after a break of hours or days) is read: the catch-up;
//   * a run that was cut short (quit, crash, power loss) is resumed first, with only the boards it had not finished.

import { nowMs as envNowMs } from '@jobleft/contracts';
import type { CrawlBoardReport, CrawlProgress, CrawlRunSummary } from '@jobleft/contracts';
import type { CrawlerConfig } from './config.ts';
import { crawl } from './crawl.ts';
import type { BoardResult, RunReport } from './crawl.ts';
import { HttpClient, Pacer } from './http.ts';
import { loopbackOrigin } from './hosts.ts';
import { Runs } from './runs.ts';
import type { RunReason, RunRow } from './runs.ts';
import { PAY_QUERY } from './sources/greenhouse.ts';
import { SOURCES, hostFor } from './sources/index.ts';
import type { Store } from './store.ts';
import type { BoardRef, SourceRegistry } from './types.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Key of the clock offset that `simulate` leaves in the database. */
export const CLOCK_OFFSET_KEY = 'clock_offset_ms';

/** The clock offset (ms) a simulation left in this database. */
export function storedClockOffset(store: Store): number {
  const v = Number(store.getMeta(CLOCK_OFFSET_KEY) ?? 0);
  return Number.isFinite(v) ? v : 0;
}

/**
 * The crawler clock of a database: real time, moved by JOBLEFT_NOW / JOBLEFT_CLOCK_OFFSET, by `extraOffsetMs`, and by
 * the offset a simulation left. A fixed time (`--now`) replaces all of that.
 */
export function crawlerClock(store: Store, opts: { fixedMs?: number | null; extraOffsetMs?: number } = {}): () => number {
  if (opts.fixedMs !== undefined && opts.fixedMs !== null) { const t = opts.fixedMs; return () => t; }
  const extra = opts.extraOffsetMs ?? 0;
  return () => envNowMs() + storedClockOffset(store) + extra;
}

const LADDER = [1 / 24, 1 / 6, 1 / 2, 1, 2, 4, 7];

/** How long after its last check a board that failed `failures` times in a row is tried again. Grows with each failure. */
export function retryDelayMs(failures: number, refreshMs: number): number {
  if (failures <= 0) return refreshMs;
  const k = LADDER[Math.min(failures, LADDER.length) - 1]!;
  return Math.max(MIN, Math.round(refreshMs * k));
}

/** A stable per-board offset, so boards due together do not all start at the same moment. */
export function jitterMs(key: string, refreshMs: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  const frac = (h >>> 0) / 4294967296;
  return Math.round(frac * Math.min(refreshMs * 0.1, HOUR));
}

export interface ScheduleSettings { refreshMs: number; confirmGapMs: number }

/** Settings from the config. A confirmation never waits longer than half a refresh period. */
export function scheduleSettings(cfg: CrawlerConfig): ScheduleSettings {
  const refreshMs = Math.round(cfg.refreshHours * HOUR);
  return { refreshMs, confirmGapMs: Math.min(Math.round(cfg.confirmHours * HOUR), Math.round(refreshMs / 2)) };
}

export type DueWhy = 'new' | 'refresh' | 'retry' | 'confirm' | 'robots' | 'deferred' | 'never';
export interface DueInfo { board: BoardRef; dueAt: number; why: DueWhy }

function boardKey(b: BoardRef): string { return `${b.ats}:${b.region ? b.region + ':' : ''}${b.board}`.toLowerCase(); }

/** When each board is due, earliest first. `now` is the crawler clock; `waitLeft` gives a host's real remaining wait. */
export function planDue(store: Store, boards: BoardRef[], now: number, s: ScheduleSettings, waitLeft?: (b: BoardRef) => number): DueInfo[] {
  const out: DueInfo[] = [];
  for (const b of boards) {
    const row = store.getBoard(b.ats, b.board);
    const checked = row?.last_checked_at ?? row?.last_attempt_at ?? null;
    if (!row || !checked) { out.push({ board: b, dueAt: now - 1, why: 'new' }); continue; }
    if (row.last_status === 'forbidden' || row.last_reason_code === 'no_adapter') { out.push({ board: b, dueAt: Infinity, why: 'never' }); continue; }
    const checkedAt = Date.parse(checked);
    const f = row.consecutive_failures ?? 0;
    let dueAt: number;
    let why: DueWhy;
    if (f > 0) {
      dueAt = Date.parse(row.last_attempt_at ?? checked) + retryDelayMs(f, s.refreshMs);
      why = 'retry';
    } else {
      dueAt = Date.parse(row.last_success_at ?? row.last_attempt_at ?? checked) + s.refreshMs + jitterMs(boardKey(b), s.refreshMs);
      why = 'refresh';
    }
    if (row.last_status === 'robots') {
      dueAt = checkedAt + (row.last_reason_code === 'robots_unreadable' ? 30 * MIN : s.refreshMs);
      why = 'robots';
    } else if (row.last_status === 'deferred' || row.last_status === 'host-skipped') {
      dueAt = Math.min(dueAt, checkedAt + MIN);
      why = 'deferred';
    }
    const pm = store.pendingMisses(b.ats, b.board);
    if (pm.count > 0 && pm.firstMissedAt) {
      const c = Math.max(Date.parse(pm.firstMissedAt) + s.confirmGapMs, checkedAt + MIN);
      if (c < dueAt) { dueAt = c; why = 'confirm'; }
    }
    if ((row.held_streak ?? 0) > 0) {
      const c = checkedAt + Math.min(12 * HOUR, s.refreshMs);
      if (c < dueAt) { dueAt = c; why = 'confirm'; }
    }
    if (row.cooldown_until) dueAt = Math.max(dueAt, Date.parse(row.cooldown_until));
    const w = waitLeft?.(b) ?? 0;
    if (w > 0) dueAt = Math.max(dueAt, now + w);
    out.push({ board: b, dueAt, why });
  }
  return out.sort((a, b) => a.dueAt - b.dueAt);
}

// -------------------------------------------------------------------------------------------------------- runs

export interface RunDeps {
  store: Store;
  config: CrawlerConfig;
  sources?: SourceRegistry;
  /** Real host -> loopback mock origin (JOBLEFT_HOST_MAP). */
  hostMap?: Record<string, string>;
  /** One pacer shared by every run of this process (1 request per second per host, across runs). */
  pacer?: Pacer;
  clock: () => number;
  log?: (line: string) => void;
  onBoard?: (r: BoardResult) => void;
  onProgress?: (done: number, total: number, r: BoardResult) => void;
  /** Tests only. */
  fetchImpl?: typeof fetch;
  lookup?: ((host: string) => Promise<string[]>) | null;
  allowHeldBack?: string[];
}

export interface RunOptions {
  reason: RunReason;
  boards: BoardRef[];
  /** Try boards that are in back-off, even after a refusal (403/429). */
  force?: boolean;
  /** Try boards in back-off after failures (not after a refusal), once and without retries. Manual runs. */
  retryFailing?: boolean;
  signal?: AbortSignal;
  note?: string | null;
  /** Resume an interrupted run first (default true). */
  resume?: boolean;
}

export interface RunOutcome { runId: number; resumed: boolean; report: RunReport; run: RunRow; requests: number; http: HttpClient }

/** A new HTTP client for one run (its own request budget), sharing the process's pacer and the database's host state. */
export function httpForRun(deps: RunDeps): HttpClient {
  const c = deps.config;
  return new HttpClient({
    userAgent: c.userAgent,
    timeoutMs: c.requestTimeoutSeconds * 1000,
    robotsTimeoutMs: c.robotsTimeoutSeconds * 1000,
    maxBodyBytes: Math.round(c.maxBodyMB * 1024 * 1024),
    maxRequests: c.maxRequestsPerRun,
    retries: c.retries,
    maxRetryAfterMs: c.maxRetryAfterSeconds * 1000,
    hostMap: deps.hostMap ?? {},
    state: deps.store.hostState(),
    pacer: deps.pacer ?? new Pacer(c.minHostIntervalSeconds * 1000),
    fetchImpl: deps.fetchImpl,
    lookup: deps.lookup,
    allowHeldBack: deps.allowHeldBack,
  });
}

/** Runs one crawl: resumes an interrupted run when there is one, else crawls `boards`. Returns null when there is nothing to do. */
export async function runOnce(deps: RunDeps, opts: RunOptions): Promise<RunOutcome | null> {
  const { store, config } = deps;
  const runs = new Runs(store);
  const iso = () => new Date(deps.clock()).toISOString();
  PAY_QUERY.value = config.greenhousePayTransparency ? '&pay_transparency=true' : '';
  let runId: number;
  let boards: BoardRef[];
  let resumed = false;
  const interrupted = opts.resume === false ? null : runs.interrupted();
  if (interrupted) {
    runs.adopt(interrupted.id);
    runId = interrupted.id;
    boards = runs.pendingBoards(interrupted.id);
    resumed = true;
    deps.log?.(`resuming run #${runId} (${interrupted.reason}, started ${interrupted.started_at}): ${boards.length} of ${interrupted.boards_total} boards were not finished`);
  } else {
    if (opts.boards.length === 0) return null;
    runId = runs.create(opts.reason, opts.boards, iso(), opts.note ?? null);
    boards = opts.boards;
  }
  const http = httpForRun(deps);
  const beat = setInterval(() => { try { runs.heartbeat(runId); runs.touchLease(); } catch { /* database busy: next beat */ } }, 20_000);
  beat.unref?.();
  const s = scheduleSettings(config);
  let report: RunReport;
  try {
    report = await crawl(boards, {
      store, http, sources: deps.sources ?? SOURCES, now: deps.clock,
      graceMs: config.graceHours * HOUR,
      confirmGapMs: s.confirmGapMs,
      confirmDelayMs: config.confirmDelaySeconds * 1000,
      perHostConcurrency: config.perHostConcurrency,
      globalConcurrency: config.globalConcurrency,
      maxJobsPerBoard: config.maxJobsPerBoard,
      boardDeadlineMs: config.boardDeadlineSeconds * 1000,
      force: opts.force,
      retryFailing: opts.retryFailing,
      runs, runId,
      signal: opts.signal,
      onBoard: deps.onBoard,
      onProgress: deps.onProgress,
    });
  } finally {
    clearInterval(beat);
  }
  runs.addRequests(runId, http.totalRequests);
  const row = runs.get(runId)!;
  const unfinished = row.boards_done < row.boards_total;
  runs.finish(runId, opts.signal?.aborted && unfinished ? 'stopped' : 'done', iso());
  return { runId, resumed, report, run: runs.get(runId)!, requests: http.totalRequests, http };
}

// -------------------------------------------------------------------------------------------------------- reports

function summary(r: RunRow): CrawlRunSummary {
  return {
    startedAt: r.started_at, finishedAt: r.finished_at ?? r.heartbeat_at ?? r.started_at, boards: r.boards_total, ok: r.ok,
    failed: r.failed, inserted: r.inserted, updated: r.updated, closed: r.closed, requests: r.requests,
  };
}

/** Crawl progress in the contract shape (GET /api/v1/crawl/status). */
export function crawlProgress(store: Store, now: number, s: ScheduleSettings, boards?: BoardRef[]): CrawlProgress {
  const runs = new Runs(store);
  const latest = runs.latest();
  const active = latest && latest.state === 'running' && latest.heartbeat_at !== null && Date.now() - Date.parse(latest.heartbeat_at) < 120_000 ? latest : null;
  const last = runs.lastFinished();
  let next: number | null = null;
  if (boards && boards.length > 0) {
    const due = planDue(store, boards, now, s).find((d) => Number.isFinite(d.dueAt));
    next = due ? Math.max(due.dueAt, now) : null;
  }
  const reason = active ? (active.reason === 'simulate' || active.reason === 'resume' || active.reason === 'confirm' ? 'schedule' : active.reason) : null;
  return {
    running: active !== null,
    reason: reason as CrawlProgress['reason'],
    boardsDone: active ? active.boards_done : 0,
    boardsTotal: active ? active.boards_total : 0,
    jobsSeen: active ? active.listed : 0,
    startedAt: active ? active.started_at : null,
    nextScheduledAt: next === null ? null : new Date(next).toISOString(),
    lastRun: last ? summary(last) : null,
  };
}

const CONTRACT_STATUS: Record<string, CrawlBoardReport['status']> = {
  ok: 'ok', failed: 'failed', cooled: 'cooled', blocked: 'blocked', 'host-skipped': 'host_skipped', deferred: 'host_skipped',
  robots: 'robots', forbidden: 'forbidden',
};

/** The last finished run with one line per board, in the contract shape (GET /api/v1/crawl/report). */
export function lastRunReport(store: Store, runId?: number): { run: CrawlRunSummary | null; boards: CrawlBoardReport[] } {
  const runs = new Runs(store);
  const r = runId ? runs.get(runId) : runs.lastFinished() ?? runs.latest();
  if (!r) return { run: null, boards: [] };
  const boards = runs.boards(r.id).filter((b) => b.state === 'done').map((b): CrawlBoardReport => ({
    boardId: `${b.ats}:${b.region ? b.region + ':' : ''}${b.board}`.toLowerCase(),
    status: b.reason_code === 'no_adapter' ? 'no_adapter' : CONTRACT_STATUS[b.status ?? 'failed'] ?? 'failed',
    reason: b.reason,
    listed: b.listed, inserted: b.inserted, updated: b.updated, unchanged: b.unchanged, skipped: b.skipped,
    unreadable: 0, closed: b.closed, closeHeld: b.close_held, requests: b.requests,
    finishedAt: b.finished_at ?? r.started_at,
  }));
  return { run: summary(r), boards };
}

// -------------------------------------------------------------------------------------------------------- scheduler

export interface SchedulerDeps extends RunDeps {
  /** The current board list (read again before every cycle, so edits apply). */
  boards: () => BoardRef[];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** True when every board of the list is served by a mock server on this computer (then short refresh periods are allowed). */
export function allMockBoards(boards: BoardRef[], hostMap: Record<string, string>, sources: SourceRegistry = SOURCES): boolean {
  if (boards.length === 0) return false;
  return boards.every((b) => {
    if (b.origin && loopbackOrigin(b.origin)) return true;
    const real = sources[b.ats]?.host?.(b) ?? hostFor(b.ats, b.region);
    return hostMap[real.toLowerCase()] !== undefined;
  });
}

/**
 * Runs crawls for as long as the app (or the menu-bar agent) runs: a catch-up on launch, then each board when it is
 * due. One crawl at a time per database (the lease). stop() finishes the board in flight or leaves it pending.
 */
export class Scheduler {
  private deps: SchedulerDeps;
  private ac = new AbortController();
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private manual: BoardRef[] | null = null;
  private busy = false;
  readonly settings: ScheduleSettings;

  constructor(deps: SchedulerDeps) {
    this.deps = { ...deps, pacer: deps.pacer ?? new Pacer(deps.config.minHostIntervalSeconds * 1000) };
    this.settings = scheduleSettings(deps.config);
    if (this.settings.refreshMs < HOUR && !allMockBoards(deps.boards(), deps.hostMap ?? {}, deps.sources)) {
      throw new Error('a refresh period under 1 hour is allowed only when every board is a mock server on this computer');
    }
  }

  private log(s: string): void { this.deps.log?.(s); }

  /** Starts the loop. Throws when another process holds the crawl lease of this database. */
  start(opts: { catchUp: boolean } = { catchUp: true }): Promise<void> {
    if (this.loop) return this.loop;
    const runs = new Runs(this.deps.store);
    const lease = runs.acquireLease();
    if (!lease.ok) throw new Error(`another jobleft crawler (pid ${lease.pid}, since ${lease.since}) is using this database`);
    const beat = setInterval(() => { try { runs.touchLease(); } catch { /* busy */ } }, 30_000);
    beat.unref?.();
    this.loop = (async () => {
      try {
        let first = true;
        let lastTick = Date.now();
        // Without a catch-up, the first look at the schedule waits one minute (the app is still starting).
        if (!opts.catchUp) await sleep(60_000, this.ac.signal);
        while (!this.ac.signal.aborted) {
          const now = this.deps.clock();
          const boards = this.deps.boards();
          if (runs.interrupted()) {
            await this.cycle('resume', []);
            continue;
          }
          if (this.manual) {
            const list = this.manual.length ? this.manual : boards;
            this.manual = null;
            await this.cycle('manual', list);
            continue;
          }
          const plan = planDue(this.deps.store, boards, now, this.settings, (b) => this.waitLeft(b));
          const due = plan.filter((d) => d.dueAt <= now);
          if (due.length > 0) {
            const everRan = runs.latest() !== null;
            const reason: RunReason = !everRan ? 'first_run' : first ? 'launch_catch_up' : due.every((d) => d.why === 'confirm') ? 'confirm' : 'schedule';
            first = false;
            await this.cycle(reason, due.map((d) => d.board));
            continue;
          }
          first = false;
          const next = plan.find((d) => Number.isFinite(d.dueAt));
          const waitMs = next ? Math.min(Math.max(next.dueAt - now, 1000), 60_000) : 60_000;
          await new Promise<void>((resolve) => { this.wake = resolve; void sleep(waitMs, this.ac.signal).then(resolve); });
          this.wake = null;
          const elapsed = Date.now() - lastTick;
          if (elapsed > waitMs + 90_000) this.log(`the computer was asleep for about ${Math.round(elapsed / 60_000)} minutes; checking which boards are due`);
          lastTick = Date.now();
        }
      } finally {
        clearInterval(beat);
        runs.releaseLease();
      }
    })();
    return Promise.resolve();
  }

  /** A client used only to read host waits between runs (it sends nothing). */
  private probe: HttpClient | null = null;

  private waitLeft(b: BoardRef): number {
    const real = (this.deps.sources ?? SOURCES)[b.ats]?.host?.(b) ?? hostFor(b.ats, b.region);
    if (!this.probe) this.probe = httpForRun(this.deps);
    return this.probe.waitLeft(this.probe.hostKey(real, b.origin ?? null));
  }

  private async cycle(reason: RunReason, boards: BoardRef[]): Promise<void> {
    this.busy = true;
    try {
      const out = await runOnce(this.deps, { reason, boards, retryFailing: reason === 'manual', signal: this.ac.signal });
      if (out) {
        const r = out.run;
        this.log(`run #${out.runId} (${out.resumed ? 'resumed' : reason}) ${r.state}: ${r.boards_done}/${r.boards_total} boards, ${r.ok} ok, ${r.failed} failed, ` +
          `${r.inserted} new, ${r.updated} updated, ${r.closed} closed, ${out.requests} requests`);
      }
    } catch (e) {
      this.log(`run failed: ${(e as Error).message}`);
      await sleep(5_000, this.ac.signal);
    } finally {
      this.busy = false;
    }
  }

  /** Stops the loop: no new board starts, requests in flight are cancelled, unfinished boards stay pending. */
  async stop(): Promise<void> {
    this.ac.abort();
    this.wake?.();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  /** Waits until the loop ends (after stop()). */
  get done(): Promise<void> { return this.loop ?? Promise.resolve(); }

  /** Asks for a refresh now (all listed boards, or the given ones). The polite rules still apply. */
  runNow(boards?: BoardRef[]): { started: boolean; message: string; nextAllowedAt: string | null } {
    if (this.busy) return { started: false, message: 'a crawl is already running', nextAllowedAt: null };
    this.manual = boards ?? [];
    this.wake?.();
    return { started: true, message: 'a refresh starts now', nextAllowedAt: null };
  }

  progress(): CrawlProgress {
    return crawlProgress(this.deps.store, this.deps.clock(), this.settings, this.deps.boards());
  }

  lastReport(): { run: CrawlRunSummary | null; boards: CrawlBoardReport[] } {
    return lastRunReport(this.deps.store);
  }
}

// -------------------------------------------------------------------------------------------------------- simulate

export interface SimulationResult { runs: number; fromMs: number; toMs: number; outcomes: RunOutcome[] }

/**
 * Runs the schedule as if the app had been open for `forMs`: every refresh, confirmation and retry happens in order,
 * with the crawler clock moved to each event's time. Requests still go out at the real polite pace. At the end the
 * database keeps the clock offset, so later commands see the clock where the simulation left it.
 */
export async function simulate(deps: RunDeps & { boards: BoardRef[] }, forMs: number, opts: { signal?: AbortSignal; maxRuns?: number } = {}): Promise<SimulationResult> {
  const { store } = deps;
  const settings = scheduleSettings(deps.config);
  const start = deps.clock();
  const end = start + forMs;
  let simNow = start;
  const offsetBefore = storedClockOffset(store);
  const realStart = envNowMs();
  const outcomes: RunOutcome[] = [];
  const pacer = deps.pacer ?? new Pacer(deps.config.minHostIntervalSeconds * 1000);
  // In a simulation the confirming reading is the scheduled one (hours later in simulated time), so the in-run second
  // reading does not wait real seconds.
  const simDeps: RunDeps = { ...deps, pacer, clock: () => simNow, config: { ...deps.config, confirmDelaySeconds: 0 } };
  const probe = httpForRun(simDeps);
  const maxRuns = opts.maxRuns ?? 500;
  let runsDone = 0;
  while (runsDone < maxRuns && !opts.signal?.aborted) {
    const runs = new Runs(store);
    if (runs.interrupted()) {
      const out = await runOnce(simDeps, { reason: 'resume', boards: [], signal: opts.signal });
      if (out) outcomes.push(out);
      runsDone++;
      continue;
    }
    const plan = planDue(store, deps.boards, simNow, settings, (b) => {
      const real = (deps.sources ?? SOURCES)[b.ats]?.host?.(b) ?? hostFor(b.ats, b.region);
      return probe.waitLeft(probe.hostKey(real, b.origin ?? null));
    });
    const next = plan.find((d) => Number.isFinite(d.dueAt));
    if (!next || next.dueAt > end) break;
    simNow = Math.max(simNow, next.dueAt);
    const due = plan.filter((d) => d.dueAt <= simNow).map((d) => d.board);
    deps.log?.(`simulated time ${new Date(simNow).toISOString()}: ${due.length} board(s) due`);
    const out = await runOnce(simDeps, { reason: 'simulate', boards: due, signal: opts.signal, note: 'simulate' });
    if (out) outcomes.push(out);
    runsDone++;
    simNow += MIN; // the next event is at least a minute later
  }
  // Leave the clock where the simulation ended.
  const realElapsed = envNowMs() - realStart;
  store.setMeta(CLOCK_OFFSET_KEY, String(Math.round(offsetBefore + forMs - realElapsed)));
  return { runs: runsDone, fromMs: start, toMs: end, outcomes };
}

/** Days, hours, minutes and seconds, e.g. "2d 3h". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'never';
  const neg = ms < 0;
  let s = Math.round(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [d ? `${d}d` : '', h ? `${h}h` : '', m ? `${m}m` : '', !d && !h && s ? `${s}s` : ''].filter(Boolean);
  return (neg ? '-' : '') + (parts.slice(0, 2).join(' ') || '0s');
}

export { DAY as DAY_MS, HOUR as HOUR_MS };
