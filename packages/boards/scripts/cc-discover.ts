#!/usr/bin/env node
// Common Crawl index discovery: finds more board tokens by listing the URLs that Common Crawl saw on each
// provider's public board host, then keeping the board token of each URL. It reads only the public URL index
// (index.commoncrawl.org, the CDX API); it never downloads crawled pages.
//
//   node scripts/cc-discover.ts --crawl CC-MAIN-2026-39 --host job-boards.greenhouse.io [--host jobs.ashbyhq.com]
//        [--pages 0-1] [--max-requests 20] [--out discovered.json]
//        [--record <dir> [--record-lines 400]]     save each index answer (optionally only its first N lines)
//        [--replay <dir>]                          read saved answers instead of the network (offline tests)
//
// Politeness: every request goes through the boards lane's polite client: the project User-Agent, robots.txt,
// 1 request per second per host, Retry-After honoured, a hard request budget (--max-requests, default 20).
// Terms: Common Crawl Terms of Use (https://commoncrawl.org/terms-of-use, last updated 2024-03-07) grant a limited
// licence; they do not exclude commercial use but recommend legal advice first. Only board tokens are kept (no page
// content, no personal data). A token becomes a directory row only after `jobleft-boards directory refresh
// --discovered <file>` finds the board live AND the board reports its own employer name; the row's name is the
// board's own answer, never Common Crawl text.
//
// Output (--out): { source: <a directory source entry>, slugs: [{ ats, slug, region, source }], stats }.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostMapFromEnv } from '@jobleft/crawler';
import { BusyPacer, createBoardHttp, offlineFromEnv } from '../src/http.ts';
import { parseCdx, slugsFromCdx } from '../src/commoncrawl.ts';
import { boardId } from '../src/ids.ts';
import type { CrawlAtsId } from '@jobleft/contracts';

function arg(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; }
function args(name: string): string[] { const out: string[] = []; process.argv.forEach((a, i) => { if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]!); }); return out; }

function pageRange(spec: string | undefined, pages: number): number[] {
  if (!spec) return pages > 0 ? [0] : [];
  const m = /^(\d+)(?:-(\d+))?$/.exec(spec);
  if (!m) throw new Error(`bad --pages "${spec}" (use 0 or 0-2)`);
  const a = Number(m[1]), b = Math.min(Number(m[2] ?? m[1]), Math.max(0, pages - 1));
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

async function main(): Promise<void> {
  const crawl = arg('crawl');
  const hosts = args('host');
  if (!crawl || !/^CC-MAIN-\d{4}-\d{2}$/.test(crawl) || hosts.length === 0) {
    console.error('usage: node scripts/cc-discover.ts --crawl CC-MAIN-2026-39 --host job-boards.greenhouse.io [--pages 0-1] [--max-requests 20] [--out f] [--record dir] [--replay dir]');
    process.exit(2);
  }
  const replay = arg('replay') ? resolve(arg('replay')!) : null;
  const record = arg('record') ? resolve(arg('record')!) : null;
  const recordLines = arg('record-lines') ? Number(arg('record-lines')) : null;
  const maxRequests = Number(arg('max-requests') ?? 20);
  const out = arg('out') ? resolve(arg('out')!) : null;
  const http = replay ? null : createBoardHttp({
    pacer: new BusyPacer(1000), hostMap: hostMapFromEnv(), offline: () => offlineFromEnv(),
    timeoutMs: 90_000, maxRequests, retries: 1, retryDelayMs: 5000,
  });
  const base = `https://index.commoncrawl.org/${crawl}-index`;
  const fetchText = async (key: string, url: string): Promise<string> => {
    if (replay) {
      const p = join(replay, key);
      if (!existsSync(p)) throw new Error(`no recorded answer ${p}`);
      return readFileSync(p, 'utf8');
    }
    const text = await http!.getText(url, 'application/json, text/plain');
    if (record) {
      const p = join(record, key);
      mkdirSync(join(p, '..'), { recursive: true });
      const keep = recordLines && key.endsWith('.ndjson') ? text.split('\n').slice(0, recordLines).join('\n') + '\n' : text;
      writeFileSync(p, keep);
    }
    return text;
  };

  const source = `commoncrawl-${crawl}`;
  const all = new Map<string, { ats: CrawlAtsId; slug: string; region: string | null; source: string }>();
  const stats: Record<string, { pages: number; fetched: number[]; lines: number; slugs: number }> = {};
  for (const host of hosts) {
    const q = `url=${encodeURIComponent(`${host}/*`)}&output=json&fl=url,status`;
    const key = (name: string) => join(crawl, host, name);
    let pages = 0;
    try {
      const meta = JSON.parse(await fetchText(key('pages.json'), `${base}?${q}&showNumPages=true`)) as { pages?: number };
      pages = Number(meta.pages ?? 0);
    } catch (e) { console.error(`${host}: cannot read the page count (${(e as Error).message})`); continue; }
    const want = pageRange(arg('pages'), pages);
    stats[host] = { pages, fetched: [], lines: 0, slugs: 0 };
    for (const p of want) {
      let text: string;
      try { text = await fetchText(key(`page-${p}.ndjson`), `${base}?${q}&page=${p}`); } catch (e) { console.error(`${host} page ${p}: ${(e as Error).message}`); break; }
      const lines = parseCdx(text);
      const slugs = slugsFromCdx(lines, source);
      stats[host]!.fetched.push(p);
      stats[host]!.lines += lines.length;
      for (const s of slugs) { const id = boardId(s.ats, s.slug, s.region); if (!all.has(id)) { all.set(id, s); stats[host]!.slugs++; } }
      console.error(`${host} page ${p} of ${pages}: ${lines.length} URLs, ${slugs.length} board tokens`);
    }
  }
  const result = {
    source: {
      id: source,
      name: `Common Crawl URL index ${crawl} (board tokens only; each board checked live and named by its own provider answer)`,
      url: 'https://index.commoncrawl.org/',
      licence: 'Common Crawl Terms of Use (limited licence; commercial use is not excluded; legal advice recommended)',
      licenceUrl: 'https://commoncrawl.org/terms-of-use',
      note: 'Only the board token of each URL is kept. Employer names come from each board\'s own public API.',
      rows: all.size,
    },
    slugs: [...all.values()].sort((a, b) => (boardId(a.ats, a.slug, a.region) < boardId(b.ats, b.slug, b.region) ? -1 : 1)),
    stats,
    requests: http ? http.totalRequests : 0,
  };
  if (out) writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
  console.log(`${all.size} board tokens from ${hosts.join(', ')} (${result.requests} requests${replay ? ', replayed' : ''})${out ? `; wrote ${out}` : ''}`);
}

main().catch((e) => { console.error(`cc-discover: ${(e as Error).message}`); process.exit(1); });
