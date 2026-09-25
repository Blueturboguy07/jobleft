#!/usr/bin/env node
// CLI (`jobleft-crawl`, or `pnpm --filter @jobleft/crawler run crawl ...`). Commands:
//   verify --in candidates.json --out verify.json        one request per candidate board
//   crawl  --boards boards.json --db run.db --out run.json [--grace-hours 48] [--max-requests 3000]
//          [--now 2026-09-28T00:00:00Z]                  time-skip: run as if the clock said this
//   report --db run.db [--out report.json]
//   search --db run.db --q "registered nurse"
//   probe  --url https://... [--key pay_input_ranges]     one request, print the shape of the JSON
// Environment: JOBLEFT_HOST_MAP='{"boards-api.greenhouse.io":"http://127.0.0.1:4010"}' sends a real ATS host
// to a loopback mock server (see docs/INTERFACES.md). Every request carries USER_AGENT and obeys the pacer.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { crawl } from './crawl.ts';
import { HttpClient, USER_AGENT, hostMapFromEnv } from './http.ts';
import { PAY_QUERY } from './sources/greenhouse.ts';
import { hostFor } from './sources/index.ts';
import { Store } from './store.ts';
import type { Ats, BoardRef } from './types.ts';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) out[k] = 'true';
    else { out[k] = v; i++; }
  }
  return out;
}

function need(args: Record<string, string>, k: string): string {
  const v = args[k];
  if (!v) { console.error(`missing --${k}`); process.exit(2); }
  return v;
}

function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T; }

// ---------------------------------------------------------------- verify

interface VerifyRow { ats: Ats; board: string; company: string; ok: boolean; status: string; count: number | null; bytes: number; ms: number }

function verifyUrl(b: BoardRef): string {
  switch (b.ats) {
    case 'greenhouse': return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(b.board)}/jobs`;
    case 'lever': return `https://api.lever.co/v0/postings/${encodeURIComponent(b.board)}?mode=json&limit=1`;
    case 'ashby': return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(b.board)}`;
    default: throw new Error(`verify supports greenhouse, lever and ashby only, not "${b.ats}"`);
  }
}

async function cmdVerify(args: Record<string, string>): Promise<void> {
  const list = readJson<BoardRef[]>(need(args, 'in'));
  const http = new HttpClient({ maxRequests: Number(args['max-requests'] ?? 3000), hostMap: hostMapFromEnv() });
  const queues = new Map<string, BoardRef[]>();
  for (const b of list) { const h = hostFor(b.ats, b.region); (queues.get(h) ?? queues.set(h, []).get(h)!).push(b); }
  const rows: VerifyRow[] = [];
  await Promise.all([...queues.values()].map(async (q) => {
    for (const b of q) {
      const snap = http.snapshot();
      const t0 = Date.now();
      let row: VerifyRow;
      try {
        const j = await http.getJson(verifyUrl(b)) as unknown;
        let count: number | null = null;
        if (Array.isArray(j)) count = j.length;
        else if (j && typeof j === 'object' && Array.isArray((j as { jobs?: unknown }).jobs)) count = ((j as { jobs: unknown[] }).jobs).length;
        row = { ats: b.ats, board: b.board, company: b.company, ok: true, status: '200', count, bytes: 0, ms: 0 };
      } catch (e) {
        row = { ats: b.ats, board: b.board, company: b.company, ok: false, status: e instanceof Error ? `${e.name}: ${e.message}` : String(e), count: null, bytes: 0, ms: 0 };
      }
      const s2 = http.snapshot();
      row.bytes = s2.bytesDecoded - snap.bytesDecoded;
      row.ms = Date.now() - t0;
      rows.push(row);
      console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${b.ats.padEnd(10)} ${b.board.padEnd(34)} count=${row.count} ${row.ok ? '' : row.status}`);
    }
  }));
  const out = { userAgent: USER_AGENT, requests: http.totalRequests, hosts: Object.fromEntries(http.stats), rows };
  writeFileSync(need(args, 'out'), JSON.stringify(out, null, 2));
  console.log(`verify done: ${rows.filter((r) => r.ok).length}/${rows.length} ok, ${http.totalRequests} requests (incl. robots.txt)`);
}

// ---------------------------------------------------------------- crawl

