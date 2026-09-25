// One HTTP request to an AI provider, with the three limits every AI request has (ai-engine O4):
//   * connect: the TCP (and TLS) connection must open within connectTimeoutMs (10 s),
//   * silence: no byte for idleTimeoutMs (120 s), before or after the headers, ends the request,
//   * cancel: the caller's AbortSignal closes the socket at once, so the upstream sees the request stop.
// It never retries. It never follows redirects. It never logs.

import http from 'node:http';
import https from 'node:https';
import { AiError } from './errors.ts';

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** Silence limit: 110 s, so a silent provider ends well inside 2 minutes (ai-engine O4). */
export const DEFAULT_IDLE_TIMEOUT_MS = 110_000;
/** Largest non-streamed body read into memory. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface HttpRequest {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** The body as it arrives. Throws AiError on silence, cancel or a broken connection. */
  chunks(): AsyncIterable<Buffer>;
  /** Reads the whole body (at most MAX_BODY_BYTES). */
  text(): Promise<string>;
  /** Stops reading and closes the connection. */
  close(): void;
}

function silenceMessage(ms: number, gotHeaders: boolean): string {
  const s = Math.round(ms / 1000);
  return gotHeaders
    ? `The AI provider stopped sending data for ${s} seconds, so jobleft stopped waiting.`
    : `The AI provider took the request but sent nothing for ${s} seconds, so jobleft stopped waiting.`;
}

function networkError(err: NodeJS.ErrnoException, origin: string): AiError {
  const code = err.code ?? '';
  if (code === 'ECONNREFUSED') return new AiError('unreachable', `Nothing answers at ${origin}. Check that the AI server is running and that the address is right.`);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new AiError('unreachable', `The address ${origin} cannot be found. Check the address, or check that this computer is online.`);
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENETDOWN') return new AiError('unreachable', `This computer cannot reach ${origin}. Check the network connection.`);
  if (code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'EPROTO') {
    return new AiError('unreachable', `A secure connection to ${origin} failed. If this is a server on your network, use its http:// address or a valid certificate.`);
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') return new AiError('unreachable', `The AI server at ${origin} closed the connection before it answered.`);
  return new AiError('unreachable', `jobleft could not connect to ${origin}.`);
}

/** Sends one request. Resolves when the response headers arrive. Every failure is an AiError with a plain message. */
export function send(req: HttpRequest): Promise<HttpResponse> {
  const connectTimeoutMs = req.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = req.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  let url: URL;
  try { url = new URL(req.url); } catch { return Promise.reject(new AiError('bad_request', 'The AI server address is not valid.')); }
  const origin = url.origin;
  const mod = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
  if (!mod) return Promise.reject(new AiError('bad_request', 'The AI server address must start with http:// or https://.'));
  if (req.signal?.aborted) return Promise.reject(new AiError('cancelled', 'The request was cancelled.'));

  return new Promise<HttpResponse>((resolve, reject) => {
    let settled = false;
    let gotHeaders = false;
    let failure: AiError | null = null;
    let connectTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;

    const headers: Record<string, string> = { 'user-agent': 'jobleft/0.1', accept: '*/*', ...req.headers };
    if (req.body !== undefined) {
      headers['content-type'] ??= 'application/json';
      headers['content-length'] = String(Buffer.byteLength(req.body));
    }
    const cr = mod.request(url, { method: req.method, headers, agent: false });

    const clearTimers = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    };
    const fail = (err: AiError) => {
      if (!failure) failure = err;
      clearTimers();
      req.signal?.removeEventListener('abort', onAbort);
      cr.destroy(failure);
      if (!settled) { settled = true; reject(failure); }
    };
    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(new AiError('timeout', silenceMessage(idleTimeoutMs, gotHeaders))), idleTimeoutMs);
    };
    const onAbort = () => fail(new AiError('cancelled', 'The request was cancelled.'));
    req.signal?.addEventListener('abort', onAbort, { once: true });

    connectTimer = setTimeout(() => fail(new AiError('unreachable', `No connection to ${origin} within ${Math.round(connectTimeoutMs / 1000)} seconds. Check that the AI server is running and reachable.`)), connectTimeoutMs);
    cr.on('socket', (socket) => {
      const connected = () => {
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        touch();
      };
      if (!socket.connecting) connected();
      else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', connected);
    });
    cr.on('error', (err: NodeJS.ErrnoException) => {
      if (failure) { if (!settled) { settled = true; reject(failure); } return; }
      if (gotHeaders) fail(new AiError('provider_error', `The AI server at ${origin} closed the connection in the middle of the answer.`));
      else fail(networkError(err, origin));
    });
    cr.on('response', (res) => {
      gotHeaders = true;
      touch();
      const outHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        outHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
      }
      let consumed = false;
      const response: HttpResponse = {
        status: res.statusCode ?? 0,
        headers: outHeaders,
        chunks() {
          if (consumed) throw new Error('body already read');
          consumed = true;
          return (async function* () {
            try {
              for await (const chunk of res) {
                touch();
                yield chunk as Buffer;
              }
              if (failure) throw failure;
              if (!res.complete) throw new AiError('provider_error', `The AI server at ${origin} closed the connection in the middle of the answer.`);
            } catch (e) {
              if (failure) throw failure;
              if (e instanceof AiError) throw e;
              throw new AiError('provider_error', `The AI server at ${origin} closed the connection in the middle of the answer.`);
            } finally {
              clearTimers();
              req.signal?.removeEventListener('abort', onAbort);
              if (!res.complete) cr.destroy();
            }
          })();
        },
        async text() {
          const parts: Buffer[] = [];
          let size = 0;
          for await (const c of response.chunks()) {
            size += c.length;
            if (size > MAX_BODY_BYTES) { response.close(); throw new AiError('provider_error', 'The AI server sent an answer that is too large.'); }
            parts.push(c);
          }
          return Buffer.concat(parts).toString('utf8');
        },
        close() {
          clearTimers();
          req.signal?.removeEventListener('abort', onAbort);
          cr.destroy();
        },
      };
      settled = true;
      resolve(response);
    });
    if (req.body !== undefined) cr.end(req.body);
    else cr.end();
  });
}

/** Parses a server-sent-event stream into { event, data } records. */
export async function* sseEvents(chunks: AsyncIterable<Buffer>): AsyncGenerator<{ event: string | null; data: string }> {
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | null = null;
  let data: string[] = [];
  const flush = function* () {
    if (data.length) yield { event, data: data.join('\n') };
    event = null;
    data = [];
  };
  for await (const chunk of chunks) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') { yield* flush(); continue; }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
    }
  }
  buf += decoder.decode();
  if (buf.trim()) {
    const line = buf.replace(/\r$/, '');
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  yield* flush();
}

/** Parses newline-delimited JSON (Ollama). Lines that are not JSON are returned as { __bad: line }. */
export async function* ndjsonLines(chunks: AsyncIterable<Buffer>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buf = '';
  const parse = (line: string): unknown => {
    try { return JSON.parse(line); } catch { return { __bad: line.slice(0, 200) }; }
  };
  for await (const chunk of chunks) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield parse(line);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield parse(buf.trim());
}

/** True when a body looks like a web page and not an API answer. */
export function looksLikeHtml(contentType: string | undefined, body: string): boolean {
  if (contentType && /text\/html|application\/xhtml/i.test(contentType)) return true;
  const head = body.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head') || head.startsWith('<body') || (head.startsWith('<') && head.includes('<title'));
}

export function tryJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}
