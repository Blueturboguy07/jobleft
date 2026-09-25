// Stand-in feeds for every other source (sources-other O15): one loopback HTTP server per real host, answering the
// same paths as the real API from editable fixture files, with switchable failures, and a log of every request.
//
//   <dir>/scenarios.json        {"remoteok": "ok", "themuse": "http500", ...}   read on every request
//   <dir>/<sourceId>.json       the feed's answer (edit it between refreshes; read on every request)
//   <dir>/gh-speedyapply-*/     the four markdown files of a speedyapply list
//   <dir>/robots/<host>.txt     optional robots.txt for a host (absent = 404 = no rules)
//   <dir>/requests.ndjson       one line per request: time, real host, path, query and headers (keys redacted), status
//   <dir>/hostmap.json          the JOBLEFT_HOST_MAP value that sends each real host here
//
// Scenarios: ok, empty, http500, http503, http429, http403, http401, http404, hang, slow, html, notjson, renamed,
// truncated, cutoff, redirect, page2fail. The stand-in binds 127.0.0.1 only and never contacts anything.

import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GITHUB_LISTS } from './feeds/github.ts';

export const SCENARIOS = ['ok', 'empty', 'http500', 'http503', 'http429', 'http403', 'http401', 'http404', 'hang', 'slow', 'html', 'notjson', 'renamed', 'truncated', 'cutoff', 'redirect', 'page2fail'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const STANDIN_HOSTS = ['remoteok.com', 'www.themuse.com', 'hn.algolia.com', 'raw.githubusercontent.com', 'remotive.com', 'data.usajobs.gov'] as const;
const SOURCE_IDS = ['remoteok', 'themuse', 'hn-whoishiring', ...GITHUB_LISTS.map((l) => l.id), 'remotive', 'usajobs'];

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(PKG, 'fixtures');

/** Copies the lane's fixtures into a stand-in folder (only the files that are missing). */
export function seedStandinDir(dir: string): void {
  mkdirSync(join(dir, 'robots'), { recursive: true });
  const copy = (from: string, to: string) => { if (!existsSync(join(dir, to))) cpSync(join(FIXTURES, from), join(dir, to), { recursive: true }); };
  copy('remoteok/api.json', 'remoteok.json');
  copy('themuse/jobs.json', 'themuse.json');
  copy('hn/search.json', 'hn-search.json');
  copy('hn/item.json', 'hn-item.json');
  copy('github/simplify-listings.json', 'gh-simplify-internships.json');
  copy('github/vanshb03-internships.json', 'gh-vanshb03-internships.json');
  copy('github/vanshb03-newgrad.json', 'gh-vanshb03-newgrad.json');
  copy('github/speedyapply-swe', 'gh-speedyapply-swe');
  copy('github/speedyapply-ai', 'gh-speedyapply-ai');
  copy('remotive/remote-jobs.json', 'remotive.json');
  copy('usajobs/search.json', 'usajobs.json');
  const sc = join(dir, 'scenarios.json');
  if (!existsSync(sc)) writeFileSync(sc, JSON.stringify(Object.fromEntries(SOURCE_IDS.map((id) => [id, 'ok'])), null, 2) + '\n');
}

export function setScenario(dir: string, sourceId: string, scenario: string): void {
  if (!SOURCE_IDS.includes(sourceId)) throw new Error(`unknown source "${sourceId}" (known: ${SOURCE_IDS.join(', ')})`);
  if (!(SCENARIOS as readonly string[]).includes(scenario)) throw new Error(`unknown scenario "${scenario}" (known: ${SCENARIOS.join(', ')})`);
  const p = join(dir, 'scenarios.json');
  const cur = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as Record<string, string> : {};
  cur[sourceId] = scenario;
  writeFileSync(p, JSON.stringify(cur, null, 2) + '\n');
}

function scenarioOf(dir: string, sourceId: string): Scenario {
  try {
    const s = (JSON.parse(readFileSync(join(dir, 'scenarios.json'), 'utf8')) as Record<string, string>)[sourceId];
    return (SCENARIOS as readonly string[]).includes(s ?? '') ? s as Scenario : 'ok';
  } catch { return 'ok'; }
}

function fingerprint(v: string): string {
  return `[redacted: ${v.length} characters, sha256 ${createHash('sha256').update(v).digest('hex').slice(0, 8)}]`;
}

const SECRET_PARAMS = /^(api_key|apikey|key|token|app_key|app_id|access_token)$/i;
const SECRET_HEADERS = new Set(['authorization-key', 'authorization', 'x-api-key', 'cookie', 'x-jobleft-token']);

function renameKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(renameKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [`${k}_v2`, renameKeys(x)]));
  return v;
}

