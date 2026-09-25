// Crawl health in plain words: per board and per ATS, from the crawler's run report and its store.
// Counts are jobs, never requests. A board that gave jobs before and now gives no readable job is flagged.

import type { AtsId } from '@jobleft/contracts';
import type { RunReport, Store } from '@jobleft/crawler';
import { atsName } from './detect.ts';
import { notCrawledReason } from './source-list.ts';

/** One short plain reason for a failed board, from the crawler's `${name}: ${message}` error text. */
export function plainReason(error: string | null | undefined): string | null {
  if (!error) return null;
  const e = error;
  const status = /HTTP (\d{3})/.exec(e)?.[1];
  if (/^no adapter for ATS/.test(e)) return `jobleft has no adapter for this ATS (${e.replace(/^no adapter for ATS /, '')}); nothing was sent`;
  if (/host tripped|HostTrippedError/.test(e)) return 'the host refused requests twice earlier in this run, so its boards wait for the next run';
  if (/cooldown/.test(e)) return 'the board failed several runs in a row and is resting (back-off); it will be tried again later';
  const ra = /^RetryAfterError: .*Retry-After asks for (\d+) s more on ([^)\s]+)/.exec(e);
  if (ra) return `the host ${ra[2]} asked jobleft to wait ${ra[1]} more seconds (Retry-After); the board waits for a later run and nothing was closed`;
  if (/^BlockedError/.test(e) && status === '429') return 'the host asked jobleft to slow down (HTTP 429); the board waits for a later run and nothing was closed';
  if (/^BlockedError/.test(e)) return `the host refused access (HTTP ${status ?? '403'}); nothing was closed`;
  if (/^NotFoundError/.test(e)) return `the board was not found (HTTP ${status ?? '404'}): the board name may be wrong, or the employer left this ATS`;
  if (/redirect not followed/.test(e)) return `the board answered with a redirect (HTTP ${status ?? '3xx'}); jobleft does not follow redirects, so nothing was read`;
  if (/body too large/.test(e)) return 'the answer was larger than the size limit, so it was not read';
  if (/invalid JSON/.test(e)) {
    if (/Unexpected end of JSON input|Unexpected end/i.test(e)) return 'the answer was empty or cut off, not a job list';
    if (/Unexpected token '<'|<!doctype|<html/i.test(e)) return 'the answer was a web page (HTML), not the JSON job list';
    return 'the answer was not valid JSON, so nothing was read';
  }
  if (/^HttpError/.test(e) && status && Number(status) >= 500) return `the board's server failed (HTTP ${status}) after retries`;
  if (/^HttpError/.test(e) && status) return `the board answered HTTP ${status}, so nothing was read`;
  if (/TimeoutError|timed out|timeout/i.test(e)) return 'the board did not answer in time (20 seconds per try, 3 tries)';
  if (/AbortError/.test(e)) return 'the request was stopped before the board answered';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket/i.test(e)) return 'the host could not be reached';
  if (/^RobotsError/.test(e)) return "the host's robots.txt disallows this feed, so nothing was requested";
  if (/^DeniedHostError/.test(e)) return "this host is on jobleft's never-contact list; nothing was sent";
  if (/^BudgetError/.test(e)) return "the run's request budget ran out before this board";
  const m = /^(FeedFormatError|PagingError|BoardTokenError|SourceChangedError): (.*)$/s.exec(e);
  if (m) return m[2];
  return e.replace(/^[A-Za-z]*Error: /, '');
}

export interface BoardHealth {
  /** "<ats>:<board>" in lower case (the region is shown separately). */
  boardId: string;
  ats: string;
  board: string;
  company: string;
  status: string;
  /** Plain reason for anything but ok. */
  reason: string | null;
  /** A warning on a board that answered but looks wrong (for example it gave jobs before and now gives none). */
  flag: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  /** Postings the board listed in this run. */
  listed: number;
  /** Postings read and stored (new + updated + unchanged). */
  read: number;
  new: number;
  updated: number;
  unchanged: number;
  unreadable: number;
  skipped: number;
  closed: number;
  closeHeld: string | null;
  /** Open jobs of this board in the store after the run. */
  openJobs: number;
}

