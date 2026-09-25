// Stand-in boards: loopback HTTP servers that answer the same paths as the real ATS feeds, from files in a folder.
// Used by the tests and the README walkthrough. Every request is logged (time, host, path, headers). Nothing here
// contacts the internet: servers listen on 127.0.0.1 only.
//
// Folder layout (one file per board; "<board>@<region>" selects a regional host, for example acme@com.xml):
//   greenhouse/<board>.json   -> GET /v1/boards/<board>/jobs            on boards-api.greenhouse.io
//   lever/<board>.json        -> GET /v0/postings/<board>               on api.lever.co (api.eu.lever.co for @eu)
//   ashby/<board>.json        -> GET /posting-api/job-board/<board>     on api.ashbyhq.com
//   workable/<board>.json     -> GET /api/v1/widget/accounts/<board>    on apply.workable.com
//   recruitee/<board>.json    -> GET /api/offers/                       on <board>.recruitee.com
//   personio/<board>.xml      -> GET /xml (and <board>.en.xml for ?language=en) on <board>.jobs.personio.de (.com for @com)
//   teamtailor/<board>.rss    -> GET /jobs.rss?offset=&per_page=        on <board>.teamtailor.com (.na. for @na); paged
//   gem/<board>.json          -> GET /job_board/v0/<board>/job_posts/   on api.gem.com
// Optional next to a data file:
//   <board>.meta.json   {"status": 500, "headers": {"retry-after": "10"}, "body": "...", "delayMs": 0, "bytesPerSecond": 0}
//   <ats>/robots.txt or <ats>/<board>.robots.txt  served at /robots.txt of that host
//   boards.json (folder root)  [{"ats","board","company","region"?}] to name the employers; else company = board

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CrawlAtsId } from '@jobleft/contracts';
import { hostFor } from '@jobleft/crawler';
import type { BoardRef } from '@jobleft/crawler';
import { boardHost, normalRegion } from './hosts.ts';

const FAMILIES: Record<string, { ext: string; type: string }> = {
  greenhouse: { ext: '.json', type: 'application/json' },
  lever: { ext: '.json', type: 'application/json' },
  ashby: { ext: '.json', type: 'application/json' },
  workable: { ext: '.json', type: 'application/json' },
  recruitee: { ext: '.json', type: 'application/json' },
  personio: { ext: '.xml', type: 'application/xml; charset=utf-8' },
  teamtailor: { ext: '.rss', type: 'application/rss+xml; charset=utf-8' },
  gem: { ext: '.json', type: 'application/json' },
};

export interface StandinBoard extends BoardRef {
  file: string;
  host: string;
}

export interface StandinRequest {
  at: string;
  host: string;
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  status: number;
}

export interface Standin {
  boards: StandinBoard[];
  /** Real host -> loopback origin, ready for JOBLEFT_HOST_MAP. */
  hostMap: Record<string, string>;
  requests: StandinRequest[];
  close(): Promise<void>;
}

function hostOf(ats: string, board: string, region: string | null): string {
  if (ats === 'greenhouse' || ats === 'lever' || ats === 'ashby') return hostFor(ats, region ?? undefined);
  return boardHost({ ats: ats as CrawlAtsId, board, region: region ?? undefined });
}

/** Reads the folder and lists the stand-in boards it holds. */
export function listStandinBoards(dir: string): StandinBoard[] {
  let names: Record<string, { company: string; region?: string }> = {};
  const manifest = join(dir, 'boards.json');
  if (existsSync(manifest)) {
    const rows = JSON.parse(readFileSync(manifest, 'utf8')) as Array<{ ats: string; board: string; company: string; region?: string }>;
    names = Object.fromEntries(rows.map((r) => [`${r.ats}:${r.board}${r.region ? '@' + r.region : ''}`, r]));
  }
  const out: StandinBoard[] = [];
  for (const [ats, f] of Object.entries(FAMILIES)) {
    const d = join(dir, ats);
    if (!existsSync(d)) continue;
    for (const file of readdirSync(d).sort()) {
      if (!file.endsWith(f.ext) || file.endsWith('.meta.json') || file.endsWith(`.en${f.ext}`)) continue;
      const stem = file.slice(0, -f.ext.length);
      const [board, rawRegion] = stem.split('@');
      const region = rawRegion ? (['greenhouse', 'lever', 'ashby'].includes(ats) ? rawRegion : normalRegion(ats as CrawlAtsId, rawRegion)) : null;
      const named = names[`${ats}:${stem}`] ?? names[`${ats}:${board}`];
      out.push({
        ats: ats as CrawlAtsId, board, company: named?.company ?? board, ...(region ? { region } : {}),
        file: join(d, file), host: hostOf(ats, board, region),
      });
    }
  }
  return out;
}

interface Meta { status?: number; headers?: Record<string, string>; body?: string; delayMs?: number; bytesPerSecond?: number }

function metaFor(file: string, ext: string): Meta | null {
  const m = file.slice(0, -ext.length) + '.meta.json';
  return existsSync(m) ? (JSON.parse(readFileSync(m, 'utf8')) as Meta) : null;
}

