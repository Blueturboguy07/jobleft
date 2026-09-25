// A loopback HTTP server for the store's routes of the local API (docs/INTERFACES.md section 6), so the store can be
// driven and timed end to end before the app server lane wires it. Same paths, bodies, answers and error shapes.
// Rules kept from section 6.1: 127.0.0.1 only; Host must be 127.0.0.1:<port> or localhost:<port>; any Origin is
// refused; every route but health needs x-jobleft-token; writes take application/json only; 1 MiB body limit;
// inputs are validated before any work; errors never echo the request; logs hold no search words or profile text.
// Fit indexing runs in the background (the ONNX work runs on its own threads, so searches are not blocked).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ERROR_STATUS, JSON_BODY_LIMIT, LAUNCH_TOKEN_HEADER, validate, nowMs,
  JobSearchRequestSchema, JobFilterSchema, JobSortSchema, ProfileInputSchema, TrackerPatchSchema, TrackerViewSchema, TrackerStatusSchema,
  type ErrorCode, type JobDetail, type JobSearchRequest,
} from '@jobleft/contracts';
import { StoreError } from './db.ts';
import { h1bTagOf } from './search.ts';
import type { StoreService } from './service.ts';

export interface ServeOptions {
  port?: number;
  token?: string;
  /** Download the fit model when it is missing (never when offline). Default true. */
  download?: boolean;
  quiet?: boolean;
}

class HttpError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) { super(message); this.code = code; }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': headers['content-type'] ?? 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(data);
}

function sendError(res: ServerResponse, code: ErrorCode, message: string): void {
  send(res, ERROR_STATUS[code], { error: { code, message } });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const ct = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (ct !== 'application/json') throw new HttpError('unsupported_media_type', 'Send the body as application/json.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > JSON_BODY_LIMIT) throw new HttpError('payload_too_large', 'The body is larger than 1 MiB.');
    chunks.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError('bad_request', 'The body is not valid JSON.'); }
}

function check<T>(schema: Parameters<typeof validate>[0], value: unknown, what: string): T {
  const v = validate(schema, value);
  if (!v.ok) throw new HttpError('bad_request', `The ${what} is not valid (${v.issues[0]!.path || what}: ${v.issues[0]!.message}).`);
  return v.value as T;
}

