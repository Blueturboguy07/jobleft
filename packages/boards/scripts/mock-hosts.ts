#!/usr/bin/env node
// Loopback mock hosts for tests and README demos: a Greenhouse, Lever and Ashby job-board API, their public board
// pages, and a host for employer careers pages. Every request is logged (time, host, method, path, headers).
//
//   node scripts/mock-hosts.ts --config <file.json> [--log <requests.ndjson>]
// prints the JOBLEFT_HOST_MAP to use, then serves until stopped (Ctrl-C).
//
// Config: {
//   "boards": { "greenhouse:acme": { "name": "Acme Corp", "jobs": 5, "script": ["ok"] }, "lever:beta": {...}, ... },
//   "pages":  { "/acme.html": "<html>...</html>", ... },          served on the careers host (careers.mock.example)
//   "redirects": { "/old": "https://boards.greenhouse.io/acme" }, 302 answers on the careers host
//   "robots": { "careers.mock.example": "User-agent: *\nDisallow: /private" }
// }
// A board's "script" is the answer to each successive list request; the last step repeats. Steps: ok, 404, 500,
// 403, timeout (no answer for 30 s), empty (a valid empty list), broken (not JSON), 429:<seconds> (Retry-After).
// "jobs" is a count, or a list of job ids.

import { createServer, type Server } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

export type Step = string;
export interface MockBoard { name?: string; jobs?: number | string[]; script?: Step[]; pageTitle?: string }
export interface MockConfig {
  boards?: Record<string, MockBoard>;
  pages?: Record<string, string>;
  redirects?: Record<string, string>;
  robots?: Record<string, string>;
}
export interface MockRequest { at: number; host: string; method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }

export const MOCK_HOSTS = [
  'boards-api.greenhouse.io', 'boards-api.eu.greenhouse.io', 'api.lever.co', 'api.eu.lever.co', 'api.ashbyhq.com',
  'jobs.lever.co', 'jobs.eu.lever.co', 'jobs.ashbyhq.com', 'careers.mock.example',
] as const;

export interface MockHosts {
  hostMap: Record<string, string>;
  log: MockRequest[];
  config: MockConfig;
  /** Requests to one board's list endpoint. */
  listRequests(boardKey: string): MockRequest[];
  setBoard(key: string, b: MockBoard): void;
  close(): Promise<void>;
}

function jobIds(b: MockBoard): string[] {
  if (Array.isArray(b.jobs)) return b.jobs.map(String);
  return Array.from({ length: b.jobs ?? 3 }, (_, i) => String(1000 + i));
}

function greenhouseJobs(key: string, b: MockBoard): unknown {
  const token = key.split(':').pop()!;
  return { jobs: jobIds(b).map((id) => ({
    id: Number(id) || id, title: `Role ${id}`, absolute_url: `https://job-boards.greenhouse.io/${token}/jobs/${id}`,
    location: { name: 'Austin, TX' }, content: `&lt;p&gt;Job ${id} at ${b.name ?? token}&lt;/p&gt;`,
    updated_at: '2026-09-01T00:00:00Z', first_published: '2026-09-01T00:00:00Z', ...(b.name ? { company_name: b.name } : {}),
  })), meta: { total: jobIds(b).length } };
}
function leverJobs(key: string, b: MockBoard): unknown {
  const site = key.split(':').pop()!;
  return jobIds(b).map((id) => ({
    id: `0000${id}-0000-4000-8000-000000000000`.slice(-36), text: `Role ${id}`, hostedUrl: `https://jobs.lever.co/${site}/${id}`,
    applyUrl: `https://jobs.lever.co/${site}/${id}/apply`, categories: { location: 'Austin, TX', commitment: 'Full-time' },
    description: `<p>Job ${id}</p>`, lists: [], additional: '', createdAt: 1756684800000, workplaceType: 'onsite',
  }));
}
function ashbyJobs(key: string, b: MockBoard): unknown {
  const name = key.split(':').pop()!;
  return { jobs: jobIds(b).map((id) => ({
    id: `a${id}`, title: `Role ${id}`, jobUrl: `https://jobs.ashbyhq.com/${name}/a${id}`, applyUrl: `https://jobs.ashbyhq.com/${name}/a${id}/application`,
    location: 'Austin, TX', descriptionHtml: `<p>Job ${id}</p>`, publishedAt: '2026-09-01T00:00:00Z', isListed: true, workplaceType: 'OnSite',
  })) };
}

