// CrawlScheduler: runs refreshes. A catch-up on launch, then one every intervalHours while the app runs, and a
// manual "refresh now". Each run crawls the due boards through the crawler core (@jobleft/crawler crawl()), records
// what each board check saw (BoardService.recordCheck), writes the run report (crawl_runs, crawl_board_reports) and
// reports progress after every board, so new jobs are findable at once.
//
// A run is split into small batches; stop() lets the current batch finish and starts no new one. Boards on a host
// that asked jobleft to wait (Retry-After) are skipped with a reason instead of holding the run.

import type { CrawlBoardReport, CrawlProgress, CrawlRunSummary } from '@jobleft/contracts';
import { nowMs } from '@jobleft/contracts';
import { crawl, hostFor } from '@jobleft/crawler';
import type { BoardRef, BoardResult, HttpClient, SourceRegistry, Store } from '@jobleft/crawler';
import { boardId } from './ids.ts';
import { httpStateFor } from './http.ts';
import type { BoardService, CheckOutcome } from './service.ts';
import { classifyError, type CheckFailure } from './verify.ts';

export interface SchedulerOptions {
  boards: BoardService;
  crawlStore: Store;
  http: HttpClient;
  sources: SourceRegistry;
  intervalHours: () => number;
  now?: () => number;
  /** Called after each board and at the end, so new jobs are findable at once. */
  onProgress?: (p: CrawlProgress) => void;
  /** A fresh polite client per run (same shared pacer), so a host that tripped in one run is asked again in the next. */
  newHttp?: () => HttpClient;
  /** true = no request at all (JOBLEFT_OFFLINE): runs do not start. */
  offline?: () => boolean;
  /** Boards per batch (default 40). */
  batchSize?: number;
  /**
   * Passed to crawl(): how long a posting may be missing from a board whose whole list was read before it closes.
   * Default 24 h here (the crawler's own default is 48 h): with a refresh every 6 hours a removed job closes 24 to
   * 30 hours after the first refresh that no longer lists it, and one flaky answer never closes anything.
   */
  graceMs?: number;
}

type Reason = NonNullable<CrawlProgress['reason']>;

/** Turns a crawler board result into a check outcome (null = no check happened, e.g. cooldown). */
export function outcomeOf(r: BoardResult): { outcome: CheckOutcome | null; status: CrawlBoardReport['status']; reason: string | null } {
  if (r.status === 'ok') return { outcome: { ok: true, listed: r.listed }, status: 'ok', reason: null };
  if (r.status === 'cooled') return { outcome: null, status: 'cooled', reason: 'The board failed several times in a row; the crawler waits before asking it again.' };
  if (r.status === 'host-skipped') return { outcome: null, status: 'host_skipped', reason: 'The host refused jobleft earlier in this run, so jobleft did not ask it again.' };
  const err = r.error ?? '';
  const name = err.split(':')[0] ?? '';
  let failure: CheckFailure = 'network';
  let message = err;
  let status: CrawlBoardReport['status'] = r.status === 'blocked' ? 'blocked' : 'failed';
  if (/^no adapter/.test(err)) return { outcome: null, status: 'no_adapter', reason: `jobleft cannot read ${r.ats} boards yet.` };
  if (name === 'NotFoundError') { failure = 'not_found'; message = `The board answered "not found" (${/HTTP \d+/.exec(err)?.[0] ?? 'HTTP 404'}).`; }
  else if (name === 'BlockedError') { failure = 'blocked'; message = /HTTP 429/.test(err) ? 'The host asked jobleft to slow down (HTTP 429).' : `The host refused the request (${/HTTP \d+/.exec(err)?.[0] ?? 'HTTP 403'}).`; }
  else if (name === 'RobotsError') { failure = 'robots'; status = 'robots'; message = "The host's robots.txt does not allow jobleft to read this board."; }
  else if (name === 'DeniedHostError' || name === 'ForbiddenHostError') { failure = 'forbidden'; status = 'forbidden'; message = 'The host is on the never-crawl list; nothing was sent.'; }
  else if (name === 'HostBusyError') { failure = 'busy'; status = 'blocked'; message = 'The host asked jobleft to wait before asking again.'; }
  else if (name === 'OfflineError') { return { outcome: null, status: 'failed', reason: 'jobleft is offline; nothing was sent.' }; }
  else if (name === 'HttpError') {
    if (/invalid JSON/i.test(err)) { failure = 'bad_reply'; message = 'The board sent a reply that is not job data.'; }
    else if (/too large/i.test(err)) { failure = 'bad_reply'; message = 'The reply was too large to read.'; }
    else if (/redirect not followed/i.test(err)) { failure = 'bad_reply'; message = 'The board answered with a redirect instead of job data.'; }
    else { failure = 'server'; message = `The board's server failed (${/HTTP \d+/.exec(err)?.[0] ?? 'an HTTP error'}).`; }
  } else if (/timeout|aborted/i.test(err)) { failure = 'timeout'; message = 'The board did not answer in time.'; }
  else if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(err)) { failure = 'network'; message = 'The connection to the board failed.'; }
  else if (/BudgetError/.test(name)) return { outcome: null, status: 'failed', reason: 'The request budget for this run ran out; the board waits for the next run.' };
  else { const c = classifyError(new Error(err)); failure = c.failure; message = err.slice(0, 200) || c.message; }
  return { outcome: { ok: false, failure, message }, status, reason: message };
}

