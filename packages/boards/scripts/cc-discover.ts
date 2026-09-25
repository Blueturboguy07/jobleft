#!/usr/bin/env node
// Common Crawl index discovery: finds more board tokens by listing the URLs that Common Crawl saw on each
// provider's public board host, then keeping the board token of each URL. It reads only the public URL index
// (index.commoncrawl.org, the CDX API); it never downloads crawled pages.
//
//   node scripts/cc-discover.ts --crawl CC-MAIN-2026-39 --host job-boards.greenhouse.io [--host jobs.ashbyhq.com]
//        [--pages 0-1] [--max-requests 20] [--out discovered.json]
//        [--record <dir> [--record-lines 400]]     save each index answer (optionally only its first N lines)
//        [--replay <dir>]                          read saved answers instead of the network (offline tests)
//   node scripts/cc-discover.ts --crawl CC-MAIN-2026-39 --from-file <cdx answer> [--from-file ...] [--out f]
//                                                 extract tokens from CDX answers obtained another way (no network)
//
// ROBOTS.TXT: on 2026-09-25 both index.commoncrawl.org and data.commoncrawl.org answer robots.txt with
// "User-agent: * / Disallow: /" (the index keeps only its home pages open). The live mode obeys robots.txt, so today
// it stops with a plain message and sends nothing beyond robots.txt. Using the index needs the owner's decision
// (ask Common Crawl for permission, or read the index from its S3 bucket with an AWS account). --from-file and
// --replay work offline on answers in the CDX API format (one JSON object per line: urlkey, timestamp, url, status...).
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

function sourceEntry(crawl: string, rows: number) {
  return {
    id: `commoncrawl-${crawl}`,
    name: `Common Crawl URL index ${crawl} (board tokens only; each board checked live and named by its own provider answer)`,
    url: 'https://index.commoncrawl.org/',
    licence: 'Common Crawl Terms of Use (limited licence; commercial use is not excluded; legal advice recommended)',
    licenceUrl: 'https://commoncrawl.org/terms-of-use',
    note: 'Only the board token of each URL is kept. Employer names come from each board\'s own public API.',
    rows,
  };
}

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
  const files = args('from-file');
  if (crawl && /^CC-MAIN-\d{4}-\d{2}$/.test(crawl) && files.length) {
    const source = `commoncrawl-${crawl}`;
    const all = new Map<string, { ats: CrawlAtsId; slug: string; region: string | null; source: string }>();
    let lines = 0;
    for (const f of files) {
      const text = readFileSync(resolve(f), 'utf8');
      const parsed = parseCdx(text);
      lines += parsed.length;
      for (const s of slugsFromCdx(parsed, source)) { const id = boardId(s.ats, s.slug, s.region); if (!all.has(id)) all.set(id, s); }
    }
    const result = { source: sourceEntry(crawl, all.size), slugs: [...all.values()].sort((a, b) => (boardId(a.ats, a.slug, a.region) < boardId(b.ats, b.slug, b.region) ? -1 : 1)), stats: { files: files.length, lines }, requests: 0 };
    const outFile = arg('out') ? resolve(arg('out')!) : null;
    if (outFile) writeFileSync(outFile, JSON.stringify(result, null, 1) + '\n');
    console.log(`${all.size} board tokens from ${lines} index lines in ${files.length} file(s) (no network)${outFile ? `; wrote ${outFile}` : ''}`);
    return;
  }
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
    pacer: new BusyPacer(1100), hostMap: hostMapFromEnv(), offline: () => offlineFromEnv(),
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
  let robotsBlocked = false;
  const all = new Map<string, { ats: CrawlAtsId; slug: string; region: string | null; source: string }>();
  const stats: Record<string, { pages: number; fetched: number[]; lines: number; slugs: number }> = {};
  for (const host of hosts) {
    const q = `url=${encodeURIComponent(`${host}/*`)}&output=json&fl=url,status`;
    const key = (name: string) => join(crawl, host, name);
    let pages = 0;
    try {
      const meta = JSON.parse(await fetchText(key('pages.json'), `${base}?${q}&showNumPages=true`)) as { pages?: number };
      pages = Number(meta.pages ?? 0);
    } catch (e) {
      const msg = (e as Error).message;
      if (/robots\.txt/.test(msg)) {
        console.error(`${host}: index.commoncrawl.org's robots.txt does not allow this address for crawlers, so nothing was asked. See the note at the top of this script.`);
        robotsBlocked = true;
        break;
      }
      console.error(`${host}: cannot read the page count (${msg})`); continue;
    }
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
    source: sourceEntry(crawl, all.size),
    robotsBlocked,
    slugs: [...all.values()].sort((a, b) => (boardId(a.ats, a.slug, a.region) < boardId(b.ats, b.slug, b.region) ? -1 : 1)),
    stats,
    requests: http ? http.totalRequests : 0,
  };
  if (out) writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
  if (robotsBlocked) process.exitCode = 3;
  console.log(`${all.size} board tokens from ${hosts.join(', ')} (${result.requests} requests${replay ? ', replayed' : ''})${out ? `; wrote ${out}` : ''}`);
}

main().catch((e) => { console.error(`cc-discover: ${(e as Error).message}`); process.exit(1); });
