// The Network tool's own local server and screens, until apps/server wires the network routes. It follows the
// local API security rules of docs/INTERFACES.md section 6.1:
//   * listens on 127.0.0.1 only;
//   * the Host header must be exactly 127.0.0.1:<port> or localhost:<port> (DNS rebinding fails);
//   * a request with an Origin header is refused unless it is this server's own origin; Origin "null" is refused;
//   * no CORS headers at all (a foreign page can never read an answer);
//   * every /api route except health needs the launch token in the x-jobleft-token header (constant-time check);
//     a token in the URL query is refused; no cookie is ever used;
//   * writes accept only application/json (the CSV import also text/csv and text/plain); 415 otherwise;
//   * bodies over 1 MiB JSON / 10 MiB raw answer 413; every body and query is checked against its contract;
//   * error bodies and logs never hold a name, email, note or network row.
// The screens are static files that hold no data; they read data through the same token-protected routes.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import {
  ERROR_STATUS, JSON_BODY_LIMIT, LAUNCH_TOKEN_HEADER, LOCAL_API, RAW_BODY_LIMIT, arr, bool, enm, formatDollars, int, matchRoute, nowMs,
  nullable, obj, str, validate, type ErrorCode, type JsonSchema, type RouteSpec,
} from '@jobleft/contracts';
import { resolveCompanyKey } from '../company.ts';
import { openNetworkDatabase } from '../db.ts';
import { profileSummary } from '../draft.ts';
import { handleNetworkRoute, NETWORK_ROUTES, NetworkApiError, type NetworkRouteName } from '../routes.ts';
import { NetworkService } from '../service.ts';
import { localTimeZone } from '../text.ts';
import { bridgeDestination, createBridgeClient, normalizeBaseUrl, type BridgeConfig } from './ai-bridge.ts';
import { showDesktopNotification } from './notify.ts';
import { StandIn } from './standin.ts';
import { feedPage } from './feed.ts';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui');
export const DEV_PORT_START = 47841;

export interface DevServerOptions {
  home: string;
  port?: number;
  token?: string;
  /** Show desktop notifications for due follow-ups (macOS). Default true. */
  osNotifications?: boolean;
  /** Seconds between reminder checks. Default 30. */
  reminderEverySeconds?: number;
  offline?: boolean;
  quiet?: boolean;
}

export interface DevServer {
  port: number;
  token: string;
  origin: string;
  uiUrl: string;
  service: NetworkService;
  close(): Promise<void>;
}

interface Notice { id: string; kind: 'follow_up'; title: string; body: string; target: string | null; createdAt: string }

// ---------------------------------------------------------------- dev-only routes (stand-ins for other lanes)

interface DevRoute { method: string; path: string; body?: JsonSchema; query?: JsonSchema }
const DEV_ROUTES: Record<string, DevRoute> = {
  devJobs: { method: 'GET', path: '/api/v1/network-dev/jobs', query: obj({}, { q: str({ maxLength: 200 }), liked: enm(['true', 'false']), limit: str({ pattern: '^[0-9]{1,6}$' }) }) },
  devAddJob: { method: 'POST', path: '/api/v1/network-dev/jobs', body: obj({ title: str({ minLength: 1, maxLength: 300 }), company: str({ minLength: 1, maxLength: 300 }) }, { department: nullable(str({ maxLength: 200 })), liked: bool() }) },
  devGetJob: { method: 'GET', path: '/api/v1/network-dev/jobs/:jobId' },
  devLikeJob: { method: 'POST', path: '/api/v1/network-dev/jobs/:jobId/like', body: obj({ liked: bool() }) },
  devDeleteJob: { method: 'DELETE', path: '/api/v1/network-dev/jobs/:jobId' },
  devGetProfile: { method: 'GET', path: '/api/v1/network-dev/profile' },
  devPutProfile: { method: 'PUT', path: '/api/v1/network-dev/profile', body: obj({}, {
    firstName: str({ maxLength: 100 }), lastName: str({ maxLength: 100 }), currentTitle: nullable(str({ maxLength: 200 })),
    currentCompany: nullable(str({ maxLength: 200 })), school: nullable(str({ maxLength: 200 })), degree: nullable(str({ maxLength: 200 })),
    targetTitles: arr(str({ maxLength: 200 })), skills: arr(str({ maxLength: 100 })),
  }) },
  devGetAi: { method: 'GET', path: '/api/v1/network-dev/ai' },
  devPutAi: { method: 'PUT', path: '/api/v1/network-dev/ai', body: obj({ provider: nullable(enm(['local', 'custom', 'publik'])) }, { baseUrl: nullable(str({ maxLength: 500 })), model: nullable(str({ maxLength: 200 })) }) },
  devStatus: { method: 'GET', path: '/api/v1/network-dev/status' },
  devRemindNow: { method: 'POST', path: '/api/v1/network-dev/reminders/check', body: obj({}) },
};
void int;

