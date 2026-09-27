// Serves the practice application forms for the extension tests on http://127.0.0.1:<port>/practice/<page>.html and
// records every form submit or "Next" press at POST /__log (GET /__log lists them, POST /__reset clears them).
// Usage: node qa/bin/practice-server.mjs [port]   (default 47900)
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = fileURLToPath(new URL('../practice/', import.meta.url));
const PORT = Number(process.argv[2] ?? process.env.PRACTICE_PORT ?? 47900);
const events = [];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if ((url.pathname === '/__log' || url.pathname === '/__event') && req.method === 'POST') { /* the pages' logger beacons to /__event */ let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { events.push({ at: new Date().toISOString(), body: b.slice(0, 500) }); res.end('ok'); }); return; }
  if (url.pathname === '/__log') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ count: events.length, submit: events.filter((e) => /submit/i.test(e.body)).length, next: events.filter((e) => /next/i.test(e.body)).length, events })); return; }
  if (url.pathname === '/__reset') { events.length = 0; res.end('ok'); return; }
  const f = join(DIR, url.pathname.replace(/^\/practice\//, '').replace(/^\/+/, '') || 'index.html');
  if (!f.startsWith(DIR) || !existsSync(f)) { res.statusCode = 404; res.end('not found'); return; }
  res.setHeader('content-type', types[f.slice(f.lastIndexOf('.'))] ?? 'application/octet-stream');
  res.end(readFileSync(f));
}).listen(PORT, '127.0.0.1', () => console.log(`practice pages on http://127.0.0.1:${PORT}/practice/ (job-a.html, job-b.html, workday-like.html, ashby-like.html, tricky.html, captcha.html, iframes...)`));