export interface AtsHealth {
  ats: string;
  boards: number;
  ok: number;
  failed: number;
  flagged: number;
  listed: number;
  read: number;
  new: number;
  closed: number;
  openJobs: number;
}

export interface HealthReport {
  startedAt: string;
  finishedAt: string;
  boards: BoardHealth[];
  byAts: AtsHealth[];
  totals: Omit<AtsHealth, 'ats'>;
}

/** Per-board and per-ATS health of one crawl run, with counts read back from the store. */
export function buildHealthReport(run: RunReport, store: Store): HealthReport {
  const openStmt = store.db.prepare('SELECT count(*) AS n FROM jobs WHERE ats = ? AND board = ? AND closed_at IS NULL');
  const boards: BoardHealth[] = run.boards.map((r) => {
    const row = store.getBoard(r.ats, r.board);
    const openJobs = Number((openStmt.get(r.ats, r.board) as { n: number }).n);
    const read = r.stats.ingested;
    let flag: string | null = null;
    if (r.status === 'ok') {
      if (r.listed > 0 && read === 0) flag = `the board listed ${r.listed} postings but none could be read (possible format change); nothing was closed`;
      else if (r.stats.unreadable > 0) flag = `${r.stats.unreadable} of ${r.listed} postings could not be read`;
      else if (r.listed === 0 && openJobs > 0) flag = `the board answered with 0 jobs but ${openJobs} jobs from earlier runs are still open (kept until the board stays empty for 3 runs and 7 days)`;
    } else if (/FeedFormatError/.test(r.error ?? '')) {
      flag = 'the board answered in a format jobleft cannot read (possible format change)';
    }
    return {
      boardId: `${r.ats}:${r.board}`.toLowerCase(),
      ats: r.ats,
      board: r.board,
      company: r.company,
      status: r.status,
      reason: r.status === 'ok' ? null : /^no adapter for ATS/.test(r.error ?? '')
        ? `jobleft does not crawl ${atsName(r.ats)}${notCrawledReason(r.ats as AtsId) ? `: ${notCrawledReason(r.ats as AtsId)}` : ''} Nothing was sent.`
        : plainReason(r.error),
      flag,
      lastCheckedAt: row?.last_attempt_at ?? null,
      lastSuccessAt: row?.last_success_at ?? null,
      listed: r.listed,
      read,
      new: r.stats.inserted,
      updated: r.stats.updated,
      unchanged: r.stats.unchanged,
      unreadable: r.stats.unreadable,
      skipped: r.stats.skipped,
      closed: r.closed,
      closeHeld: r.closeHeld,
      openJobs,
    };
  }).sort((a, b) => (a.boardId < b.boardId ? -1 : a.boardId > b.boardId ? 1 : 0));

  const per = new Map<string, AtsHealth>();
  const zero = (ats: string): AtsHealth => ({ ats, boards: 0, ok: 0, failed: 0, flagged: 0, listed: 0, read: 0, new: 0, closed: 0, openJobs: 0 });
  for (const b of boards) {
    const a = per.get(b.ats) ?? zero(b.ats);
    a.boards++;
    if (b.status === 'ok') a.ok++; else a.failed++;
    if (b.flag) a.flagged++;
    a.listed += b.listed; a.read += b.read; a.new += b.new; a.closed += b.closed; a.openJobs += b.openJobs;
    per.set(b.ats, a);
  }
  const byAts = [...per.values()].sort((a, b) => (a.ats < b.ats ? -1 : 1));
  const t = zero('');
  for (const a of byAts) {
    t.boards += a.boards; t.ok += a.ok; t.failed += a.failed; t.flagged += a.flagged; t.listed += a.listed;
    t.read += a.read; t.new += a.new; t.closed += a.closed; t.openJobs += a.openJobs;
  }
  const { ats: _ignored, ...totals } = t;
  return { startedAt: run.startedAt, finishedAt: run.finishedAt, boards, byAts, totals };
}
