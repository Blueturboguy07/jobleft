#!/usr/bin/env node
// A mock ATS server for tests and demos. It answers like Greenhouse, Lever and Ashby on ONE loopback port, logs every
// request (time, method, path, headers), supports ETag / If-None-Match (304), and can misbehave on purpose.
//
// Library:  const m = await startMockBoards({ boards: { acme: { ats: 'greenhouse', jobs: [...] } } }); ... await m.close();
// CLI:      node packages/crawler/testkit/mock-boards.ts --port 4010 --boards mock.json [--log requests.ndjson] [--robots robots.txt]
//           The boards file is read again on every request, so a test can edit it while the server runs.
//
// Paths served (the real API paths):
//   Greenhouse  GET /v1/boards/<token>/jobs            -> { "jobs": [...], "meta": { "total": n } }
//   Lever       GET /v0/postings/<site>                 -> [ ... ]
//   Ashby       GET /posting-api/job-board/<name>       -> { "jobs": [...] }
//   robots      GET /robots.txt                         -> 404 unless set
//
// A board's "mode" makes it misbehave: ok (default), error500, error503, timeout, slow, cutoff, html, empty, notfound,
// forbidden403, ratelimit429 (with "retryAfter" seconds), redirect (to "redirectTo"), redirectLoop, huge, junk, broken.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface MockJob {
  id: string | number;
  title: string;
  /** One place, or several. Omit for "no place stated". */
  location?: string | string[];
  description?: string;
  /** ISO date-time. Omit for "no posted date". */
  postedAt?: string;
  updatedAt?: string;
  /** The job page on the employer's site; default: a page on the mock server. */
  url?: string;
  applyUrl?: string;
  /** Structured pay in the board's own format. */
  pay?: { min: number; max: number; currency?: string; period: 'hour' | 'year' | 'month' };
  workplaceType?: 'Remote' | 'Hybrid' | 'OnSite';
  commitment?: string;
  department?: string;
  /** Served exactly as given (bypasses the fields above). */
  raw?: Record<string, unknown>;
}

export type MockMode = 'ok' | 'error500' | 'error503' | 'timeout' | 'slow' | 'cutoff' | 'html' | 'empty' | 'notfound' | 'forbidden403'
  | 'ratelimit429' | 'redirect' | 'redirectLoop' | 'huge' | 'junk' | 'broken';

export interface MockBoard {
  ats: 'greenhouse' | 'lever' | 'ashby';
  jobs: MockJob[];
  mode?: MockMode;
  retryAfter?: number;
  redirectTo?: string;
  /** Send ETag and honour If-None-Match. Default true. */
  etag?: boolean;
  /** Number of junk postings for mode "junk". Default 50,000. */
  junkCount?: number;
  /** Megabytes for mode "huge". Default 500. */
  hugeMB?: number;
}

export interface MockRequest { t: number; method: string; path: string; headers: Record<string, string | string[] | undefined>; status: number }

export interface MockServerOptions {
  port?: number;
  boards?: Record<string, MockBoard>;
  /** A JSON file { "<token>": MockBoard } read on every request (CLI use). */
  boardsFile?: string;
  robots?: { status: number; body: string } | null;
  /** Append each request as one JSON line. */
  logFile?: string;
}

export interface MockServer {
  origin: string;
  port: number;
  requests: MockRequest[];
  boards: Record<string, MockBoard>;
  robots: { status: number; body: string } | null;
  close(): Promise<void>;
}

