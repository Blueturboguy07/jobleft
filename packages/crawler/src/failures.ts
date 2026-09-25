// Every way a board can fail, in plain words. The crawl report and `jobleft-crawl status` show these sentences.

import {
  AbortedError, BlockedError, BudgetError, CutOffError, DeniedHostError, HeldBackHostError, HostMapError, HostTrippedError,
  HostWaitError, HttpError, NetworkError, NotFoundError, NotJobDataError, NotModifiedError, PrivateAddressError, RedirectError,
  RequestTimeoutError, RobotsError, TooLargeError,
} from './http.ts';
import { forbiddenReason } from './hosts.ts';

/** How a board's crawl ended. The first five are the S1 values; the rest were added by the crawler lane. */
export type BoardStatus = 'ok' | 'failed' | 'cooled' | 'blocked' | 'host-skipped' | 'deferred' | 'robots' | 'forbidden';

/** A machine code for each reason (stable; the report and the tests use them). */
export type ReasonCode =
  | 'ok' | 'not_modified' | 'empty' | 'server_error' | 'timeout' | 'cut_off' | 'not_job_data' | 'broken_reply'
  | 'not_found' | 'blocked' | 'rate_limited' | 'host_wait' | 'host_skipped' | 'robots' | 'robots_unreadable'
  | 'forbidden_host' | 'held_back_host' | 'private_address' | 'redirect' | 'too_large' | 'too_many_jobs' | 'network'
  | 'budget' | 'stopped' | 'deadline' | 'no_adapter' | 'bad_origin' | 'cooldown' | 'http_error' | 'error';

export interface Failure {
  status: BoardStatus;
  code: ReasonCode;
  /** One plain sentence. */
  message: string;
  /** True when the failure says nothing bad about the board itself (it must not push the board towards back-off). */
  blameless: boolean;
  /** Extra back-off the board gets at once (403: the host refused us). */
  cooldownMs?: number;
}

