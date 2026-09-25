// A small development server for the board routes of the local API (docs/INTERFACES.md section 6), so the boards
// lane can be driven over HTTP before apps/server wires it: list, resolve, add, update, export, crawl status, run
// and report. It keeps the local API's security rules: loopback only, Host check, Origin refused, the launch token
// in x-jobleft-token (never in the URL), JSON bodies only, a 1 MiB body limit, and every body checked against its
// contract before any work. The real app serves these routes from apps/server with the same BoardService.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ERROR_STATUS, JSON_BODY_LIMIT, LAUNCH_TOKEN_HEADER, LOCAL_API, matchRoute, validate } from '@jobleft/contracts';
import type { JsonSchema } from '@jobleft/contracts';
import type { BoardsApp } from './app.ts';
import { BoardError, type ListView } from './service.ts';
import { liveBoardCount } from './app.ts';

type Code = keyof typeof ERROR_STATUS;

const BOARD_ROUTES = new Set(['listBoards', 'resolveBoard', 'addBoard', 'updateBoard', 'exportBoards', 'crawlStatus', 'crawlRun', 'crawlReport']);

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
}
function err(res: ServerResponse, code: Code, message: string, details?: unknown): void {
  send(res, ERROR_STATUS[code], { error: { code, message, ...(details === undefined ? {} : { details }) } });
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; code: Code; message: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > JSON_BODY_LIMIT) return { ok: false, code: 'payload_too_large', message: 'The body is larger than 1 MiB.' };
    chunks.push(c as Buffer);
  }
  if (size === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; } catch { return { ok: false, code: 'bad_request', message: 'The body is not valid JSON.' }; }
}

export interface DevServer { origin: string; port: number; token: string; close(): Promise<void> }

export async function startDevServer(app: BoardsApp, opts: { port?: number; token?: string; allowLive?: boolean; liveLimit?: number } = {}): Promise<DevServer> {
  const token = opts.token ?? process.env.JOBLEFT_LAUNCH_TOKEN ?? randomBytes(24).toString('base64url');
  let port = 0;
  const server = createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return err(res, 'forbidden_host', 'This server answers only on 127.0.0.1 and localhost.');
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return err(res, 'forbidden_origin', 'Requests from other web pages are refused.');
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const m = matchRoute(req.method ?? 'GET', url.pathname);
      if (!m || !BOARD_ROUTES.has(m.name)) return err(res, 'not_found', 'This development server serves only the board and crawl routes.');
      if (url.searchParams.has('token')) return err(res, 'unauthorized', 'A token in the address is refused; send it in the x-jobleft-token header.');
      const t = req.headers[LAUNCH_TOKEN_HEADER];
      if (typeof t !== 'string' || !sameToken(t, token)) return err(res, 'unauthorized', 'Missing or wrong x-jobleft-token.');
      const spec = LOCAL_API[m.name] as { method: string; query?: JsonSchema; body?: JsonSchema };
      let body: Record<string, unknown> = {};
      if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
        const ct = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        if (ct !== 'application/json') return err(res, 'unsupported_media_type', 'Send the body as application/json.');
        const b = await readBody(req);
        if (!b.ok) return err(res, b.code, b.message);
        if (spec.body) {
          const v = validate(spec.body, b.value);
          if (!v.ok) return err(res, 'bad_request', 'The body does not match the contract.', v.issues);
        }
        body = (b.value ?? {}) as Record<string, unknown>;
      }
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v;
      if (spec.query) {
        const v = validate(spec.query, query);
        if (!v.ok) return err(res, 'bad_request', 'The query does not match the contract.', v.issues);
      }
      switch (m.name) {
        case 'listBoards': return send(res, 200, app.service.list({
          ...(query.q ? { q: query.q } : {}), ...(query.view ? { view: query.view as ListView } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}), ...(query.limit ? { limit: Number(query.limit) } : {}),
        }));
        case 'resolveBoard': return send(res, 200, await app.service.resolve(String(body.url), { acceptPaidLookup: body.acceptPaidLookup === true }));
        case 'addBoard': return send(res, 200, app.service.add({ ats: body.ats as never, board: String(body.board), region: (body.region as string | undefined) ?? null }));
        case 'updateBoard': return send(res, 200, app.service.update(m.params.boardId ?? '', body as { followed?: boolean; hidden?: boolean; disabled?: boolean }));
        case 'exportBoards': {
          const lines = [...app.service.export()].join('');
          return send(res, 200, lines, { 'content-disposition': 'attachment; filename="jobleft-boards.ndjson"' });
        }
        case 'crawlStatus': return send(res, 200, app.scheduler.progress());
        case 'crawlReport': return send(res, 200, app.scheduler.lastReport());
        case 'crawlRun': {
          const ids = Array.isArray(body.boardIds) ? (body.boardIds as string[]) : undefined;
          const live = liveBoardCount(app, ids);
          const limit = opts.liveLimit ?? 25;
          if (!opts.allowLive && live > limit) {
            return send(res, 200, { started: false, message: `This refresh would ask ${live} boards on live hosts. Start the development server with --live to allow that (or map the hosts to mocks with JOBLEFT_HOST_MAP).`, nextAllowedAt: null });
          }
          return send(res, 200, app.scheduler.runNow(ids));
        }
        default: return err(res, 'not_found', 'Unknown route.');
      }
    } catch (e) {
      if (e instanceof BoardError) return err(res, e.code, e.message);
      return err(res, 'internal', 'Something went wrong in the board service.');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin, port, token,
    close: async () => {
      await app.scheduler.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
