// Saves copies of PUBLIC job application pages as practice pages (test data), politely:
//   * User-Agent "jobleft/0.1.0 (+https://github.com/Blueturboguy07/jobleft; no personal data)" on every request;
//   * robots.txt read first for every host, and obeyed (a disallowed path is never requested);
//   * at most 1 request per second per host; images, fonts, media and every host outside the system are blocked;
//   * a hard budget of requests for the whole run; no login pages; no personal data anywhere.
// The saved page has its scripts and outside links removed, its styles inlined, and a comment naming the source.
//
//   node scripts/record-fixture.ts --ats greenhouse --board gymshark [--count 1] [--embed] [--budget 400]

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from './cdp.ts';

const UA = 'jobleft/0.1.0 (+https://github.com/Blueturboguy07/jobleft; no personal data)';
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'fixtures', 'recorded');
const args = process.argv.slice(2);
const arg = (n: string): string | null => (args.includes(n) ? args[args.indexOf(n) + 1] ?? null : null);
const ats = arg('--ats') ?? '';
const board = arg('--board') ?? '';
const count = Number(arg('--count') ?? 1);
const embed = args.includes('--embed');
let budget = Number(arg('--budget') ?? 400);
let used = 0;

const ALLOWED: Record<string, RegExp> = {
  greenhouse: /(^|\.)greenhouse\.io$/,
  lever: /(^|\.)lever\.co$/,
  ashby: /(^|\.)(ashbyhq\.com|ashbyprd\.com)$/,
  // Workable serves its application app from its own CloudFront host (scripts and styles only).
  workable: /(^|\.)(workable\.com|workablecdn\.com)$|^dcvxs6ggqztsa\.cloudfront\.net$/,
};

// ------------------------------------------------------------------ polite fetch

const lastAt = new Map<string, number>();
const chains = new Map<string, Promise<void>>();
const robots = new Map<string, Promise<string[]>>();

/** At most one request per second per host, in order (a queue per host). */
function pace(host: string): Promise<void> {
  const next = (chains.get(host) ?? Promise.resolve()).then(async () => {
    const wait = (lastAt.get(host) ?? 0) + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt.set(host, Date.now());
  });
  chains.set(host, next);
  return next;
}

function spend(what: string): void {
  used += 1;
  if (used > budget) throw new Error(`request budget used up at ${what}`);
}

async function loadRobots(url: URL): Promise<string[]> {
  await pace(url.host);
  spend(`robots ${url.host}`);
  const r = await fetch(`${url.protocol}//${url.host}/robots.txt`, { headers: { 'user-agent': UA }, redirect: 'manual' });
  const text = r.ok ? await r.text() : '';
  const rules: string[] = [];
  let applies = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = (m[1] ?? '').toLowerCase();
    const v = (m[2] ?? '').trim();
    if (k === 'user-agent') applies = v === '*' || v.toLowerCase().includes('jobleft');
    else if (k === 'disallow' && applies && v) rules.push(v);
  }
  return rules;
}

async function disallows(url: URL): Promise<boolean> {
  let rules = robots.get(url.host);
  if (!rules) { rules = loadRobots(url); robots.set(url.host, rules); }
  return (await rules).some((p) => (url.pathname + url.search).startsWith(p));
}

// ------------------------------------------------------------------ the browser's only way out: a filter proxy

