// The security gate (docs/INTERFACES.md section 6.1). Every request passes these checks, in this order, before a
// handler runs:
//   1. Host must be exactly 127.0.0.1:<port> or localhost:<port> (stops DNS rebinding).
//   2. Origin: none, the app's own origin, or chrome-extension://<id> on the extension routes. "null" never passes.
//   3. With no Origin, a browser's Sec-Fetch-Site of cross-site or same-site is refused for the API (image and
//      script tags from other pages).
//   4. No token in a URL query string.
//   5. The route's token: x-jobleft-token (launch) or x-jobleft-pairing (a paired extension, from its own Origin).
//   6. Writes carry application/json or a raw type the route lists (a cross-site form post is refused).

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;

export function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** Constant-time comparison of a presented token with a stored sha256 digest. */
export function tokenMatches(presented: string | undefined, digest: Buffer): boolean {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 512) return false;
  return timingSafeEqual(sha256(presented), digest);
}

export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

export function ownOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

export function extensionIdOf(origin: string | undefined): string | null {
  if (!origin) return null;
  const m = EXTENSION_ORIGIN.exec(origin);
  return m ? m[1]! : null;
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v.length === 1 ? v[0] : undefined; // a repeated security header is never trusted
  return v;
}

const TOKEN_QUERY_KEYS = new Set([
  'token', 'launchtoken', 'launch_token', 'x-jobleft-token', 'pairing', 'pairingtoken', 'pairing_token',
  'x-jobleft-pairing', 'access_token', 'auth', 'authorization', 'key', 'apikey', 'api_key',
]);

/** True when the query string tries to carry a token (refused: tokens never travel in a URL). */
export function queryCarriesToken(params: URLSearchParams, secrets: string[]): boolean {
  for (const [k, v] of params) {
    if (TOKEN_QUERY_KEYS.has(k.toLowerCase())) return true;
    for (const s of secrets) if (s && v.includes(s)) return true;
  }
  return false;
}

/** Sec-Fetch-Site values a browser sends for a request that another site started. */
export function crossSiteFetch(req: IncomingMessage): boolean {
  const s = headerValue(req, 'sec-fetch-site');
  return s === 'cross-site' || s === 'same-site';
}
