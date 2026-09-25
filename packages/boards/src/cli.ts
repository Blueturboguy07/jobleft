#!/usr/bin/env node
// jobleft-boards: the board list, board discovery from a link, refreshes and the directory, from a terminal.
// Run from the repository root:  pnpm --filter @jobleft/boards run boards <command> [options]
// or directly:                   node packages/boards/src/cli.ts <command> [options]
// `node packages/boards/src/cli.ts help` prints every command. Environment variables: src/app.ts.

import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BoardEntry, BoardResolveResponse, CrawlAtsId } from '@jobleft/contracts';
import { nowMs } from '@jobleft/contracts';
import { liveBoardCount, openBoardsApp, resolveHome, type BoardsApp } from './app.ts';
import {
  BUNDLED_DIRECTORY_PATH, PRUNED_DIRECTORY_PATH, installedDirectoryPath, loadActiveDirectory, parseDirectoryFile, readDirectoryFile,
} from './directory.ts';
import { PROVIDER_NAMES, boardApiHost, boardPageUrl } from './detect.ts';
import { forbiddenProvider } from './hosts.ts';
import { isCrawlAts } from './ids.ts';
import { BoardError } from './service.ts';
import { readPruned, refreshDirectory, writeJsonAtomic, type DiscoveredSlug } from './refresh.ts';
import { startDevServer } from './server.ts';

const HELP = `jobleft-boards <command> [options]

Board list
  list [--view all|followed|user|hidden|disabled|failing] [--q <text>] [--limit <n>] [--cursor <c>] [--json]
  count [--json]                          boards by origin, provider and state
  search <text> [--limit <n>] [--json]    find an employer in the list ("stripe", "Stripe, Inc.")
  show <boardId> [--json]                 one board with its status, last check and next check date
  export [--out <file>]                   every board as NDJSON (directory rows and your own boards)

Your boards
  resolve <link> [<link> ...] [--accept-paid] [--json]
                                          what board is behind a link (adds nothing)
  add <link> [--pick <n>] [--yes] [--json]
                                          resolve a link, show the board, ask, then add it
  add --ats <provider> --board <token> [--region eu] [--yes]
  follow|unfollow|hide|unhide|disable|enable <boardId> [<boardId> ...]
  pending [--retry]                       links pasted while offline
  jobs <boardId> [--all] [--json]         the jobs a board's refreshes stored (open; --all adds closed)

Refresh
  refresh [--boards <id,id>] [--due-hours <h>] [--live] [--json]
                                          one refresh now: every board that is not hidden, disabled or
                                          waiting for its next check date (or only the listed boards);
                                          more than 25 boards on live hosts needs --live
  status [--json]                         the last run
  report [--failed] [--json]              the last run, board by board, with reasons

Directory
  directory info [--json]                 which directory is in use, its sources and licences, counts
  directory check [--file <f>] [--json]   rows, providers, duplicates, blank names, forbidden hosts
  directory load <file>                   use a newer directory file (your boards and choices stay)
  directory unload                        go back to the directory that ships with the app
  directory refresh [--all | --sample <n> | --unverified | --ids <id,id>] [--ats <a,b>]
                    [--max-requests <n>] [--recheck-after-hours <h>] [--discovered <file>]
                    [--in <file>] [--out <file>] [--seed <n>]
                                          check rows against their providers, prune dead tokens,
                                          add discovered boards that answer with their own name

Development server (the board routes of the local API, docs/INTERFACES.md section 6)
  serve [--port <n>] [--token <t>] [--live] [--schedule]
                                          loopback only; prints the address and the token;
                                          --schedule starts the catch-up and the regular refresh

Environment: JOBLEFT_HOME, JOBLEFT_HOST_MAP, JOBLEFT_OFFLINE, JOBLEFT_NOW, JOBLEFT_CLOCK_OFFSET,
JOBLEFT_BOARD_DIRECTORY, JOBLEFT_REFRESH_HOURS, JOBLEFT_PAID_FETCH_URL, JOBLEFT_PAID_FETCH_PRICE_MICROS.
`;

