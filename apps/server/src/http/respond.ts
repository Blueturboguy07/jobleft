// Answers: JSON, errors, file downloads, server-sent events. Every answer carries the same safety headers and never
// an Access-Control-Allow-Origin (INTERFACES 6.1 rule 4), except the extension preflight answered in gate.ts.

import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiFailure, errorBody } from '../errors.ts';

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'x-permitted-cross-domain-policies': 'none',
  vary: 'Origin',
};

export function setSecurityHeaders(res: ServerResponse, api: boolean): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (api) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
  }
}

function closeIfUnread(req: IncomingMessage, res: ServerResponse): void {
  // A body we did not read (an early refusal) must not be read at all: close the connection after answering.
  if (!req.complete && !req.readableEnded) res.setHeader('connection', 'close');
}

export function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) { res.end(); return; }
  const text = JSON.stringify(body);
  closeIfUnread(req, res);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(text));
  res.end(text);
}

export function sendError(req: IncomingMessage, res: ServerResponse, e: ApiFailure): void {
  if (e.extra.retryAfterSeconds !== undefined) res.setHeader('retry-after', String(e.extra.retryAfterSeconds));
  sendJson(req, res, e.status, errorBody(e));
}

/** A file name safe for a content-disposition header (ASCII fallback plus the UTF-8 form). */
export function contentDisposition(fileName: string): string {
  const base = fileName.replace(/[\\/\r\n"]/g, '_').slice(0, 200) || 'download';
  const ascii = base.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

export interface FileBody {
  fileName: string;
  mimeType: string;
  bytes?: Uint8Array;
  /** A file on disk inside the data folder, streamed; `cleanup` runs when the answer ends (tmp files). */
  path?: string;
  size?: number;
  cleanup?: () => void;
}

export function sendFile(req: IncomingMessage, res: ServerResponse, f: FileBody): void {
  res.statusCode = 200;
  res.setHeader('content-type', f.mimeType);
  res.setHeader('content-disposition', contentDisposition(f.fileName));
  if (f.bytes) {
    res.setHeader('content-length', f.bytes.byteLength);
    res.end(Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength));
    f.cleanup?.();
    return;
  }
  if (!f.path) { res.end(); f.cleanup?.(); return; }
  if (f.size !== undefined) res.setHeader('content-length', f.size);
  const stream = createReadStream(f.path);
  let done = false;
  const finish = () => { if (done) return; done = true; f.cleanup?.(); };
  stream.on('error', () => { res.destroy(); finish(); });
  res.on('close', () => { stream.destroy(); finish(); });
  stream.pipe(res);
  void req;
}

/** Starts a text/event-stream answer. Returns a writer; each event is one `data:` line and a blank line. */
export function startSse(res: ServerResponse): (event: unknown) => boolean {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders();
  return (event: unknown) => {
    if (res.writableEnded || res.destroyed) return false;
    return res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}