export async function startMockHosts(config: MockConfig, opts: { logFile?: string } = {}): Promise<MockHosts> {
  const log: MockRequest[] = [];
  const steps = new Map<string, number>();
  const servers: Server[] = [];
  const hostMap: Record<string, string> = {};
  const cfg: MockConfig = { boards: {}, pages: {}, redirects: {}, robots: {}, ...config };

  const listKey = (host: string, path: string): string | null => {
    let m: RegExpExecArray | null;
    if ((m = /^\/v1\/boards\/([^/?]+)\/jobs$/.exec(path))) return `greenhouse:${host.includes('.eu.') ? 'eu:' : ''}${decodeURIComponent(m[1]!).toLowerCase()}`;
    if ((m = /^\/v0\/postings\/([^/?]+)$/.exec(path))) return `lever:${host.includes('.eu.') ? 'eu:' : ''}${decodeURIComponent(m[1]!).toLowerCase()}`;
    if ((m = /^\/posting-api\/job-board\/([^/?]+)$/.exec(path))) return `ashby:${decodeURIComponent(m[1]!).toLowerCase()}`;
    return null;
  };

  for (const host of MOCK_HOSTS) {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://x');
        const entry: MockRequest = { at: Date.now(), host, method: req.method ?? 'GET', path: url.pathname + url.search, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
        log.push(entry);
        if (opts.logFile) appendFileSync(opts.logFile, JSON.stringify({ ...entry, at: new Date(entry.at).toISOString() }) + '\n');
        const json = (status: number, v: unknown, h: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(v)); };
        const html = (status: number, v: string) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(v); };
        if (url.pathname === '/robots.txt') {
          const r = cfg.robots?.[host];
          if (r === undefined) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(r); }
          return;
        }
        const key = listKey(host, url.pathname);
        if (key) {
          const b = cfg.boards?.[key];
          if (!b) return json(404, { ok: false, error: 'Document not found' });
          const script = b.script?.length ? b.script : ['ok'];
          const i = steps.get(key) ?? 0;
          steps.set(key, i + 1);
          const step = script[Math.min(i, script.length - 1)]!;
          if (step === '404') return json(404, { ok: false, error: 'Document not found' });
          if (step === '500') return json(500, { error: 'server' });
          if (step === '403') return json(403, { error: 'forbidden' });
          if (step === 'timeout') { setTimeout(() => { try { json(200, []); } catch { /* client gone */ } }, 30_000).unref(); return; }
          if (step === 'broken') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"jobs": [ {"id": 1, "tit'); return; }
          if (step.startsWith('429')) return json(429, { error: 'slow down' }, { 'retry-after': step.split(':')[1] ?? '5' });
          const empty = step === 'empty';
          const ats = key.split(':')[0];
          const bb = empty ? { ...b, jobs: 0 } : b;
          return json(200, ats === 'greenhouse' ? greenhouseJobs(key, bb) : ats === 'lever' ? leverJobs(key, bb) : ashbyJobs(key, bb));
        }
        let m: RegExpExecArray | null;
        if ((m = /^\/v1\/boards\/([^/?]+)$/.exec(url.pathname))) {
          const b = cfg.boards?.[`greenhouse:${host.includes('.eu.') ? 'eu:' : ''}${m[1]!.toLowerCase()}`];
          return b ? json(200, { name: b.name ?? '', content: '' }) : json(404, { status: 404, error: 'Job not found' });
        }
        if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co' || host === 'jobs.ashbyhq.com') {
          const seg = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
          const ats = host.includes('lever') ? 'lever' : 'ashby';
          const b = cfg.boards?.[`${ats}:${host.includes('.eu.') ? 'eu:' : ''}${seg}`];
          if (!b || !b.pageTitle) return html(404, '<title>Not found</title>');
          return html(200, `<html><head><title>${b.pageTitle}${ats === 'ashby' ? ' Jobs' : ''}</title></head><body></body></html>`);
        }
        if (host === 'careers.mock.example') {
          const to = cfg.redirects?.[url.pathname];
          if (to) { res.writeHead(302, { location: to }); res.end(); return; }
          const page = cfg.pages?.[url.pathname];
          if (page !== undefined) return html(200, page);
          return html(404, '<title>Not found</title><h1>Page not found</h1>');
        }
        return json(404, { error: 'unknown path' });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    servers.push(server);
    hostMap[host] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  return {
    hostMap, log, config: cfg,
    listRequests: (k: string) => log.filter((e) => listKey(e.host, e.path.split('?')[0]!) === k.toLowerCase()),
    setBoard: (k: string, b: MockBoard) => { cfg.boards![k.toLowerCase()] = b; steps.delete(k.toLowerCase()); },
    close: async () => { for (const s of servers) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); } },
  };
}

if (process.argv[1]?.endsWith('mock-hosts.ts')) {
  const i = process.argv.indexOf('--config');
  const l = process.argv.indexOf('--log');
  const config = i > 0 ? JSON.parse(readFileSync(process.argv[i + 1]!, 'utf8')) as MockConfig : {};
  const m = await startMockHosts(config, l > 0 ? { logFile: process.argv[l + 1]! } : {});
  console.log(`JOBLEFT_HOST_MAP='${JSON.stringify(m.hostMap)}'`);
  console.error('Mock hosts are running on loopback. Stop with Ctrl-C.');
}
