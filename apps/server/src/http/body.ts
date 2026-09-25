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

/** The media type of a request, lower case, without parameters. */
export function mediaType(req: IncomingMessage): string | null {
  const h = req.headers['content-type'];
  if (!h) return null;
  return h.split(';')[0]!.trim().toLowerCase() || null;
}
