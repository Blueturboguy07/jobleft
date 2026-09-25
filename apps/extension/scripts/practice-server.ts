// The practice-page server: serves apps/extension/fixtures (hand-made practice forms and saved copies of public
// application pages) on 127.0.0.1, and LOGS every request it gets, every submit attempt, every "Next" press and
// every page change. It is a test tool; the product does not need it.
//
//   node scripts/practice-server.ts [--port 47900] [--dir <folder>]
//   GET  /__log     -> the log as JSON        POST /__reset -> empty the log
//   Any other POST  -> logged as a submit to the employer (the practice page never really sends anything)

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (n: string): string | null => (args.includes(n) ? args[args.indexOf(n) + 1] ?? null : null);
const port = Number(arg('--port') ?? 47900);
const root = arg('--dir') ?? join(here, '..', 'fixtures');
const host = arg('--host') ?? '127.0.0.1';

interface Entry { at: string; kind: 'request' | 'submit' | 'next' | 'page-change' | 'event'; method: string; path: string; detail: string }
const log: Entry[] = [];
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };

function add(e: Omit<Entry, 'at'>): void {
  log.push({ at: new Date().toISOString(), ...e });
  if (e.kind !== 'request') console.log(`[practice] ${e.kind.toUpperCase()} ${e.path} ${e.detail}`);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = decodeURIComponent(url.pathname);
  add({ kind: 'request', method: req.method ?? 'GET', path: `${url.host}${path}`, detail: String(req.headers['user-agent'] ?? '').slice(0, 60) });
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if (path === '/__log') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ entries: log, counts: { submit: log.filter((e) => e.kind === 'submit').length, next: log.filter((e) => e.kind === 'next').length, pageChange: log.filter((e) => e.kind === 'page-change').length, requests: log.filter((e) => e.kind === 'request').length } }));
      return;
    }
    if (path === '/__reset' && req.method === 'POST') { log.length = 0; res.writeHead(204); res.end(); return; }
    if (path === '/__event' && req.method === 'POST') {
      let ev: { type?: string; page?: string; detail?: string } = {};
      try { ev = JSON.parse(body) as typeof ev; } catch { /* ignore */ }
      const kind = ev.type === 'submit' || ev.type === 'next' || ev.type === 'page-change' ? ev.type : 'event';
      add({ kind, method: 'POST', path: String(ev.page ?? ''), detail: String(ev.detail ?? '').slice(0, 300) });
      res.writeHead(204); res.end();
      return;
    }
    if (req.method === 'POST') {
      add({ kind: 'submit', method: 'POST', path, detail: `form post, ${body.length} bytes` });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Submitted (practice)</title><p>The practice server got a form post. A real employer would now have the application.</p>');
      return;
    }
    const file = normalize(join(root, path.endsWith('/') ? `${path}index.html` : path));
    if (!file.startsWith(normalize(root)) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
});

server.listen(port, host, () => {
  console.log(`practice pages: http://${host}:${port}/  (index: http://${host}:${port}/practice/index.html, log: http://${host}:${port}/__log)`);
});
