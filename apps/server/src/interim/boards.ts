// INTERIM stand-in for @jobleft/boards BoardService and CrawlScheduler: the person's own boards (table srv_boards)
// and crawl runs (table srv_crawl_runs), driving the crawler core (@jobleft/crawler crawl(), Built).
// The crawl never blocks startup or reads (it runs after the server listens, in the background), closes a job only
// when the crawler proves the board was read in full (a failing or offline board closes nothing), and never touches
// the person's tracker rows. JOBLEFT_OFFLINE=1 or a failed network check refuses a run before any request.

import { lookup } from 'node:dns/promises';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AppSettings, BoardEntry, CrawlAtsId, CrawlBoardReport, CrawlProgress, CrawlRunSummary,
} from '@jobleft/contracts';
import { CRAWL_ATS_IDS, nowIso, nowMs } from '@jobleft/contracts';
import { HttpClient, Pacer, SOURCES, crawl, hostFor, type BoardRef, type BoardResult, type Store } from '@jobleft/crawler';
import { b, parseJson, tx } from '../db/util.ts';
import { ApiFailure } from '../errors.ts';
import type { Logger } from '../log.ts';
import { redact } from '../log.ts';

interface Row { id: string; ats: string; board: string; region: string | null; company: string; followed: number; hidden: number; disabled: number; added_at: string }
interface HealthRow { consecutive_failures: number; cooldown_until: string | null; last_attempt_at: string | null; last_success_at: string | null; last_error: string | null }

export function boardIdOf(ats: string, board: string, region?: string | null): string {
  return region ? `${ats}:${region}:${board}`.toLowerCase() : `${ats}:${board}`.toLowerCase();
}

export interface CrawlOptions {
  db: DatabaseSync;
  crawlStore: Store;
  hostMap: Record<string, string>;
  offline: () => boolean;
  settings: () => AppSettings;
  log: Logger;
  /** Called after a run that saved new jobs (saved-filter alerts). */
  afterRun?: (summary: CrawlRunSummary) => void;
}

export class BoardsService {
  private readonly o: CrawlOptions;
  private readonly pacer = new Pacer(1000);
  private readonly stopCtl = new AbortController();
  private runningP: Promise<void> | null = null;
  private progress: { reason: CrawlProgress['reason']; done: number; total: number; seen: number; startedAt: string } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(o: CrawlOptions) { this.o = o; }

  // ---------------------------------------------------------------- boards

  private health(ats: string, board: string): HealthRow | undefined {
    return this.o.db.prepare('SELECT consecutive_failures, cooldown_until, last_attempt_at, last_success_at, last_error FROM boards WHERE ats = ? AND board = ?').get(ats, board) as HealthRow | undefined;
  }

  private toEntry(r: Row): BoardEntry {
    const h = this.health(r.ats, r.board);
    const now = nowMs();
    let state: BoardEntry['state'] = 'not_checked';
    if (h?.cooldown_until && Date.parse(h.cooldown_until) > now) state = 'cooldown';
    else if (h && h.consecutive_failures > 0) state = 'failing';
    else if (h?.last_success_at) state = 'live';
    const open = h?.last_success_at
      ? Number((this.o.db.prepare('SELECT count(*) AS n FROM jobs WHERE ats = ? AND board = ? AND closed_at IS NULL').get(r.ats, r.board) as { n: number }).n)
      : null;
    const interval = this.o.settings().crawl.intervalHours * 3_600_000;
    return {
      id: r.id, ats: r.ats as CrawlAtsId, board: r.board, region: r.region, company: r.company, origin: 'user',
      followed: r.followed === 1, hidden: r.hidden === 1, disabled: r.disabled === 1, state,
      lastCheckAt: h?.last_attempt_at ?? null, lastSuccessAt: h?.last_success_at ?? null,
      nextCheckAt: r.disabled === 1 ? null : h?.last_attempt_at ? new Date(Date.parse(h.last_attempt_at) + interval).toISOString() : null,
      openJobs: open, lastError: h?.last_error ? redact(h.last_error) : null,
    };
  }