function iso(ms: number): string { return new Date(ms).toISOString(); }

/** A posting missing from a fully read board for this long closes (see SchedulerOptions.graceMs). */
export const DEFAULT_GRACE_MS = 24 * 3_600_000;

export class CrawlScheduler {
  private o: SchedulerOptions;
  private now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<CrawlRunSummary | null> | null = null;
  private stopping = false;
  private state: { reason: Reason | null; done: number; total: number; jobsSeen: number; startedAt: string | null; nextScheduledAt: string | null } =
    { reason: null, done: 0, total: 0, jobsSeen: 0, startedAt: null, nextScheduledAt: null };

  constructor(opts: SchedulerOptions) {
    this.o = opts;
    this.now = opts.now ?? (() => nowMs());
  }

  private get db() { return this.o.boards.db; }

  /** Starts the schedule: a catch-up crawl now (when asked), then one every intervalHours. */
  start(opts: { catchUp: boolean }): void {
    this.stopping = false;
    if (opts.catchUp) {
      const first = !(this.db.prepare('SELECT 1 FROM crawl_runs LIMIT 1').get());
      const hours = Math.max(0.01, this.o.intervalHours());
      void this.launch(first ? 'first_run' : 'launch_catch_up', this.o.boards.due(this.now(), { intervalHours: hours, catchUp: true }));
    }
    this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const hours = Math.max(0.01, this.o.intervalHours());
    const ms = hours * 3_600_000;
    this.state.nextScheduledAt = iso(this.now() + ms);
    this.timer = setTimeout(() => {
      if (this.stopping) return;
      if (!this.running) void this.launch('schedule', this.o.boards.due(this.now(), { intervalHours: Math.max(0.01, this.o.intervalHours()), catchUp: false }));
      this.arm();
    }, ms);
    this.timer.unref?.();
  }

  /** Stops the schedule. The batch that is running finishes (at most a few seconds per host); no new batch starts. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.state.nextScheduledAt = null;
    const r = this.running;
    if (r) await Promise.race([r.catch(() => null), new Promise((res) => setTimeout(res, 4000))]);
  }

  /** Starts a refresh now: all due boards (back-off respected), or exactly the listed ones. */
  runNow(boardIds?: string[]): { started: boolean; message: string; nextAllowedAt: string | null } {
    if (this.o.offline?.()) return { started: false, message: 'jobleft is offline, so no refresh started.', nextAllowedAt: null };
    if (this.running) {
      return { started: false, message: `A refresh is already running (${this.state.done} of ${this.state.total} boards done).`, nextAllowedAt: null };
    }
    const boards = this.pick(boardIds);
    if (boards.length === 0) return { started: false, message: boardIds?.length ? 'None of those boards can be refreshed (unknown, hidden or disabled).' : 'No board is due: every board is hidden, disabled or waiting for its next check date.', nextAllowedAt: null };
    this.stopping = false;
    void this.launch('manual', boards);
    return { started: true, message: `Refresh started for ${boards.length} board${boards.length === 1 ? '' : 's'}.`, nextAllowedAt: null };
  }

