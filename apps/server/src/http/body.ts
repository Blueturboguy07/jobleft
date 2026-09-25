// Request bodies with hard limits (INTERFACES 6.1 rule 7): the declared length is checked before any byte is read,
// and a body that grows past the limit stops at once (413, nothing stored, the connection closes).

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

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = declaredLength(req);
  if (declared !== null && declared > limit) return Promise.reject(tooLarge(limit));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        settled = true;
        req.off('data', onData);
        req.pause();
        reject(tooLarge(limit));
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
