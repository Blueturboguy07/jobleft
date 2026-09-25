#!/usr/bin/env node
// jobleft-ats: the command line of @jobleft/sources-ats. Run from the repository root:
//   node packages/sources-ats/src/cli.ts <command> [flags]
// Commands:
//   sources [--json]                                   the ATS source list (crawled or not, why, checked when)
//   detect <url> [<url> ...] [--json]                  what jobleft can do with a pasted link (sends nothing)
//   crawl --boards <boards.json> --db <jobs.db> [--out <report.json>] [--log <requests.ndjson>]
//         [--grace-hours 48] [--max-requests 3000] [--now <RFC 3339>]
//   jobs --db <jobs.db> [--ats <id>] [--board <token>] [--status open|closed|all] [--full] [--json]
//   report --db <jobs.db> [--json]                     board and ATS health from the database
//   standin --dir <folder> [--port 4600] [--log <file>] [--boards-out <file>] [--map-out <file>]
// Environment: JOBLEFT_HOST_MAP sends real ATS hosts to loopback stand-ins; JOBLEFT_OFFLINE=1 sends nothing.

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { crawl, HttpClient, hostMapFromEnv, Store, USER_AGENT } from '@jobleft/crawler';
import type { BoardRef } from '@jobleft/crawler';
import { atsName, classifyUrl } from './detect.ts';
import { stripControls } from './entities.ts';
import { BoundedPacer, politeFetch } from './polite-fetch.ts';
import { allSources } from './registry.ts';
import { buildHealthReport, plainReason } from './report.ts';
import { ATS_SOURCE_DETAILS, notCrawledReason } from './source-list.ts';
import { startStandin } from './standin.ts';

type Args = { _: string[]; [k: string]: string | string[] };

/** Flags that never take a value: `detect --json A B` keeps A and B as links. */
const BOOLEAN_FLAGS = new Set(['json', 'full']);

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 2) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const k = a.slice(2);
    const v = argv[i + 1];
    if (BOOLEAN_FLAGS.has(k) || v === undefined || v.startsWith('--')) out[k] = 'true';
    else { out[k] = v; i++; }
  }
  return out;
}

function flag(args: Args, k: string): string | undefined {
  const v = args[k];
  return typeof v === 'string' ? v : undefined;
}

function need(args: Args, k: string): string {
  const v = flag(args, k);
  if (!v) { console.error(`missing --${k}`); process.exit(2); }
  return v;
}

/** A number flag, checked before anything runs: a plain message and exit 2 when it is not a number in range. */
function numFlag(args: Args, k: string, dflt: number, opts: { min: number; integer?: boolean }): number {
  const raw = flag(args, k);
  if (raw === undefined) return dflt;
  const v = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(v) || v < opts.min || (opts.integer && !Number.isInteger(v))) {
    console.error(`--${k} must be ${opts.integer ? 'a whole number' : 'a number'} of ${opts.min} or more, not "${raw}"`);
    process.exit(2);
  }
  return v;
}

/** A path flag whose folder must exist, checked before the crawl starts (not after it, when the work would be lost). */
function outFlag(args: Args, k: string): string | undefined {
  const p = flag(args, k);
  if (p === undefined) return undefined;
  const dir = dirname(p);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`--${k} ${p}: the folder ${dir} does not exist; make it first`);
    process.exit(2);
  }
  return p;
}

/** Opens an existing database read-only, or prints one plain sentence and exits 2 (never a stack dump). */
function openReadOnly(args: Args): DatabaseSync {
  const path = need(args, 'db');
  if (!existsSync(path)) { console.error(`the database ${path} does not exist; run crawl first`); process.exit(2); }
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (e) {
    console.error(`cannot read the database ${path}: ${(e as Error).message}`);
    process.exit(2);
  }
}