interface Args { _: string[]; [k: string]: string | boolean | string[] }
const FLAGS = new Set(['json', 'yes', 'accept-paid', 'retry', 'failed', 'all', 'unverified', 'dry-run', 'live', 'schedule']);

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (FLAGS.has(k)) { out[k] = true; continue; }
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { out[k] = true; continue; }
      out[k] = v; i++;
    } else out._.push(a);
  }
  return out;
}
const str = (a: Args, k: string): string | undefined => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
const num = (a: Args, k: string): number | undefined => { const v = str(a, k); return v === undefined ? undefined : Number(v); };

function fail(msg: string, code = 1): never { console.error(msg); process.exit(code); }

function when(iso: string | null): string { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '-'; }

function stateText(e: BoardEntry): string {
  switch (e.state) {
    case 'not_checked': return 'not checked yet';
    case 'live': return `live, ${e.openJobs ?? 0} open jobs (checked ${when(e.lastCheckAt)})`;
    case 'failing': return `warning: ${e.lastError ?? 'the last check failed'} (checked ${when(e.lastCheckAt)})`;
    case 'unreachable': return `unreachable: ${e.lastError ?? ''} (last check ${when(e.lastCheckAt)}, next check ${when(e.nextCheckAt)})`;
    case 'blocked': return `blocked: ${e.lastError ?? ''} (last check ${when(e.lastCheckAt)}, next check ${when(e.nextCheckAt)})`;
    case 'cooldown': return `waiting (next check ${when(e.nextCheckAt)})`;
    default: return e.state;
  }
}

function line(e: BoardEntry): string {
  const flags = [e.origin === 'user' ? 'yours' : 'directory', e.followed ? 'followed' : '', e.hidden ? 'hidden' : '', e.disabled ? 'disabled' : ''].filter(Boolean).join(', ');
  return `${e.id.padEnd(34)} ${e.company.slice(0, 32).padEnd(32)} ${PROVIDER_NAMES[e.ats].padEnd(10)} [${flags}] ${stateText(e)}`;
}

function printResolve(r: BoardResolveResponse, link: string): void {
  console.log(`Link: ${link}`);
  if (r.candidates.length === 0) {
    console.log(`  Cannot use this link (${r.reason}). ${r.message}`);
  } else {
    console.log(`  ${r.message}`);
    r.candidates.forEach((c, i) => {
      const jobs = c.openJobs === null ? 'open jobs unknown' : `${c.openJobs} open jobs`;
      console.log(`  ${i + 1}. ${PROVIDER_NAMES[c.ats]} "${c.board}"${c.region ? ` (${c.region})` : ''}: ${c.company}, ${jobs}${c.alreadyAdded ? ' [already added]' : ''}  id ${c.boardId}`);
    });
  }
  if (r.paidLookup) console.log(`  Paid page fetch offered: ${r.message.match(/\$[0-9.,<]+/)?.[0] ?? ''} from your publik balance. Run again with --accept-paid to use it.`);
}

async function confirm(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim()); } finally { rl.close(); }
}

function withApp<T>(fn: (app: BoardsApp) => Promise<T> | T): Promise<T> {
  let app: BoardsApp;
  try { app = openBoardsApp(); } catch (e) { fail(`jobleft-boards cannot start: ${(e as Error).message}`); }
  return Promise.resolve(fn(app)).finally(() => app.close());
}

