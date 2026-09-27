// Request bodies with hard limits (INTERFACES 6.1 rule 7): the declared length is checked before any byte is kept,
// and a body that grows past the limit is never stored (413, nothing stored). The rest of an oversized body is read
// and dropped before the answer (up to a cap), so a client still sending gets the plain 413 instead of a reset
// connection (JL-resume-26); a body far past the cap, or one that trickles, is cut off.

import { createWriteStream, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { ApiFailure } from '../errors.ts';

function tooLarge(limit: number): ApiFailure {
  const mb = limit >= 1_048_576 ? `${Math.round(limit / 1_048_576)} MB` : `${Math.round(limit / 1024)} KB`;
  return new ApiFailure('payload_too_large', `The request body is larger than the ${mb} this request allows. Nothing was stored.`);
}

function declaredLength(req: IncomingMessage): number | null {
  const h = req.headers['content-length'];
  if (h === undefined) return null;
  const n = Number(h);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** How much of an oversized body is read and dropped before the 413 (and for how long) so the client hears it. */
const DRAIN_BYTES = 64 * 1_048_576;
const DRAIN_MS = 15_000;

/** Reads and drops the rest of a body (nothing is kept), then calls done once: at its end, past the cap, or on time. */
function drain(req: IncomingMessage, done: () => void): void {
  let dropped = 0;
  let over = false;
  const finish = () => { if (over) return; over = true; clearTimeout(timer); req.off('data', drop); done(); };
  const drop = (c: Buffer) => { dropped += c.length; if (dropped > DRAIN_BYTES) finish(); };
  const timer = setTimeout(finish, DRAIN_MS);
  req.on('data', drop);
  req.once('end', finish);
  req.once('error', finish);
  req.once('aborted', finish);
  req.resume();
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = declaredLength(req);
  if (declared !== null && declared > limit) {
    if (declared > limit + DRAIN_BYTES || req.complete) return Promise.reject(tooLarge(limit));
    return new Promise((_, reject) => drain(req, () => reject(tooLarge(limit))));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        settled = true;
        req.off('data', onData);
        chunks.length = 0;
        drain(req, () => reject(tooLarge(limit)));
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks, size)); } });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    req.on('aborted', () => { if (!settled) { settled = true; reject(new ApiFailure('bad_request', 'The request was cut short.')); } });
  });
}

/** Streams a body to a file (restore uploads). The partial file is removed on any failure. */
export function bodyToFile(req: IncomingMessage, path: string, limit: number): Promise<number> {
  const declared = declaredLength(req);
  if (declared !== null && declared > limit) return Promise.reject(tooLarge(limit));
  return new Promise((resolve, reject) => {
    const out = createWriteStream(path, { mode: 0o600, flags: 'wx' });
    let size = 0;
    let settled = false;
    const failWith = (e: unknown) => {
      if (settled) return;
      settled = true;
      req.unpipe(out);
      req.pause();
      out.destroy();
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
      reject(e);
    };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) failWith(tooLarge(limit));
    });
    req.on('aborted', () => failWith(new ApiFailure('bad_request', 'The upload was cut short. Nothing was changed.')));
    req.on('error', failWith);
    out.on('error', failWith);
    out.on('finish', () => { if (!settled) { settled = true; resolve(size); } });
    req.pipe(out);
  });
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function wellFormed(v: unknown, depth = 0): boolean {
  if (typeof v === 'string') return v.isWellFormed();
  if (v === null || typeof v !== 'object') return true;
  if (depth > 200) return false;
  if (Array.isArray(v)) return v.every((x) => wellFormed(x, depth + 1));
  for (const [k, x] of Object.entries(v)) if (!k.isWellFormed() || !wellFormed(x, depth + 1)) return false;
  return true;
}

/**
 * A JSON body, read strictly (server O4 and O13: text is stored character for character, or refused). Bytes that are
 * not UTF-8 and a lone surrogate (such as "\ud800") are refused, instead of being saved as a replacement character.
 */
export function parseJsonBody(buf: Buffer): unknown {
  let text: string;
  try { text = UTF8.decode(buf); } catch { throw new ApiFailure('bad_request', 'The body is not UTF-8 text. Nothing was stored.'); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ApiFailure('bad_request', 'The body is not valid JSON.'); }
  if (!wellFormed(parsed)) throw new ApiFailure('bad_request', 'The body has a broken character (a lone UTF-16 surrogate). Nothing was stored.');
  return parsed;
}

/** The media type of a request, lower case, without parameters. */
export function mediaType(req: IncomingMessage): string | null {
  const h = req.headers['content-type'];
  if (!h) return null;
  return h.split(';')[0]!.trim().toLowerCase() || null;
}