/** A CONNECT proxy that lets the recording browser reach only the system's own hosts, and logs what it refused. */
async function filterProxy(allow: RegExp): Promise<{ port: number; close: () => void; refused: Set<string> }> {
  const net = await import('node:net');
  const refused = new Set<string>();
  const srv = net.createServer((sock) => {
    sock.on('error', () => sock.destroy());
    sock.once('data', (buf) => {
      const head = buf.toString('latin1');
      const m = head.match(/^CONNECT ([^:\s]+):(\d+) HTTP/);
      if (!m || !allow.test(m[1] ?? '') || m[2] !== '443') {
        refused.add(m ? `${m[1]}:${m[2]}` : head.split('\r\n')[0]?.slice(0, 60) ?? '?');
        sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const up = net.connect(443, m[1], () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock); sock.pipe(up); });
      up.on('error', () => sock.destroy());
      sock.on('close', () => up.destroy());
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { port: (srv.address() as { port: number }).port, close: () => srv.close(), refused };
}

async function getJson(u: string): Promise<unknown> {
  const url = new URL(u);
  if (await disallows(url)) throw new Error(`robots.txt disallows ${u}`);
  await pace(url.host);
  spend(u);
  const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
  return r.json();
}

// ------------------------------------------------------------------ which pages

async function pages(): Promise<string[]> {
  switch (ats) {
    case 'greenhouse': {
      const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs`) as { jobs: Array<{ id: number }> };
      return d.jobs.slice(0, count).map((j) => (embed ? `https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${j.id}` : `https://job-boards.greenhouse.io/${board}/jobs/${j.id}`));
    }
    case 'lever': {
      const d = await getJson(`https://api.lever.co/v0/postings/${board}?mode=json&limit=${count}`) as Array<{ hostedUrl: string }>;
      return d.slice(0, count).map((j) => `${j.hostedUrl}/apply`);
    }
    case 'ashby': {
      const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${board}`) as { jobs: Array<{ jobUrl: string }> };
      return d.jobs.slice(0, count).map((j) => `${j.jobUrl}/application`);
    }
    case 'workable': {
      const d = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${board}`) as { jobs: Array<{ shortcode: string }> };
      return d.jobs.slice(0, count).map((j) => `https://apply.workable.com/${board}/j/${j.shortcode}/apply/`);
    }
  }
  throw new Error('--ats must be greenhouse, lever, ashby or workable');
}

// ------------------------------------------------------------------ recording one page

function staticHtml(html: string, css: string[], source: string): string {
  let h = html;
  h = h.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  h = h.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '');
  h = h.replace(/<link\b[^>]*>/gi, '');
  h = h.replace(/<base\b[^>]*>/gi, '');
  h = h.replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '');
  h = h.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
  h = h.replace(/<(img|source|video|audio)\b([^>]*?)\s(src|srcset)=("[^"]*"|'[^']*')/gi, '<$1$2 data-removed-$3=$4');
  h = h.replace(/<iframe\b([^>]*?)\ssrc=("[^"]*"|'[^']*')/gi, '<iframe$1 data-removed-src=$2');
  h = h.replace(/url\((["']?)(https?:)?\/\/[^)]*\)/gi, 'url()');
  h = h.replace(/\saction=("[^"]*"|'[^']*')/gi, ' action="/apply/recorded"');
  const style = css.map((c) => c.replace(/@import[^;]+;/g, '').replace(/url\((["']?)(https?:)?\/\/[^)]*\)/gi, 'url()').replace(/url\((["']?)\/[^)]*\)/gi, 'url()')).join('\n');
  const head = `<style>\n${style}\n</style>\n<script src="/practice/_log.js"></script>`;
  h = h.includes('</head>') ? h.replace('</head>', `${head}\n</head>`) : `${head}\n${h}`;
  return `<!-- saved from url=(${String(source.length).padStart(4, '0')})${source} -->\n<!-- jobleft practice copy of a public application page, saved ${new Date().toISOString().slice(0, 10)} by scripts/record-fixture.ts. Scripts, images and outside links removed. -->\n${h}`;
}

async function record(b: Browser, url: string, file: string): Promise<{ requests: number; blocked: string[] }> {
  const allow = ALLOWED[ats] as RegExp;
  const blocked = new Set<string>();
  let requests = 0;
  const t = await b.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const p = await b.attach(t.targetId);
  const sheets: string[] = [];
  b.on((m) => { if (m.sessionId === p.sessionId && m.method === 'CSS.styleSheetAdded') sheets.push(String((m.params.header as { styleSheetId: string }).styleSheetId)); });
  b.on((m) => {
    if (m.sessionId !== p.sessionId || m.method !== 'Fetch.requestPaused') return;
    const rid = String(m.params.requestId);
    const req = m.params.request as { url: string };
    const type = String(m.params.resourceType);
    void (async () => {
      try {
        const u = new URL(req.url);
        if (u.protocol === 'data:' || u.protocol === 'blob:') { await p.send('Fetch.continueRequest', { requestId: rid }); return; }
        const ok = /^https:$/.test(u.protocol) && allow.test(u.hostname) && !['Image', 'Font', 'Media', 'Ping', 'CSPViolationReport', 'Manifest', 'Other', 'Prefetch'].includes(type);
        if (!ok || await disallows(u) || used >= budget) {
          blocked.add(`${type} ${u.hostname}${u.pathname.slice(0, 40)}`);
          await p.send('Fetch.failRequest', { requestId: rid, errorReason: 'BlockedByClient' });
          return;
        }
        await pace(u.hostname);
        spend(req.url);
        requests += 1;
        await p.send('Fetch.continueRequest', { requestId: rid });
      } catch {
        await p.send('Fetch.failRequest', { requestId: rid, errorReason: 'BlockedByClient' }).catch(() => undefined);
      }
    })();
  });
  await p.send('Network.enable');
  await p.send('Network.setUserAgentOverride', { userAgent: UA });
  await p.send('DOM.enable');
  await p.send('CSS.enable');
  await p.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await p.send('Page.navigate', { url });
  const end = Date.now() + 90_000;
  let n = 0;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 1500));
    n = await p.eval<number>(`document.querySelectorAll('input:not([type=hidden]), textarea, select').length`).catch(() => 0);
    const busy = await p.eval<boolean>(`document.readyState !== 'complete'`).catch(() => true);
    if (n >= 3 && !busy) break;
  }
  await new Promise((r) => setTimeout(r, 2500));
  const html = await p.eval<string>(`'<!doctype html>\\n' + document.documentElement.outerHTML`);
  const css: string[] = [];
  for (const id of sheets) {
    try { css.push((await p.send<{ text: string }>('CSS.getStyleSheetText', { styleSheetId: id })).text); } catch { /* gone */ }
  }
  writeFileSync(file, staticHtml(html, css, url));
  await b.send('Target.closeTarget', { targetId: t.targetId });
  console.log(`  ${n} fields, ${requests} page requests, ${blocked.size} blocked kinds -> ${file}`);
  return { requests, blocked: [...blocked].slice(0, 20) };
}

// ------------------------------------------------------------------ main

mkdirSync(outDir, { recursive: true });
const sourcesPath = join(outDir, 'sources.json');
const sources = existsSync(sourcesPath) ? JSON.parse(readFileSync(sourcesPath, 'utf8')) as Array<Record<string, unknown>> : [];
const list = await pages();
const proxy = await filterProxy(ALLOWED[ats] as RegExp);
const b = await Browser.launch({ proxy: `127.0.0.1:${proxy.port}` });
try {
  let i = 0;
  for (const url of list) {
    i += 1;
    const file = join(outDir, `${ats}-${board}${embed ? '-embed' : ''}-${i}.html`);
    console.log(`recording ${url}`);
    const r = await record(b, url, file);
    const entry = { file: file.slice(outDir.length + 1), source: url, ats, board, savedAt: new Date().toISOString(), pageRequests: r.requests, blockedSample: r.blocked };
    const k = sources.findIndex((s) => s.file === entry.file);
    if (k >= 0) sources[k] = entry; else sources.push(entry);
  }
} finally {
  await b.close();
  proxy.close();
  if (proxy.refused.size) console.log(`the proxy refused: ${[...proxy.refused].slice(0, 15).join(', ')}`);
}
writeFileSync(sourcesPath, `${JSON.stringify(sources, null, 2)}\n`);
console.log(`requests used this run: ${used} (budget ${budget})`);
