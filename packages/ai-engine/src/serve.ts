// A standalone dev server for this lane's routes, with the security rules of docs/INTERFACES.md section 6.1:
// loopback only, exact Host check, Origin check (only the app's own origin), launch token in a header (never in a
// URL), JSON-only writes (a plain form post answers 415 before any work), a 1 MiB body limit, no CORS at all.
// apps/server mounts the same handlers (routes.ts) for the real app; this server exists so the lane can be probed
// on its own.

import { timingSafeEqual, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { JSON_BODY_LIMIT, LAUNCH_TOKEN_HEADER, matchRoute } from '@jobleft/contracts';
import type { AiEngine } from './engine.ts';
import { createAiRouteHandlers, type AiRouteHandlers, type RouteResult } from './routes.ts';

export interface DevServer {
  port: number;
  origin: string;
  token: string;
  close(): Promise<void>;
}

const HANDLED = new Set(['health', 'getAiSettings', 'putAiSettings', 'setAiKey', 'deleteAiKey', 'checkAi', 'listModels', 'chat', 'cancelAi', 'getPublik', 'connectPublik', 'disconnectPublik', 'refreshPublik']);

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function err(res: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

export async function startDevServer(engine: AiEngine, opts: { port?: number; token?: string; version?: string } = {}): Promise<DevServer> {
  const token = opts.token ?? randomBytes(32).toString('base64url');
  const handlers: AiRouteHandlers = createAiRouteHandlers(engine);
  let port = 0;

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return err(res, 403, 'forbidden_host', 'This address is not allowed.');
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
        return err(res, 403, 'forbidden_origin', 'Requests from web pages are not allowed.');
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (req.method === 'OPTIONS') return err(res, 403, 'forbidden_origin', 'Requests from web pages are not allowed.');
      const match = matchRoute(req.method ?? 'GET', url.pathname);
      if (!match || !HANDLED.has(match.name)) return err(res, 404, 'not_found', 'There is no such route here.');
      if (match.name === 'health') return sendJson(res, 200, { app: 'jobleft', version: opts.version ?? '0.1.0', apiVersion: 1, extensionProtocol: 1 });
      for (const k of url.searchParams.keys()) {
        if (/token|key|auth|pairing/i.test(k)) return err(res, 401, 'unauthorized', 'A token in the address is refused. Send it in the header.');
      }
      const given = req.headers[LAUNCH_TOKEN_HEADER];
      if (typeof given !== 'string' || !sameToken(given, token)) return err(res, 401, 'unauthorized', 'Missing or wrong token.');
      let body: unknown = undefined;
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        const ct = (req.headers['content-type'] ?? '').toLowerCase();
        const len = Number(req.headers['content-length'] ?? '0');
        if (!/^application\/json(\s*;|$)/.test(ct) && !(len === 0 && !req.headers['transfer-encoding'] && ct === '')) {
          req.resume();
          return err(res, 415, 'unsupported_media_type', 'Send JSON (application/json).');
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > JSON_BODY_LIMIT) return err(res, 413, 'payload_too_large', 'The request is too large.');
          chunks.push(c as Buffer);
        }
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.trim()) {
          try { body = JSON.parse(text); } catch { return err(res, 400, 'bad_request', 'The body is not valid JSON.'); }
        } else body = {};
      }
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableFinished) controller.abort(); });
      const handler = handlers[match.name as keyof AiRouteHandlers];
      const result: RouteResult = await handler({ params: match.params, query: Object.fromEntries(url.searchParams), body, signal: controller.signal });
      if ('sse' in result) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        for await (const ev of result.sse) {
          if (res.destroyed) break;
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        }
        res.end();
        return;
      }
      sendJson(res, result.status, result.json);
    } catch {
      if (!res.headersSent) err(res, 500, 'internal', 'Something failed inside jobleft. Nothing was changed.');
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    token,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