async function cmdCrawl(args: Record<string, string>): Promise<void> {
  const boards = readJson<BoardRef[]>(need(args, 'boards'));
  if (args['pay-transparency'] === 'true') PAY_QUERY.value = '&pay_transparency=true';
  const store = new Store(need(args, 'db'));
  const http = new HttpClient({ maxRequests: Number(args['max-requests'] ?? 3000), hostMap: hostMapFromEnv() });
  const graceMs = Number(args['grace-hours'] ?? 48) * 3600 * 1000;
  let now: (() => number) | undefined;
  if (args.now) {
    const t = Date.parse(args.now);
    if (!Number.isFinite(t)) { console.error(`--now is not a date: ${args.now}`); process.exit(2); }
    now = () => t;
  }
  const report = await crawl(boards, {
    store, http, graceMs, now,
    onBoard: (r) => console.log(
      `${r.status.padEnd(7)} ${r.ats.padEnd(10)} ${r.board.padEnd(34)} listed=${String(r.listed).padStart(4)} ` +
      `ins=${r.stats.inserted} upd=${r.stats.updated} same=${r.stats.unchanged} dupUrl=${r.stats.dupUrl} dupRole=${r.stats.dupRole} ` +
      `skip=${r.stats.skipped} closed=${r.closed} ${r.elapsedMs}ms req=${r.requests} ${(r.bytesDecoded / 1024).toFixed(0)}KB` +
      `${r.error ? ' ERR ' + r.error : ''}`,
    ),
  });
  const out = {
    userAgent: USER_AGENT,
    totalRequests: http.totalRequests,
    hosts: Object.fromEntries(http.stats),
    report,
  };
  writeFileSync(need(args, 'out'), JSON.stringify(out, null, 2));
  const ok = report.boards.filter((b) => b.status === 'ok' && b.stats.ingested > 0).length;
  console.log(`crawl done: ${ok}/${report.boards.length} boards produced rows, ${report.totals.ingested} ingested ` +
    `(${report.totals.inserted} new, ${report.totals.updated} updated, ${report.totals.unchanged} unchanged), ` +
    `${report.totals.dupUrl} dupUrl, ${report.totals.dupRole} dupRole, ${report.totals.closed} closed, ` +
    `${http.totalRequests} requests, wall ${(report.wallMs / 1000).toFixed(1)}s, peak rss ${report.peakRssMb} MB`);
  store.close();
}

// ---------------------------------------------------------------- report

function one<T>(db: DatabaseSync, sql: string, ...p: Array<string | number>): T { return db.prepare(sql).get(...p) as T; }

