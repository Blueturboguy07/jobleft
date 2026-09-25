#!/usr/bin/env node
// jobleft-store: the command line of the local job store. Every command works on $JOBLEFT_HOME (or --home).
// Run `node packages/store/src/cli.ts help` for the list. Output is plain text; add --json for JSON.

import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { nowMs, type JobFilter, type JobSearchRequest, type ProfileInput, type TrackerView } from '@jobleft/contracts';
import { StoreError } from './db.ts';
import { resolveStoreHome } from './home.ts';
import { StoreService } from './service.ts';
import { SynthGenerator } from './synth.ts';
import { fakeVectors, runBench, type BenchResult } from './bench.ts';
import { MODEL_TOTAL_BYTES, DEFAULT_MODEL_BASE_URL } from './embed/model.ts';
import { emptyProfileInput } from './userdata.ts';
import type { CompanyInput } from './writer.ts';

process.umask(0o077);

interface Args { _: string[]; flags: Map<string, string | true> }

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags.set(a.slice(2, eq), a.slice(eq + 1)); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags.set(a.slice(2), next); i++; } else flags.set(a.slice(2), true);
    } else _.push(a);
  }
  return { _, flags };
}

function flag(a: Args, name: string): string | undefined {
  const v = a.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

function out(a: Args, value: unknown, text?: string): void {
  if (a.flags.has('json') || text === undefined) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${text}\n`);
}

function nowFrom(a: Args): number {
  const n = flag(a, 'now');
  if (n) {
    const t = Date.parse(n);
    if (!Number.isFinite(t)) throw new StoreError('bad_request', `--now is not a date: ${n}`);
    return t;
  }
  return nowMs();
}

function mb(bytes: number): string { return `${(bytes / 1e6).toFixed(1)} MB`; }

const HELP = `jobleft-store: the local job store (words, filters, fit order), from the command line.

Data folder: $JOBLEFT_HOME, else ~/Library/Application Support/jobleft on macOS (or --home <dir>).

  init                                  Create the data folder and database; print where they are
  import-jobs <file.ndjson|->           Import jobs (one JSON object per line; see README). Options:
        --source <id> --source-name <name>   credit for lines that name no source
        --complete                           the file is the whole current listing of its board(s):
                                             listed jobs are kept, missing ones close (guards apply)
        --now <RFC 3339>                     the clock for "first seen" and "last seen"
  seed --synthetic <n> [--seed 42] [--prefix syn]   Add n synthetic jobs (and their company facts)
  gen --synthetic <n> --out <file> [--seed 42]      Write n synthetic jobs as NDJSON (nothing imported)
  close <jobId...> [--reason source_removed]        Close jobs
  sync-crawler                          Mirror the crawler's jobs table (same database file) into the store
  search [--q words] [--sort recommended|top_matched|most_recent] [--filter '<JobFilter JSON>']
         [--limit 20] [--cursor c] [--all]          One search (--all pages to the end and checks for repeats)
  get <jobId>                           One job as JSON
  profile show | set <file.json> | clear
  tracker like|unlike|hide|unhide <jobId> | status <jobId> <applied|interviewing|offer_received|rejected|archived|none>
          | note <jobId> <text> | list <liked|applied|external|hidden|closed>
  filters list | save <name> --filter '<JSON>' --sort <sort> [--default] | delete <id>
  index [--limit n] [--no-download]     Run fit indexing now (downloads the model first when missing)
  status                                Fit indexing: indexed, waiting, last run, model
  stats                                 Where the store is, its size, job counts
  model status | download | verify      The fit model (${mb(MODEL_TOTAL_BYTES)} from ${DEFAULT_MODEL_BASE_URL})
  vacuum [--full]                       Compact the word index and give freed space back to the disk
  export-saved                          Saved jobs with their source credits (NDJSON)
  serve [--port 47850] [--token <t>]    Loopback HTTP server with the store routes (see README)
  bench [--synthetic <n>] [--queries 300]  Time the O4 query mix (in memory with --synthetic)
Add --json to any command for JSON output.`;

async function readLines(path: string, onLine: (line: string, n: number) => void): Promise<void> {
  const input = path === '-' ? process.stdin : createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) { n++; onLine(line, n); }
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0] ?? 'help';
  if (cmd === 'help' || a.flags.has('help')) { process.stdout.write(`${HELP}\n`); return 0; }
  const home = flag(a, 'home') ?? resolveStoreHome();

  if (cmd === 'gen') {
    const n = Number(flag(a, 'synthetic') ?? 0);
    const file = flag(a, 'out');
    if (!n || !file) throw new StoreError('bad_request', 'Use: gen --synthetic <n> --out <file.ndjson>');
    const g = new SynthGenerator({ seed: Number(flag(a, 'seed') ?? 42), prefix: flag(a, 'prefix') ?? 'syn', now: nowFrom(a) });
    const lines: string[] = [];
    for (const c of g.companies) lines.push(JSON.stringify({ type: 'company', key: c.key, name: c.name, industries: c.industries, stage: c.stage, isStaffingAgency: c.isStaffingAgency, h1b: c.h1b }));
    for (let i = 0; i < n; i++) lines.push(JSON.stringify(g.job(i)));
    writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    out(a, { wrote: n, companies: g.companies.length, file }, `Wrote ${n} synthetic jobs and ${g.companies.length} companies to ${file}`);
    return 0;
  }

  if (cmd === 'bench' && flag(a, 'synthetic')) {
    const n = Number(flag(a, 'synthetic'));
    const svc = new StoreService(home, { memory: true, offline: true });
    const now = nowFrom(a);
    const g = new SynthGenerator({ seed: 1, now });
    const t0 = performance.now();
    for (let i = 0; i < n; i += 20_000) svc.jobs.writer.upsert(Array.from({ length: Math.min(20_000, n - i) }, (_, k) => g.job(i + k)), new Date(now).toISOString());
    svc.jobs.upsertCompanies(g.companies.map((c) => ({ key: c.key, name: c.name, industries: c.industries, stage: c.stage, isStaffingAgency: c.isStaffingAgency, h1b: c.h1b })), now);
    const buildS = (performance.now() - t0) / 1000;
    fakeVectors(svc.db);
    const tl = performance.now();
    svc.jobs.mem.refresh();
    svc.fit.refresh();
    const loadMs = performance.now() - tl;
    const pv = new Float32Array(384).map((_, i) => Math.sin(i + 1));
    let norm = 0; for (const x of pv) norm += x * x; for (let i = 0; i < 384; i++) pv[i]! /= Math.sqrt(norm);
    const r = runBench(svc.jobs, svc.fit, pv, Number(flag(a, 'queries') ?? 300), now);
    const res = { ...r, buildSeconds: Math.round(buildS * 10) / 10, loadMs: Math.round(loadMs), rssMB: Math.round(process.memoryUsage().rss / 1e6), note: 'in-memory store; random unit vectors stand in for fit vectors (speed only)' };
    out(a, res, benchText(res));
    await svc.close();
    return 0;
  }

  const svc = new StoreService(home, { dbPath: flag(a, 'db') });
  try {
    switch (cmd) {
      case 'init': {
        const s = svc.jobs.storage(svc.dbPath, svc.h.home);
        out(a, s, `Data folder: ${svc.h.home}\nDatabase:    ${svc.dbPath} (${mb(s.dbBytes)}, ${s.openJobs} open jobs of ${s.jobs})`);
        return 0;
      }
      case 'import-jobs': {
        const file = a._[1];
        if (!file || (file !== '-' && !existsSync(file))) throw new StoreError('bad_request', 'Use: import-jobs <file.ndjson> (or - for standard input)');
        const now = nowFrom(a);
        const source = flag(a, 'source') ? { sourceId: flag(a, 'source')!, name: flag(a, 'source-name') ?? flag(a, 'source')! } : undefined;
        const jobs: unknown[] = [];
        const companies: CompanyInput[] = [];
        const bad: Array<{ line: number; error: string }> = [];
        const lineOf: number[] = [];
        await readLines(file, (line, n) => {
          const t = line.trim();
          if (!t) return;
          let v: unknown;
          try { v = JSON.parse(t); } catch { bad.push({ line: n, error: 'not valid JSON' }); return; }
          if (v && typeof v === 'object' && (v as { type?: unknown }).type === 'company') { companies.push(v as CompanyInput); return; }
          jobs.push(v);
          lineOf.push(n);
        });
        if (companies.length > 0) svc.jobs.upsertCompanies(companies, now);
        const t0 = performance.now();
        let res;
        if (a.flags.has('complete')) {
          // Group by scope: each scope is refreshed as one complete listing.
          const { normalizeInput, boardScopeOf } = await import('./record.ts');
          const groups = new Map<string, unknown[]>();
          const iso = new Date(now).toISOString();
          for (const j of jobs) {
            const r = normalizeInput(j, iso, source);
            const scope = r.job ? boardScopeOf(r.job) ?? 'import' : 'import';
            (groups.get(scope) ?? groups.set(scope, []).get(scope)!).push(j);
          }
          const all = { inserted: 0, updated: 0, unchanged: 0, merged: 0, reopened: 0, closed: 0, purged: 0, rejected: [] as Array<{ index: number; error: string }>, closeHeld: [] as string[] };
          for (const [scope, list] of groups) {
            const r = svc.jobs.refreshScope(scope, list, { now, source });
            for (const k of ['inserted', 'updated', 'unchanged', 'merged', 'reopened', 'closed', 'purged'] as const) all[k] += r[k];
            all.rejected.push(...r.rejected);
            if (r.closeHeld) all.closeHeld.push(`${scope}: ${r.closeHeld}`);
          }
          res = all;
        } else {
          res = svc.jobs.upsertJobs(jobs, { now, source });
        }
        const rejected = [...bad, ...res.rejected.map((r) => ({ line: lineOf[r.index] ?? r.index + 1, error: r.error }))];
        const { rids: _r, ...rest } = res as typeof res & { rids?: number[] };
        void _r;
        const summary = { ...rest, rejected, companies: companies.length, seconds: Math.round((performance.now() - t0) / 100) / 10 };
        out(a, summary, `Imported ${file}: ${res.inserted} new, ${res.updated} changed, ${res.unchanged} unchanged, ${res.merged} merged into existing jobs, ${res.reopened} reopened, ${res.closed} closed; ${companies.length} company facts; ${rejected.length} lines refused${rejected.length ? ` (first: line ${rejected[0]!.line}: ${rejected[0]!.error})` : ''}. ${summary.seconds}s.` +
          ('closeHeld' in res && Array.isArray(res.closeHeld) && res.closeHeld.length ? `\nHeld: ${res.closeHeld.join('; ')}` : ''));
        return rejected.length > 0 && res.inserted + res.updated + res.unchanged + res.merged === 0 ? 1 : 0;
      }
      case 'seed': {
        const n = Number(flag(a, 'synthetic') ?? 0);
        if (!n) throw new StoreError('bad_request', 'Use: seed --synthetic <n>');
        const now = nowFrom(a);
        const g = new SynthGenerator({ seed: Number(flag(a, 'seed') ?? 42), prefix: flag(a, 'prefix') ?? 'syn', now });
        svc.jobs.upsertCompanies(g.companies.map((c) => ({ key: c.key, name: c.name, industries: c.industries, stage: c.stage, isStaffingAgency: c.isStaffingAgency, h1b: c.h1b })), now);
        const t0 = performance.now();
        let inserted = 0;
        for (let i = 0; i < n; i += 10_000) {
          const r = svc.jobs.writer.upsert(Array.from({ length: Math.min(10_000, n - i) }, (_, k) => g.job(i + k)), new Date(now).toISOString());
          inserted += r.inserted;
          if (!a.flags.has('json')) process.stderr.write(`\r${Math.min(n, i + 10_000)} of ${n}`);
        }
        if (!a.flags.has('json')) process.stderr.write('\n');
        out(a, { inserted, seconds: Math.round((performance.now() - t0) / 100) / 10 }, `Added ${inserted} synthetic jobs in ${((performance.now() - t0) / 1000).toFixed(1)}s.`);
        return 0;
      }
      case 'close': {
        const ids = a._.slice(1);
        const r = svc.jobs.closeJobs(ids, (flag(a, 'reason') as 'source_removed' | 'unseen' | 'board_empty' | 'user' | undefined) ?? 'source_removed', nowFrom(a));
        out(a, r, `Closed ${r.closed} of ${ids.length} jobs.`);
        return 0;
      }
      case 'sync-crawler': {
        const r = svc.jobs.syncFromCrawler(nowFrom(a));
        out(a, r, `Crawler rows read: ${r.seen}. ${r.inserted} new, ${r.updated} changed, ${r.unchanged} unchanged, ${r.closed} closed.`);
        return 0;
      }
      case 'search': {
        let filter: JobFilter = {};
        const fj = flag(a, 'filter');
        if (fj) { try { filter = JSON.parse(fj) as JobFilter; } catch { throw new StoreError('bad_request', '--filter must be JSON'); } }
        const req: JobSearchRequest = { sort: (flag(a, 'sort') as JobSearchRequest['sort']) ?? 'recommended', filter };
        if (flag(a, 'q') !== undefined) req.q = flag(a, 'q');
        if (flag(a, 'limit')) req.limit = Number(flag(a, 'limit'));
        if (flag(a, 'cursor')) req.cursor = flag(a, 'cursor');
        if (req.sort === 'top_matched') await svc.loadModel({ download: false });
        const ctx = await svc.searchContext(nowFrom(a));
        if (a.flags.has('all')) {
          const ids = new Set<string>();
          let pages = 0, repeats = 0, total = 0;
          let r = svc.jobs.search({ ...req, limit: req.limit ?? 100 }, ctx);
          total = r.total;
          for (;;) {
            pages++;
            for (const it of r.items) { if (ids.has(it.job.id)) repeats++; ids.add(it.job.id); }
            if (!r.nextCursor) break;
            r = svc.jobs.search({ ...req, limit: req.limit ?? 100, cursor: r.nextCursor }, ctx);
          }
          out(a, { total, distinct: ids.size, pages, repeats }, `total ${total}, distinct jobs reached ${ids.size}, pages ${pages}, repeats ${repeats}`);
          return 0;
        }
        const r = svc.jobs.search(req, ctx);
        if (a.flags.has('json')) { out(a, r); return 0; }
        const lines = r.items.map((it, i) => {
          const j = it.job;
          const pay = j.pay ? `${j.pay.currency} ${j.pay.min ?? '?'}-${j.pay.max ?? '?'}/${j.pay.period}` : 'pay not stated';
          const fit = it.fitScore !== null ? ` fit ${it.fitScore.toFixed(3)}` : r.fit.state !== 'needs_profile' && req.sort === 'top_matched' ? ' not scored yet' : '';
          return `${String(i + 1).padStart(3)}. ${j.title} | ${j.company} | ${j.places.map((p) => p.text).join('; ') || 'place not stated'} | ${j.workModel ?? 'work model not stated'} | ${pay} | posted ${j.postedAt?.slice(0, 10) ?? 'not stated'}${fit}\n     ${j.id}`;
        });
        process.stdout.write(`${r.total} jobs (${r.tookMs} ms). Fit: ${r.fit.state}${r.fit.waiting ? `, ${r.fit.waiting} waiting` : ''}.\n${lines.join('\n')}\n${r.nextCursor ? `next page: --cursor ${r.nextCursor}\n` : ''}`);
        return 0;
      }
      case 'get': {
        const j = svc.jobs.get(a._[1] ?? '');
        if (!j) throw new StoreError('not_found', 'There is no job with this id.');
        out(a, { job: j, tracker: svc.tracker.get(j.id) });
        return 0;
      }
      case 'profile': {
        const sub = a._[1] ?? 'show';
        if (sub === 'show') { out(a, svc.profiles.get()); return 0; }
        if (sub === 'clear') { svc.profiles.clear(); out(a, { cleared: true }, 'Profile deleted. Top Matched now needs a profile.'); return 0; }
        if (sub === 'set') {
          const file = a._[2];
          if (!file) throw new StoreError('bad_request', 'Use: profile set <file.json> (a ProfileInput; missing parts are empty)');
          const partial = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProfileInput>;
          const base = emptyProfileInput();
          const input: ProfileInput = { ...base, ...partial, preferences: { ...base.preferences, ...(partial.preferences ?? {}) }, workAuthorization: { ...base.workAuthorization, ...(partial.workAuthorization ?? {}) }, eeo: { ...base.eeo, ...(partial.eeo ?? {}) }, personal: { ...base.personal, ...(partial.personal ?? {}) } };
          const p = svc.profiles.put(input, '', nowFrom(a));
          out(a, { version: p.version, updatedAt: p.updatedAt }, `Profile saved (version ${p.version}).`);
          return 0;
        }
        throw new StoreError('bad_request', 'Use: profile show | set <file.json> | clear');
      }
      case 'tracker': {
        const sub = a._[1];
        const id = a._[2] ?? '';
        const now = nowFrom(a);
        if (sub === 'list') {
          const r = svc.tracker.list((a._[2] ?? 'liked') as TrackerView);
          out(a, r, `${r.items.length} in view. Counts: ${JSON.stringify(r.counts)}\n${r.items.map((i) => `  ${i.job.title} | ${i.job.company} | ${i.job.status} | status ${i.entry.status ?? '-'} | notes ${i.entry.notes.length} | ${i.job.id}`).join('\n')}`);
          return 0;
        }
        const patch = sub === 'like' ? { liked: true } : sub === 'unlike' ? { liked: false } : sub === 'hide' ? { hidden: true } : sub === 'unhide' ? { hidden: false }
          : sub === 'status' ? { status: a._[3] === 'none' ? null : (a._[3] as 'applied') } : sub === 'note' ? { notes: [...(svc.tracker.get(id)?.notes.map((n) => ({ id: n.id, text: n.text })) ?? []), { text: a._.slice(3).join(' ') }] } : null;
        if (!patch) throw new StoreError('bad_request', 'Use: tracker like|unlike|hide|unhide|status|note <jobId> ... or tracker list <view>');
        const e = svc.tracker.patch(id, patch, now);
        out(a, e, `${e.jobId}: liked ${e.liked}, hidden ${e.hidden}, status ${e.status ?? '-'}, notes ${e.notes.length}`);
        return 0;
      }
      case 'filters': {
        const sub = a._[1] ?? 'list';
        if (sub === 'list') { out(a, svc.filters.list()); return 0; }
        if (sub === 'delete') { out(a, { deleted: svc.filters.delete(a._[2] ?? '') }); return 0; }
        if (sub === 'save') {
          const f = svc.filters.create({ name: a._[2] ?? '', filter: JSON.parse(flag(a, 'filter') ?? '{}') as JobFilter, sort: (flag(a, 'sort') as JobSearchRequest['sort']) ?? 'recommended' }, nowFrom(a));
          if (a.flags.has('default')) svc.settings.setJson('store.defaultFilterId', f.id);
          out(a, f, `Saved filter ${f.id} (${f.name}).`);
          return 0;
        }
        throw new StoreError('bad_request', 'Use: filters list | save <name> --filter <json> --sort <sort> | delete <id>');
      }
      case 'index': {
        const e = await svc.loadModel({ download: !a.flags.has('no-download'), onProgress: (d, t) => { if (!a.flags.has('json')) process.stderr.write(`\rmodel ${mb(d)} of ${mb(t)}`); } });
        if (!e) throw new StoreError('not_ready', `Fit indexing cannot run: ${svc.modelProblem ?? 'the fit model is not downloaded.'}`);
        const t0 = performance.now();
        const lim = flag(a, 'limit') ? Number(flag(a, 'limit')) : Infinity;
        const r = await svc.fit.runAll(undefined, (done, left) => { if (!a.flags.has('json')) process.stderr.write(`\rindexed ${done}, waiting ${left}      `); }, lim);
        if (!a.flags.has('json')) process.stderr.write('\n');
        const s = svc.fit.status();
        out(a, { ...r, seconds: Math.round((performance.now() - t0) / 100) / 10, status: s }, `Indexed ${r.indexed} jobs in ${((performance.now() - t0) / 1000).toFixed(1)}s. Now ${s.indexed} indexed, ${s.waiting} waiting.`);
        return 0;
      }
      case 'status': {
        await svc.refreshModelState();
        const s = svc.fit.status();
        out(a, s, `Fit index: ${s.state}. Model ${s.model} (${mb(s.modelBytes ?? 0)}${s.modelSource ? ` from ${s.modelSource}` : ''}).\nIndexed ${s.indexed}, waiting ${s.waiting}. Last run: ${s.lastRun ? `${s.lastRun.indexed} indexed, started ${s.lastRun.startedAt}, ${s.lastRun.finishedAt ? `finished ${s.lastRun.finishedAt}` : 'did not finish'}` : 'none yet'}.`);
        return 0;
      }
      case 'stats': {
        const s = svc.jobs.storage(svc.dbPath, svc.h.home);
        await svc.refreshModelState();
        const vec = Number((svc.db.prepare('SELECT count(*) AS n FROM job_vectors').get() as { n: number }).n);
        out(a, { ...s, vectors: vec, modelState: svc.modelState, modelDir: svc.modelDir }, `Data folder: ${s.dataDir}\nDatabase:    ${s.dbPath}\nSize:        ${mb(s.dbBytes)} (${s.jobs ? Math.round(s.dbBytes / s.jobs) : 0} bytes per job)\nJobs:        ${s.openJobs} open, ${s.jobs - s.openJobs} closed and kept (tracked)\nVectors:     ${vec}\nFit model:   ${svc.modelState} (${svc.modelDir})`);
        return 0;
      }
      case 'model': {
        const sub = a._[1] ?? 'status';
        if (sub === 'download') {
          const e = await svc.loadModel({ download: true, onProgress: (d, t) => { if (!a.flags.has('json')) process.stderr.write(`\r${mb(d)} of ${mb(t)}`); } });
          if (!a.flags.has('json')) process.stderr.write('\n');
          if (!e) throw new StoreError('not_ready', `The model is not ready: ${svc.modelProblem ?? 'unknown problem'}`);
          out(a, { state: 'ready', dir: svc.modelDir }, `Model ready in ${svc.modelDir}`);
          return 0;
        }
        const { checkModel } = await import('./embed/model.ts');
        const c = await checkModel(svc.modelDir, undefined, sub === 'verify');
        out(a, { ...c, dir: svc.modelDir, source: svc.source.base }, `Model: ${c.state} (${mb(c.haveBytes)} of ${mb(c.totalBytes)}) in ${svc.modelDir}${c.problems.length ? `\nProblems: ${c.problems.join('; ')}` : ''}\nSource: ${svc.source.base}`);
        return c.state === 'ready' ? 0 : 1;
      }
      case 'vacuum': {
        const before = svc.jobs.storage(svc.dbPath, svc.h.home).dbBytes;
        svc.jobs.vacuum(a.flags.has('full'));
        const after = svc.jobs.storage(svc.dbPath, svc.h.home).dbBytes;
        out(a, { before, after }, `Store size ${mb(before)} -> ${mb(after)}`);
        return 0;
      }
      case 'export-saved': {
        for (const line of svc.jobs.exportSaved()) process.stdout.write(`${line}\n`);
        return 0;
      }
      case 'serve': {
        const { serve } = await import('./serve.ts');
        await serve(svc, { port: flag(a, 'port') ? Number(flag(a, 'port')) : undefined, token: flag(a, 'token') ?? process.env.JOBLEFT_LAUNCH_TOKEN, download: !a.flags.has('no-download') });
        return -1;
      }
      case 'bench': {
        await svc.loadModel({ download: false });
        const ctx = await svc.searchContext(nowFrom(a));
        svc.jobs.mem.refresh();
        const r = runBench(svc.jobs, svc.fit, ctx.profileVector, Number(flag(a, 'queries') ?? 300), nowFrom(a));
        out(a, r, benchText(r));
        return 0;
      }
      default:
        throw new StoreError('bad_request', `Unknown command "${cmd}". Run: jobleft-store help`);
    }
  } finally {
    if (cmd !== 'serve') await svc.close();
  }
}

function benchText(r: BenchResult & { buildSeconds?: number; loadMs?: number; rssMB?: number; note?: string }): string {
  const rows = Object.entries(r.byKind).map(([k, v]) => `  ${k.padEnd(14)} n ${String(v.n).padStart(3)}  p50 ${v.p50.toFixed(1).padStart(6)} ms  p95 ${v.p95.toFixed(1).padStart(6)} ms  max ${v.max.toFixed(1).padStart(6)} ms`);
  return `Rows: ${r.rows} open jobs. Queries: ${r.queries}.\nFirst query ${r.firstMs.toFixed(1)} ms; all: p50 ${r.p50.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, max ${r.max.toFixed(1)} ms\n${rows.join('\n')}` +
    (r.buildSeconds !== undefined ? `\nBuilt in ${String(r.buildSeconds)}s, arrays loaded in ${String(r.loadMs)} ms, memory ${String(r.rssMB)} MB. ${String(r.note)}` : '');
}

main().then((code) => { if (code >= 0) process.exitCode = code; }).catch((e: unknown) => {
  if (e instanceof StoreError) { process.stderr.write(`${e.message}\n`); process.exitCode = e.code === 'bad_request' ? 2 : 1; return; }
  process.stderr.write(`jobleft-store failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
