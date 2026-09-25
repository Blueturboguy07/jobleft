// The local HTTP server: startServer() and the request dispatcher. Every rule of docs/INTERFACES.md section 6.1 is
// enforced here, in one place, before any handler runs.

import { accessSync, constants } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import {
  DEFAULT_PORT, FILE_NAME_HEADER, JSON_BODY_LIMIT, LAUNCH_TOKEN_HEADER, LOCAL_API, PAIRING_TOKEN_HEADER, PORT_SPAN, RAW_BODY_LIMIT,
  matchRoute, validate, type JsonSchema, type RouteName, type RouteSpec,
} from '@jobleft/contracts';
import { hostMapFromEnv } from '@jobleft/crawler';
import { App, type AppConfig } from './app.ts';
import { DataFolderError } from './db/open.ts';
import { ApiFailure, storageProblem, writeFailed } from './errors.ts';
import { cleanTmp, ensureHome, homeLayout } from './home.ts';
import { mediaType, parseJsonBody, readBody } from './http/body.ts';
import { crossSiteFetch, extensionIdOf, headerValue, hostAllowed, ownOrigins, queryCarriesToken, sha256, tokenMatches } from './http/gate.ts';
import { sendError, sendFile, sendJson, setSecurityHeaders, startSse } from './http/respond.ts';
import { StaticSite } from './http/static.ts';
import { acquireLock, holderAlive, type LockHolder } from './lock.ts';
import { createLogger, parseLogLevel, redact, type Logger } from './log.ts';
import { HANDLERS, STREAMED_BODY, type Ctx, type Out } from './routes.ts';
import { recoverInterruptedRestore } from './services/backup.ts';
import { createSecretStore, type ServerSecretStore } from './services/secrets.ts';
import { readRunFile, removeRunFile, writeRunFile, type RunInfo } from './runfile.ts';
import { PUBLIK_DEFAULT_BASE_URL } from './interim/publik.ts';
import { APP_VERSION } from './version.ts';

export interface ServerOptions {
  home: string;
  /** 0 or undefined = the first free port of DEFAULT_PORT .. DEFAULT_PORT + PORT_SPAN - 1. */
  port?: number;
  launchToken: string;
  /** The built UI (apps/ui/dist). null = the server's own small page. */
  uiDir?: string | null;
  /** JOBLEFT_DEV=1: enables POST /api/v1/dev/clock and pretty logs. */
  dev?: boolean;
  /** The shell's pid. The server exits within 10 s after that process is gone (server O11). */
  parentPid?: number | null;
  /** JOBLEFT_OFFLINE=1: no outbound request at all (crawl and AI answer "offline"). */
  offline?: boolean;
  env?: Record<string, string | undefined>;
  /** Tests: the secret store (default: the macOS Keychain, or memory where there is none). */
  secrets?: ServerSecretStore;
  /** Called when the server stops on its own (parent gone). main.ts exits the process. */
  onStop?: (reason: string) => void;
}

export interface RunningServer {
  port: number;
  /** "http://127.0.0.1:<port>" */
  origin: string;
  /** origin + "/#token=<launch token>" (the token rides in the fragment, never sent to a server). */
  uiUrl: string;
  close(): Promise<void>;
}

/** Thrown when another live server already uses the data folder. */
export class AlreadyRunningError extends Error {
  readonly holder: LockHolder | null;
  readonly run: RunInfo | null;
  constructor(holder: LockHolder | null, run: RunInfo | null) {
    super('jobleft is already running for this data folder.');
    this.name = 'AlreadyRunningError';
    this.holder = holder;
    this.run = run;
  }
}

const FALLBACK_UI = fileURLToPath(new URL('../ui-fallback/', import.meta.url));
const REPO_UI = fileURLToPath(new URL('../../ui/dist/', import.meta.url));

/** Write routes that store nothing (they may run while the folder is read-only). */
const NO_STORE_WRITES = new Set<RouteName>(['pairingCode', 'checkAi', 'cancelAi', 'backup', 'exportAll', 'devClock']);

