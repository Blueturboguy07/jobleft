#!/usr/bin/env node
// jobleft-crawl: the crawler's command line. Run `jobleft-crawl help` for the commands.
// Every request carries the configured identity and obeys the pacer, robots.txt and the never-crawl list.
// JOBLEFT_HOST_MAP='{"boards-api.greenhouse.io":"http://127.0.0.1:4010"}' sends a real ATS host to a loopback mock
// server; a board entry's "origin" sends one board to its own mock server.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { JobSchema, parseDuration, validate } from '@jobleft/contracts';
import { parseBoardList } from './boardlist.ts';
import type { BoardList } from './boardlist.ts';
import { ConfigError, loadConfigFile, makeConfig } from './config.ts';
import type { CrawlerConfig } from './config.ts';
import { getJobById, queryJobs, toContractJob } from './contract.ts';
import type { JobRow } from './contract.ts';
import { crawl } from './crawl.ts';
import type { BoardResult } from './crawl.ts';
import { HttpClient, USER_AGENT, hostMapFromEnv } from './http.ts';
import { Runs } from './runs.ts';
import {
  CLOCK_OFFSET_KEY, allMockBoards, crawlProgress, crawlerClock, formatDuration, lastRunReport, planDue, runOnce, scheduleSettings,
  simulate, storedClockOffset, Scheduler,
} from './scheduler.ts';
import { PAY_QUERY } from './sources/greenhouse.ts';
import { SOURCES, hostFor } from './sources/index.ts';
import { Store } from './store.ts';
import type { BoardRow } from './store.ts';
import type { Ats, BoardRef } from './types.ts';

// ------------------------------------------------------------------------------------------------ arguments

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) out[k] = 'true';
    else { out[k] = v; i++; }
  }
  return out;
}

class UsageError extends Error {}

function need(args: Record<string, string>, k: string): string {
  const v = args[k];
  if (!v || v === 'true') throw new UsageError(`missing --${k}`);
  return v;
}

function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T; }

function homeDir(): string {
  if (process.env.JOBLEFT_HOME) return process.env.JOBLEFT_HOME;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'jobleft');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'jobleft');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'jobleft');
}

/** --db, else $JOBLEFT_HOME/data/jobleft.db (the app's database). */
function dbPath(args: Record<string, string>): string {
  const p = args.db && args.db !== 'true' ? resolve(args.db) : join(homeDir(), 'data', 'jobleft.db');
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  return p;
}

function duration(v: string, name: string): number {
  try { return parseDuration(v); } catch { throw new UsageError(`--${name} must be a duration such as 24h, 30m, 3d or 90s (got "${v}")`); }
}

function configFrom(args: Record<string, string>): CrawlerConfig {
  const o: Record<string, unknown> = {};
  if (args['user-agent']) o.userAgent = args['user-agent'];
  if (args.refresh) o.refreshHours = duration(args.refresh, 'refresh') / 3_600_000;
  if (args.confirm) o.confirmHours = duration(args.confirm, 'confirm') / 3_600_000;
  if (args['max-requests']) o.maxRequestsPerRun = Number(args['max-requests']);
  if (args['confirm-delay']) o.confirmDelaySeconds = duration(args['confirm-delay'], 'confirm-delay') / 1000;
  if (args.timeout) o.requestTimeoutSeconds = duration(args.timeout, 'timeout') / 1000;
  if (args['pay-transparency']) o.greenhousePayTransparency = args['pay-transparency'] !== 'false';
  return args.config ? loadConfigFile(args.config, o) : makeConfig(o);
}

function clockFor(store: Store, args: Record<string, string>): () => number {
  let fixed: number | null = null;
  if (args.now) {
    fixed = Date.parse(args.now);
    if (!Number.isFinite(fixed)) throw new UsageError(`--now is not a date: ${args.now}`);
  }
  const extra = args['clock-offset'] ? duration(args['clock-offset'], 'clock-offset') : 0;
  return crawlerClock(store, { fixedMs: fixed, extraOffsetMs: extra });
}

function loadBoards(args: Record<string, string>): BoardList {
  const file = need(args, 'boards');
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (e) { throw new UsageError(`cannot read the board list ${file}: ${(e as Error).message}`); }
  return parseBoardList(text);
}