function matchDevRoute(method: string, pathname: string): { name: string; params: Record<string, string> } | null {
  const segs = pathname.split('/').filter(Boolean);
  for (const [name, r] of Object.entries(DEV_ROUTES)) {
    if (r.method !== method) continue;
    const rs = r.path.split('/').filter(Boolean);
    if (rs.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < rs.length; i++) {
      if (rs[i]!.startsWith(':')) { try { params[rs[i]!.slice(1)] = decodeURIComponent(segs[i]!); } catch { ok = false; break; } }
      else if (rs[i] !== segs[i]) { ok = false; break; }
    }
    if (ok) return { name, params };
  }
  return null;
}

// ---------------------------------------------------------------- helpers

class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly link: { label: string; url: string } | null;
  constructor(code: ErrorCode, message: string, details?: unknown, link: { label: string; url: string } | null = null) {
    super(message);
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
    this.link = link;
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, e: HttpError): void {
  const error: Record<string, unknown> = { code: e.code, message: e.message };
  if (e.details !== undefined) error.details = e.details;
  if (e.link) error.link = e.link;
  sendJson(res, e.status, { error });
}

function tokenOk(given: string | undefined, token: string): boolean {
  if (!given) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (declared > limit) throw new HttpError('payload_too_large', `The body is larger than ${Math.round(limit / 1048576)} MiB.`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) {
      req.destroy();
      throw new HttpError('payload_too_large', `The body is larger than ${Math.round(limit / 1048576)} MiB.`);
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function mediaType(req: IncomingMessage): string {
  return String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
}

function issuesOf(r: { ok: false; issues: Array<{ path: string; message: string }> }): Array<{ path: string; message: string }> {
  return r.issues.slice(0, 10);
}

// ---------------------------------------------------------------- the server

export async function startDevServer(opts: DevServerOptions): Promise<DevServer> {
  const home = opts.home;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const token = opts.token ?? randomBytes(24).toString('base64url');
  const keyFn = resolveCompanyKey();
  const db: DatabaseSync = openNetworkDatabase(join(home, 'data', 'jobleft.db'));
  const service = new NetworkService({ db, companyKey: keyFn.fn });
  const standin = new StandIn(home, keyFn.fn);
  const notices: Notice[] = [];
  const logDir = join(home, 'logs');
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logFile = join(logDir, 'network-dev.log');
  const log = (line: string) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch { /* ignore */ } };
  let port = 0;

  const aiConfig = (): BridgeConfig => standin.ai();
  const deps = {
    service,
    job: (id: string) => standin.asJob(id),
    profileSummary: () => profileSummary(standin.asProfile(new Date(nowMs()).toISOString())),
    ai: () => createBridgeClient(aiConfig(), { onWallet: (w) => standin.setWallet(w) }),
    aiDestination: () => bridgeDestination(aiConfig()),
    targets: () => standin.targets(),
    offline: !!opts.offline,
  };

  function checkReminders(): number {
    const r = service.takeReminders();
    if (r.count && r.text) {
      notices.push({ id: randomBytes(8).toString('hex'), kind: 'follow_up', title: r.text.title, body: r.text.body, target: '/network/due', createdAt: new Date(nowMs()).toISOString() });
      if (opts.osNotifications !== false) showDesktopNotification(r.text.title, r.text.body);
    }
    return r.count;
  }

  async function devRoute(name: string, params: Record<string, string>, query: Record<string, string>, body: unknown): Promise<unknown> {
    switch (name) {
      case 'devJobs':
        return feedPage(standin, service, {
          ...(query.q ? { q: query.q } : {}), liked: query.liked === 'true', limit: query.limit ? Number(query.limit) : 200,
        });
      case 'devAddJob': {
        const b = body as { title: string; company: string; department?: string | null; liked?: boolean };
        const j = standin.addJob(b, new Date(nowMs()).toISOString());
        return { ...j, companyKey: standin.companyKeyOf(j) };
      }
      case 'devGetJob': {
        const j = standin.findJob(params.jobId!);
        if (!j) throw new HttpError('not_found', 'No such job.');
        const key = standin.companyKeyOf(j);
        return { ...j, companyKey: key, networkCount: service.countFor(key), match: key ? service.explain(key, j.company) : null };
      }
      case 'devLikeJob': {
        const j = standin.like(params.jobId!, (body as { liked: boolean }).liked);
        if (!j) throw new HttpError('not_found', 'No such job.');
        return j;
      }
      case 'devDeleteJob': {
        if (!standin.removeJob(params.jobId!)) throw new HttpError('not_found', 'No such job.');
        return { ok: true };
      }
      case 'devGetProfile': return { ...standin.profile(), summary: deps.profileSummary() };
      case 'devPutProfile': { standin.setProfile(body as Record<string, never>); return { ...standin.profile(), summary: deps.profileSummary() }; }
      case 'devGetAi': {
        const cfg = aiConfig();
        const w = standin.wallet();
        return {
          config: cfg, destination: bridgeDestination(cfg), source: 'interim (this package) until the app wires @jobleft/ai-engine',
          wallet: cfg.provider === 'publik' ? { balanceMicros: w.balanceMicros, balance: w.balanceMicros === null ? null : formatDollars(w.balanceMicros), lastChargeMicros: w.lastChargeMicros, at: w.at } : null,
        };
      }
      case 'devPutAi': {
        const b = body as { provider: 'local' | 'custom' | 'publik' | null; baseUrl?: string | null; model?: string | null };
        if (!b.provider) { standin.setAi({ provider: null, baseUrl: null, model: null }); return devRoute('devGetAi', {}, {}, null); }
        const url = b.baseUrl || (b.provider === 'publik' ? process.env.JOBLEFT_PUBLIK_BASE_URL ?? '' : '');
        if (!url) throw new HttpError('bad_request', 'Give the address of the AI server.');
        let normal: string;
        try { normal = normalizeBaseUrl(url, b.provider); } catch (e) { throw new HttpError('bad_request', (e as Error).message); }
        standin.setAi({ provider: b.provider, baseUrl: normal, model: b.model || null });
        return devRoute('devGetAi', {}, {}, null);
      }
      case 'devStatus': {
        return {
          companyKeySource: keyFn.source, contacts: service.total(), lastImport: service.lastImport(), today: service.today(),
          timeZone: localTimeZone(), offline: !!opts.offline, due: service.due().length,
        };
      }
      case 'devRemindNow': return { shown: checkReminders() };
    }
    throw new HttpError('not_found', 'No such route.');
  }

  const server = createServer(async (req, res) => {
    const started = performance.now();
    let label = 'static';
    let status = 200;
    try {
      // 1. Host: exactly 127.0.0.1:<port> or localhost:<port>.
      const host = String(req.headers.host ?? '');
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError('forbidden_host', 'This server answers only on 127.0.0.1 and localhost.');
      // 2. Origin: only this server's own origin.
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
        throw new HttpError('forbidden_origin', 'Requests from other web pages are refused.');
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const method = (req.method ?? 'GET').toUpperCase();
      if (method === 'OPTIONS') throw new HttpError('forbidden_origin', 'Requests from other web pages are refused.');

      if (!url.pathname.startsWith('/api/')) {
        // Static screens: no data inside them.
        if (method !== 'GET' && method !== 'HEAD') throw new HttpError('not_found', 'No such page.');
        const files: Record<string, [string, string]> = {
          '/': ['index.html', 'text/html; charset=utf-8'],
          '/index.html': ['index.html', 'text/html; charset=utf-8'],
          '/ui/app.js': ['app.js', 'text/javascript; charset=utf-8'],
          '/ui/app.css': ['app.css', 'text/css; charset=utf-8'],
        };
        const f = files[url.pathname];
        if (!f) throw new HttpError('not_found', 'No such page.');
        const data = readFileSync(join(UI_DIR, f[0]));
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': f[1], 'content-security-policy': CSP, 'content-length': data.length });
        res.end(method === 'HEAD' ? undefined : data);
        return;
      }

      // 3. No token in a URL.
      for (const k of url.searchParams.keys()) {
        if (/token|x-jobleft|auth|key/i.test(k)) throw new HttpError('unauthorized', 'Tokens in a URL are refused. Send the token in the x-jobleft-token header.');
      }

      const hit = matchRoute(method, url.pathname);
      const dev = hit ? null : matchDevRoute(method, url.pathname);
      const isNetwork = !!hit && (NETWORK_ROUTES as readonly string[]).includes(hit.name);
      const isServer = !!hit && (hit.name === 'health' || hit.name === 'listNotifications' || hit.name === 'ackNotification');
      if (!dev && !isNetwork && !isServer) throw new HttpError('not_found', 'No such route in the Network tool server.');
      label = hit ? hit.name : dev!.name;

      if (hit?.name === 'health') { sendJson(res, 200, { app: 'jobleft', version: '0.1.0-network-dev', apiVersion: 1, extensionProtocol: 1 }); return; }

      // 4. The launch token.
      if (!tokenOk(req.headers[LAUNCH_TOKEN_HEADER] as string | undefined, token)) throw new HttpError('unauthorized', 'The launch token is missing or wrong.');

      const spec: RouteSpec | DevRoute = hit ? LOCAL_API[hit.name] as RouteSpec : DEV_ROUTES[dev!.name]!;
      const params = hit ? hit.params : dev!.params;
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v;
      if (spec.query) {
        const r = validate(spec.query, query);
        if (!r.ok) throw new HttpError('bad_request', 'The query does not match the route.', { issues: issuesOf(r) });
      }

      // 5. Bodies: media type, size, contract.
      let body: unknown = undefined;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const type = mediaType(req);
        const rawTypes = spec.body && 'raw' in spec.body ? (spec.body as { raw: readonly string[] }).raw : null;
        if (rawTypes) {
          if (!rawTypes.includes(type)) throw new HttpError('unsupported_media_type', `Send the file as ${rawTypes.join(' or ')}.`);
          body = new Uint8Array(await readBody(req, RAW_BODY_LIMIT));
        } else {
          if (type !== 'application/json') throw new HttpError('unsupported_media_type', 'Send JSON (application/json).');
          const buf = await readBody(req, JSON_BODY_LIMIT);
          try { body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { throw new HttpError('bad_request', 'The body is not valid JSON.'); }
          if (spec.body) {
            const r = validate(spec.body as JsonSchema, body);
            if (!r.ok) throw new HttpError('bad_request', 'The body does not match the route.', { issues: issuesOf(r) });
          }
        }
      }

      let out: unknown;
      if (isNetwork) {
        try {
          out = await handleNetworkRoute(hit!.name as NetworkRouteName, { params, query, body }, deps);
        } catch (e) {
          if (e instanceof NetworkApiError) throw new HttpError(e.code, e.message, e.details, e.link);
          throw e;
        }
      } else if (hit?.name === 'listNotifications') {
        out = notices.map((n) => ({ ...n }));
      } else if (hit?.name === 'ackNotification') {
        const i = notices.findIndex((n) => n.id === params.notificationId);
        if (i < 0) throw new HttpError('not_found', 'No such notification.');
        notices.splice(i, 1);
        out = { ok: true };
      } else {
        out = await devRoute(dev!.name, params, query, body);
      }
      sendJson(res, 200, out);
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError('internal', 'Something went wrong.');
      status = err.status;
      if (!res.headersSent) sendError(res, err);
      else res.end();
    } finally {
      log(`${req.method} ${label} ${status} ${Math.round(performance.now() - started)}ms`);
    }
  });

  const tryPorts = opts.port !== undefined && opts.port !== 0 ? [opts.port] : Array.from({ length: 10 }, (_, i) => DEV_PORT_START + i);
  for (const p of tryPorts) {
    const ok = await new Promise<boolean>((resolve) => {
      const onErr = () => { server.removeListener('listening', onOk); resolve(false); };
      const onOk = () => { server.removeListener('error', onErr); resolve(true); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(p, '127.0.0.1');
    });
    if (ok) { port = (server.address() as { port: number }).port; break; }
  }
  if (!port) {
    db.close();
    throw new Error(`No free port in ${tryPorts[0]} to ${tryPorts[tryPorts.length - 1]}.`);
  }

  const runDir = join(home, 'run');
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const runFile = join(runDir, 'network-dev.json');
  writeFileSync(runFile, JSON.stringify({ pid: process.pid, port, token, startedAt: new Date().toISOString() }), { mode: 0o600 });
  try { chmodSync(runFile, 0o600); } catch { /* ignore */ }

  checkReminders();
  const timer = setInterval(() => { try { checkReminders(); } catch { /* the next tick tries again */ } }, (opts.reminderEverySeconds ?? 30) * 1000);
  timer.unref();

  const origin = `http://127.0.0.1:${port}`;
  return {
    port, token, origin, uiUrl: `${origin}/#token=${token}`, service,
    close: async () => {
      clearInterval(timer);
      await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
      try { rmSync(runFile, { force: true }); } catch { /* ignore */ }
      db.close();
    },
  };
}