export function buildReport(dbPath: string): Record<string, unknown> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const n = (sql: string): number => Number(one<{ n: number }>(db, sql).n);
  const total = n('SELECT count(*) AS n FROM jobs');
  const pct = (x: number): number => (total ? Math.round((1000 * x) / total) / 10 : 0);
  const open = n('SELECT count(*) AS n FROM jobs WHERE closed_at IS NULL');
  const withDesc = n("SELECT count(*) AS n FROM jobs WHERE length(description) > 200");
  const withPay = n('SELECT count(*) AS n FROM jobs WHERE pay_min IS NOT NULL OR pay_max IS NOT NULL');
  const payApi = n("SELECT count(*) AS n FROM jobs WHERE pay_source = 'api'");
  const payText = n("SELECT count(*) AS n FROM jobs WHERE pay_source = 'text'");
  const withPosted = n('SELECT count(*) AS n FROM jobs WHERE posted_at IS NOT NULL');
  const withLevel = n('SELECT count(*) AS n FROM jobs WHERE level IS NOT NULL');
  const withLoc = n("SELECT count(*) AS n FROM jobs WHERE location <> ''");
  const remote = n('SELECT count(*) AS n FROM jobs WHERE remote = 1');
  const us = n('SELECT count(*) AS n FROM jobs WHERE is_us = 1');
  const nonUs = n('SELECT count(*) AS n FROM jobs WHERE is_us = 0');
  const usUnknown = n('SELECT count(*) AS n FROM jobs WHERE is_us IS NULL');
  const dupRole = n('SELECT count(*) AS n FROM jobs WHERE duplicate_of IS NOT NULL');
  const closed = n('SELECT count(*) AS n FROM jobs WHERE closed_at IS NOT NULL');
  const avgDesc = Number(one<{ v: number | null }>(db, 'SELECT avg(length(description)) AS v FROM jobs').v ?? 0);
  const sumDesc = Number(one<{ v: number | null }>(db, 'SELECT sum(length(description)) AS v FROM jobs').v ?? 0);
  const pageSize = Number(one<{ page_size: number }>(db, 'PRAGMA page_size').page_size);
  const pageCount = Number(one<{ page_count: number }>(db, 'PRAGMA page_count').page_count);
  const byAts = db.prepare('SELECT ats, count(*) AS rows, count(DISTINCT board) AS boards FROM jobs GROUP BY ats').all();
  const byLevel = db.prepare("SELECT coalesce(level,'(none)') AS level, count(*) AS rows FROM jobs GROUP BY level ORDER BY rows DESC").all();
  const payBands = db.prepare(
    `SELECT pay_period AS period, count(*) AS rows, min(pay_min) AS min_low, max(pay_max) AS max_high,
     round(avg((pay_min + pay_max) / 2.0)) AS avg_mid FROM jobs WHERE pay_min IS NOT NULL AND pay_max IS NOT NULL GROUP BY pay_period`).all();
  const perBoard = db.prepare(
    `SELECT ats, board, company, count(*) AS rows,
       round(100.0 * sum(length(description) > 200) / count(*), 1) AS pct_desc,
       round(100.0 * sum(pay_min IS NOT NULL OR pay_max IS NOT NULL) / count(*), 1) AS pct_pay,
       round(100.0 * sum(level IS NOT NULL) / count(*), 1) AS pct_level,
       round(100.0 * sum(posted_at IS NOT NULL) / count(*), 1) AS pct_posted,
       round(100.0 * sum(is_us = 1) / count(*), 1) AS pct_us,
       sum(duplicate_of IS NOT NULL) AS dup_role
     FROM jobs GROUP BY ats, board ORDER BY ats, board`).all();
  let tableBytes: unknown = null;
  try {
    tableBytes = db.prepare("SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 12").all();
  } catch { tableBytes = 'dbstat not available'; }
  const fileBytes = statSync(dbPath).size;
  db.close();
  return {
    rows: total, open, closed, roleDuplicatesFlagged: dupRole,
    coverage: {
      description_over_200_chars: { n: withDesc, pct: pct(withDesc) },
      pay_any: { n: withPay, pct: pct(withPay) }, pay_from_api: { n: payApi, pct: pct(payApi) }, pay_from_text: { n: payText, pct: pct(payText) },
      posted_at: { n: withPosted, pct: pct(withPosted) },
      level: { n: withLevel, pct: pct(withLevel) },
      location: { n: withLoc, pct: pct(withLoc) },
      remote_flag: { n: remote, pct: pct(remote) },
    },
    usShare: { us: { n: us, pct: pct(us) }, notUs: { n: nonUs, pct: pct(nonUs) }, unknown: { n: usUnknown, pct: pct(usUnknown) } },
    description: { avgChars: Math.round(avgDesc), totalChars: sumDesc },
    db: { fileBytes, pageBytes: pageSize * pageCount, bytesPerRow: total ? Math.round(fileBytes / total) : 0, tableBytes },
    byAts, byLevel, payBands, perBoard,
  };
}

function cmdReport(args: Record<string, string>): void {
  const r = buildReport(need(args, 'db'));
  if (args.out) writeFileSync(args.out, JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r, null, 2));
}

function cmdSearch(args: Record<string, string>): void {
  const s = new Store(need(args, 'db'));
  for (const r of s.search(need(args, 'q'), Number(args.limit ?? 8))) console.log(`${r.id}\t${r.company}\t${r.title}\t${r.location}`);
  s.close();
}

async function cmdProbe(args: Record<string, string>): Promise<void> {
  const http = new HttpClient({ maxRequests: 10, hostMap: hostMapFromEnv() });
  const j = await http.getJson(need(args, 'url')) as unknown;
  const first = Array.isArray(j) ? j[0] : (j as { jobs?: unknown[] }).jobs?.[0];
  console.log('top-level:', Array.isArray(j) ? `array(${j.length})` : Object.keys(j as object));
  console.log('first item keys:', first && typeof first === 'object' ? Object.keys(first as object) : first);
  if (args.key && first && typeof first === 'object') console.log(args.key, '=', JSON.stringify((first as Record<string, unknown>)[args.key]));
  console.log('requests (incl robots):', http.totalRequests, 'bytes:', http.snapshot().bytesDecoded);
}

// ---------------------------------------------------------------- main

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
switch (cmd) {
  case 'verify': await cmdVerify(args); break;
  case 'crawl': await cmdCrawl(args); break;
  case 'report': cmdReport(args); break;
  case 'search': cmdSearch(args); break;
  case 'probe': await cmdProbe(args); break;
  default:
    console.error('usage: node src/cli.ts <verify|crawl|report|search|probe> [--flags]');
    process.exit(2);
}