function boardErr(e: unknown): never {
  if (e instanceof BoardError) fail(`${e.code}: ${e.message}`, e.code === 'conflict' ? 3 : 1);
  throw e;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0] ?? 'help';
  const json = a.json === true;

  switch (cmd) {
    case 'help': case '--help': case '-h': console.log(HELP); return;

    case 'list': return withApp((app) => {
      const view = (str(a, 'view') ?? 'all') as 'all';
      if (!['all', 'followed', 'user', 'hidden', 'disabled', 'failing'].includes(view)) fail(`unknown view "${view}"`, 2);
      let r;
      try { r = app.service.list({ view, ...(str(a, 'q') ? { q: str(a, 'q')! } : {}), ...(str(a, 'cursor') ? { cursor: str(a, 'cursor')! } : {}), limit: num(a, 'limit') ?? 50 }); } catch (e) { boardErr(e); }
      if (json) { console.log(JSON.stringify(r, null, 1)); return; }
      for (const e of r.items) console.log(line(e));
      console.log(`${r.items.length} shown of ${r.total}${r.nextCursor ? `; next page: --cursor ${r.nextCursor}` : ''}`);
    });

    case 'count': return withApp((app) => {
      const c = app.service.counts();
      if (json) { console.log(JSON.stringify(c, null, 1)); return; }
      console.log(`boards ${c.total} (directory ${c.directory}, yours ${c.user}); followed ${c.followed}, hidden ${c.hidden}, disabled ${c.disabled}`);
      console.log(`by provider: ${Object.entries(c.byProvider).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      console.log(`by state: ${Object.entries(c.byState).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    });

    case 'search': return withApp((app) => {
      const q = a._.slice(1).join(' ');
      if (!q) fail('usage: search <text>', 2);
      const r = app.service.list({ q, limit: num(a, 'limit') ?? 10 });
      if (json) { console.log(JSON.stringify(r.items, null, 1)); return; }
      r.items.forEach((e, i) => console.log(`${i + 1}. ${line(e)}`));
      if (!r.items.length) console.log(`No board matches "${q}".`);
    });

    case 'show': return withApp((app) => {
      const id = a._[1] ?? fail('usage: show <boardId>', 2);
      const e = app.service.get(id);
      if (!e) fail(`not_found: no board "${id}" in your list or the directory`, 4);
      if (json) { console.log(JSON.stringify(e, null, 1)); return; }
      console.log(line(e));
    });

    case 'export': return withApp((app) => {
      const out = str(a, 'out');
      const lines = [...app.service.export()];
      if (out) { writeFileSync(resolve(out), lines.join('')); console.error(`wrote ${lines.length} boards to ${resolve(out)}`); }
      else process.stdout.write(lines.join(''));
    });

    case 'resolve': return withApp(async (app) => {
      const links = a._.slice(1);
      if (!links.length) fail('usage: resolve <link> [<link> ...]', 2);
      const results = await Promise.all(links.map((l) => app.service.resolve(l, { acceptPaidLookup: a['accept-paid'] === true })));
      if (json) { console.log(JSON.stringify(links.length === 1 ? results[0] : results, null, 1)); return; }
      results.forEach((r, i) => printResolve(r, links[i]!));
    });

    case 'add': return withApp(async (app) => {
      let target: { ats: CrawlAtsId; board: string; region: string | null; sourceUrl: string | null } | null = null;
      if (str(a, 'ats') || str(a, 'board')) {
        const ats = str(a, 'ats') ?? '';
        if (!isCrawlAts(ats)) fail(`unsupported_source: jobleft does not read "${ats}" boards`, 2);
        target = { ats, board: str(a, 'board') ?? fail('missing --board', 2), region: str(a, 'region') ?? null, sourceUrl: null };
        // Check the board first (it exists, its name, its open jobs), exactly as a pasted link would be.
        const r = await app.service.resolve(boardPageUrl(target.ats, target.board.toLowerCase(), target.region));
        if (!json) printResolve(r, `${PROVIDER_NAMES[target.ats]} board "${target.board}"`);
        if (!r.candidates.length) { if (json) console.log(JSON.stringify(r, null, 1)); process.exitCode = 5; return; }
        if (r.candidates[0]!.alreadyAdded) { if (json) console.log(JSON.stringify({ added: false, reason: 'already added', candidate: r.candidates[0] }, null, 1)); else console.log('Already added: nothing changed.'); process.exitCode = 3; return; }
        target.region = r.candidates[0]!.region;
      } else {
        const link = a._[1] ?? fail('usage: add <link> | add --ats <provider> --board <token>', 2);
        const r = await app.service.resolve(link);
        if (!json) printResolve(r, link);
        if (!r.candidates.length) { if (json) console.log(JSON.stringify(r, null, 1)); process.exitCode = 5; return; }
        const pick = num(a, 'pick') ?? (r.candidates.length === 1 ? 1 : NaN);
        if (!Number.isInteger(pick) || pick < 1 || pick > r.candidates.length) {
          if (json) console.log(JSON.stringify(r, null, 1));
          else console.log(`The link holds ${r.candidates.length} boards. Run again with --pick <n> to choose one.`);
          process.exitCode = 6; return;
        }
        const c = r.candidates[pick - 1]!;
        if (c.alreadyAdded) { if (json) console.log(JSON.stringify({ added: false, reason: 'already added', candidate: c }, null, 1)); else console.log('Already added: nothing changed.'); process.exitCode = 3; return; }
        target = { ats: c.ats, board: c.board, region: c.region, sourceUrl: link };
      }
      if (a.yes !== true && !(await confirm(`Add ${PROVIDER_NAMES[target.ats]} board "${target.board}"${target.region ? ` (${target.region})` : ''}?`))) {
        console.log('Not added (confirm with --yes, or answer y).');
        process.exitCode = 7; return;
      }
      let e: BoardEntry;
      try { e = app.service.add(target); } catch (err) { boardErr(err); }
      if (json) { console.log(JSON.stringify(e, null, 1)); return; }
      console.log(`Added: ${line(e)}`);
    });

    case 'follow': case 'unfollow': case 'hide': case 'unhide': case 'disable': case 'enable': return withApp((app) => {
      const ids = a._.slice(1);
      if (!ids.length) fail(`usage: ${cmd} <boardId> [<boardId> ...]`, 2);
      const patch = { follow: { followed: true }, unfollow: { followed: false }, hide: { hidden: true }, unhide: { hidden: false }, disable: { disabled: true }, enable: { disabled: false } }[cmd];
      const out: BoardEntry[] = [];
      for (const id of ids) {
        try { out.push(app.service.update(id, patch)); } catch (e) { boardErr(e); }
      }
      if (json) { console.log(JSON.stringify(out, null, 1)); return; }
      for (const e of out) console.log(line(e));
    });

    case 'pending': return withApp(async (app) => {
      const list = app.service.listPending();
      if (a.retry === true) {
        for (const p of list) printResolve(await app.service.resolve(p.url), p.url);
        return;
      }
      if (json) { console.log(JSON.stringify(list, null, 1)); return; }
      if (!list.length) console.log('No pending links.');
      for (const p of list) console.log(`${p.createdAt}  ${p.url}  (${p.reason})`);
    });

    case 'refresh': return withApp(async (app) => {
      if (app.offline) fail('offline: JOBLEFT_OFFLINE is set, so no refresh runs (nothing was sent).', 8);
      const ids = str(a, 'boards')?.split(',').map((s) => s.trim()).filter(Boolean);
      const dueHours = num(a, 'due-hours');
      const live = liveBoardCount(app, ids);
      if (live > 25 && a.live !== true) {
        fail(`This refresh would ask ${live} boards on live job-board hosts (about ${Math.ceil(live / 3 / 60)} minutes at 1 request per second per host). Add --live to do that, or use a small directory (JOBLEFT_BOARD_DIRECTORY) and mock hosts (JOBLEFT_HOST_MAP).`, 9);
      }
      let last = 0;
      const t0 = Date.now();
      const sched = app.scheduler;
      const timer = json ? null : setInterval(() => {
        const p = sched.progress();
        if (p.running && p.boardsDone !== last) { last = p.boardsDone; console.error(`  ${p.boardsDone} of ${p.boardsTotal} boards done, ${p.jobsSeen} jobs seen`); }
      }, 2000);
      let summary;
      try { summary = await sched.runOnce({ ...(ids?.length ? { boardIds: ids } : {}), ...(dueHours !== undefined ? { intervalHours: dueHours } : {}) }); } finally { if (timer) clearInterval(timer); }
      const rep = sched.lastReport();
      if (json) { console.log(JSON.stringify(rep, null, 1)); return; }
      if (!summary) { console.log('Nothing ran.'); return; }
      console.log(`Refresh done in ${Math.round((Date.now() - t0) / 1000)} s: ${summary.boards} boards, ${summary.ok} ok, ${summary.failed} not ok; jobs new ${summary.inserted}, changed ${summary.updated}, closed ${summary.closed}; ${summary.requests} requests.`);
      for (const b of rep.boards.filter((x) => x.status !== 'ok')) console.log(`  ${b.boardId}: ${b.status}${b.reason ? `: ${b.reason}` : ''}`);
    });

    case 'status': return withApp((app) => {
      const p = app.scheduler.progress();
      if (json) { console.log(JSON.stringify(p, null, 1)); return; }
      if (!p.lastRun) { console.log('No refresh has run yet.'); return; }
      const r = p.lastRun;
      console.log(`Last refresh ${when(r.startedAt)} to ${when(r.finishedAt)}: ${r.boards} boards, ${r.ok} ok, ${r.failed} not ok, jobs new ${r.inserted}, changed ${r.updated}, closed ${r.closed}, ${r.requests} requests.`);
    });

    case 'report': return withApp((app) => {
      const rep = app.scheduler.lastReport();
      const boards = a.failed === true ? rep.boards.filter((b) => b.status !== 'ok') : rep.boards;
      if (json) { console.log(JSON.stringify({ run: rep.run, boards }, null, 1)); return; }
      if (!rep.run) { console.log('No refresh has run yet.'); return; }
      for (const b of boards) console.log(`${b.boardId.padEnd(34)} ${b.status.padEnd(12)} listed ${String(b.listed).padStart(4)} new ${b.inserted} closed ${b.closed} requests ${b.requests}${b.reason ? `  ${b.reason}` : ''}${b.closeHeld ? `  (${b.closeHeld})` : ''}`);
    });

    case 'jobs': return withApp((app) => {
      const id = a._[1] ?? fail('usage: jobs <boardId> [--all]', 2);
      const e = app.service.get(id);
      if (!e) fail(`not_found: no board "${id}" in your list or the directory`, 4);
      const rows = app.crawlStore.db.prepare(`SELECT job_id, title, location, first_seen, last_seen, closed_at, closed_reason FROM jobs
        WHERE ats = ? AND board = ? ${a.all === true ? '' : 'AND closed_at IS NULL'} ORDER BY closed_at IS NOT NULL, title, job_id`).all(e.ats, e.board) as Array<Record<string, string | null>>;
      if (json) { console.log(JSON.stringify({ board: e, jobs: rows }, null, 1)); return; }
      console.log(`${line(e)}${e.hidden ? '  (hidden: its jobs are left out of the feed)' : ''}`);
      for (const r of rows) console.log(`  ${String(r.job_id).padEnd(12)} ${String(r.title).slice(0, 50).padEnd(50)} ${r.closed_at ? `closed ${when(r.closed_at)} (${r.closed_reason})` : `open, last seen ${when(r.last_seen)}`}`);
      const open = rows.filter((r) => !r.closed_at).length;
      console.log(`${open} open${a.all === true ? `, ${rows.length - open} closed` : ''}`);
    });

    case 'directory': return directoryCmd(a, json);

    case 'serve': {
      const app = openBoardsApp();
      const srv = await startDevServer(app, { port: num(a, 'port') ?? 0, allowLive: a.live === true, ...(str(a, 'token') ? { token: str(a, 'token')! } : {}) });
      if (a.schedule === true) app.scheduler.start({ catchUp: true });
      console.log(`jobleft boards dev server on ${srv.origin}`);
      console.log(`token: ${srv.token}   (send it in the x-jobleft-token header)`);
      console.log(`data folder: ${app.home}; directory: ${app.loaded.origin} (${app.directory.size} boards)`);
      const stop = async (): Promise<void> => { await srv.close(); app.close(); process.exit(0); };
      process.on('SIGINT', () => void stop());
      process.on('SIGTERM', () => void stop());
      return;
    }

    default: fail(`unknown command "${cmd}". Run: jobleft-boards help`, 2);
  }
}

async function directoryCmd(a: Args, json: boolean): Promise<void> {
  const sub = a._[1] ?? 'info';
  const home = resolveHome();
  if (sub === 'info') {
    const d = loadActiveDirectory({ home });
    const byAts: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const e of d.entries) { byAts[e.ats] = (byAts[e.ats] ?? 0) + 1; byStatus[e.status] = (byStatus[e.status] ?? 0) + 1; }
    const info = { origin: d.origin, path: d.path, version: d.version, rows: d.entries.length, byProvider: byAts, byStatus, sources: d.sources, notice: d.notice, refused: d.refused.length };
    if (json) { console.log(JSON.stringify(info, null, 1)); return; }
    console.log(`Directory in use: ${d.origin} (${d.path ?? 'none'}), version ${d.version}`);
    console.log(`${d.entries.length} boards: ${Object.entries(byAts).map(([k, v]) => `${k} ${v}`).join(', ')}; status: ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    for (const s of d.sources) console.log(`Source "${s.id}": ${s.name}. Licence ${s.licence}. ${s.url}${s.commit ? ` (commit ${s.commit})` : ''}. ${s.rows} rows.${s.note ? ` ${s.note}` : ''}`);
    if (d.notice) console.log(`Notice: ${d.notice}`);
    return;
  }
  if (sub === 'check') {
    const path = str(a, 'file') ?? loadActiveDirectory({ home }).path ?? BUNDLED_DIRECTORY_PATH;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { rows?: Array<Record<string, unknown>> };
    const rows = raw.rows ?? [];
    const pairs = new Map<string, number>();
    let blank = 0, forbidden = 0, badSlug = 0;
    const providers = new Set<string>();
    for (const r of rows) {
      const ats = String(r.ats ?? ''), slug = String(r.slug ?? '').toLowerCase(), region = r.region ? String(r.region) : null;
      providers.add(ats);
      const k = `${ats}|${region ?? ''}|${slug}`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
      if (!String(r.name ?? '').trim()) blank++;
      if (!/^[a-z0-9][a-z0-9._ -]{0,99}$/.test(slug)) badSlug++;
      if (isCrawlAts(ats) && forbiddenProvider(boardApiHost(ats, slug || 'x', region).split(':')[0]!)) forbidden++;
      if (!isCrawlAts(ats)) forbidden += forbiddenProvider(ats) ? 1 : 0;
    }
    const dups = [...pairs.values()].filter((n) => n > 1).length;
    const parsed = parseDirectoryFile(raw);
    const out = { file: path, rows: rows.length, providers: [...providers].sort(), duplicates: dups, blankNames: blank, badSlugs: badSlug, forbiddenHosts: forbidden, refusedByLoader: parsed.refused.length };
    if (json) { console.log(JSON.stringify(out, null, 1)); return; }
    console.log(`${out.file}: ${out.rows} rows, ${out.providers.length} providers (${out.providers.join(', ')}); duplicates ${dups}, blank names ${blank}, bad board names ${badSlug}, forbidden hosts ${forbidden}; rows the loader refuses ${out.refusedByLoader}`);
    return;
  }
  if (sub === 'load') {
    const file = a._[2] ?? fail('usage: directory load <file>', 2);
    let parsed;
    try { parsed = readDirectoryFile(resolve(file)); } catch (e) { fail((e as Error).message); }
    if (parsed.entries.length === 0) fail('The directory file has no usable rows; nothing was changed.');
    const dest = installedDirectoryPath(home);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    writeJsonAtomic(dest, JSON.parse(readFileSync(resolve(file), 'utf8')));
    console.log(`Loaded ${parsed.entries.length} boards (version ${parsed.file.version}; ${parsed.refused.length} rows refused). Your own boards and choices are unchanged.`);
    return;
  }
  if (sub === 'unload') {
    const dest = installedDirectoryPath(home);
    if (existsSync(dest)) rmSync(dest);
    console.log('Using the directory that ships with the app. Your own boards and choices are unchanged.');
    return;
  }
  if (sub === 'refresh') {
    const inPath = resolve(str(a, 'in') ?? loadActiveDirectory({ home }).path ?? BUNDLED_DIRECTORY_PATH);
    const outPath = resolve(str(a, 'out') ?? installedDirectoryPath(home));
    const prunedPath = str(a, 'pruned') ? resolve(str(a, 'pruned')!) : outPath === BUNDLED_DIRECTORY_PATH ? PRUNED_DIRECTORY_PATH : outPath.replace(/\.json$/, '-pruned.json');
    const input = JSON.parse(readFileSync(inPath, 'utf8'));
    const ats = str(a, 'ats')?.split(',').filter(isCrawlAts);
    const select = a.all === true ? { kind: 'all' as const }
      : a.unverified === true ? { kind: 'unverified' as const }
      : str(a, 'ids') ? { kind: 'ids' as const, ids: str(a, 'ids')!.split(',') }
      : num(a, 'sample') !== undefined ? { kind: 'sample' as const, n: num(a, 'sample')!, seed: num(a, 'seed') ?? 1 }
      : { kind: 'none' as const };
    let discovered: DiscoveredSlug[] = [];
    let discoveredSources: import('./directory.ts').DirectorySource[] = [];
    if (str(a, 'discovered')) {
      const d = JSON.parse(readFileSync(resolve(str(a, 'discovered')!), 'utf8')) as { source?: import('./directory.ts').DirectorySource; slugs?: DiscoveredSlug[] };
      discovered = d.slugs ?? [];
      if (d.source) discoveredSources = [d.source];
    }
    const app = openBoardsApp({ env: { ...process.env, JOBLEFT_BOARD_DIRECTORY: 'none' } });
    try {
      if (app.offline) fail('offline: JOBLEFT_OFFLINE is set, so the directory cannot be checked.', 8);
      const res = await refreshDirectory({
        input, pruned: readPruned(prunedPath), http: app.newHttp(), select, ...(ats?.length ? { ats } : {}),
        discovered, discoveredSources, maxChecks: num(a, 'max-requests') ?? 500, recheckAfterHours: num(a, 'recheck-after-hours') ?? 24,
        now: nowMs(), log: (l) => console.error(l),
      });
      if (a['dry-run'] !== true) {
        mkdirSync(dirname(outPath), { recursive: true });
        writeJsonAtomic(outPath, res.file);
        writeJsonAtomic(prunedPath, res.pruned, true);
      }
      const s = res.summary;
      if (json) { console.log(JSON.stringify({ out: outPath, prunedFile: prunedPath, ...s, rows: res.file.rows.length }, null, 1)); return; }
      console.log(`Checked ${s.checked} rows: live ${s.live}, suspect ${s.suspect}, pruned ${s.pruned}, unknown ${s.unknown}, renamed ${s.renamed}. Discovered checked ${s.discoveredChecked}, added ${s.added}, skipped (no name from the board) ${s.discoveredSkippedNoName}.${s.stoppedAtBudget ? ' Stopped at the request budget.' : ''}`);
      console.log(`${a['dry-run'] === true ? 'Would write' : 'Wrote'} ${res.file.rows.length} rows to ${outPath}; pruned list ${prunedPath}.`);
    } finally { app.close(); }
    return;
  }
  fail(`unknown directory command "${sub}"`, 2);
}

main().catch((e) => { console.error(`jobleft-boards: ${(e as Error).message}`); process.exit(1); });
