#!/usr/bin/env node
// jobleft-sources: run and inspect the other job sources from a terminal (no app needed).
//
//   node packages/sources-other/src/cli.ts <command> [options]
//
// Commands
//   list [--json]                         every source: on/off, key, last success, open jobs, last problem, next allowed
//   enable <id...> | disable <id...>      turn sources on or off (off = no request at all)
//   refresh [id...] [--reason manual|schedule|launch] [--json]
//                                         refresh now (manual) or as the scheduler would; each source obeys its limits
//   due [--json]                          what the scheduler would run now (runs them)
//   jobs [--source id] [--status open|closed|all] [--remote] [--open-to-us] [--include-unknown-region] [--limit n] [--json]
//   export [--out file] [--source id] [--status open|closed|all]
//                                         NDJSON, one contract Job per line with its sources, links and credits
//   runs [--source id] [--limit n]        run history (outcome, counts, requests, problem)
//   discover [--json]                     ATS boards behind the links of open postings (nothing is sent)
//   standin [--dir d] [--port p]          start the stand-in feeds (loopback only) and print JOBLEFT_HOST_MAP
//   standin-set <id> <scenario> [--dir d] switch a stand-in source to a scenario (ok, http500, hang, renamed, ...)
//
// Environment
//   JOBLEFT_HOME                 data folder (default: the OS default); the database is $JOBLEFT_HOME/data/jobleft.db
//   JOBLEFT_HOST_MAP             real host -> loopback stand-in (printed by `standin`)
//   JOBLEFT_OFFLINE=1            send nothing
//   JOBLEFT_NOW, JOBLEFT_CLOCK_OFFSET   the app clock (time-skip for limits and dates)
//   JOBLEFT_SOURCE_KEY_THEMUSE   The Muse key (read only from the environment; never saved, never printed)
//   JOBLEFT_SOURCE_KEY_USAJOBS   "<registered email> <key>" (USAJOBS is not crawled; see docs/sources/usajobs.md)
//   JOBLEFT_SOURCE_TIMEOUT_MS    per-request timeout (default 15000)
// Logs (no keys, no emails, no query strings): $JOBLEFT_HOME/logs/sources.log

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { nowMs } from '@jobleft/contracts';
import { Store, hostMapFromEnv } from '@jobleft/crawler';
import { ALL_FEEDS } from './catalog.ts';
import { discoverBoards } from './discover.ts';
import { migrateSourcesOther } from './db.ts';
import { SourceService, envSecretStore } from './service.ts';
import type { SourceRunResult } from './runner.ts';
import { SCENARIOS, setScenario, startStandin } from './standin.ts';
import { exportFeedJobs, feedJobs } from './view.ts';

function defaultHome(): string {
  if (process.env.JOBLEFT_HOME) return resolve(process.env.JOBLEFT_HOME);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'jobleft');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'jobleft');
  return join(homedir(), '.local', 'share', 'jobleft');
}

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const rest = argv.slice(1);
function flag(name: string): boolean { return rest.includes(`--${name}`); }
function opt(name: string): string | undefined { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; }
function positional(): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) { if (['--reason', '--source', '--status', '--limit', '--out', '--dir', '--port'].includes(a)) i++; continue; }
    out.push(a);
  }
  return out;
}

