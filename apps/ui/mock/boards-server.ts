// Stand-in employer boards on http://127.0.0.1:47920. It serves each board's job list (read from the mock data
// folder on every request, so an edited board file takes effect at the next refresh) and a page per posting, which
// is the "original posting" the app links to. All companies and postings are made up.
// Run: node apps/ui/mock/boards-server.ts --home <mock data folder>

import { createServer, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardFile, CompanyFixture, RawPosting } from './fixtures.ts';
import { PORTS, parseArgs, trafficLogger } from './util.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const home = resolve(String(args.home ?? join(HERE, '..', '.mock-home')));
const port = Number(args.port ?? PORTS.boards);
const boardsDir = join(home, 'boards');
const logTraffic = trafficLogger(args.traffic ? String(args.traffic) : join(home, 'traffic', 'boards.ndjson'));

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(res: ServerResponse, status: number, title: string, body: string, ld?: unknown): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${ld ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>` : ''}<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#111}pre{white-space:pre-wrap;font:inherit}.note{background:#f4f4f4;padding:8px 12px;border-radius:8px;font-size:13px}dt{font-weight:600}dd{margin:0 0 8px}</style></head><body><p class="note">Stand-in employer site for the jobleft UI mock. Made-up data.</p>${body}</body></html>`);
}

function boards(): BoardFile[] {
  if (!existsSync(boardsDir)) return [];
  const out: BoardFile[] = [];
  for (const f of readdirSync(boardsDir).sort()) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(readFileSync(join(boardsDir, f), 'utf8')) as BoardFile); } catch { /* broken file: its API answers 500 */ }
  }
  return out;
}

function boardById(id: string): BoardFile | null | 'broken' {
  const f = join(boardsDir, `${id.replace(':', '__')}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')) as BoardFile; } catch { return 'broken'; }
}

function payLine(p: RawPosting): string | null {
  if (!p.pay) return null;
  const unit = { hour: 'an hour', day: 'a day', week: 'a week', month: 'a month', year: 'a year' }[p.pay.period];
  const f = (v: number) => `${p.pay!.currency} ${v.toLocaleString('en-US')}`;
  if (p.pay.min !== null && p.pay.max !== null) return `${f(p.pay.min)} to ${f(p.pay.max)} ${unit}${p.pay.ranges > 1 ? ' (one of two ranges)' : ''}`;
  if (p.pay.min !== null) return `From ${f(p.pay.min)} ${unit}`;
  return `Up to ${f(p.pay.max!)} ${unit}`;
}

const server = createServer((req, res) => {
  logTraffic(req);
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (parts[0] === 'api' && parts[1] === 'boards' && parts[2]) {
    const b = boardById(parts[2]);
    if (b === 'broken') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"broken board file"}'); return; }
    if (!b) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"no such board"}'); return; }
    if (b.down) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"service unavailable"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ board: b.board, company: b.company, postings: b.postings }));
    return;
  }
  if (parts.length === 0) {
    const list = boards().map((b) => `<li><a href="/${encodeURIComponent(b.board)}">${esc(b.company)}</a> (${b.postings.length} postings${b.down ? ', site down' : ''})</li>`).join('');
    return page(res, 200, 'Stand-in employer boards', `<h1>Stand-in employer boards</h1><ul>${list}</ul><p><a href="/about">A page that is not a job</a></p>`);
  }
  if (parts[0] === 'about') return page(res, 200, 'About us', '<h1>About us</h1><p>We make garden furniture. This page is not a job posting.</p>');
  if (parts[0] === 'registry' && parts[1]) {
    const list = JSON.parse(readFileSync(join(home, 'companies.json'), 'utf8')) as CompanyFixture[];
    const c = list.find((x) => x.key === parts[1]);
    if (!c) return page(res, 404, 'Not found', '<h1>Not found</h1>');
    return page(res, 200, c.name, `<h1>${esc(c.name)}</h1><dl>${[['Founded', c.founded], ['Headquarters', c.headquarters], ['Size', c.size], ['Industries', c.industries.join(', ')], ['Stage', c.stage]].filter((x) => x[1]).map(([k, v]) => `<dt>${k}</dt><dd>${esc(String(v))}</dd>`).join('')}</dl>`);
  }
  if (parts[0] === 'news' && parts[1]) return page(res, 200, 'News', '<h1>News</h1><p>Made-up news item for the mock.</p>');
  if (parts[0] === 'pasted') return page(res, 200, 'Pasted job', '<h1>Pasted job</h1><p>This job was pasted as text, so it has no employer page.</p>');

  const b = boards().find((x) => x.board === parts[0]);
  if (!b) return page(res, 404, 'Page not found', '<h1>Page not found</h1>');
  if (b.down) return page(res, 503, 'Service unavailable', '<h1>This careers site is down right now.</h1>');
  if (parts.length === 1) {
    const list = b.postings.map((p) => `<li><a href="/${encodeURIComponent(b.board)}/jobs/${encodeURIComponent(p.externalId)}">${esc(p.title)}</a></li>`).join('');
    return page(res, 200, `${b.company} careers`, `<h1>${esc(b.company)} careers</h1><ul>${list}</ul>`);
  }
  if (parts[1] !== 'jobs' || !parts[2]) return page(res, 404, 'Page not found', '<h1>Page not found</h1>');
  const p = b.postings.find((x) => x.externalId === parts[2]);
  if (!p) return page(res, 404, 'Job not found', '<h1>This job is no longer posted.</h1>');
  if (parts[3] === 'apply') {
    return page(res, 200, `Apply: ${p.title}`, `<h1>Apply: ${esc(p.title)}</h1><p>${esc(b.company)}</p><p>This is a stand-in application page. It has no form and sends nothing.</p>`);
  }
  const ld = {
    '@context': 'https://schema.org', '@type': 'JobPosting', title: p.title, hiringOrganization: { '@type': 'Organization', name: b.company },
    datePosted: p.postedAt ?? undefined, description: p.description,
    jobLocation: p.locations.filter((l) => !/^remote/i.test(l)).map((l) => { const [city, region] = l.split(/,\s*/); return { '@type': 'Place', address: { addressLocality: city, addressRegion: region } }; }),
    employmentType: p.employmentType === 'full_time' ? 'FULL_TIME' : p.employmentType === 'contract' ? 'CONTRACTOR' : p.employmentType === 'part_time' ? 'PART_TIME' : undefined,
  };
  const facts: Array<[string, string | null]> = [
    ['Company', b.company], ['Locations', p.locations.join('; ') || null], ['Workplace', p.workplace], ['Job type', p.employmentType],
    ['Department', p.department], ['Posted', p.postedAt], ['Pay (board field)', payLine(p)],
  ];
  return page(res, 200, `${p.title} - ${b.company}`, `<h1>${esc(p.title)}</h1><dl>${facts.filter((f) => f[1]).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v!)}</dd>`).join('')}</dl><pre>${esc(p.description)}</pre>${p.hasApplyPage ? `<p><a href="/${encodeURIComponent(b.board)}/jobs/${encodeURIComponent(p.externalId)}/apply">Apply</a></p>` : ''}`, ld);
});

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${port} is already in use, so the stand-in employer boards cannot start.`);
  else console.error(`The stand-in employer boards cannot start: ${e.message}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => console.log(`Stand-in employer boards on http://127.0.0.1:${port} (reads ${boardsDir})`));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