function pad(s: string, n: number): string { return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

// ---------------------------------------------------------------- sources

function cmdSources(args: Args): void {
  if (flag(args, 'json')) { console.log(JSON.stringify(ATS_SOURCE_DETAILS, null, 2)); return; }
  console.log('ATS source list (docs/sources/ holds the quotes). Crawled:');
  for (const s of ATS_SOURCE_DETAILS.filter((d) => d.crawled)) {
    console.log(`  ${pad(s.name, 18)} checked ${s.checkedOn}  evidence ${s.evidenceUrl}`);
    if (s.limits) console.log(`  ${' '.repeat(18)} limits: ${s.limits}`);
  }
  console.log('Not crawled:');
  for (const s of ATS_SOURCE_DETAILS.filter((d) => !d.crawled)) {
    console.log(`  ${pad(s.name, 18)} checked ${s.checkedOn}  ${s.reason}`);
  }
}

// ---------------------------------------------------------------- detect

function cmdDetect(args: Args): void {
  if (args._.length === 0) { console.error('usage: detect <url> [<url> ...]'); process.exit(2); }
  const rows = args._.map((u) => ({ input: u, ...classifyUrl(u, notCrawledReason) }));
  if (flag(args, 'json')) { console.log(JSON.stringify(rows, null, 2)); return; }
  for (const r of rows) console.log(`${pad(r.verdict, 22)} ${r.message}\n${' '.repeat(23)}${r.input}`);
}

// ---------------------------------------------------------------- crawl

function readBoards(path: string): BoardRef[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) {
    console.error(`cannot read the board list ${path}: ${(e as Error).message}`); process.exit(2);
  }
  if (!Array.isArray(raw)) { console.error('the board list must be a JSON array of { "ats", "board", "company", "region"? }'); process.exit(2); }
  const out: BoardRef[] = [];
  raw.forEach((b, i) => {
    const o = (b ?? {}) as Record<string, unknown>;
    if (typeof o.ats !== 'string' || typeof o.board !== 'string' || !o.board.trim()) {
      console.error(`board ${i + 1} is skipped: it needs "ats" and "board" strings`);
      return;
    }
    out.push({
      ats: o.ats.trim().toLowerCase() as BoardRef['ats'], board: o.board.trim(),
      company: typeof o.company === 'string' && o.company.trim() ? o.company.trim() : o.board.trim(),
      ...(typeof o.region === 'string' && o.region.trim() ? { region: o.region.trim().toLowerCase() } : {}),
    });
  });
  return out;
}

async function cmdCrawl(args: Args): Promise<void> {
  const boards = readBoards(need(args, 'boards'));
  const dbPath = need(args, 'db');
  const graceHours = numFlag(args, 'grace-hours', 48, { min: 0 });
  const maxRequests = numFlag(args, 'max-requests', 3000, { min: 1, integer: true });
  const outPath = outFlag(args, 'out');
  const logPath = outFlag(args, 'log');
  if (process.env.JOBLEFT_OFFLINE === '1') {
    console.log('offline: JOBLEFT_OFFLINE=1 is set, so no request was sent and nothing changed');
    return;
  }
  // One clock value for the whole run (the run's start, or --now). The crawler compares each job's last-seen time
  // with "now minus the grace period" after the run; with a moving clock, jobs seen earlier in the SAME run would
  // look older than the cutoff when the grace is 0. A fixed run clock makes "--grace-hours 0" mean "close what this
  // run proved missing" and nothing else.
  const nowArg = flag(args, 'now');
  let runStart = Date.now();
  if (nowArg) {
    runStart = Date.parse(nowArg);
    if (!Number.isFinite(runStart)) { console.error(`--now is not a date: ${nowArg}`); process.exit(2); }
    process.env.JOBLEFT_NOW ??= new Date(runStart).toISOString();
  }
  const now = (): number => runStart;
  const store = new Store(dbPath);
  const http = new HttpClient({
    maxRequests,
    pacer: new BoundedPacer(),
    hostMap: hostMapFromEnv(),
    fetchImpl: politeFetch({ onRequest: logPath ? (e) => appendFileSync(logPath, JSON.stringify(e) + '\n') : undefined }),
  });
  const graceMs = graceHours * 3600 * 1000;
  const run = await crawl(boards, {
    store, http, sources: allSources(), graceMs, now,
    onBoard: (r) => {
      const reason = r.status === 'ok' ? '' : ` -- ${r.error?.startsWith('no adapter')
        ? `jobleft does not crawl ${atsName(r.ats)}; nothing was sent` : plainReason(r.error)}`;
      console.log(`${pad(r.status, 12)} ${pad(`${r.ats}:${r.board}`, 40)} listed=${r.listed} new=${r.stats.inserted} ` +
        `updated=${r.stats.updated} same=${r.stats.unchanged} unreadable=${r.stats.unreadable} requests=${r.requests}${reason}`);
    },
  });
  if (!nowArg) run.finishedAt = new Date().toISOString();
  const health = buildHealthReport(run, store);
  const out = { userAgent: USER_AGENT, totalRequests: http.totalRequests, hosts: Object.fromEntries(http.stats), health, run };
  if (outPath) writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('\nper ATS: boards ok/failed, jobs listed, read, new, closed, open after the run');
  for (const a of health.byAts) {
    console.log(`  ${pad(a.ats, 11)} boards ${a.ok}/${a.failed}  listed ${a.listed}  read ${a.read}  new ${a.new}  closed ${a.closed}  open ${a.openJobs}${a.flagged ? `  flagged ${a.flagged}` : ''}`);
  }
  for (const b of health.boards.filter((x) => x.flag || x.closeHeld)) console.log(`  flag ${b.boardId}: ${b.flag ?? b.closeHeld}`);
  const t = health.totals;
  console.log(`crawl done: ${t.ok} of ${t.boards} boards ok, ${t.read} jobs read (${t.new} new), ${t.closed} closed, ` +
    `${http.totalRequests} requests (robots.txt included)${outPath ? `, report in ${outPath}` : ''}`);
  store.close();
}