/** Teamtailor paging: the RSS file's items sliced by offset and per_page (default 100), as the real feed does. */
function rssPage(xml: string, offset: number, perPage: number): string {
  const items: string[] = [...(xml.match(/\s*<item>[\s\S]*?<\/item>/g) ?? [])];
  if (items.length === 0) return xml;
  const first = xml.indexOf(items[0]);
  const lastEnd = xml.lastIndexOf('</item>') + '</item>'.length;
  return xml.slice(0, first) + items.slice(offset, offset + perPage).join('') + xml.slice(lastEnd);
}

function route(b: StandinBoard, url: URL): { file: string; body?: string } | null {
  const p = url.pathname.replace(/\/+$/, '');
  const ext = FAMILIES[b.ats].ext;
  switch (b.ats) {
    case 'greenhouse': return p === `/v1/boards/${b.board}/jobs` ? { file: b.file } : null;
    case 'lever': return p === `/v0/postings/${b.board}` ? { file: b.file } : null;
    case 'ashby': return p === `/posting-api/job-board/${b.board}` ? { file: b.file } : null;
    case 'workable': return p === `/api/v1/widget/accounts/${b.board}` ? { file: b.file } : null;
    case 'recruitee': return p === '/api/offers' ? { file: b.file } : null;
    case 'gem': return p === `/job_board/v0/${b.board}/job_posts` ? { file: b.file } : null;
    case 'personio': {
      if (p !== '/xml') return null;
      const en = b.file.slice(0, -ext.length) + '.en' + ext;
      return { file: url.searchParams.get('language') === 'en' && existsSync(en) ? en : b.file };
    }
    case 'teamtailor': {
      if (p !== '/jobs.rss') return null;
      const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
      const perPage = Math.max(1, Number(url.searchParams.get('per_page') ?? 100) || 100);
      return { file: b.file, body: rssPage(readFileSync(b.file, 'utf8'), offset, perPage) };
    }
    default: return null;
  }
}

/** Starts one loopback server per real host (boards that share a host share a server), from port `basePort` up. */
export async function startStandin(dir: string, opts: { basePort?: number; log?: string } = {}): Promise<Standin> {
  const boards = listStandinBoards(dir);
  const byHost = new Map<string, StandinBoard[]>();
  for (const b of boards) (byHost.get(b.host) ?? byHost.set(b.host, []).get(b.host)!).push(b);
  const requests: StandinRequest[] = [];
  const servers: Server[] = [];
  const hostMap: Record<string, string> = {};
  let port = opts.basePort ?? 0;

  for (const [host, list] of byHost) {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://standin');
      const record = (status: number): void => {
        const r: StandinRequest = {
          at: new Date().toISOString(), host, port: (server.address() as { port: number }).port, method: req.method ?? 'GET',
          path: url.pathname + url.search, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), status,
        };
        requests.push(r);
        if (opts.log) appendFileSync(opts.log, JSON.stringify(r) + '\n');
      };
      if (url.pathname === '/robots.txt') {
        const ats = list[0].ats;
        const own = join(dir, ats, `${list[0].board}.robots.txt`);
        const shared = join(dir, ats, 'robots.txt');
        const f = list.length === 1 && existsSync(own) ? own : existsSync(shared) ? shared : null;
        record(f ? 200 : 404);
        res.writeHead(f ? 200 : 404, { 'content-type': 'text/plain' });
        res.end(f ? readFileSync(f) : 'not found');
        return;
      }
      let hit: { b: StandinBoard; r: { file: string; body?: string } } | null = null;
      for (const b of list) { const r = route(b, url); if (r) { hit = { b, r }; break; } }
      if (!hit) { record(404); res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}'); return; }
      const ext = FAMILIES[hit.b.ats].ext;
      const meta = metaFor(hit.b.file, ext);
      const status = meta?.status ?? 200;
      const body = Buffer.from(meta?.body ?? hit.r.body ?? readFileSync(hit.r.file, 'utf8'));
      const send = (): void => {
        record(status);
        res.writeHead(status, { 'content-type': FAMILIES[hit!.b.ats].type, ...(meta?.headers ?? {}) });
        if (meta?.bytesPerSecond && meta.bytesPerSecond > 0) {
          let i = 0;
          const step = Math.max(1, Math.floor(meta.bytesPerSecond / 10));
          const timer = setInterval(() => {
            if (i >= body.length || res.destroyed) { clearInterval(timer); res.end(); return; }
            res.write(body.subarray(i, i + step));
            i += step;
          }, 100);
          res.on('close', () => clearInterval(timer));
          return;
        }
        res.end(body);
      };
      if (meta?.delayMs) setTimeout(send, meta.delayMs); else send();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    const actual = (server.address() as { port: number }).port;
    hostMap[host] = `http://127.0.0.1:${actual}`;
    if (port) port = actual + 1;
    servers.push(server);
  }
  return {
    boards, hostMap, requests,
    close: () => Promise.all(servers.map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }))).then(() => undefined),
  };
}