  /** Runs one refresh and waits for it (the CLI uses this). */
  async runOnce(opts: { boardIds?: string[]; reason?: Reason; intervalHours?: number } = {}): Promise<CrawlRunSummary | null> {
    if (this.o.offline?.()) return null;
    if (this.running) await this.running.catch(() => null);
    const boards = opts.boardIds?.length ? this.pick(opts.boardIds)
      : this.o.boards.due(this.now(), { intervalHours: opts.intervalHours ?? 0, catchUp: (opts.intervalHours ?? 0) > 0 });
    this.stopping = false;
    return this.launch(opts.reason ?? 'manual', boards);
  }

  private pick(boardIds?: string[]): BoardRef[] {
    if (!boardIds || boardIds.length === 0) return this.o.boards.due(this.now(), { intervalHours: 0, catchUp: false });
    const out: BoardRef[] = [];
    const seen = new Set<string>();
    for (const raw of boardIds) {
      const e = this.o.boards.get(raw);
      if (!e || e.hidden || e.disabled || seen.has(e.id) || !this.o.sources[e.ats]) continue;
      seen.add(e.id);
      out.push({ ats: e.ats, board: e.board, company: e.company, ...(e.region ? { region: e.region } : {}) });
    }
    return out;
  }

  private launch(reason: Reason, boards: BoardRef[]): Promise<CrawlRunSummary | null> {
    const p = this.run(reason, boards).finally(() => { if (this.running === p) this.running = null; });
    this.running = p;
    return p;
  }

  private emit(): void {
    try { this.o.onProgress?.(this.progress()); } catch { /* a listener must not stop the crawl */ }
  }