// ---------------------------------------------------------------- jobs

interface JobRow {
  ats: string; board: string; job_id: string; title: string; company: string; location: string; remote: number;
  work_mode: string; is_us: number | null; pay_min: number | null; pay_max: number | null; pay_currency: string | null;
  pay_period: string | null; pay_source: string | null; posted_at: string | null; employment_type: string;
  department: string; canonical_url: string; apply_url: string; description: string; first_seen: string;
  last_seen: string; closed_at: string | null; closed_reason: string | null; duplicate_of: number | null; level: string | null;
}

function cmdJobs(args: Args): void {
  const db = openReadOnly(args);
  const where: string[] = [];
  const params: string[] = [];
  const ats = flag(args, 'ats'); if (ats) { where.push('ats = ?'); params.push(ats.toLowerCase()); }
  const board = flag(args, 'board'); if (board) { where.push('board = ?'); params.push(board); }
  const status = flag(args, 'status') ?? 'all';
  if (status === 'open') where.push('closed_at IS NULL');
  if (status === 'closed') where.push('closed_at IS NOT NULL');
  const rows = db.prepare(`SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ats, board, job_id`)
    .all(...params) as unknown as JobRow[];
  const full = !!flag(args, 'full');
  // Text from postings is printed as plain text: a control character (ESC, BEL, NUL) in an old row must not reach the terminal.
  const safe = (v: string): string => stripControls(v).replace(/\r/g, '');
  for (const r of rows) {
    r.title = safe(r.title); r.company = safe(r.company); r.location = safe(r.location ?? '');
    r.department = safe(r.department ?? ''); r.description = safe(r.description ?? '');
  }
  const shaped = rows.map((r) => ({
    id: `${r.ats}:${r.board}:${r.job_id}`.replace(/^([^:]+):([^:]+):/, (_m, a: string, b: string) => `${a.toLowerCase()}:${b.toLowerCase()}:`),
    ats: r.ats, board: r.board, externalId: r.job_id, title: r.title, company: r.company,
    location: r.location || null, remote: r.remote === 1, workMode: r.work_mode || null,
    isUs: r.is_us === null ? null : r.is_us === 1,
    pay: r.pay_min === null && r.pay_max === null ? null
      : { min: r.pay_min, max: r.pay_max, currency: r.pay_currency, period: r.pay_period, source: r.pay_source },
    postedAt: r.posted_at, employmentType: r.employment_type || null, department: r.department || null, level: r.level,
    url: r.canonical_url, applyUrl: r.apply_url || null,
    status: r.closed_at ? 'closed' : 'open', closedAt: r.closed_at, closedReason: r.closed_reason, duplicateOf: r.duplicate_of,
    firstSeenAt: r.first_seen, lastSeenAt: r.last_seen,
    description: full ? r.description : r.description.slice(0, 240),
  }));
  if (flag(args, 'json')) { console.log(JSON.stringify(shaped, null, 2)); db.close(); return; }
  for (const j of shaped) {
    const pay = j.pay ? `${j.pay.currency ?? '?'} ${j.pay.min ?? '?'}-${j.pay.max ?? '?'}/${j.pay.period} (${j.pay.source})` : 'pay: not stated';
    console.log(`${j.status === 'open' ? 'OPEN  ' : 'CLOSED'} ${j.id}\n  ${j.title} | ${j.company} | ${j.location ?? 'place: not stated'}` +
      ` | ${j.workMode ?? 'work model: not stated'}${j.remote ? ' (remote)' : ''}\n  ${pay} | posted ${j.postedAt ?? 'not stated'}` +
      ` | ${j.url}${j.closedAt ? `\n  closed ${j.closedAt} (${j.closedReason})` : ''}`);
  }
  console.log(`${shaped.length} jobs (${shaped.filter((j) => j.status === 'open').length} open)`);
  db.close();
}

// ---------------------------------------------------------------- report (from the database)

