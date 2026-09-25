// One error shape for every answer (docs/INTERFACES.md section 6.2). A handler throws ApiFailure; anything else is a
// bug and answers `internal` with a plain message (the details go to the log, redacted, never to the caller).

import { ERROR_STATUS, type ErrorCode } from '@jobleft/contracts';

export interface FailureExtra {
  details?: unknown;
  retryAfterSeconds?: number;
  link?: { label: string; url: string };
}

export class ApiFailure extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly extra: FailureExtra;
  constructor(code: ErrorCode, message: string, extra: FailureExtra = {}) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.extra = extra;
  }
}

export function fail(code: ErrorCode, message: string, extra?: FailureExtra): never {
  throw new ApiFailure(code, message, extra);
}

export function notFound(what = 'That item'): never {
  throw new ApiFailure('not_found', `${what} does not exist.`);
}

/** A route whose logic belongs to a lane that has not landed in this build. */
export function notReady(feature: string): never {
  throw new ApiFailure('not_ready', `${feature} is not available in this build yet. Nothing was changed.`);
}

/** The body of an error answer. */
export function errorBody(e: ApiFailure): { error: Record<string, unknown> } {
  const error: Record<string, unknown> = { code: e.code, message: e.message };
  if (e.extra.details !== undefined) error.details = e.extra.details;
  if (e.extra.retryAfterSeconds !== undefined) error.retryAfterSeconds = e.extra.retryAfterSeconds;
  if (e.extra.link) error.link = e.extra.link;
  return { error };
}

// ---------------------------------------------------------------- storage failures (server O5)

const SQLITE_READONLY = 8;
const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_CANTOPEN = 14;

/** What kind of storage failure an error is, or null when it is not one. */
export function storageProblem(e: unknown): 'full' | 'read_only' | 'io' | 'corrupt' | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as { code?: unknown; errcode?: unknown };
  if (typeof o.errcode === 'number') {
    const primary = o.errcode & 0xff;
    if (primary === SQLITE_FULL) return 'full';
    if (primary === SQLITE_READONLY) return 'read_only';
    if (primary === SQLITE_IOERR || primary === SQLITE_CANTOPEN) return 'io';
    if (primary === SQLITE_CORRUPT) return 'corrupt';
  }
  if (o.code === 'ENOSPC' || o.code === 'EDQUOT') return 'full';
  if (o.code === 'EROFS' || o.code === 'EACCES' || o.code === 'EPERM') return 'read_only';
  if (o.code === 'EIO') return 'io';
  return null;
}

/** The plain answer for a save the disk refused. */
export function writeFailed(problem: 'full' | 'read_only' | 'io' | 'corrupt'): ApiFailure {
  const why = problem === 'full'
    ? 'the disk that holds the jobleft data folder is full'
    : problem === 'read_only'
      ? 'the jobleft data folder is read-only'
      : problem === 'corrupt'
        ? 'the jobleft database file is damaged'
        : 'the disk reported an error';
  return new ApiFailure('write_failed', `Nothing was saved because ${why}. Your earlier data is unchanged.`, { details: { reason: problem } });
}