function emptyOf(sourceId: string, data: unknown): unknown {
  if (sourceId === 'remoteok') return Array.isArray(data) ? data.filter((x) => x && typeof x === 'object' && 'legal' in (x as object)) : [];
  if (sourceId === 'themuse') return { results: [] };
  if (sourceId === 'hn-item') return { ...(data as object), children: [] };
  if (sourceId === 'remotive') return { ...(data as object), 'job-count': 0, jobs: [] };
  if (sourceId === 'usajobs') { const d = data as { SearchResult: Record<string, unknown> }; return { ...d, SearchResult: { ...d.SearchResult, SearchResultCount: 0, SearchResultCountAll: 0, SearchResultItems: [] } }; }
  return Array.isArray(data) ? [] : data;
}

interface Route { sourceId: string; file: string | null; kind: 'json' | 'text' }

function route(host: string, url: URL): Route | null {
  const p = url.pathname;
  if (host === 'remoteok.com' && p === '/api') return { sourceId: 'remoteok', file: 'remoteok.json', kind: 'json' };
  if (host === 'www.themuse.com' && p === '/api/public/jobs') return { sourceId: 'themuse', file: 'themuse.json', kind: 'json' };
  if (host === 'hn.algolia.com' && p === '/api/v1/search_by_date') return { sourceId: 'hn-whoishiring', file: 'hn-search.json', kind: 'json' };
  if (host === 'hn.algolia.com' && p.startsWith('/api/v1/items/')) return { sourceId: 'hn-whoishiring', file: 'hn-item.json', kind: 'json' };
  if (host === 'remotive.com' && p === '/api/remote-jobs') return { sourceId: 'remotive', file: 'remotive.json', kind: 'json' };
  if (host === 'data.usajobs.gov' && p.toLowerCase() === '/api/search') return { sourceId: 'usajobs', file: 'usajobs.json', kind: 'json' };
  if (host === 'raw.githubusercontent.com') {
    for (const l of GITHUB_LISTS) {
      const prefix = `/${l.repo}/${l.branch}/`;
      if (!p.startsWith(prefix)) continue;
      const f = decodeURIComponent(p.slice(prefix.length));
      if (!l.files.includes(f)) return null;
      return l.format === 'json' ? { sourceId: l.id, file: `${l.id}.json`, kind: 'json' } : { sourceId: l.id, file: `${l.id}/${f}`, kind: 'text' };
    }
  }
  return null;
}

export interface StandinOptions {
  dir: string;
  /** First port; hosts take consecutive ports. 0 = any free ports. */
  basePort?: number;
  /** Milliseconds the "slow" scenario waits. Default 5000. */
  slowMs?: number;
  quiet?: boolean;
}

export interface RunningStandin {
  hostMap: Record<string, string>;
  logPath: string;
  close(): Promise<void>;
}

