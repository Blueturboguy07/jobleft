// Outbound requests to the AI provider and publik the person chose (never anything else: INTERFACES section 9).
// Every request ends: the answer's headers must arrive within the connect limit, and a streamed body may be silent
// for at most the idle limit. JOBLEFT_OFFLINE=1 refuses every outbound request before it starts.

import { ApiFailure } from './errors.ts';

export const CONNECT_LIMIT_MS = 8_000;
export const IDLE_LIMIT_MS = 120_000;

export interface OutboundOptions {
  offline: boolean;
  signal?: AbortSignal;
  connectMs?: number;
}

export class OutboundError extends Error {
  readonly kind: 'offline' | 'unreachable' | 'timeout' | 'cancelled';
  constructor(kind: OutboundError['kind'], message: string) { super(message); this.name = 'OutboundError'; this.kind = kind; }
}

function describe(e: unknown): 'unreachable' | 'timeout' {
  const code = (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'timeout';
  return 'unreachable';
}

/** fetch with a connect limit and a caller signal. Resolves when the headers arrive. */
export async function outbound(url: string, init: RequestInit, opts: OutboundOptions): Promise<Response> {
  if (opts.offline) throw new OutboundError('offline', 'jobleft is set to work offline, so nothing was sent.');
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, opts.connectMs ?? CONNECT_LIMIT_MS);
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: ctl.signal, redirect: 'manual' });
  } catch (e) {
    if (opts.signal?.aborted) throw new OutboundError('cancelled', 'The request was cancelled.');
    if (timedOut) throw new OutboundError('timeout', 'did not answer in time');
    throw new OutboundError(describe(e), 'could not be reached');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Reads a streamed body line by line; each read must arrive within the idle limit. */
export async function* lines(res: Response, signal: AbortSignal | undefined, idleMs = IDLE_LIMIT_MS): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const aborted = new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(new OutboundError('cancelled', 'cancelled'));
    signal?.addEventListener('abort', () => reject(new OutboundError('cancelled', 'cancelled')), { once: true });
  });
  aborted.catch(() => { /* handled by the race below */ });
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const idle = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OutboundError('timeout', 'went silent')), idleMs); });
      idle.catch(() => { /* handled by the race below */ });
      let r: Awaited<ReturnType<typeof reader.read>>;
      try { r = await Promise.race([reader.read(), idle, aborted]); } finally { clearTimeout(timer); }
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        yield line;
      }
    }
    if (buf) yield buf;
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/** A plain ApiFailure for an outbound problem with a named service. */
export function outboundFailure(e: unknown, service: string): ApiFailure {
  if (e instanceof OutboundError) {
    if (e.kind === 'offline') return new ApiFailure('offline', `jobleft is set to work offline, so nothing was sent to ${service}.`);
    if (e.kind === 'timeout') return new ApiFailure('provider_timeout', `${service} did not answer within ${Math.round(CONNECT_LIMIT_MS / 1000)} seconds. Check that it is running and that this computer is online.`);
    if (e.kind === 'cancelled') return new ApiFailure('provider_error', 'The request was cancelled.');
    return new ApiFailure('offline', `${service} could not be reached. Check that it is running and that this computer is online.`);
  }
  return new ApiFailure('provider_error', `${service} failed.`);
}

export function isLoopbackUrl(u: URL): boolean {
  return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1';
}