const home = defaultHome();
const logsDir = join(home, 'logs');
function log(line: string): void {
  try { mkdirSync(logsDir, { recursive: true, mode: 0o700 }); appendFileSync(join(logsDir, 'sources.log'), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch { /* logging never breaks a command */ }
}

function openStore(): Store {
  const dataDir = join(home, 'data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(join(dataDir, 'jobleft.db'));
  migrateSourcesOther(store.db);
  return store;
}

function service(store: Store): SourceService {
  const timeout = Number(process.env.JOBLEFT_SOURCE_TIMEOUT_MS ?? '15000');
  return new SourceService({
    store,
    secrets: envSecretStore(),
    hostMap: hostMapFromEnv(),
    offline: process.env.JOBLEFT_OFFLINE === '1',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 15000,
  });
}

function pad(s: string, n: number): string { return s.length >= n ? s.slice(0, n - 1) + ' ' : s + ' '.repeat(n - s.length); }

function printResults(results: SourceRunResult[], json: boolean): void {
  if (json) { console.log(JSON.stringify(results, null, 2)); return; }
  for (const r of results) {
    const head = r.outcome === 'ok' ? 'OK     ' : r.outcome === 'failed' ? 'FAILED ' : 'SKIPPED';
    console.log(`${head} ${pad(r.sourceId, 26)} ${r.message}${r.nextAllowedAt && r.outcome === 'skipped' ? '' : ''}`);
    if (r.notes.length) for (const n of r.notes) console.log(`        ${' '.repeat(26)} note: ${n}`);
    log(`refresh ${r.sourceId} ${r.outcome}${r.skipReason ? ` (${r.skipReason})` : ''}: ${r.message} [requests ${r.requests}]`);
  }
}

async function main(): Promise<number> {
  switch (cmd) {
    case 'list': {
      const store = openStore();
      const list = await service(store).list();
      if (flag('json')) { console.log(JSON.stringify(list, null, 2)); store.close(); return 0; }
      console.log(`${pad('SOURCE', 26)}${pad('CRAWLED', 8)}${pad('ON', 4)}${pad('STATE', 12)}${pad('OPEN', 6)}${pad('LAST SUCCESS', 22)}NEXT ALLOWED / PROBLEM`);
      for (const s of list) {
        const extra = !s.crawled ? `not crawled: ${s.reason}` : [s.status.nextAllowedAt ? `next ${s.status.nextAllowedAt}` : '', s.status.lastProblem ?? ''].filter(Boolean).join(' | ');
        console.log(`${pad(s.id, 26)}${pad(s.crawled ? 'yes' : 'no', 8)}${pad(s.enabled ? 'on' : 'off', 4)}${pad(s.status.state, 12)}${pad(s.status.openJobs === null ? '-' : String(s.status.openJobs), 6)}${pad(s.status.lastSuccessAt ?? '-', 22)}${extra}`);
        if (s.credit) console.log(`${' '.repeat(26)}credit: ${s.credit.text} (${s.credit.url})`);
      }
      store.close();
      return 0;
    }
    case 'enable':
    case 'disable': {
      const ids = positional();
      if (!ids.length) { console.error(`usage: ${cmd} <sourceId...>  (ids: ${ALL_FEEDS.map((f) => f.id).join(', ')})`); return 2; }
      const store = openStore();
      const svc = service(store);
      let code = 0;
      for (const id of ids) {
        try {
          const s = await svc.update(id, { enabled: cmd === 'enable' });
          console.log(`${s.id}: ${s.enabled ? 'on' : 'off'} (state ${s.status.state})${s.status.state === 'needs_key' ? ` - ${s.status.lastProblem}` : ''}`);
          log(`${cmd} ${id}`);
        } catch (e) { console.error(`${id}: ${(e as Error).message}`); code = 1; }
      }
      store.close();
      return code;
    }
    case 'refresh':
    case 'due': {
      const store = openStore();
      const svc = service(store);
      const ids = positional();
      const reason = (opt('reason') ?? 'manual') as 'manual' | 'schedule' | 'launch';
      if (!['manual', 'schedule', 'launch'].includes(reason)) { console.error('--reason must be manual, schedule or launch'); return 2; }
      let report;
      try {
        report = cmd === 'due' ? await svc.runDue(reason === 'manual' ? 'schedule' : reason) : await svc.refresh({ ids: ids.length ? ids : undefined, reason });
      } catch (e) { console.error((e as Error).message); store.close(); return 1; }
      printResults(report.results, flag('json'));
      if (!flag('json') && report.nextAllowedAt) console.log(`Nothing ran. The next refresh is allowed at ${report.nextAllowedAt}.`);
      store.close();
      return 0;
    }
    case 'jobs': {
      const store = openStore();
      const status = (opt('status') ?? 'open') as 'open' | 'closed' | 'all';
      const jobs = feedJobs(store.db, { sourceId: opt('source'), status, remote: flag('remote'), openToUs: flag('open-to-us'), includeUnknownRegion: flag('include-unknown-region'), limit: opt('limit') ? Number(opt('limit')) : undefined });
      if (flag('json')) { console.log(JSON.stringify(jobs, null, 2)); store.close(); return 0; }
      for (const j of jobs) {
        const pay = j.pay ? `${j.pay.currency} ${j.pay.min ?? '?'}-${j.pay.max ?? '?'} per ${j.pay.period}` : 'pay not stated';
        const where = j.remoteScope ? `remote: ${j.remoteScope.regions.length ? j.remoteScope.regions.join(',') : 'region not stated'} ("${j.remoteScope.text}")` : j.places.map((p) => p.text).join('; ') || 'place not stated';
        console.log(`${j.status === 'open' ? '' : '[closed] '}${j.title} | ${j.company} | ${where} | ${pay} | posted ${j.postedAt ?? 'date not stated'}`);
        for (const s of j.sources) console.log(`    source: ${s.name} -> ${s.url}${s.credit ? `  [${s.credit.text}: ${s.credit.url}]` : ''}`);
      }
      console.log(`${jobs.length} job(s)`);
      store.close();
      return 0;
    }
    case 'export': {
      const store = openStore();
      const out = opt('out') ?? join(home, 'files', 'exports', `other-sources-${new Date(nowMs()).toISOString().replace(/[:.]/g, '-')}.ndjson`);
      mkdirSync(resolve(out, '..'), { recursive: true, mode: 0o700 });
      const lines = [...exportFeedJobs(store.db, { sourceId: opt('source'), status: (opt('status') ?? 'all') as 'open' | 'closed' | 'all' })];
      writeFileSync(out, lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 });
      console.log(`${lines.length} job(s) written to ${out}`);
      log(`export ${lines.length} jobs`);
      store.close();
      return 0;
    }
    case 'runs': {
      const store = openStore();
      const src = opt('source');
      const limit = Number(opt('limit') ?? '30');
      const rows = store.db.prepare(`SELECT source_id, reason, started_at, finished_at, outcome, problem, listed, inserted, closed, merged, close_held, requests
        FROM source_runs ${src ? 'WHERE source_id = ?' : ''} ORDER BY id DESC LIMIT ${Math.max(1, Math.floor(limit))}`).all(...(src ? [src] : [])) as Array<Record<string, unknown>>;
      if (flag('json')) console.log(JSON.stringify(rows, null, 2));
      else for (const r of rows) console.log(`${r.started_at} ${pad(String(r.source_id), 26)} ${pad(String(r.reason), 9)} ${pad(String(r.outcome), 8)} listed ${r.listed} new ${r.inserted} closed ${r.closed} merged ${r.merged} requests ${r.requests}${r.problem ? ` | ${r.problem}` : ''}${r.close_held ? ` | ${r.close_held}` : ''}`);
      store.close();
      return 0;
    }
    case 'discover': {
      const store = openStore();
      const rep = discoverBoards(store.db);
      if (flag('json')) console.log(JSON.stringify(rep, null, 2));
      else {
        for (const c of rep.candidates) console.log(`${pad(c.ats, 11)} ${pad(c.board + (c.region ? ` (${c.region})` : ''), 32)} ${pad(c.company, 28)} ${c.postings} posting(s) from ${c.sources.join(', ')}`);
        console.log(`${rep.candidates.length} crawlable board(s). Not crawled (never contacted): ${JSON.stringify(rep.notCrawled)}. Other hosts: ${rep.otherHosts}.`);
      }
      store.close();
      return 0;
    }
    case 'standin': {
      const dir = resolve(opt('dir') ?? join(process.cwd(), 'standin'));
      const port = opt('port') ? Number(opt('port')) : 4701;
      const s = await startStandin({ dir, basePort: port });
      console.log(`Stand-in feeds are running (127.0.0.1 only). Fixtures and scenarios: ${dir}`);
      console.log(`Request log: ${s.logPath}`);
      console.log('Use this in the shell that runs jobleft:');
      console.log(`export JOBLEFT_HOST_MAP='${JSON.stringify(s.hostMap)}'`);
      console.log('Press Ctrl+C to stop.');
      await new Promise<void>((res) => { process.once('SIGINT', () => res()); process.once('SIGTERM', () => res()); });
      await s.close();
      return 0;
    }
    case 'standin-set': {
      const [id, scenario] = positional();
      const dir = resolve(opt('dir') ?? join(process.cwd(), 'standin'));
      if (!id || !scenario) { console.error(`usage: standin-set <sourceId> <scenario> [--dir d]; scenarios: ${SCENARIOS.join(', ')}`); return 2; }
      try { setScenario(dir, id, scenario); } catch (e) { console.error((e as Error).message); return 2; }
      console.log(`${id} now answers "${scenario}" (${dir}/scenarios.json)`);
      return 0;
    }
    default:
      console.log('usage: node packages/sources-other/src/cli.ts <list|enable|disable|refresh|due|jobs|export|runs|discover|standin|standin-set> [options]');
      console.log('See packages/sources-other/README.md.');
      return cmd === 'help' || cmd === '--help' ? 0 : 2;
  }
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error((e as Error).message); process.exitCode = 1; });
