// The default transport: node:http and node:https, not the built-in fetch. Two reasons:
//   1. exact headers: fetch adds headers of its own (sec-fetch-mode, accept-language) that look like a browser; here a
//      request carries only host, connection, user-agent, accept, accept-encoding and the conditional headers;
//   2. the address check happens when the connection is made (a custom DNS lookup), so a name that resolves to this
//      computer or the local network is refused at the moment of connecting, not only before it.
// It returns a web Response so the client code is the same for this transport and for a test's fake fetch.

import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { isPrivateAddress } from './hosts.ts';

const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 6 });
const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 6 });

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A DNS lookup that refuses local and private addresses (unless `allowLocal`). */
function guardedLookup(allowLocal: boolean) {
  return (hostname: string, options: { all?: boolean; family?: number }, cb: LookupCb): void => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, '');
      const list = addresses as LookupAddress[];
      if (!allowLocal) {
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) {
          const e = new Error(`${hostname} resolves to the local address ${bad.address}`) as NodeJS.ErrnoException;
          e.code = 'EPRIVATEADDRESS';
          return cb(e, '');
        }
      }
      if (options.all) return cb(null, list);
      const first = list[0];
      if (!first) { const e = new Error(`${hostname} has no address`) as NodeJS.ErrnoException; e.code = 'ENOTFOUND'; return cb(e, ''); }
      cb(null, first.address, first.family);
    });
  };
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function decoded(res: IncomingMessage): Readable {
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(createGunzip());
  if (enc === 'br') return res.pipe(createBrotliDecompress());
  if (enc === 'deflate') return res.pipe(createInflate());
  return res;
}

export interface TransportOptions {
  /** Allow connections to this computer (loopback mock servers named by a host map or a board origin). */
  allowLocal?: (url: URL) => boolean;
}

/** A fetch-compatible GET over node:http(s). Only GET is supported; redirects are never followed. */
export function nodeTransport(opts: TransportOptions = {}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    if (!headers['accept-encoding']) headers['accept-encoding'] = 'gzip, deflate, br';
    const allowLocal = opts.allowLocal?.(url) ?? false;
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'GET',
        headers,
        agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
        lookup: guardedLookup(allowLocal) as never,
        signal,
      }, (res) => {
        const status = res.statusCode ?? 0;
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          if (Array.isArray(v)) for (const x of v) h.append(k, x); else h.set(k, String(v));
        }
        // The body is decompressed here, so the content-length of the wire no longer applies.
        if (h.has('content-encoding')) { h.delete('content-length'); }
        if (NULL_BODY.has(status) || status < 200) {
          res.resume();
          resolve(new Response(null, { status: status < 200 ? 502 : status, headers: h }));
          return;
        }
        const body = Readable.toWeb(decoded(res)) as unknown as ReadableStream<Uint8Array>;
        resolve(new Response(body, { status: status >= 200 && status <= 599 ? status : 502, headers: h }));
      });
      req.on('error', reject);
      req.end();
    });
  }) as typeof fetch;
}