  list(q: { q?: string; view?: string; cursor?: string; limit?: number }): { items: BoardEntry[]; total: number; nextCursor: string | null } {
    let rows = this.o.db.prepare('SELECT * FROM srv_boards ORDER BY id').all() as unknown as Row[];
    if (q.q) { const n = q.q.toLowerCase(); rows = rows.filter((r) => r.board.includes(n) || r.company.toLowerCase().includes(n)); }
    let items = rows.map((r) => this.toEntry(r));
    const view = q.view ?? 'all';
    if (view === 'followed') items = items.filter((e) => e.followed);
    else if (view === 'hidden') items = items.filter((e) => e.hidden);
    else if (view === 'disabled') items = items.filter((e) => e.disabled);
    else if (view === 'failing') items = items.filter((e) => e.state === 'failing' || e.state === 'cooldown');
    const total = items.length;
    const start = q.cursor ? Math.max(0, Number.parseInt(q.cursor, 10) || 0) : 0;
    const limit = q.limit ?? 50;
    const page = items.slice(start, start + limit);
    return { items: page, total, nextCursor: start + limit < total ? String(start + limit) : null };
  }

  add(input: { ats: CrawlAtsId; board: string; region?: string }): BoardEntry {
    if (!(CRAWL_ATS_IDS as readonly string[]).includes(input.ats)) throw new ApiFailure('bad_request', 'That job board family is not supported.');
    if (!SOURCES[input.ats]) throw new ApiFailure('unsupported_source', `Boards on ${input.ats} are not crawled by this build yet (Greenhouse, Lever and Ashby are).`);
    const board = input.board.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(board)) throw new ApiFailure('bad_request', 'The board name may use letters, digits, dots, dashes and underscores only.');
    const region = input.ats === 'lever' && input.region === 'eu' ? 'eu' : null;
    const id = boardIdOf(input.ats, board, region);
    tx(this.o.db, () => {
      if (this.o.db.prepare('SELECT 1 FROM srv_boards WHERE id = ?').get(id)) throw new ApiFailure('conflict', 'That board is already in your list.');
      this.o.db.prepare('INSERT INTO srv_boards (id, ats, board, region, company, followed, hidden, disabled, added_at) VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?)')
        .run(id, input.ats, board, region, board, nowIso());
    });
    return this.get(id)!;
  }

  get(id: string): BoardEntry | null {
    const r = this.o.db.prepare('SELECT * FROM srv_boards WHERE id = ?').get(id.toLowerCase()) as Row | undefined;
    return r ? this.toEntry(r) : null;
  }

  update(id: string, patch: { followed?: boolean; hidden?: boolean; disabled?: boolean }): BoardEntry {
    tx(this.o.db, () => {
      const set: string[] = [];
      const args: number[] = [];
      if (patch.followed !== undefined) { set.push('followed = ?'); args.push(b(patch.followed)); }
      if (patch.hidden !== undefined) { set.push('hidden = ?'); args.push(b(patch.hidden)); }
      if (patch.disabled !== undefined) { set.push('disabled = ?'); args.push(b(patch.disabled)); }
      const exists = this.o.db.prepare('SELECT 1 FROM srv_boards WHERE id = ?').get(id.toLowerCase());
      if (!exists) throw new ApiFailure('not_found', 'That board is not in your list.');
      if (set.length) this.o.db.prepare(`UPDATE srv_boards SET ${set.join(', ')} WHERE id = ?`).run(...args, id.toLowerCase());
    });
    return this.get(id)!;
  }

  exportLines(): string[] {
    return (this.o.db.prepare('SELECT * FROM srv_boards ORDER BY id').all() as unknown as Row[]).map((r) => JSON.stringify(this.toEntry(r)));
  }

  count(): number { return Number((this.o.db.prepare('SELECT count(*) AS n FROM srv_boards').get() as { n: number }).n); }

  // ---------------------------------------------------------------- crawl

  private refs(ids?: string[]): BoardRef[] {
    let rows = this.o.db.prepare('SELECT * FROM srv_boards WHERE disabled = 0 AND hidden = 0 ORDER BY id').all() as unknown as Row[];
    if (ids?.length) {
      const want = new Set(ids.map((x) => x.toLowerCase()));
      rows = (this.o.db.prepare('SELECT * FROM srv_boards ORDER BY id').all() as unknown as Row[]).filter((r) => want.has(r.id));
    }
    return rows.map((r) => ({ ats: r.ats as CrawlAtsId, board: r.board, company: r.company, ...(r.region ? { region: r.region } : {}) }));
  }

  private lastRun(): { summary: CrawlRunSummary | null; boards: CrawlBoardReport[]; finishedAt: string | null } {
    const r = this.o.db.prepare('SELECT summary, boards, finished_at FROM srv_crawl_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get() as { summary: string; boards: string; finished_at: string } | undefined;
    return r ? { summary: parseJson<CrawlRunSummary | null>(r.summary, null), boards: parseJson<CrawlBoardReport[]>(r.boards, []), finishedAt: r.finished_at } : { summary: null, boards: [], finishedAt: null };
  }

  status(): CrawlProgress {
    const last = this.lastRun();
    const interval = this.o.settings().crawl.intervalHours * 3_600_000;
    const next = this.count() === 0 ? null : last.finishedAt ? new Date(Date.parse(last.finishedAt) + interval).toISOString() : null;
    const p = this.progress;
    return {
      running: p !== null, reason: p?.reason ?? null, boardsDone: p?.done ?? 0, boardsTotal: p?.total ?? 0, jobsSeen: p?.seen ?? 0,
      startedAt: p?.startedAt ?? null, nextScheduledAt: next, lastRun: last.summary,
    };
  }

  report(): { run: CrawlRunSummary | null; boards: CrawlBoardReport[] } {
    const last = this.lastRun();
    return { run: last.summary, boards: last.boards };
  }

  private async networkOk(refs: BoardRef[]): Promise<boolean> {
    const hosts = [...new Set(refs.map((r) => SOURCES[r.ats]?.host?.(r) ?? hostFor(r.ats, r.region)))];
    const real = hosts.filter((h) => !this.o.hostMap[h.toLowerCase()]);
    if (real.length === 0) return true; // every board goes to a loopback stand-in
    try {
      await Promise.race([lookup(real[0]!), new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), 3000))]);
      return true;
    } catch { return false; }
  }

  /** Starts a run in the background. Answers at once. */
  async runNow(boardIds: string[] | undefined, reason: NonNullable<CrawlProgress['reason']> = 'manual'): Promise<{ started: boolean; message: string; nextAllowedAt: string | null }> {
    if (this.o.offline()) throw new ApiFailure('offline', 'jobleft is set to work offline, so no refresh started. Your jobs are unchanged.');
    if (this.runningP) return { started: false, message: 'A refresh is already running.', nextAllowedAt: null };
    const refs = this.refs(boardIds);
    if (refs.length === 0) return { started: false, message: boardIds?.length ? 'None of those boards is in your list.' : 'There are no boards to refresh yet. Add a board first.', nextAllowedAt: null };
    if (!(await this.networkOk(refs))) throw new ApiFailure('offline', 'This computer seems to be offline (the job board address could not be found), so no refresh started. Your jobs are unchanged.');
    this.runningP = this.execute(refs, reason).finally(() => { this.runningP = null; this.progress = null; });
    return { started: true, message: `Refreshing ${refs.length} board${refs.length === 1 ? '' : 's'}. New jobs appear as each board finishes.`, nextAllowedAt: null };
  }

  private async execute(refs: BoardRef[], reason: NonNullable<CrawlProgress['reason']>): Promise<void> {
    const startedAt = nowIso();
    this.progress = { reason, done: 0, total: refs.length, seen: 0, startedAt };
    const runId = Number(tx(this.o.db, () => this.o.db.prepare('INSERT INTO srv_crawl_runs (reason, started_at) VALUES (?, ?)').run(reason, startedAt).lastInsertRowid));
    const stop = this.stopCtl.signal;
    const fetchImpl: typeof fetch = (input, init) => {
      if (stop.aborted) return Promise.reject(new Error('stopping'));
      const signals = [stop, ...(init?.signal ? [init.signal] : [])];
      return fetch(input, { ...init, signal: AbortSignal.any(signals) });
    };
    const http = new HttpClient({ pacer: this.pacer, hostMap: this.o.hostMap, fetchImpl, maxRequests: 5000 });
    const reports: CrawlBoardReport[] = [];
    try {
      const rep = await crawl(refs, {
        store: this.o.crawlStore, http, sources: SOURCES, now: () => nowMs(),
        onBoard: (r) => {
          if (this.progress) { this.progress.done++; this.progress.seen += r.listed; }
          reports.push(boardReport(r, nowIso()));
        },
      });
      if (this.stopped) return;
      // Closing happens in the sweep after every board: copy the final close counts into the report.
      const byId = new Map(rep.boards.map((r) => [boardIdOf(r.ats, r.board), r]));
      for (const x of reports) { const r = byId.get(x.boardId); if (r) { x.closed = r.closed; x.closeHeld = r.closeHeld; } }
      this.renameFromJobs(refs);
      const summary: CrawlRunSummary = {
        startedAt, finishedAt: nowIso(), boards: rep.boards.length,
        ok: rep.boards.filter((r) => r.status === 'ok').length, failed: rep.boards.filter((r) => r.status !== 'ok').length,
        inserted: rep.totals.inserted, updated: rep.totals.updated, closed: rep.totals.closed,
        requests: rep.boards.reduce((a, r) => a + r.requests, 0),
      };
      tx(this.o.db, () => { this.o.db.prepare('UPDATE srv_crawl_runs SET finished_at = ?, summary = ?, boards = ? WHERE id = ?').run(summary.finishedAt, JSON.stringify(summary), JSON.stringify(reports), runId); });
      this.o.log.info('crawl.done', { boards: summary.boards, ok: summary.ok, failed: summary.failed, inserted: summary.inserted, closed: summary.closed });
      if (summary.inserted > 0) { try { this.o.afterRun?.(summary); } catch (e) { this.o.log.warn('crawl.after_run_failed', { error: String(e) }); } }
    } catch (e) {
      if (!this.stopped) this.o.log.warn('crawl.failed', { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    }
  }

  /** A board's company name is the one its jobs state (never a guess): the most common one, once known. */
  private renameFromJobs(refs: BoardRef[]): void {
    tx(this.o.db, () => {
      for (const r of refs) {
        const top = this.o.db.prepare('SELECT company, count(*) AS n FROM jobs WHERE ats = ? AND board = ? GROUP BY company ORDER BY n DESC LIMIT 1').get(r.ats, r.board) as { company: string } | undefined;
        if (top?.company) this.o.db.prepare('UPDATE srv_boards SET company = ? WHERE id = ?').run(top.company, boardIdOf(r.ats, r.board, r.region));
      }
    });
  }

  /** The scheduler: a catch-up after launch (never before the server answers), then every intervalHours. */
  start(): void {
    const tick = () => {
      if (this.stopped || this.runningP || this.o.offline() || this.count() === 0) return;
      const s = this.o.settings();
      const last = this.lastRun().finishedAt;
      const due = !last || nowMs() - Date.parse(last) >= s.crawl.intervalHours * 3_600_000;
      if (!due) return;
      const reason = !last ? 'first_run' : 'schedule';
      this.runNow(undefined, reason).catch(() => { /* offline: try again next tick */ });
    };
    const catchUp = setTimeout(() => { if (this.o.settings().crawl.catchUpOnLaunch) tick(); }, 5000);
    catchUp.unref();
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
  }

  /** Stops the scheduler and any running crawl (its requests are aborted). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.stopCtl.abort();
    if (this.runningP) await Promise.race([this.runningP, new Promise((r) => setTimeout(r, 2000))]);
  }

  isRunning(): boolean { return this.runningP !== null; }
}

function boardReport(r: BoardResult, finishedAt: string): CrawlBoardReport {
  let status: CrawlBoardReport['status'] = r.status === 'host-skipped' ? 'host_skipped' : r.status;
  const err = r.error ?? '';
  if (status === 'failed' && /robots/i.test(err)) status = 'robots';
  else if (status === 'failed' && /no adapter/i.test(err)) status = 'no_adapter';
  else if (status === 'failed' && /never-crawl/i.test(err)) status = 'forbidden';
  return {
    boardId: boardIdOf(r.ats, r.board), status, reason: r.error ? redact(r.error) : null,
    listed: r.listed, inserted: r.stats.inserted, updated: r.stats.updated, unchanged: r.stats.unchanged,
    skipped: r.stats.skipped + r.stats.dupUrl, unreadable: r.stats.unreadable, closed: r.closed, closeHeld: r.closeHeld,
    requests: r.requests, finishedAt,
  };
}