function printSkipped(list: BoardList): void {
  for (const s of list.skipped) console.log(`skipped   ${s.entry}\n          ${s.reason}`);
  if (list.duplicates > 0) console.log(`note      ${list.duplicates} board(s) were listed more than once; each is crawled once`);
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function boardLabel(b: { ats: string; board: string; region?: string | null }): string {
  return `${b.ats}:${b.region ? b.region + ':' : ''}${b.board}`;
}

function lineFor(r: BoardResult): string {
  const id = boardLabel(r).padEnd(34);
  const st = r.status.padEnd(12);
  if (r.status === 'ok') {
    const main = r.notModified
      ? `unchanged (304)  open ${r.stats.unchanged}`
      : `listed ${String(r.listed).padStart(5)}  new ${r.stats.inserted}  updated ${r.stats.updated}  same ${r.stats.unchanged}`;
    const extra = [
      r.closed ? `closed ${r.closed}` : '',
      r.missing ? `missing ${r.missing}` : '',
      r.stats.skipped ? `skipped ${r.stats.skipped}` : '',
    ].filter(Boolean).join('  ');
    const note = r.reason && !r.notModified ? `\n${' '.repeat(12)}${r.reason}` : '';
    return `${st}${id}${main}${extra ? '  ' + extra : ''}  ${r.requests} req  ${(r.elapsedMs / 1000).toFixed(1)}s${note}`;
  }
  return `${st}${id}${r.reason ?? r.error ?? ''}`;
}

// ------------------------------------------------------------------------------------------------ run

async function cmdRun(args: Record<string, string>): Promise<number> {
  if (process.env.JOBLEFT_OFFLINE === '1') { console.log('offline (JOBLEFT_OFFLINE=1): no request was sent'); return 3; }
  const cfg = configFrom(args);
  const list = loadBoards(args);
  const store = new Store(dbPath(args));
  const runs = new Runs(store);
  const lease = runs.acquireLease();
  if (!lease.ok) { console.error(`another jobleft crawler (pid ${lease.pid}, since ${lease.since}) is using this database; try again when it is done`); store.close(); return 4; }
  const clock = clockFor(store, args);
  const hostMap = hostMapFromEnv();
  const ac = new AbortController();
  const onSig = () => { if (!ac.signal.aborted) { console.log('stopping: no new board starts; unfinished boards resume next time'); ac.abort(); } };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  try {
    printSkipped(list);
    if (args.fresh === 'true') {
      const int = runs.interrupted();
      if (int) { runs.abandon(int.id, iso(clock())); console.log(`run #${int.id} was cut short; --fresh drops what it left and starts over`); }
    }
    let boards = list.boards;
    if (args.due === 'true') {
      const plan = planDue(store, boards, clock(), scheduleSettings(cfg));
      boards = plan.filter((d) => d.dueAt <= clock()).map((d) => d.board);
      console.log(`${boards.length} of ${list.boards.length} board(s) are due`);
    }
    if (cfg.refreshHours < 1 && !allMockBoards(list.boards, hostMap)) throw new UsageError('--refresh under 1 hour is allowed only when every board is a mock server on this computer');
    const everRan = runs.latest() !== null;
    console.log(`jobleft-crawl run: ${boards.length} board(s), database ${store.path}, clock ${iso(clock())}, identity "${cfg.userAgent}"`);
    const out = await runOnce(
      { store, config: cfg, hostMap, clock, onBoard: (r) => console.log(lineFor(r)) },
      { reason: everRan ? 'manual' : 'first_run', boards, force: args.force === 'true', retryFailing: args.due !== 'true', signal: ac.signal },
    );
    if (!out) { console.log('nothing to crawl'); return 0; }
    const r = out.run;
    if (out.resumed) console.log(`(this finished run #${out.runId}, which had been cut short; run the command again for a new full crawl)`);
    console.log(`run #${out.runId} ${r.state}: ${r.boards_done}/${r.boards_total} boards, ${r.ok} ok, ${r.failed} failed, ${r.deferred} waiting; ` +
      `${r.inserted} new, ${r.updated} updated, ${r.closed} closed; ${out.requests} requests (robots.txt included); peak memory ${out.report.peakRssMb} MB`);
    const open = store.count('closed_at IS NULL AND duplicate_of IS NULL');
    const closed = store.count('closed_at IS NOT NULL');
    console.log(`jobs in the database: ${open} open, ${closed} closed`);
    if (args.out && args.out !== 'true') {
      writeFileSync(args.out, JSON.stringify({ userAgent: cfg.userAgent, runId: out.runId, run: r, report: out.report, skipped: list.skipped, hosts: Object.fromEntries(out.http.stats) }, null, 2));
    }
    return r.state === 'stopped' ? 130 : 0;
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
    runs.releaseLease();
    store.close();
  }
}

// ------------------------------------------------------------------------------------------------ daemon

async function cmdDaemon(args: Record<string, string>): Promise<number> {
  if (process.env.JOBLEFT_OFFLINE === '1') { console.log('offline (JOBLEFT_OFFLINE=1): no request was sent'); return 3; }
  const cfg = configFrom(args);
  const file = need(args, 'boards');
  const store = new Store(dbPath(args));
  const clock = clockFor(store, args);
  const hostMap = hostMapFromEnv();
  let last: BoardList = loadBoards(args);
  printSkipped(last);
  const boards = () => {
    try { last = parseBoardList(readFileSync(file, 'utf8')); } catch (e) { console.log(`${iso(Date.now())} the board list cannot be read (${(e as Error).message}); using the last good one`); }
    return last.boards;
  };
  const s = scheduleSettings(cfg);
  const sched = new Scheduler({
    store, config: cfg, hostMap, clock, boards,
    log: (line) => console.log(`${iso(Date.now())} ${line}`),
    onBoard: (r) => console.log(`${iso(Date.now())} ${lineFor(r)}`),
  });
  console.log(`jobleft-crawl daemon: ${last.boards.length} board(s), refresh every ${formatDuration(s.refreshMs)}, confirm after ${formatDuration(s.confirmGapMs)}, identity "${cfg.userAgent}". Ctrl+C stops.`);
  try { await sched.start({ catchUp: args['no-catch-up'] !== 'true' }); } catch (e) { console.error((e as Error).message); store.close(); return 4; }
  const stop = () => { console.log(`${iso(Date.now())} stopping`); void sched.stop(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await sched.done;
  store.close();
  return 0;
}

// ------------------------------------------------------------------------------------------------ simulate

async function cmdSimulate(args: Record<string, string>): Promise<number> {
  if (process.env.JOBLEFT_OFFLINE === '1') { console.log('offline (JOBLEFT_OFFLINE=1): no request was sent'); return 3; }
  const cfg = configFrom(args);
  const forMs = duration(need(args, 'for'), 'for');
  if (forMs <= 0 || forMs > 60 * 24 * 3600 * 1000) throw new UsageError('--for must be between 1s and 60d');
  const list = loadBoards(args);
  printSkipped(list);
  const store = new Store(dbPath(args));
  const runs = new Runs(store);
  const lease = runs.acquireLease();
  if (!lease.ok) { console.error(`another jobleft crawler (pid ${lease.pid}) is using this database`); store.close(); return 4; }
  const clock = clockFor(store, args);
  const hostMap = hostMapFromEnv();
  try {
    if (cfg.refreshHours < 1 && !allMockBoards(list.boards, hostMap)) throw new UsageError('--refresh under 1 hour is allowed only when every board is a mock server on this computer');
    console.log(`jobleft-crawl simulate: the schedule of ${formatDuration(forMs)} from ${iso(clock())}; requests still go out at the real polite pace`);
    const res = await simulate({ store, config: cfg, hostMap, clock, boards: list.boards, log: (l) => console.log(l), onBoard: (r) => console.log(lineFor(r)) }, forMs);
    const off = storedClockOffset(store);
    console.log(`simulated ${res.runs} run(s) up to ${iso(res.toMs)}. The crawler clock of this database now runs ${formatDuration(off)} ahead ` +
      `(every later jobleft-crawl command on it uses that clock; "jobleft-crawl clock --reset" puts it back).`);
    return 0;
  } finally {
    runs.releaseLease();
    store.close();
  }
}

function cmdClock(args: Record<string, string>): number {
  const store = new Store(dbPath(args));
  if (args.reset === 'true') store.setMeta(CLOCK_OFFSET_KEY, null);
  const off = storedClockOffset(store);
  console.log(`crawler clock ${iso(crawlerClock(store)())} (offset left by simulate: ${off ? formatDuration(off) : 'none'})`);
  store.close();
  return 0;
}

// ------------------------------------------------------------------------------------------------ status

type BoardStateWord = 'not_checked' | 'live' | 'failing' | 'unreachable' | 'cooldown' | 'blocked' | 'waiting';

function stateOf(row: BoardRow, now: number): BoardStateWord {
  if (!row.last_checked_at && !row.last_attempt_at) return 'not_checked';
  if (row.cooldown_until && Date.parse(row.cooldown_until) > now) return 'cooldown';
  switch (row.last_status) {
    case 'ok': return 'live';
    case 'blocked': case 'robots': case 'forbidden': return 'blocked';
    case 'deferred': case 'host-skipped': return 'waiting';
    case 'cooled': return 'cooldown';
    default:
      return ['not_found', 'network', 'timeout'].includes(row.last_reason_code ?? '') ? 'unreachable' : 'failing';
  }
}

function cmdStatus(args: Record<string, string>): number {
  const store = new Store(dbPath(args));
  const clock = clockFor(store, args);
  const now = clock();
  const cfg = configFrom(args);
  const s = scheduleSettings(cfg);
  const list = args.boards ? loadBoards(args) : null;
  const rows = store.listBoards().filter((r) => !list || list.boards.some((b) => b.ats === r.ats && b.board.toLowerCase() === r.board.toLowerCase()));
  const refs: BoardRef[] = list ? list.boards : rows.map((r) => {
    const ref: BoardRef = { ats: r.ats as Ats, board: r.board, company: r.company };
    if (r.region) ref.region = r.region;
    if (r.origin) ref.origin = r.origin;
    return ref;
  });
  const plan = new Map(planDue(store, refs, now, s).map((d) => [`${d.board.ats}\u0000${d.board.board.toLowerCase()}`, d]));
  const openBy = new Map((store.db.prepare('SELECT ats, board, count(*) AS n FROM jobs WHERE closed_at IS NULL AND duplicate_of IS NULL GROUP BY ats, board').all() as Array<{ ats: string; board: string; n: number }>)
    .map((r) => [`${r.ats}\u0000${r.board.toLowerCase()}`, Number(r.n)]));
  const boards = rows.map((r) => {
    const key = `${r.ats}\u0000${r.board.toLowerCase()}`;
    const d = plan.get(key);
    const pm = store.pendingMisses(r.ats, r.board);
    return {
      boardId: boardLabel(r), company: r.company, state: stateOf(r, now), lastStatus: r.last_status ?? null,
      reasonCode: r.last_reason_code ?? null, reason: r.last_reason ?? (r.last_status === 'ok' ? null : r.last_error),
      openJobs: openBy.get(key) ?? 0, listedLastTime: r.last_listed ?? null,
      lastCheckAt: r.last_checked_at ?? r.last_attempt_at, lastSuccessAt: r.last_success_at, failuresInARow: r.consecutive_failures,
      cooldownUntil: r.cooldown_until, nextCheckAt: d && Number.isFinite(d.dueAt) ? iso(Math.max(d.dueAt, now)) : null, nextCheckWhy: d?.why ?? null,
      missingNow: pm.count, missingSince: pm.firstMissedAt, origin: r.origin ?? null,
    };
  });
  const progress = crawlProgress(store, now, s, refs);
  const report = lastRunReport(store, args.run ? Number(args.run) : undefined);
  const hostWaits = store.hostWaits(Date.now()).map((h) => ({ host: h.host, until: iso(h.untilMs), reason: h.reason }));
  const open = store.count('closed_at IS NULL AND duplicate_of IS NULL');
  const closed = store.count('closed_at IS NOT NULL');
  const off = storedClockOffset(store);
  if (args.json === 'true') {
    console.log(JSON.stringify({ database: store.path, clock: iso(now), clockOffsetMs: off, progress, lastRun: report, boards, hostWaits, jobs: { open, closed } }, null, 2));
    store.close();
    return 0;
  }
  console.log(`jobleft crawler status  database ${store.path}  clock ${iso(now)}${off ? ` (${formatDuration(off)} ahead, left by simulate)` : ''}`);
  if (progress.running) console.log(`Crawl running (${progress.reason ?? 'manual'}): ${progress.boardsDone} of ${progress.boardsTotal} boards done (${progress.boardsTotal ? Math.floor((100 * progress.boardsDone) / progress.boardsTotal) : 0}%), ${progress.jobsSeen} jobs listed so far, started ${progress.startedAt}`);
  else console.log('Crawl not running.');
  if (report.run) {
    const r = report.run;
    console.log(`Last run: finished ${r.finishedAt}: ${r.boards} boards, ${r.ok} ok, ${r.failed} failed; ${r.inserted} new, ${r.updated} updated, ${r.closed} closed; ${r.requests} requests`);
  }
  if (progress.nextScheduledAt) console.log(`Next scheduled check: ${progress.nextScheduledAt}`);
  console.log(`Jobs: ${open} open, ${closed} closed.`);
  console.log('');
  console.log(`${'BOARD'.padEnd(34)}${'STATE'.padEnd(12)}${'OPEN'.padStart(6)}  ${'LAST CHECK'.padEnd(21)}${'NEXT CHECK'.padEnd(21)}PROBLEM OR NOTE`);
  for (const b of boards) {
    const note = [b.reason ?? '', b.missingNow ? `${b.missingNow} job(s) missing since ${b.missingSince}; a second reading confirms before they close` : ''].filter(Boolean).join(' | ');
    console.log(`${b.boardId.padEnd(34)}${b.state.padEnd(12)}${String(b.openJobs).padStart(6)}  ${(b.lastCheckAt ? iso(Date.parse(b.lastCheckAt)) : '-').padEnd(21)}${(b.nextCheckAt ?? '-').padEnd(21)}${note || '-'}`);
  }
  if (hostWaits.length > 0) {
    console.log('');
    for (const h of hostWaits) console.log(`host ${h.host} is left alone until ${h.until} (${h.reason ?? 'it asked to wait'})`);
  }
  store.close();
  return 0;
}

// ------------------------------------------------------------------------------------------------ jobs

function cmdJobs(args: Record<string, string>): number {
  const store = new Store(dbPath(args));
  const now = clockFor(store, args)();
  try {
    if (args.id) {
      const j = getJobById(store.db, args.id);
      if (!j) { console.error(`no job with id ${args.id}`); return 1; }
      console.log(JSON.stringify(j, null, 2));
      return 0;
    }
    const status = (args.status ?? 'all') as 'open' | 'closed' | 'all';
    if (!['open', 'closed', 'all'].includes(status)) throw new UsageError('--status must be open, closed or all');
    const page = queryJobs(store.db, {
      status, q: args.q, board: args.board, includeDuplicates: args['include-duplicates'] === 'true',
      limit: args.limit ? Number(args.limit) : 10_000, cursor: args.cursor ?? null,
    });
    if (args.format === 'lines') {
      for (const j of page.items) {
        const pay = j.pay ? ` | ${j.pay.currency} ${j.pay.min ?? '?'}-${j.pay.max ?? '?'} per ${j.pay.period}` : '';
        const where = j.places.length ? j.places.map((p) => p.text).join('; ') : '(place not stated)';
        const posted = j.postedAt ? j.postedAt.slice(0, 10) : 'not stated';
        const unseen = now - Date.parse(j.lastSeenAt);
        console.log(`${j.status.padEnd(7)}${j.id} | ${j.title} | ${j.company} | ${where}${pay} | posted ${posted} | last seen ${j.lastSeenAt}${unseen > 36 * 3600 * 1000 ? ` (not confirmed for ${formatDuration(unseen)})` : ''}${j.closedAt ? ` | closed ${j.closedAt}` : ''}`);
      }
      console.log(`${page.total} job(s): ${page.open} open, ${page.closed} closed${page.nextCursor ? ` (more: --cursor ${page.nextCursor})` : ''}`);
      return 0;
    }
    console.log(JSON.stringify({ clock: iso(now), total: page.total, open: page.open, closed: page.closed, nextCursor: page.nextCursor, items: page.items }, null, 2));
    return 0;
  } finally {
    store.close();
  }
}

// ------------------------------------------------------------------------------------------------ verify

function cmdVerifyDb(args: Record<string, string>): number {
  const path = dbPath(args);
  const store = new Store(path);
  const problems: string[] = [];
  const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) problems.push(what); };
  const integrity = (store.db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>).map((r) => r.integrity_check);
  check(integrity.length === 1 && integrity[0] === 'ok', `SQLite integrity check (${integrity.slice(0, 3).join('; ')})`);
  let ftsOk = true;
  try { store.db.exec("INSERT INTO jobs_fts(jobs_fts) VALUES ('integrity-check')"); } catch { ftsOk = false; }
  check(ftsOk, 'full-text index matches the jobs');
  check(store.schemaVersion() >= 2, `crawler schema version ${store.schemaVersion()}`);
  const n = (sql: string) => Number((store.db.prepare(sql).get() as { n: number }).n);
  check(n("SELECT count(*) AS n FROM jobs WHERE trim(title) = ''") === 0, 'every job has a title');
  check(n("SELECT count(*) AS n FROM jobs WHERE coalesce(page_url, '') NOT LIKE 'http%'") === 0, 'every job has a web link');
  check(n("SELECT count(*) AS n FROM jobs WHERE apply_link IS NOT NULL AND apply_link NOT LIKE 'http%'") === 0, 'no apply link that is not http(s)');
  check(n('SELECT count(*) AS n FROM jobs j WHERE NOT EXISTS (SELECT 1 FROM job_sources s WHERE s.job = j.id)') === 0, 'every job names its source');
  check(n('SELECT count(*) AS n FROM jobs WHERE closed_at IS NOT NULL AND closed_reason IS NULL') === 0, 'every closed job has a close reason');
  let bad = 0;
  let first = '';
  for (const r of store.db.prepare('SELECT * FROM jobs').iterate() as IterableIterator<JobRow>) {
    const j = toContractJob(r, store.db.prepare('SELECT source_id, name, url, credit_json, first_seen, last_seen FROM job_sources WHERE job = ?').all(r.id) as never);
    const v = validate(JobSchema, j);
    if (!v.ok) { bad++; if (!first) first = `${j.id}: ${JSON.stringify(v.issues.slice(0, 2))}`; }
  }
  check(bad === 0, `every job is a valid contract Job record${bad ? ` (${bad} are not; first: ${first})` : ''}`);
  const runs = new Runs(store);
  const int = runs.interrupted();
  console.log(int ? `note run #${int.id} was cut short with ${int.boards_total - int.boards_done} board(s) left; "jobleft-crawl run" resumes it` : 'note no run is waiting to resume');
  const counts = store.db.prepare('SELECT count(*) AS n, sum(closed_at IS NULL) AS o FROM jobs').get() as { n: number; o: number | null };
  console.log(`${counts.n} job(s) (${counts.o ?? 0} open) in ${path}`);
  store.close();
  return problems.length === 0 ? 0 : 1;
}

// ------------------------------------------------------------------------------------------------ legacy S1 commands

interface VerifyRow { ats: Ats; board: string; company: string; ok: boolean; status: string; count: number | null; bytes: number; ms: number }

function verifyUrl(b: BoardRef): string {
  switch (b.ats) {
    case 'greenhouse': return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(b.board)}/jobs`;
    case 'lever': return `https://api.lever.co/v0/postings/${encodeURIComponent(b.board)}?mode=json&limit=1`;
    case 'ashby': return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(b.board)}`;
    default: throw new Error(`verify supports greenhouse, lever and ashby only, not "${b.ats}"`);
  }
}

async function cmdVerifyBoards(args: Record<string, string>): Promise<number> {
  const list = readJson<BoardRef[]>(need(args, 'in'));
  const cfg = configFrom(args);
  const http = new HttpClient({ userAgent: args['user-agent'] ? cfg.userAgent : USER_AGENT, maxRequests: Number(args['max-requests'] ?? 3000), hostMap: hostMapFromEnv() });
  const queues = new Map<string, BoardRef[]>();
  for (const b of list) { const h = hostFor(b.ats, b.region); (queues.get(h) ?? queues.set(h, []).get(h)!).push(b); }
  const rows: VerifyRow[] = [];
  await Promise.all([...queues.values()].map(async (q) => {
    for (const b of q) {
      const snap = http.snapshot();
      const t0 = Date.now();
      let row: VerifyRow;
      try {
        const j = await http.getJson(verifyUrl(b), { origin: b.origin ?? null }) as unknown;
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
  const out = { userAgent: http.userAgent, requests: http.totalRequests, hosts: Object.fromEntries(http.stats), rows };
  writeFileSync(need(args, 'out'), JSON.stringify(out, null, 2));
  console.log(`verify done: ${rows.filter((r) => r.ok).length}/${rows.length} ok, ${http.totalRequests} requests (incl. robots.txt)`);
  return 0;
}

async function cmdCrawlLegacy(args: Record<string, string>): Promise<number> {
  const boards = readJson<BoardRef[]>(need(args, 'boards'));
  if (args['pay-transparency'] === 'true') PAY_QUERY.value = '&pay_transparency=true';
  const store = new Store(need(args, 'db'));
  const http = new HttpClient({ maxRequests: Number(args['max-requests'] ?? 3000), hostMap: hostMapFromEnv(), state: store.hostState() });
  const graceMs = Number(args['grace-hours'] ?? 48) * 3600 * 1000;
  let now: (() => number) | undefined;
  if (args.now) {
    const t = Date.parse(args.now);
    if (!Number.isFinite(t)) throw new UsageError(`--now is not a date: ${args.now}`);
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
  writeFileSync(need(args, 'out'), JSON.stringify({ userAgent: http.userAgent, totalRequests: http.totalRequests, hosts: Object.fromEntries(http.stats), report }, null, 2));
  const ok = report.boards.filter((b) => b.status === 'ok' && b.stats.ingested > 0).length;
  console.log(`crawl done: ${ok}/${report.boards.length} boards produced rows, ${report.totals.ingested} ingested ` +
    `(${report.totals.inserted} new, ${report.totals.updated} updated, ${report.totals.unchanged} unchanged), ` +
    `${report.totals.dupUrl} dupUrl, ${report.totals.dupRole} dupRole, ${report.totals.closed} closed, ` +
    `${http.totalRequests} requests, wall ${(report.wallMs / 1000).toFixed(1)}s, peak rss ${report.peakRssMb} MB`);
  store.close();
  return 0;
}

function one<T>(db: DatabaseSync, sql: string, ...p: Array<string | number>): T { return db.prepare(sql).get(...p) as T; }

export function buildReport(dbPath: string): Record<string, unknown> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const n = (sql: string): number => Number(one<{ n: number }>(db, sql).n);
  const total = n('SELECT count(*) AS n FROM jobs');
  const pct = (x: number): number => (total ? Math.round((1000 * x) / total) / 10 : 0);
  const open = n('SELECT count(*) AS n FROM jobs WHERE closed_at IS NULL');
  const withDesc = n('SELECT count(*) AS n FROM jobs WHERE length(description) > 200');
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
    tableBytes = db.prepare('SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 12').all();
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

function cmdReport(args: Record<string, string>): number {
  if (args.run) {
    const store = new Store(dbPath(args));
    const r = lastRunReport(store, args.run === 'last' ? undefined : Number(args.run));
    console.log(JSON.stringify(r, null, 2));
    store.close();
    return 0;
  }
  const r = buildReport(dbPath(args));
  if (args.out && args.out !== 'true') writeFileSync(args.out, JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r, null, 2));
  return 0;
}

function cmdSearch(args: Record<string, string>): number {
  const store = new Store(dbPath(args));
  const page = queryJobs(store.db, { status: 'open', q: need(args, 'q'), limit: Number(args.limit ?? 20) });
  for (const j of page.items) console.log(`${j.id}\t${j.company}\t${j.title}\t${j.places.map((p) => p.text).join('; ')}`);
  console.log(`${page.total} open job(s) match`);
  store.close();
  return 0;
}

async function cmdProbe(args: Record<string, string>): Promise<number> {
  const http = new HttpClient({ maxRequests: 10, hostMap: hostMapFromEnv() });
  const j = await http.getJson(need(args, 'url')) as unknown;
  const first = Array.isArray(j) ? j[0] : (j as { jobs?: unknown[] }).jobs?.[0];
  console.log('top-level:', Array.isArray(j) ? `array(${j.length})` : Object.keys(j as object));
  console.log('first item keys:', first && typeof first === 'object' ? Object.keys(first as object) : first);
  if (args.key && first && typeof first === 'object') console.log(args.key, '=', JSON.stringify((first as Record<string, unknown>)[args.key]));
  console.log('requests (incl robots):', http.totalRequests, 'bytes:', http.snapshot().bytesDecoded);
  return 0;
}

// ------------------------------------------------------------------------------------------------ main

const HELP = `jobleft-crawl <command> [--flags]

  run       --boards <file> [--db <file>] [--force] [--due] [--fresh] [--out <file>]
            Crawl the listed boards now. A run that was cut short is finished first (only its unfinished boards).
            A board that failed before is asked once, without retries. A board whose host refused access (403/429) waits
            out its back-off unless --force. --due crawls only boards whose time has come (the scheduler's rule).
  status    [--db <file>] [--boards <file>] [--json] [--run <id>]
            Crawl progress, the last run, and each board: state, open jobs, last and next check, the problem in words.
  jobs      [--db <file>] [--status open|closed|all] [--q <words>] [--board <ats:board>] [--id <job id>]
            [--format json|lines] [--include-duplicates]   The stored jobs as contract Job records.
  daemon    --boards <file> [--db <file>] [--refresh 24h] [--confirm 2h] [--no-catch-up]
            Keep jobs current: a catch-up now, then each board when it is due. Ctrl+C stops cleanly.
  simulate  --for <48h|3d...> --boards <file> [--db <file>]
            Time-skip: run the schedule as if the app had been open that long (requests still at the real pace).
  verify    [--db <file>]            Check the database: integrity, full-text index, every job a valid record.
  verify    --in <boards.json> --out <file>    One request per board to see which boards are live.
  clock     [--db <file>] [--reset]  Show (or reset) the clock offset a simulation left.
  report    [--db <file>] [--run <id|last>]    Coverage report of the database, or the report of one run.
  search    --q <words> [--db <file>]          Open jobs that hold all the words.

Common flags: --config <file.json>, --user-agent "<jobleft/x.y (contact)>", --refresh 24h, --confirm 2h,
  --max-requests <n>, --now <RFC 3339>, --clock-offset <72h>.
Environment: JOBLEFT_HOME (default database folder), JOBLEFT_HOST_MAP (real host -> loopback mock),
  JOBLEFT_NOW / JOBLEFT_CLOCK_OFFSET (time-skip), JOBLEFT_OFFLINE=1 (send nothing).`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case 'run': return cmdRun(args);
    case 'status': return cmdStatus(args);
    case 'jobs': return cmdJobs(args);
    case 'daemon': return cmdDaemon(args);
    case 'simulate': return cmdSimulate(args);
    case 'clock': return cmdClock(args);
    case 'verify': return args.in ? cmdVerifyBoards(args) : cmdVerifyDb(args);
    case 'crawl': return cmdCrawlLegacy(args);
    case 'report': return cmdReport(args);
    case 'search': return cmdSearch(args);
    case 'probe': return cmdProbe(args);
    case 'help': case '--help': case undefined: console.log(HELP); return cmd ? 0 : 2;
    default: console.error(`unknown command "${cmd}"\n\n${HELP}`); return 2;
  }
}

try {
  process.exitCode = await main();
} catch (e) {
  if (e instanceof UsageError || e instanceof ConfigError) { console.error(e.message); process.exitCode = 2; }
  else { console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e)); process.exitCode = 1; }
}