function tokenOk(given: string | string[] | undefined, want: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function serve(svc: StoreService, opts: ServeOptions = {}): Promise<{ port: number; token: string; close(): Promise<void> }> {
  const token = opts.token ?? randomBytes(24).toString('base64url');
  const log = (line: string) => { if (!opts.quiet) process.stderr.write(`${new Date().toISOString()} ${line}\n`); };
  const t0 = performance.now();
  svc.jobs.mem.refresh();
  log(`store loaded: ${svc.jobs.mem.openCount} open jobs in ${Math.round(performance.now() - t0)} ms`);

  // ---- background: vectors, model, fit indexing
  let stopping = false;
  const abort = new AbortController();
  let indexing: Promise<unknown> | null = null;
  const background = async () => {
    // Vectors load after the filter arrays, so word and filter searches are ready first.
    await new Promise((r) => setImmediate(r));
    svc.fit.refresh();
    await svc.refreshModelState();
    const wantModel = opts.download !== false && svc.jobs.mem.openCount > 0;
    await svc.loadModel({ download: wantModel });
    if (svc.hasModel()) { log('fit model ready'); await svc.warmFit().catch(() => undefined); }
    else log(`fit model not ready (${svc.modelState}${svc.modelProblem ? `: ${svc.modelProblem}` : ''})`);
  };
  // A run starts at launch (it records 0 when nothing waits), after every data change (not after the run's own
  // vector writes), and when jobs wait that the last run did not see (for example Top Matched asked for them).
  let lastGen = -1;
  let lastWaiting = -1;
  const tick = async () => {
    if (stopping || indexing) return;
    svc.jobs.mem.refresh();
    const gen = svc.jobs.mem.generation;
    const waiting = svc.fit.counts().waiting;
    const due = gen !== lastGen || (waiting > 0 && waiting !== lastWaiting);
    if (!due) return;
    if (!svc.hasModel()) {
      if (svc.modelState !== 'downloading' && opts.download !== false && svc.jobs.mem.openCount > 0 && svc.modelState !== 'failed') await svc.loadModel({ download: true });
      if (!svc.hasModel()) return;
    }
    lastGen = gen;
    indexing = svc.fit.runAll(abort.signal)
      .then((r) => { if (r.indexed > 0) log(`fit indexing: ${r.indexed} jobs indexed`); })
      .catch((e: unknown) => log(`fit indexing stopped: ${e instanceof Error ? e.message : 'error'}`))
      .finally(() => { indexing = null; lastWaiting = svc.fit.counts().waiting; });
  };
  const bg = background().then(() => tick()).catch(() => undefined);
  const timer = setInterval(() => { void tick(); }, 2000);

  // ---- routes
  type Handler = (req: IncomingMessage, params: string[], url: URL) => Promise<unknown>;
  const routes: Array<{ method: string; re: RegExp; name: string; fn: Handler }> = [];
  const route = (method: string, path: string, name: string, fn: Handler) => {
    routes.push({ method, re: new RegExp(`^${path.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`), name, fn });
  };

  route('GET', '/api/v1/health', 'health', async () => ({ app: 'jobleft', version: '0.1.0', apiVersion: 1, extensionProtocol: 1 }));
  route('GET', '/api/v1/storage', 'storage', async () => svc.jobs.storage(svc.dbPath, svc.h.home));
  route('GET', '/api/v1/index/status', 'fitIndexStatus', async () => svc.fit.status());
  route('POST', '/api/v1/jobs/search', 'searchJobs', async (req) => {
    const body = check<JobSearchRequest>(JobSearchRequestSchema, await readJson(req), 'search request');
    const ctx = await svc.searchContext(nowMs());
    return svc.jobs.search(body, ctx);
  });
  route('GET', '/api/v1/jobs', 'listJobs', async (_req, _p, url) => {
    const q = url.searchParams;
    const sort = q.get('sort') ?? 'recommended';
    check(JobSortSchema, sort, 'sort');
    const limit = q.get('limit');
    if (limit !== null && !/^[0-9]{1,6}$/.test(limit)) throw new HttpError('bad_request', 'limit must be digits.');
    const defId = svc.settings.getJson<string>('store.defaultFilterId');
    const def = defId ? svc.filters.get(defId)?.filter ?? {} : {};
    const status = q.get('status');
    const body: JobSearchRequest = { sort: sort as JobSearchRequest['sort'], filter: status === 'open' || status === 'closed' ? { ...def, status } : def };
    if (q.get('q') !== null) body.q = q.get('q')!;
    if (q.get('cursor')) body.cursor = q.get('cursor')!;
    if (limit) body.limit = Number(limit);
    check(JobSearchRequestSchema, body, 'search request');
    return svc.jobs.search(body, await svc.searchContext(nowMs()));
  });
  route('GET', '/api/v1/jobs/:jobId', 'getJob', async (_req, p) => {
    const id = decodeURIComponent(p[0]!);
    const job = svc.jobs.get(id);
    if (!job) throw new HttpError('not_found', 'There is no job with this id.');
    const rid = (svc.db.prepare('SELECT k.rid AS rid FROM job_keys k WHERE k.key = ?').get(`id:${id}`) as { rid: number } | undefined)?.rid;
    const mem = svc.jobs.mem;
    let tag: JobDetail['h1bTag'] = null;
    if (rid !== undefined) {
      const co = mem.companyTag[Number(rid)] ?? -1;
      tag = h1bTagOf(mem.stmt[Number(rid)] ?? 0, co >= 0 && mem.companies.get(co)?.h1b === 'likely');
    }
    const detail: JobDetail = { job, company: null, match: null, tracker: svc.tracker.get(job.id), networkCount: null, h1bTag: tag };
    return detail;
  });
  route('GET', '/api/v1/tracker', 'listTracker', async (_req, _p, url) => {
    const view = check<string>(TrackerViewSchema, url.searchParams.get('view'), 'view');
    const status = url.searchParams.get('status');
    if (status !== null) check(TrackerStatusSchema, status, 'status');
    return svc.tracker.list(view as 'liked', (status ?? undefined) as 'applied' | undefined);
  });
  route('PATCH', '/api/v1/tracker/:jobId', 'updateTracker', async (req, p) => {
    const body = check<Record<string, unknown>>(TrackerPatchSchema, await readJson(req), 'tracker change');
    return svc.tracker.patch(decodeURIComponent(p[0]!), body, nowMs());
  });
  const filterBody = async (req: IncomingMessage) => {
    const b = await readJson(req) as { name?: unknown; filter?: unknown; sort?: unknown; alert?: unknown };
    if (!b || typeof b !== 'object') throw new HttpError('bad_request', 'The body must be an object.');
    if (typeof b.name !== 'string' || b.name.length < 1 || b.name.length > 120) throw new HttpError('bad_request', 'name must be 1 to 120 characters.');
    check(JobFilterSchema, b.filter, 'filter');
    check(JobSortSchema, b.sort, 'sort');
    if (b.alert !== undefined && typeof b.alert !== 'boolean') throw new HttpError('bad_request', 'alert must be true or false.');
    return b as { name: string; filter: never; sort: never; alert?: boolean };
  };
  route('GET', '/api/v1/filters', 'listFilters', async () => svc.filters.list());
  route('POST', '/api/v1/filters', 'createFilter', async (req) => svc.filters.create(await filterBody(req), nowMs()));
  route('PUT', '/api/v1/filters/:filterId', 'updateFilter', async (req, p) => svc.filters.update(decodeURIComponent(p[0]!), await filterBody(req), nowMs()));
  route('DELETE', '/api/v1/filters/:filterId', 'deleteFilter', async (_req, p) => {
    if (!svc.filters.delete(decodeURIComponent(p[0]!))) throw new HttpError('not_found', 'There is no saved filter with this id.');
    return { ok: true };
  });
  route('GET', '/api/v1/profile', 'getProfile', async () => svc.profiles.get());
  route('PUT', '/api/v1/profile', 'putProfile', async (req) => {
    const body = check<never>(ProfileInputSchema, await readJson(req), 'profile');
    const p = svc.profiles.put(body, '', nowMs());
    // The new profile vector is made on the next fit search (or now, when the model is loaded).
    setImmediate(() => { void svc.warmFit().catch(() => undefined); });
    return p;
  });
  route('GET', '/api/v1/export/jobs', 'exportJobs', async () => {
    const lines = [...svc.jobs.exportSaved()];
    return { __file: `${lines.join('\n')}${lines.length ? '\n' : ''}` };
  });

  let port = 0;
  const server = createServer((req, res) => {
    const started = performance.now();
    let routeName = 'unknown';
    const finish = (status: number) => log(`${req.method} ${routeName} ${status} ${Math.round(performance.now() - started)}ms`);
    void (async () => {
      try {
        const host = req.headers.host ?? '';
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError('forbidden_host', 'This server answers only on 127.0.0.1 or localhost.');
        if (req.headers.origin !== undefined) throw new HttpError('forbidden_origin', 'Requests from web pages are refused.');
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (url.searchParams.has('token')) throw new HttpError('unauthorized', 'A token in the address is refused; send it in the header.');
        const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
        if (!r) throw new HttpError('not_found', 'There is no such route.');
        routeName = r.name;
        if (r.name !== 'health' && !tokenOk(req.headers[LAUNCH_TOKEN_HEADER], token)) throw new HttpError('unauthorized', 'The token is missing or wrong.');
        const params = r.re.exec(url.pathname)!.slice(1);
        const result = await r.fn(req, params, url);
        if (result && typeof result === 'object' && '__file' in (result as Record<string, unknown>)) {
          send(res, 200, (result as { __file: string }).__file, { 'content-type': 'application/x-ndjson', 'content-disposition': 'attachment; filename="jobleft-saved-jobs.ndjson"' });
        } else send(res, 200, result);
        finish(200);
      } catch (e) {
        let code: ErrorCode = 'internal';
        let msg = 'Something went wrong in the store.';
        if (e instanceof HttpError) { code = e.code; msg = e.message; }
        else if (e instanceof StoreError) { code = e.code; msg = e.message; }
        sendError(res, code, msg);
        finish(ERROR_STATUS[code]);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 47850, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;
  const runFile = join(svc.h.run, 'store-serve.json');
  try { writeFileSync(runFile, JSON.stringify({ pid: process.pid, port, token, startedAt: new Date().toISOString() }), { mode: 0o600 }); } catch { /* memory store */ }
  log(`listening on http://127.0.0.1:${port} (token in ${runFile})`);
  if (!opts.quiet) process.stdout.write(`${JSON.stringify({ port, token, runFile })}\n`);

  const close = async () => {
    stopping = true;
    clearInterval(timer);
    abort.abort();
    await Promise.race([indexing ?? Promise.resolve(), new Promise((r) => setTimeout(r, 3000))]);
    await new Promise<void>((r) => server.close(() => r()));
    try { rmSync(runFile, { force: true }); } catch { /* ignore */ }
    await bg;
    await svc.close();
  };
  const onSignal = () => { void close().then(() => process.exit(0)); };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  return { port, token, close };
}