function cmdReport(args: Args): void {
  const db = openReadOnly(args);
  const rows = db.prepare(`
    SELECT b.ats, b.board, b.company, b.region, b.consecutive_failures, b.cooldown_until, b.last_attempt_at,
           b.last_success_at, b.last_yield_at, b.last_error, b.last_ingested, b.empty_streak,
           (SELECT count(*) FROM jobs j WHERE j.ats = b.ats AND j.board = b.board AND j.closed_at IS NULL) AS open_jobs,
           (SELECT count(*) FROM jobs j WHERE j.ats = b.ats AND j.board = b.board AND j.closed_at IS NOT NULL) AS closed_jobs
    FROM boards b ORDER BY b.ats, b.board`).all() as Array<Record<string, string | number | null>>;
  const boards = rows.map((r) => {
    const failing = Number(r.consecutive_failures) > 0;
    let flagText: string | null = null;
    if (!failing && Number(r.last_ingested) === 0 && Number(r.open_jobs) > 0 && r.last_success_at) {
      flagText = 'the last good answer had no readable jobs, but earlier jobs are still open';
    }
    return {
      boardId: `${r.ats}:${r.board}`.toLowerCase(), ats: r.ats, board: r.board, company: r.company, region: r.region || null,
      state: r.cooldown_until ? 'cooldown' : failing ? 'failing' : r.last_success_at ? 'ok' : 'not_checked',
      lastCheckedAt: r.last_attempt_at, lastSuccessAt: r.last_success_at,
      lastProblem: failing ? plainReason(String(r.last_error)) : null,
      failuresInARow: Number(r.consecutive_failures), cooldownUntil: r.cooldown_until,
      jobsLastRun: Number(r.last_ingested), openJobs: Number(r.open_jobs), closedJobs: Number(r.closed_jobs), flag: flagText,
    };
  });
  const byAts = new Map<string, { ats: string; boards: number; ok: number; failing: number; openJobs: number; closedJobs: number }>();
  for (const b of boards) {
    const a = byAts.get(String(b.ats)) ?? { ats: String(b.ats), boards: 0, ok: 0, failing: 0, openJobs: 0, closedJobs: 0 };
    a.boards++; if (b.state === 'ok') a.ok++; if (b.state === 'failing' || b.state === 'cooldown') a.failing++;
    a.openJobs += b.openJobs; a.closedJobs += b.closedJobs;
    byAts.set(a.ats, a);
  }
  if (flag(args, 'json')) { console.log(JSON.stringify({ boards, byAts: [...byAts.values()] }, null, 2)); db.close(); return; }
  for (const b of boards) {
    console.log(`${pad(b.state, 11)} ${pad(b.boardId, 40)} open ${b.openJobs} closed ${b.closedJobs} last checked ${b.lastCheckedAt ?? 'never'}` +
      `${b.lastProblem ? `\n            problem: ${b.lastProblem}` : ''}${b.flag ? `\n            flag: ${b.flag}` : ''}`);
  }
  for (const a of byAts.values()) console.log(`ATS ${pad(a.ats, 11)} boards ${a.boards} (ok ${a.ok}, failing ${a.failing}) open jobs ${a.openJobs} closed ${a.closedJobs}`);
  db.close();
}

// ---------------------------------------------------------------- standin

async function cmdStandin(args: Args): Promise<void> {
  const s = await startStandin(need(args, 'dir'), { basePort: Number(flag(args, 'port') ?? 4600), log: flag(args, 'log') });
  const boards = s.boards.map(({ ats, board, company, region }) => ({ ats, board, company, ...(region ? { region } : {}) }));
  const boardsOut = flag(args, 'boards-out');
  const mapOut = flag(args, 'map-out');
  if (boardsOut) writeFileSync(boardsOut, JSON.stringify(boards, null, 2));
  if (mapOut) writeFileSync(mapOut, JSON.stringify(s.hostMap));
  console.log(`stand-in boards on 127.0.0.1 (${s.boards.length} boards, ${Object.keys(s.hostMap).length} hosts):`);
  for (const b of s.boards) console.log(`  ${pad(`${b.ats}:${b.board}`, 32)} ${b.host} -> ${s.hostMap[b.host]}`);
  console.log(`JOBLEFT_HOST_MAP='${JSON.stringify(s.hostMap)}'`);
  console.log('Press Ctrl+C to stop.');
  const stop = (): void => { void s.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// ---------------------------------------------------------------- main

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
try {
  switch (cmd) {
    case 'sources': cmdSources(args); break;
    case 'detect': cmdDetect(args); break;
    case 'crawl': await cmdCrawl(args); break;
    case 'jobs': cmdJobs(args); break;
    case 'report': cmdReport(args); break;
    case 'standin': await cmdStandin(args); break;
    default:
      console.error('usage: node packages/sources-ats/src/cli.ts <sources|detect|crawl|jobs|report|standin> [flags]');
      process.exit(2);
  }
} catch (e) {
  // One plain sentence, never a stack dump (a database that is not SQLite, a folder that is read-only, a bad host map...).
  const message = e instanceof Error ? e.message.split('\n')[0] : String(e);
  console.error(`jobleft-ats ${cmd}: ${message}`);
  process.exit(1);
}