  private async run(reason: Reason, boards: BoardRef[]): Promise<CrawlRunSummary | null> {
    const started = this.now();
    this.state = { ...this.state, reason, done: 0, total: boards.length, jobsSeen: 0, startedAt: iso(started) };
    const runId = Number(this.db.prepare('INSERT INTO crawl_runs (reason, started_at, boards) VALUES (?, ?, ?)').run(reason, iso(started), boards.length).lastInsertRowid);
    const http = this.o.newHttp ? this.o.newHttp() : this.o.http;
    const pacer = httpStateFor(http)?.pacer;
    const totals = { ok: 0, failed: 0, inserted: 0, updated: 0, closed: 0, requests: 0 };
    const insertReport = this.db.prepare(`INSERT OR REPLACE INTO crawl_board_reports (run_id, board_id, status, reason, listed, inserted, updated,
      unchanged, skipped, unreadable, closed, close_held, requests, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const report = (id: string, status: CrawlBoardReport['status'], why: string | null, r: BoardResult | null): void => {
      insertReport.run(runId, id, status, why, r?.listed ?? 0, r?.stats.inserted ?? 0, r?.stats.updated ?? 0, r?.stats.unchanged ?? 0,
        r?.stats.skipped ?? 0, r?.stats.unreadable ?? 0, r?.closed ?? 0, r?.closeHeld ?? null, r?.requests ?? 0, iso(this.now()));
    };
    this.emit();
    const size = Math.max(1, this.o.batchSize ?? 40);
    try {
      for (let i = 0; i < boards.length && !this.stopping; i += size) {
        let batch = boards.slice(i, i + size);
        // A host that asked jobleft to wait longer than a minute: skip its boards this run, with a reason.
        if (pacer) {
          const keep: BoardRef[] = [];
          for (const b of batch) {
            const host = this.o.sources[b.ats]?.host?.(b) ?? hostFor(b.ats, b.region);
            const until = pacer.busyUntil(host);
            if (until - Date.now() > 60_000) {
              report(boardId(b.ats, b.board, b.region), 'blocked', `The host asked jobleft to wait until ${iso(until)}; this board waits for the next run.`, null);
              totals.failed++; this.state.done++;
              continue;
            }
            keep.push(b);
          }
          batch = keep;
        }
        if (batch.length === 0) { this.emit(); continue; }
        const res = await crawl(batch, {
          store: this.o.crawlStore, http, sources: this.o.sources, now: this.now,
          graceMs: this.o.graceMs ?? DEFAULT_GRACE_MS,
          onBoard: (r) => {
            const id = boardId(r.ats, r.board, batch.find((b) => b.ats === r.ats && b.board === r.board)?.region ?? null);
            const o = outcomeOf(r);
            if (o.outcome) {
              let open = 0;
              try { open = this.o.crawlStore.countUnseenForBoard(r.ats, r.board, iso(this.now())).open; } catch { /* no jobs table yet */ }
              this.o.boards.recordCheck(id, o.outcome, { now: this.now(), storeOpenJobs: open });
            }
            this.state.done++;
            this.state.jobsSeen += r.listed;
            this.emit();
          },
        });
        // Report rows after the sweep, so "closed" is filled in.
        for (const r of res.boards) {
          const region = batch.find((b) => b.ats === r.ats && b.board === r.board)?.region ?? null;
          const o = outcomeOf(r);
          report(boardId(r.ats, r.board, region), o.status, o.reason, r);
          if (r.status === 'ok') totals.ok++; else totals.failed++;
          totals.inserted += r.stats.inserted; totals.updated += r.stats.updated; totals.closed += r.closed; totals.requests += r.requests;
        }
      }
    } finally {
      const finished = this.now();
      this.db.prepare('UPDATE crawl_runs SET finished_at = ?, ok = ?, failed = ?, inserted = ?, updated = ?, closed = ?, requests = ? WHERE id = ?')
        .run(iso(finished), totals.ok, totals.failed, totals.inserted, totals.updated, totals.closed, totals.requests, runId);
      this.state.reason = null;
      this.state.startedAt = null;
    }
    const summary = this.summary(runId);
    this.emit();
    return summary;
  }

  private summary(runId: number): CrawlRunSummary | null {
    const r = this.db.prepare('SELECT * FROM crawl_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
    if (!r || !r.finished_at) return null;
    return {
      startedAt: String(r.started_at), finishedAt: String(r.finished_at), boards: Number(r.boards), ok: Number(r.ok),
      failed: Number(r.failed), inserted: Number(r.inserted), updated: Number(r.updated), closed: Number(r.closed), requests: Number(r.requests),
    };
  }

  private lastRunId(): number | null {
    const r = this.db.prepare('SELECT id FROM crawl_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined;
    return r ? Number(r.id) : null;
  }

  progress(): CrawlProgress {
    const last = this.lastRunId();
    return {
      running: this.running !== null,
      reason: this.running ? this.state.reason : null,
      boardsDone: this.running ? this.state.done : 0,
      boardsTotal: this.running ? this.state.total : 0,
      jobsSeen: this.running ? this.state.jobsSeen : 0,
      startedAt: this.running ? this.state.startedAt : null,
      nextScheduledAt: this.state.nextScheduledAt,
      lastRun: last === null ? null : this.summary(last),
    };
  }

  lastReport(): { run: CrawlRunSummary | null; boards: CrawlBoardReport[] } {
    const last = this.lastRunId();
    if (last === null) return { run: null, boards: [] };
    const rows = this.db.prepare('SELECT * FROM crawl_board_reports WHERE run_id = ? ORDER BY board_id').all(last) as Array<Record<string, unknown>>;
    return {
      run: this.summary(last),
      boards: rows.map((r) => ({
        boardId: String(r.board_id), status: String(r.status) as CrawlBoardReport['status'], reason: (r.reason as string | null) ?? null,
        listed: Number(r.listed), inserted: Number(r.inserted), updated: Number(r.updated), unchanged: Number(r.unchanged),
        skipped: Number(r.skipped), unreadable: Number(r.unreadable), closed: Number(r.closed), closeHeld: (r.close_held as string | null) ?? null,
        requests: Number(r.requests), finishedAt: String(r.finished_at),
      })),
    };
  }
}