/** Starts the stand-in servers (127.0.0.1 only). */
export async function startStandin(opts: StandinOptions): Promise<RunningStandin> {
  const dir = opts.dir;
  seedStandinDir(dir);
  const logPath = join(dir, 'requests.ndjson');
  const servers: Server[] = [];
  const hanging = new Set<ServerResponse>();
  const hostMap: Record<string, string> = {};

  const handler = (host: string) => (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://standin.local');
    const r = route(host, url);
    const sourceId = r?.sourceId ?? null;
    const scenario: Scenario = sourceId ? scenarioOf(dir, sourceId) : 'ok';
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = SECRET_PARAMS.test(k) ? fingerprint(v) : v;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v !== 'string') continue;
      headers[k] = SECRET_HEADERS.has(k) ? fingerprint(v) : v;
    }
    const log = (status: number, note?: string) => {
      appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), host, method: req.method, path: url.pathname, query, headers, source: sourceId, scenario, status, ...(note ? { note } : {}) }) + '\n');
    };
    const send = (status: number, body: string, type = 'application/json', extra: Record<string, string> = {}) => {
      log(status);
      res.writeHead(status, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)), ...extra });
      res.end(body);
    };
    if (req.method !== 'GET') { send(405, '{"error":"method not allowed"}'); return; }
    if (url.pathname === '/robots.txt') {
      const f = join(dir, 'robots', `${host}.txt`);
      if (existsSync(f)) send(200, readFileSync(f, 'utf8'), 'text/plain');
      else send(404, 'not found', 'text/plain');
      return;
    }
    if (!r || !r.file) { send(404, '{"error":"not found"}'); return; }
    const page = Number(url.searchParams.get('page') ?? url.searchParams.get('Page') ?? '0');
    const laterPage = r.sourceId === 'themuse' ? page >= 1 : r.sourceId === 'usajobs' ? page >= 2 : false;
    switch (scenario) {
      case 'http500': send(500, '{"error":"internal error"}'); return;
      case 'http503': send(503, '{"error":"unavailable"}', 'application/json', { 'retry-after': '120' }); return;
      case 'http429': send(429, '{"error":"too many requests"}', 'application/json', { 'retry-after': '3600' }); return;
      case 'http403': send(403, '{"error":"forbidden"}'); return;
      case 'http401': send(401, '{"error":"invalid key"}'); return;
      case 'http404': send(404, '{"error":"not found"}'); return;
      case 'redirect': send(302, '', 'text/plain', { location: 'https://www.linkedin.com/jobs/' }); return;
      case 'html': send(200, '<!doctype html><html><head><title>Maintenance</title></head><body><h1>We will be back soon</h1></body></html>', 'text/html; charset=utf-8'); return;
      case 'notjson': send(200, 'this is not json at all', r.kind === 'json' ? 'application/json' : 'text/plain'); return;
      case 'hang': log(0, 'held open; never answered'); hanging.add(res); res.on('close', () => hanging.delete(res)); return;
      case 'page2fail': if (laterPage) { send(500, '{"error":"internal error on a later page"}'); return; } break;
      default: break;
    }
    if (r.sourceId === 'usajobs' && !req.headers['authorization-key']) { send(401, '{"error":"Authorization-Key header is required"}'); return; }
    const path = join(dir, r.file);
    if (!existsSync(path)) { send(404, '{"error":"fixture file missing"}'); return; }
    let body: string;
    const raw = readFileSync(path, 'utf8');
    if (r.kind === 'text') {
      body = scenario === 'renamed' ? raw.replace(/\|\s*Company\s*\|/g, '| Employer |').replace(/\|\s*Posting\s*\|/g, '| Link |') : scenario === 'empty' ? raw.replace(/^\|(?!\s*Company|\s*-).*$/gm, '') : raw;
    } else {
      let data: unknown;
      try { data = JSON.parse(raw); } catch { send(200, raw); return; } // an edited fixture that is not JSON is served as is
      if (scenario === 'empty') data = emptyOf(url.pathname.startsWith('/api/v1/items/') ? 'hn-item' : r.sourceId, data);
      if (r.sourceId === 'hn-whoishiring' && url.pathname.startsWith('/api/v1/items/')) {
        const want = url.pathname.split('/').pop();
        if (String((data as { id?: unknown }).id) !== want) { send(404, '{"error":"item not found"}'); return; }
      }
      if (r.sourceId === 'themuse') {
        const results = Array.isArray((data as { results?: unknown }).results) ? (data as { results: unknown[] }).results : [];
        const pageCount = Math.ceil(results.length / 20);
        data = { page, page_count: pageCount, items_per_page: 20, took: 1, timed_out: false, total: results.length, results: results.slice(page * 20, page * 20 + 20), aggregations: {} };
      }
      if (r.sourceId === 'usajobs') {
        const d = data as { SearchResult?: { SearchResultItems?: unknown[] } & Record<string, unknown> };
        const items = d.SearchResult?.SearchResultItems ?? [];
        const per = Math.max(1, Math.min(500, Number(url.searchParams.get('ResultsPerPage') ?? '25')));
        const pg = Math.max(1, Number(url.searchParams.get('Page') ?? '1'));
        const slice = items.slice((pg - 1) * per, pg * per);
        data = { ...d, SearchResult: { ...d.SearchResult, SearchResultCount: slice.length, SearchResultCountAll: items.length, SearchResultItems: slice } };
      }
      if (scenario === 'renamed') data = renameKeys(data);
      body = JSON.stringify(data);
    }
    const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
    if (r.sourceId.startsWith('gh-') && req.headers['if-none-match'] === etag && scenario === 'ok') { log(304); res.writeHead(304, { etag }); res.end(); return; }
    const type = r.kind === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    if (scenario === 'truncated') { send(200, body.slice(0, Math.floor(body.length * 0.6)), type); return; }
    if (scenario === 'cutoff') {
      log(200, 'announced the full length, sent 60%, then closed the connection');
      res.writeHead(200, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)) });
      res.write(body.slice(0, Math.floor(body.length * 0.6)));
      setTimeout(() => res.socket?.destroy(), 50);
      return;
    }
    if (scenario === 'slow') { setTimeout(() => send(200, body, type, { etag }), opts.slowMs ?? 5000); return; }
    send(200, body, type, { etag });
  };

  let port = opts.basePort ?? 4701;
  for (const host of STANDIN_HOSTS) {
    const server = createServer(handler(host));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.basePort === 0 ? 0 : port, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const p = typeof addr === 'object' && addr ? addr.port : port;
    hostMap[host] = `http://127.0.0.1:${p}`;
    servers.push(server);
    port++;
  }
  writeFileSync(join(dir, 'hostmap.json'), JSON.stringify(hostMap) + '\n');
  return {
    hostMap,
    logPath,
    async close() {
      for (const r of hanging) r.socket?.destroy();
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); })));
    },
  };
}

/** Reads the request log of a stand-in folder. */
export function readStandinLog(dir: string): Array<Record<string, unknown>> {
  const p = join(dir, 'requests.ndjson');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

export function listStandinFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}