function html(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function places(j: MockJob): string[] { return j.location === undefined ? [] : Array.isArray(j.location) ? j.location : [j.location]; }

function toGreenhouse(j: MockJob, origin: string, token: string): Record<string, unknown> {
  if (j.raw) return j.raw;
  const p = places(j);
  const o: Record<string, unknown> = {
    id: j.id, title: j.title, absolute_url: j.url ?? `${origin}/jobs/${token}/${j.id}`,
    location: { name: p.join('; ') }, content: html(j.description ?? ''), departments: j.department ? [{ name: j.department }] : [],
    offices: [], metadata: j.commitment ? [{ name: 'Employment Type', value: j.commitment }] : [], company_name: token,
  };
  if (j.postedAt) o.first_published = j.postedAt;
  if (j.updatedAt) o.updated_at = j.updatedAt;
  if (j.pay) o.pay_input_ranges = [{ min_cents: j.pay.min * 100, max_cents: j.pay.max * 100, currency_type: j.pay.currency ?? 'USD', title: j.pay.period === 'hour' ? 'Hourly pay' : j.pay.period === 'month' ? 'Monthly pay' : 'Annual salary', blurb: '' }];
  return o;
}

function toLever(j: MockJob, origin: string, token: string): Record<string, unknown> {
  if (j.raw) return j.raw;
  const p = places(j);
  const o: Record<string, unknown> = {
    id: String(j.id), text: j.title, hostedUrl: j.url ?? `${origin}/jobs/${token}/${j.id}`, applyUrl: j.applyUrl ?? `${origin}/jobs/${token}/${j.id}/apply`,
    categories: { location: p[0] ?? '', allLocations: p, commitment: j.commitment ?? '', department: j.department ?? '' },
    description: j.description ?? '', lists: [], additional: '',
  };
  if (j.postedAt) o.createdAt = Date.parse(j.postedAt);
  if (j.workplaceType) o.workplaceType = j.workplaceType.toLowerCase() === 'onsite' ? 'onsite' : j.workplaceType.toLowerCase();
  if (j.pay) o.salaryRange = { min: j.pay.min, max: j.pay.max, currency: j.pay.currency ?? 'USD', interval: j.pay.period === 'hour' ? 'per-hour-wage' : j.pay.period === 'month' ? 'per-month-salary' : 'per-year-salary' };
  return o;
}

function toAshby(j: MockJob, origin: string, token: string): Record<string, unknown> {
  if (j.raw) return j.raw;
  const p = places(j);
  const o: Record<string, unknown> = {
    id: String(j.id), title: j.title, jobUrl: j.url ?? `${origin}/jobs/${token}/${j.id}`, applyUrl: j.applyUrl ?? `${origin}/jobs/${token}/${j.id}/application`,
    location: p[0] ?? '', secondaryLocations: p.slice(1).map((l) => ({ location: l })), descriptionHtml: j.description ?? '',
    employmentType: j.commitment ?? '', department: j.department ?? '', isListed: true,
  };
  if (j.postedAt) o.publishedAt = j.postedAt;
  if (j.workplaceType) o.workplaceType = j.workplaceType;
  if (j.pay) {
    o.compensation = { compensationTiers: [{ components: [{ compensationType: 'Salary', interval: j.pay.period === 'hour' ? '1 HOUR' : j.pay.period === 'month' ? '1 MONTH' : '1 YEAR', currencyCode: j.pay.currency ?? 'USD', minValue: j.pay.min, maxValue: j.pay.max }] }] };
  }
  return o;
}

function bodyFor(b: MockBoard, origin: string, token: string): unknown {
  const jobs = b.mode === 'empty' ? [] : b.jobs;
  if (b.ats === 'greenhouse') return { jobs: jobs.map((j) => toGreenhouse(j, origin, token)), meta: { total: jobs.length } };
  if (b.ats === 'lever') return jobs.map((j) => toLever(j, origin, token));
  return { jobs: jobs.map((j) => toAshby(j, origin, token)) };
}

function route(path: string): { ats: MockBoard['ats']; token: string } | null {
  let m = /^\/v1\/boards\/([^/]+)\/jobs$/.exec(path);
  if (m) return { ats: 'greenhouse', token: decodeURIComponent(m[1]!) };
  m = /^\/v0\/postings\/([^/]+)$/.exec(path);
  if (m) return { ats: 'lever', token: decodeURIComponent(m[1]!) };
  m = /^\/posting-api\/job-board\/([^/]+)$/.exec(path);
  if (m) return { ats: 'ashby', token: decodeURIComponent(m[1]!) };
  return null;
}

export async function startMockBoards(opts: MockServerOptions = {}): Promise<MockServer> {
  const requests: MockRequest[] = [];
  const state = { boards: opts.boards ?? {}, robots: opts.robots ?? null };
  const sockets = new Set<import('node:net').Socket>();
  let origin = '';
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const log = (status: number) => {
      const entry: MockRequest = { t: Date.now(), method: req.method ?? 'GET', path: url.pathname + url.search, headers: req.headers, status };
      requests.push(entry);
      if (opts.logFile) appendFileSync(opts.logFile, JSON.stringify(entry) + '\n');
    };
    let boards = state.boards;
    if (opts.boardsFile) {
      try { boards = JSON.parse(readFileSync(opts.boardsFile, 'utf8')) as Record<string, MockBoard>; } catch { boards = {}; }
    }
    if (url.pathname === '/robots.txt') {
      const r = state.robots;
      if (!r) { log(404); res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no robots.txt'); return; }
      log(r.status); res.writeHead(r.status, { 'content-type': 'text/plain' }); res.end(r.body); return;
    }
    const rt = route(url.pathname);
    const b = rt ? boards[rt.token] : undefined;
    if (!rt || !b || b.ats !== rt.ats) { log(404); res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}'); return; }
    const mode = b.mode ?? 'ok';
    switch (mode) {
      case 'error500': log(500); res.writeHead(500, { 'content-type': 'text/plain' }); res.end('internal error'); return;
      case 'error503': log(503); res.writeHead(503, b.retryAfter !== undefined ? { 'retry-after': String(b.retryAfter) } : {}); res.end('unavailable'); return;
      case 'notfound': log(404); res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"board not found"}'); return;
      case 'forbidden403': log(403); res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden'); return;
      case 'ratelimit429': log(429); res.writeHead(429, b.retryAfter !== undefined ? { 'retry-after': String(b.retryAfter) } : {}); res.end('too many requests'); return;
      case 'redirect': log(302); res.writeHead(302, { location: b.redirectTo ?? 'https://www.linkedin.com/jobs/view/1' }); res.end(); return;
      case 'redirectLoop': log(302); res.writeHead(302, { location: url.pathname + url.search }); res.end(); return;
      case 'html': log(200); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html><body><h1>Sign in</h1><form>...</form></body></html>'); return;
      case 'broken': log(200); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"jobs": [{"id": 1,, "title": }'); return;
      case 'timeout': log(0); return; // never answers; the socket stays open until the client gives up
      case 'huge': {
        log(200);
        res.writeHead(200, { 'content-type': 'application/json' });
        const chunk = Buffer.alloc(1024 * 1024, 0x20);
        let sent = 0;
        const total = (b.hugeMB ?? 500);
        res.write('{"jobs": [');
        const pump = () => {
          while (sent < total) {
            sent++;
            if (!res.write(chunk)) { res.once('drain', pump); return; }
          }
          res.end(']}');
        };
        res.on('close', () => { sent = total; });
        pump();
        return;
      }
      case 'junk': {
        log(200);
        const n = b.junkCount ?? 50_000;
        const jobs = Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `junk ${i}`, absolute_url: `${origin}/j/${i}`, location: { name: '' }, content: '' }));
        const body = rt.ats === 'lever' ? jobs.map((j) => ({ id: String(j.id), text: j.title, hostedUrl: j.absolute_url, categories: {} }))
          : rt.ats === 'ashby' ? { jobs: jobs.map((j) => ({ id: String(j.id), title: j.title, jobUrl: j.absolute_url })) }
          : { jobs, meta: { total: n } };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      default: break;
    }
    const body = JSON.stringify(bodyFor(b, origin, rt.token));
    const tag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
    if ((b.etag ?? true) && mode === 'ok' && req.headers['if-none-match'] === tag) {
      log(304); res.writeHead(304, { etag: tag }); res.end(); return;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (b.etag ?? true) headers.etag = tag;
    if (mode === 'cutoff') {
      log(200);
      headers['content-length'] = String(Buffer.byteLength(body));
      res.writeHead(200, headers);
      res.write(body.slice(0, Math.floor(body.length / 2)));
      setTimeout(() => res.socket?.destroy(), 50);
      return;
    }
    if (mode === 'slow') {
      log(200);
      res.writeHead(200, headers);
      let i = 0;
      const t = setInterval(() => {
        if (i >= body.length || res.destroyed) { clearInterval(t); if (!res.destroyed) res.end(); return; }
        res.write(body[i++]!);
      }, 1000);
      res.on('close', () => clearInterval(t));
      return;
    }
    log(200);
    res.writeHead(200, headers);
    res.end(body);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  origin = `http://127.0.0.1:${port}`;
  return {
    origin, port, requests,
    get boards() { return state.boards; },
    set boards(v) { state.boards = v; },
    get robots() { return state.robots; },
    set robots(v) { state.robots = v; },
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  } as MockServer;
}

// ---------------------------------------------------------------------------------------------------- CLI

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const port = Number(get('port') ?? 4010);
  const boardsFile = get('boards');
  const robotsFile = get('robots');
  const logFile = get('log');
  const m = await startMockBoards({
    port, boardsFile, logFile,
    robots: robotsFile ? { status: 200, body: readFileSync(robotsFile, 'utf8') } : null,
  });
  console.log(`mock boards on ${m.origin} (boards file: ${boardsFile ?? 'none'}; log: ${logFile ?? 'memory'})`);
  const stop = () => { void m.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