/** The board took longer than its deadline. */
export class BoardDeadlineError extends Error {
  constructor(ms: number) { super(`the board took longer than ${Math.round(ms / 1000)} s`); this.name = 'BoardDeadlineError'; }
}
/** The board lists more postings than a board may have. */
export class TooManyJobsError extends Error {
  listed: number;
  limit: number;
  constructor(listed: number, limit: number) {
    super(`the board lists ${listed} postings, more than the ${limit} a board may have; nothing was stored`);
    this.name = 'TooManyJobsError';
    this.listed = listed;
    this.limit = limit;
  }
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

const HOUR = 3600 * 1000;

export function describeFailure(e: unknown): Failure {
  if (e instanceof NotModifiedError) return { status: 'ok', code: 'not_modified', message: 'unchanged since the last reading (HTTP 304)', blameless: true };
  if (e instanceof HeldBackHostError) {
    return { status: 'forbidden', code: 'held_back_host', message: e.forbidden ? forbiddenReason(e.forbidden) : e.message, blameless: true };
  }
  if (e instanceof DeniedHostError) {
    return { status: 'forbidden', code: 'forbidden_host', message: e.forbidden ? forbiddenReason(e.forbidden) : e.message, blameless: true };
  }
  if (e instanceof PrivateAddressError) return { status: 'forbidden', code: 'private_address', message: e.message, blameless: true };
  if (e instanceof HostMapError) return { status: 'forbidden', code: 'bad_origin', message: e.message, blameless: true };
  if (e instanceof RobotsError) {
    return e.disallowed
      ? { status: 'robots', code: 'robots', message: `the host's robots.txt does not allow this address (${e.message.replace(/^robots\.txt: /, '')})`, blameless: true }
      : { status: 'robots', code: 'robots_unreadable', message: `${e.message.replace(/^robots\.txt: /, '').replace(/ for https?:\/\/\S+$/, '')}; jobleft does not crawl a host whose robots.txt it cannot read`, blameless: true };
  }
  if (e instanceof HostWaitError) {
    return { status: 'deferred', code: 'host_wait', message: `the host asked jobleft to wait until ${new Date(e.untilMs).toISOString()}; the board waits for a later run`, blameless: true };
  }
  if (e instanceof HostTrippedError) return { status: 'host-skipped', code: 'host_skipped', message: 'the host refused two requests in a row earlier in this run; its other boards wait for a later run', blameless: true };
  if (e instanceof BudgetError) return { status: 'deferred', code: 'budget', message: `the request budget of this run is used up (${e.message}); the board waits for the next run`, blameless: true };
  if (e instanceof AbortedError) return { status: 'deferred', code: 'stopped', message: 'the run stopped before this board finished; it resumes next time', blameless: true };
  if (e instanceof BoardDeadlineError) return { status: 'failed', code: 'deadline', message: e.message, blameless: false };
  if (e instanceof TooManyJobsError) return { status: 'failed', code: 'too_many_jobs', message: e.message, blameless: false };
  if (e instanceof RedirectError) {
    const where = e.targetHost ?? 'an address it did not name';
    let msg = `the board answered with a redirect (HTTP ${e.status}) to ${where}; jobleft does not follow redirects`;
    if (e.forbidden) msg += ` (${forbiddenReason(e.forbidden)})`;
    else if (e.privateTarget) msg += ' (the target is on this computer or the local network)';
    return { status: 'failed', code: 'redirect', message: msg, blameless: false };
  }
  if (e instanceof BlockedError) {
    return e.status === 429
      ? { status: 'blocked', code: 'rate_limited', message: 'the host answered "too many requests" (HTTP 429); jobleft backs off', blameless: false, cooldownMs: HOUR }
      : { status: 'blocked', code: 'blocked', message: `the host refused access (HTTP ${e.status}); jobleft backs off and never retries with another identity`, blameless: false, cooldownMs: 6 * HOUR };
  }
  if (e instanceof NotFoundError) return { status: 'failed', code: 'not_found', message: `the board was not found (HTTP ${e.status}); its jobs stay as they were`, blameless: false };
  if (e instanceof TooLargeError) return { status: 'failed', code: 'too_large', message: `the reply is larger than ${Math.round(e.limit / 1048576)} MB; it was not read`, blameless: false };
  if (e instanceof NotJobDataError) {
    const code = e.kind === 'cut_off' ? 'cut_off' : e.kind === 'broken' ? 'broken_reply' : 'not_job_data';
    const what = e.kind === 'web_page' ? 'the board answered with a web page, not job data'
      : e.kind === 'cut_off' ? 'the reply was cut off before the end of the job data'
      : e.kind === 'broken' ? 'the reply is not valid job data (broken JSON)'
      : `the reply is not the job data this board type sends (${e.message.replace(/^.*?: /, '')})`;
    return { status: 'failed', code, message: `${what}; its jobs stay as they were`, blameless: false };
  }
  if (e instanceof RequestTimeoutError) return { status: 'failed', code: 'timeout', message: `${e.message.replace(/ from https?:\/\/\S+$/, '')} (timed out); its jobs stay as they were`, blameless: false };
  if (e instanceof CutOffError) return { status: 'failed', code: 'cut_off', message: `the connection closed before the whole reply arrived (cut off); its jobs stay as they were`, blameless: false };
  if (e instanceof NetworkError) {
    const what = e.code === 'ECONNREFUSED' ? 'the connection was refused'
      : e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' ? 'the host name does not resolve'
      : e.code === 'ECONNRESET' ? 'the connection was reset'
      : `the host could not be reached (${e.code})`;
    return { status: 'failed', code: 'network', message: `${what} (${hostOf(e.url)}); its jobs stay as they were`, blameless: false };
  }
  if (e instanceof HttpError) {
    if (e.status >= 500) return { status: 'failed', code: 'server_error', message: `the board answered with a server error (HTTP ${e.status}); its jobs stay as they were`, blameless: false };
    return { status: 'failed', code: 'http_error', message: `the board answered HTTP ${e.status}; its jobs stay as they were`, blameless: false };
  }
  const m = e instanceof Error ? e.message : String(e);
  return { status: 'failed', code: 'error', message: m, blameless: false };
}