function listen(server: Server, port: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (e.code === 'EADDRINUSE' || e.code === 'EACCES') resolve(null); else reject(e);
    };
    const onListening = () => { server.off('error', onError); resolve((server.address() as AddressInfo).port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

async function listenOnFreePort(server: Server, wanted: number | undefined, log: Logger): Promise<number> {
  const tries: number[] = [];
  if (wanted && wanted > 0) tries.push(wanted);
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + PORT_SPAN; p++) if (!tries.includes(p)) tries.push(p);
  for (const p of tries) {
    const got = await listen(server, p);
    if (got !== null) return got;
    log.info('port.busy', { port: p });
  }
  // Every usual port is taken: take any free loopback port rather than fail (the shell reads run/server.json).
  const got = await listen(server, 0);
  if (got === null) throw new Error('no free port on 127.0.0.1');
  log.warn('port.outside_range', { port: got });
  return got;
}

function writable(path: string): boolean {
  try { accessSync(path, constants.W_OK); return true; } catch { return false; }
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const env = opts.env ?? process.env;
  const layout = homeLayout(opts.home);
  ensureHome(layout);
  const log = createLogger({ dir: layout.logs, level: parseLogLevel(env.JOBLEFT_LOG_LEVEL), echo: false });
  log.addSecret(opts.launchToken);

  const lock = acquireLock(layout.lockFile);
  if (!lock.ok) {
    const run = readRunFile(layout.runFile);
    throw new AlreadyRunningError(lock.holder, run && lock.holder && run.pid === lock.holder.pid ? run : null);
  }
  const recovered = recoverInterruptedRestore(layout);
  if (recovered !== 'none') log.warn('restore.recovered', { outcome: recovered });
  cleanTmp(layout);

  const secrets = opts.secrets ?? createSecretStore(env.JOBLEFT_SECRET_STORE, opts.home);
  let hostMap: Record<string, string> = {};
  try { hostMap = hostMapFromEnv(env); } catch (e) { log.warn('host_map.ignored', { error: e instanceof Error ? e.message : 'invalid' }); }
  const uiDir = opts.uiDir ?? (existsSync(REPO_UI) ? REPO_UI : null);
  const cfg: AppConfig = {
    home: opts.home, layout, launchToken: opts.launchToken, dev: opts.dev ?? false, offline: opts.offline ?? false,
    parentPid: opts.parentPid ?? null, uiDir, publikBaseUrl: env.JOBLEFT_PUBLIK_BASE_URL || PUBLIK_DEFAULT_BASE_URL,
    publikAppToken: env.JOBLEFT_PUBLIK_APP_TOKEN || null, hostMap, env, log, secrets,
  };
  const app = new App(cfg);
  let data;
  try {
    data = app.open();
  } catch (e) {
    lock.release();
    throw e;
  }
  log.info('db.opened', { schemaFrom: data.migrated.from, schemaTo: data.migrated.to, fresh: data.migrated.fresh });

  let site: StaticSite;
  try { site = new StaticSite(uiDir ?? FALLBACK_UI); } catch { site = new StaticSite(FALLBACK_UI); }
  const launchDigest = sha256(opts.launchToken);
  let port = 0;
  const sockets = new Set<Socket>();

  const server = createServer({ headersTimeout: 15_000, requestTimeout: 600_000, keepAliveTimeout: 5_000, maxHeaderSize: 16_384 }, (req, res) => {
    dispatch(req, res).catch((e) => {
      log.error('dispatch.crash', { error: e instanceof Error ? `${e.name}: ${e.message}` : 'error' });
      if (!res.headersSent) sendError(req, res, new ApiFailure('internal', 'Something went wrong inside jobleft. Try again.'));
      else res.destroy();
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('clientError', (_e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n'); } catch { /* gone */ } });

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t0 = performance.now();
    const method = req.method ?? 'GET';
    const isApi = (req.url ?? '/').startsWith('/api/');
    setSecurityHeaders(res, isApi);
    let routeName: string = isApi ? '(none)' : 'static';
    // Request lines are debug-level: at the default level a request, refused or not, writes nothing to the data
    // folder (a probe from a web page leaves the folder byte for byte as it was). JOBLEFT_LOG_LEVEL=debug shows them.
    res.on('finish', () => {
      log.debug('request', { method, route: routeName, status: res.statusCode, ms: Math.round(performance.now() - t0) });
    });

    // 1. Host (DNS rebinding). Node keeps only the first of several Host lines, so a request that sends more than one
    // is refused here (RFC 9112: 400), never judged by its first line alone.
    let hostLines = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() === 'host') hostLines++;
    if (hostLines > 1) {
      sendError(req, res, new ApiFailure('bad_request', 'A request may carry only one Host header.'));
      return;
    }
    if (!hostAllowed(headerValue(req, 'host'), port)) {
      sendError(req, res, new ApiFailure('forbidden_host', 'This address is not allowed. Use http://127.0.0.1 with the app\'s port.'));
      return;
    }
    // Dot segments ("..", "%2e%2e") and backslashes are refused before the URL is normalised, so a path can never
    // climb out of /api/ or out of the UI folder.
    const rawPath = (req.url ?? '/').split('?')[0]!;
    // Only origin-form paths ("/..."): "//x" would read as a host name and "*" or a full URL is not a page here.
    if (!rawPath.startsWith('/') || rawPath.startsWith('//')) {
      sendError(req, res, new ApiFailure('not_found', 'There is nothing here.'));
      return;
    }
    for (const seg of rawPath.split('/')) {
      let d: string;
      try { d = decodeURIComponent(seg); } catch { sendError(req, res, new ApiFailure('bad_request', 'The address is not valid.')); return; }
      if (d === '.' || d === '..' || d.includes('\\') || /(^|\/)\.\.(\/|$)/.test(d)) {
        sendError(req, res, new ApiFailure('not_found', 'There is nothing here.'));
        return;
      }
    }
    let url: URL;
    try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); } catch { sendError(req, res, new ApiFailure('bad_request', 'The address is not valid.')); return; }
    if (url.host !== `127.0.0.1:${port}`) { sendError(req, res, new ApiFailure('forbidden_host', 'This address is not allowed.')); return; }

    // 2. Origin.
    const originHeader = headerValue(req, 'origin');
    const hasOrigin = req.headers.origin !== undefined;
    const own = originHeader !== undefined && ownOrigins(port).includes(originHeader);
    const extId = extensionIdOf(originHeader);
    if (hasOrigin && (originHeader === undefined || originHeader === 'null' || (!own && !extId))) {
      sendError(req, res, new ApiFailure('forbidden_origin', 'Requests from other web pages are not allowed.'));
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      if (extId) { sendError(req, res, new ApiFailure('forbidden_origin', 'Requests from other web pages are not allowed.')); return; }
      if (method !== 'GET' && method !== 'HEAD') { sendError(req, res, new ApiFailure('not_found', 'There is nothing here.')); return; }
      if (!site.serve(req, res, url.pathname)) sendError(req, res, new ApiFailure('not_found', 'There is nothing here.'));
      return;
    }

    // 3. Image and script tags from another site carry no Origin, but browsers say where they came from.
    if (!hasOrigin && crossSiteFetch(req)) {
      sendError(req, res, new ApiFailure('forbidden_origin', 'Requests from other web pages are not allowed.'));
      return;
    }

    // Preflight: answered only for a paired extension (or the pair route), for the extension routes.
    if (method === 'OPTIONS') {
      const target = matchRoute(headerValue(req, 'access-control-request-method') ?? '', url.pathname);
      const spec = target ? (LOCAL_API[target.name] as RouteSpec) : null;
      const cur = app.data;
      const allowed = !!extId && !!spec && (spec.auth === 'pairing' ? !!cur && cur.pairing.isPaired(extId) : target!.name === 'pair' || target!.name === 'health');
      if (!allowed) { sendError(req, res, new ApiFailure('forbidden_origin', 'Requests from other web pages are not allowed.')); return; }
      res.statusCode = 204;
      res.setHeader('access-control-allow-origin', originHeader!);
      res.setHeader('access-control-allow-methods', spec!.method);
      res.setHeader('access-control-allow-headers', `content-type, ${PAIRING_TOKEN_HEADER}`);
      res.setHeader('access-control-max-age', '600');
      res.end();
      return;
    }

    const m = matchRoute(method, url.pathname);
    if (!m) { sendError(req, res, new ApiFailure('not_found', 'There is no such API route.')); return; }
    routeName = m.name;
    const spec = LOCAL_API[m.name] as RouteSpec;
    if (spec.devOnly && !cfg.dev) { sendError(req, res, new ApiFailure('not_found', 'There is no such API route.')); return; }

    // 4. No token in a URL.
    if (queryCarriesToken(url.searchParams, [opts.launchToken])) {
      sendError(req, res, new ApiFailure('bad_request', 'Tokens are never accepted in a URL. Send the token in its header.'));
      return;
    }

    // 5. Tokens. Launch routes: never from an extension Origin. Pairing routes: only from the paired Origin.
    let extensionId: string | null = null;
    if (spec.auth === 'launch') {
      if (extId) { sendError(req, res, new ApiFailure('forbidden_origin', 'The extension may not use this route.')); return; }
      if (!tokenMatches(headerValue(req, LAUNCH_TOKEN_HEADER), launchDigest)) { sendError(req, res, new ApiFailure('unauthorized', 'This request needs the app\'s launch token.')); return; }
    } else if (spec.auth === 'pairing') {
      const d = app.data;
      if (!extId || own) { sendError(req, res, new ApiFailure(extId || own ? 'unauthorized' : 'forbidden_origin', 'This route is for the paired browser extension only.')); return; }
      if (!d) { sendError(req, res, new ApiFailure('not_ready', 'jobleft is busy restoring or deleting data. Try again in a moment.', { retryAfterSeconds: 5 })); return; }
      if (!d.pairing.verify(extId, headerValue(req, PAIRING_TOKEN_HEADER))) { sendError(req, res, new ApiFailure('unauthorized', 'This extension is not paired with jobleft, or it was unpaired.')); return; }
      extensionId = extId;
      d.pairing.touch(extId);
    } else if (m.name === 'pair') {
      if (!extId) { sendError(req, res, new ApiFailure('forbidden_origin', 'Only a browser extension can pair.')); return; }
      extensionId = extId;
    } else if (extId && m.name !== 'health') {
      sendError(req, res, new ApiFailure('forbidden_origin', 'The extension may not use this route.'));
      return;
    }
    if (extId) {
      // A paired extension (or one pairing) may read the answer: its own Origin only, never "*".
      res.setHeader('access-control-allow-origin', originHeader!);
    }

    // 6. Media type of writes.
    const ct = mediaType(req);
    const isWrite = method === 'POST' || method === 'PUT' || method === 'PATCH';
    const rawTypes = spec.body && 'raw' in spec.body ? (spec.body as { raw: readonly string[] }).raw : null;
    if (isWrite) {
      if (rawTypes) {
        if (!ct || !rawTypes.includes(ct)) { sendError(req, res, new ApiFailure('unsupported_media_type', `This request needs one of these types: ${rawTypes.join(', ')}.`)); return; }
      } else if (spec.body) {
        if (ct !== 'application/json') { sendError(req, res, new ApiFailure('unsupported_media_type', 'This request needs a JSON body (content-type: application/json).')); return; }
      } else if (ct !== null && ct !== 'application/json') {
        sendError(req, res, new ApiFailure('unsupported_media_type', 'This request takes no body, or an empty JSON body.'));
        return;
      }
    }

    const d = app.data;
    if (!d) {
      if (m.name === 'health') { /* health never needs the data */ } else {
        sendError(req, res, new ApiFailure('not_ready', 'jobleft is busy restoring or deleting data. Try again in a moment.', { retryAfterSeconds: 5 }));
        return;
      }
    }
    if (isWrite || method === 'DELETE') {
      if (!NO_STORE_WRITES.has(m.name) && m.name !== 'pair' && (!writable(layout.data) || (existsSync(layout.db) && !writable(layout.db)))) {
        sendError(req, res, writeFailed('read_only'));
        return;
      }
    }

    // 7-8. Body and query, checked against the contract before any work.
    let body: unknown = undefined;
    if (isWrite && !STREAMED_BODY.has(m.name)) {
      const limit = rawTypes ? RAW_BODY_LIMIT : JSON_BODY_LIMIT;
      let buf: Buffer;
      try { buf = await readBody(req, limit); } catch (e) {
        if (e instanceof ApiFailure) { sendError(req, res, e); return; }
        throw e;
      }
      if (rawTypes) body = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      else if (spec.body) {
        let parsed: unknown;
        try { parsed = parseJsonBody(buf); } catch (e) { sendError(req, res, e instanceof ApiFailure ? e : new ApiFailure('bad_request', 'The body is not valid JSON.')); return; }
        const v = validate(spec.body as JsonSchema, parsed);
        if (!v.ok) { sendError(req, res, new ApiFailure('bad_request', 'The body does not match what this request expects.', { details: { issues: v.issues } })); return; }
        body = parsed;
      } else if (buf.length > 0) {
        let parsed: unknown;
        try { parsed = parseJsonBody(buf); } catch (e) { sendError(req, res, e instanceof ApiFailure ? e : new ApiFailure('bad_request', 'The body is not valid JSON.')); return; }
        if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed as object).length > 0)) {
          sendError(req, res, new ApiFailure('bad_request', 'This request takes no body.'));
          return;
        }
      }
    }
    const q: Record<string, string> = {};
    for (const [k, v] of url.searchParams) {
      if (k in q) { sendError(req, res, new ApiFailure('bad_request', 'A query parameter appears twice.')); return; }
      q[k] = v;
    }
    if (spec.query) {
      const v = validate(spec.query, q);
      if (!v.ok) { sendError(req, res, new ApiFailure('bad_request', 'The query does not match what this request expects.', { details: { issues: v.issues } })); return; }
      // Paged lists take limit 1 to 100 (INTERFACES 6.3), the same rule as a search body.
      if (q.limit !== undefined && !(Number(q.limit) >= 1 && Number(q.limit) <= 100)) {
        sendError(req, res, new ApiFailure('bad_request', 'The query does not match what this request expects.', { details: { issues: [{ path: '/limit', message: 'must be 1 to 100' }] } }));
        return;
      }
    }

    const gone = new AbortController();
    res.on('close', () => { if (!res.writableFinished) gone.abort(); });
    const ctx: Ctx<RouteName> = {
      app, d: d!, params: m.params, query: q as never, body: body as never, req, res, extensionId, contentType: ct,
      fileName: headerValue(req, FILE_NAME_HEADER) ?? null, gone: gone.signal,
    };
    let out: Out;
    try {
      out = await (HANDLERS[m.name] as (c: Ctx<RouteName>) => Out | Promise<Out>)(ctx);
    } catch (e) {
      if (e instanceof ApiFailure) { sendError(req, res, e); return; }
      const p = storageProblem(e);
      if (p) { sendError(req, res, writeFailed(p)); return; }
      log.error('handler.failed', { route: m.name, error: e instanceof Error ? `${e.name}: ${e.message}` : 'error', stack: e instanceof Error ? redact(e.stack ?? '') : '' });
      sendError(req, res, new ApiFailure('internal', 'Something went wrong inside jobleft. Try again; if it keeps happening, restart the app.'));
      return;
    }
    if ('json' in out) {
      if (cfg.dev && spec.response !== 'sse' && spec.response !== 'file') {
        const v = validate(spec.response as JsonSchema, out.json);
        if (!v.ok) log.warn('response.contract', { route: m.name, issues: v.issues.slice(0, 3).map((i) => `${i.path} ${i.message}`).join('; ') });
      }
      sendJson(req, res, out.status ?? 200, out.json);
    } else if ('file' in out) {
      sendFile(req, res, out.file);
    } else {
      const send = startSse(res);
      try { await out.sse(send, gone.signal); } finally { res.end(); }
    }
  }

  try {
    port = await listenOnFreePort(server, opts.port, log);
  } catch (e) {
    await app.close();
    lock.release();
    throw e;
  }
  const origin = `http://127.0.0.1:${port}`;
  writeRunFile(layout.runFile, { pid: process.pid, port, token: opts.launchToken, version: APP_VERSION, startedAt: new Date().toISOString() });
  log.info('server.listening', { port, version: APP_VERSION, ui: uiDir ? 'built' : 'fallback', offline: cfg.offline, dev: cfg.dev });
  // Warm the search index's pages once, in the background: the first search after launch on a large store paid
  // ~0.5 s for a cold page cache (gate 9); every later search takes tens of milliseconds.
  const warm = setTimeout(() => {
    try {
      const db = app.data.db;
      db.prepare(`SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH 'engineer OR manager OR nurse OR analyst OR sales' LIMIT 1`).all();
      db.prepare('SELECT count(*) AS n FROM jobs WHERE closed_at IS NULL').get();
    } catch { /* no index yet, or the folder is being replaced: nothing to warm */ }
  }, 300);
  warm.unref();
  data.startBackground(log);

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      if (parentTimer) clearInterval(parentTimer);
      server.close();
      for (const s of sockets) s.destroy();
      await app.close();
      removeRunFile(layout.runFile);
      lock.release();
      log.info('server.stopped', {});
    })();
    return closing;
  };

  // The shell's pid: when it is gone (a crash, kill -9), stop within 10 s (server O11).
  let parentTimer: NodeJS.Timeout | null = null;
  const parent = opts.parentPid ?? null;
  if (parent && parent > 0) {
    const startPpid = process.ppid;
    parentTimer = setInterval(() => {
      let alive = true;
      try { process.kill(parent, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code === 'EPERM'; }
      if (parent === startPpid && process.ppid !== startPpid) alive = false;
      if (!alive) {
        log.warn('parent.gone', {});
        void close().then(() => opts.onStop?.('parent gone'));
      }
    }, 1000);
    parentTimer.unref();
  }

  return { port, origin, uiUrl: `${origin}/#token=${opts.launchToken}`, close };
}

export { holderAlive };
