// The mock crawl (the real one is @jobleft/crawler + @jobleft/boards). It reads each stand-in employer board over
// HTTP (so a stopped board server looks like a site that is down), upserts postings, and closes a job only when it
// vanished from a board that answered in full. A failed board never closes its jobs. A board that suddenly lists
// nothing, or loses more than half its jobs at once, has its closes held.

import type { CrawlBoardReport, CrawlProgress, CrawlRunSummary, JobSearchRequest, Notification } from '@jobleft/contracts';
import type { BoardFile, RawPosting } from './fixtures.ts';
import { boardsOrigin, toJob } from './jobs.ts';
import type { MockState } from './state.ts';
import { buildMatcher } from './search.ts';
import { isOffline } from './ai-client.ts';
import { newId, sleep } from './util.ts';

export interface CrawlOptions {
  delayMs: number;
  now: () => number;
  onChange: () => void;
}

export class Crawler {
  private state: MockState;
  private opts: CrawlOptions;
  progress: CrawlProgress = { running: false, reason: null, boardsDone: 0, boardsTotal: 0, jobsSeen: 0, startedAt: null, nextScheduledAt: null, lastRun: null };
  private timer: NodeJS.Timeout | null = null;

  constructor(state: MockState, opts: CrawlOptions) {
    this.state = state;
    this.opts = opts;
    this.progress.lastRun = state.data.crawlRuns.at(-1) ?? null;
  }

  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const hours = this.state.data.settings.crawl.intervalHours;
    const next = this.opts.now() + hours * 3_600_000;
    this.progress.nextScheduledAt = new Date(next).toISOString();
    this.timer = setTimeout(() => { void this.run('schedule'); }, Math.min(hours * 3_600_000, 2_147_000_000));
    this.timer.unref();
  }

  runNow(boardIds?: string[]): { started: boolean; message: string; nextAllowedAt: string | null } {
    if (this.progress.running) return { started: false, message: 'A refresh is already running. New jobs appear as each board finishes.', nextAllowedAt: null };
    if (isOffline(this.state)) return { started: false, message: 'This computer is offline, so jobleft cannot read job boards now. Your saved jobs still work.', nextAllowedAt: null };
    void this.run('manual', boardIds);
    return { started: true, message: 'Refresh started. New jobs appear as each board finishes.', nextAllowedAt: null };
  }

  async run(reason: NonNullable<CrawlProgress['reason']>, only?: string[]): Promise<void> {
    if (this.progress.running) return;
    const prefs = this.state.data.boardPrefs;
    const boards = this.state.boardFiles().filter((b) => !prefs[b.id]?.disabled && !prefs[b.id]?.hidden && (!only || only.includes(b.id)));
    const started = this.opts.now();
    this.progress = { ...this.progress, running: true, reason, boardsDone: 0, boardsTotal: boards.length, jobsSeen: 0, startedAt: new Date(started).toISOString() };
    this.opts.onChange();
    const reports: CrawlBoardReport[] = [];
    const before = new Set([...this.state.jobs.values()].filter((r) => r.job.status === 'open').map((r) => r.job.id));
    const newIds: string[] = [];
    let requests = 0;
    for (const b of boards) {
      if (this.opts.delayMs) await sleep(this.opts.delayMs);
      const r = await this.crawlBoard(b, newIds);
      requests += r.requests;
      reports.push(r);
      this.progress.boardsDone++;
      this.progress.jobsSeen += r.listed;
      if (this.progress.boardsDone % 10 === 0) this.safeSaveJobs();
      this.opts.onChange();
    }
    this.safeSaveJobs();
    const finished = this.opts.now();
    const summary: CrawlRunSummary = {
      startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(), boards: boards.length,
      ok: reports.filter((r) => r.status === 'ok').length, failed: reports.filter((r) => r.status !== 'ok').length,
      inserted: reports.reduce((s, r) => s + r.inserted, 0), updated: reports.reduce((s, r) => s + r.updated, 0),
      closed: reports.reduce((s, r) => s + r.closed, 0), requests,
    };
    try {
      this.state.mutate('crawlRuns', 'the refresh history', (d) => { d.push(summary); while (d.length > 30) d.shift(); });
      this.state.set('lastReport', 'the refresh report', reports);
      this.notifyNew(newIds.filter((id) => !before.has(id)), finished);
    } catch { /* the report is shown from memory; the jobs are already saved */ }
    this.progress = { ...this.progress, running: false, reason: null, lastRun: summary };
    this.schedule();
    this.opts.onChange();
  }

  private safeSaveJobs(): void {
    try { this.state.saveJobs(); } catch { /* reported on the next write the person makes */ }
  }

  private async crawlBoard(b: BoardFile, newIds: string[]): Promise<CrawlBoardReport> {
    const now = new Date(this.opts.now()).toISOString();
    const rep: CrawlBoardReport = { boardId: b.id, status: 'ok', reason: null, listed: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0, unreadable: 0, closed: 0, closeHeld: null, requests: 1, finishedAt: now };
    const status = this.state.data.boardStatus[b.id] ?? { state: 'not_checked', lastCheckAt: null, lastSuccessAt: null, openJobs: null, lastError: null };
    let postings: RawPosting[];
    try {
      const res = await fetch(`${boardsOrigin()}/api/boards/${encodeURIComponent(b.id)}`, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'jobleft-build/0.1 (research build; no personal data)' } });
      if (!res.ok) throw new Error(res.status === 503 ? 'The employer site answered "service unavailable".' : `The employer site answered with an error (${res.status}).`);
      const body = await res.json() as { postings?: unknown };
      if (!Array.isArray(body.postings)) throw new Error('The board answered with something that is not a job list.');
      postings = body.postings as RawPosting[];
    } catch (err) {
      const msg = (err as Error).name === 'TimeoutError' ? 'The employer site did not answer in time.' : (err as Error).message.startsWith('The ') ? (err as Error).message : 'The employer site did not answer.';
      rep.status = 'failed';
      rep.reason = `${msg} Its jobs stay open until a later refresh reads the board.`;
      this.saveStatus(b.id, { ...status, state: 'failing', lastCheckAt: now, lastError: msg });
      return rep;
    }
    const seenIds = new Set<string>();
    for (const p of postings) {
      if (!p || typeof p !== 'object' || typeof p.title !== 'string' || !p.title.trim() || typeof p.externalId !== 'string' || typeof p.description !== 'string') { rep.unreadable++; continue; }
      const id = `${b.ats}:${b.board}:${p.externalId}`.toLowerCase();
      if (seenIds.has(id)) { rep.skipped++; continue; }
      seenIds.add(id);
      rep.listed++;
      const old = this.state.jobs.get(id);
      let job;
      try {
        job = toJob(b, p, { firstSeenAt: old?.job.firstSeenAt ?? now, lastSeenAt: now });
      } catch { rep.unreadable++; continue; }
      if (!old) { rep.inserted++; newIds.push(id); }
      else if (old.job.contentHash === job.contentHash && old.job.status === 'open') { rep.unchanged++; job = { ...old.job, lastSeenAt: now, sources: old.job.sources.map((s) => ({ ...s, lastSeenAt: now })) }; }
      else { rep.updated++; if (old.job.status === 'closed') newIds.push(id); }
      this.state.putJob(job, b.id);
    }
    // close vanished jobs, with guards
    const openHere = [...this.state.jobs.values()].filter((r) => r.boardId === b.id && r.job.status === 'open');
    const vanished = openHere.filter((r) => !seenIds.has(r.job.id));
    if (vanished.length) {
      if (rep.listed === 0) rep.closeHeld = `The board listed no jobs this time. jobleft keeps its ${vanished.length} jobs open until an empty list repeats.`;
      else if (openHere.length >= 10 && vanished.length / openHere.length > 0.5) rep.closeHeld = `More than half of this board's jobs vanished at once (${vanished.length} of ${openHere.length}). The closes are held until the next refresh confirms them.`;
      else {
        for (const r of vanished) {
          this.state.putJob({ ...r.job, status: 'closed', closedAt: now, closedReason: 'unseen', updatedAt: now }, b.id);
          rep.closed++;
        }
      }
    }
    this.saveStatus(b.id, { state: 'live', lastCheckAt: now, lastSuccessAt: now, openJobs: rep.listed, lastError: null });
    return rep;
  }

  private saveStatus(id: string, s: MockState['data']['boardStatus'][string]): void {
    try { this.state.mutate('boardStatus', 'board status', (d) => { d[id] = s; }); } catch { this.state.data.boardStatus[id] = s; }
  }

  private notifyNew(newIds: string[], now: number): void {
    if (!newIds.length || !this.state.data.settings.notifications.alerts) return;
    const list: Notification[] = [];
    const created = new Date(now).toISOString();
    const recs = newIds.map((id) => this.state.jobs.get(id)!).filter((r) => r && r.job.status === 'open');
    if (!recs.length) return;
    list.push({ id: newId('n'), kind: 'new_matches', title: `${recs.length} new ${recs.length === 1 ? 'job' : 'jobs'} from your refresh`, body: `The last refresh found ${recs.length} new ${recs.length === 1 ? 'job' : 'jobs'} on the boards you follow.`, target: '/jobs', createdAt: created });
    for (const f of this.state.data.filters) {
      if (!f.alert.enabled) continue;
      const req: JobSearchRequest = { sort: f.sort, filter: f.filter };
      const m = buildMatcher(this.state, req.filter ?? {}, undefined, now);
      const n = recs.filter(m).length;
      if (n) list.push({ id: newId('n'), kind: 'saved_filter_alert', title: `${n} new ${n === 1 ? 'job' : 'jobs'} for "${f.name}"`.slice(0, 120), body: `Your saved filter "${f.name}" has ${n} new ${n === 1 ? 'job' : 'jobs'} after the last refresh.`.slice(0, 400), target: `/jobs?filter=${f.id}`, createdAt: created });
    }
    try { this.state.mutate('notifications', 'notifications', (d) => { d.push(...list); }); } catch { /* best effort */ }
  }
}
