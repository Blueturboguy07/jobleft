#!/usr/bin/env node
// jobleft-network: the command-line front end of the Network tool (packages/network/README.md lists every command).
// Each command is a new process, like a new start of the app. Data lives in $JOBLEFT_HOME/data/jobleft.db.
// The tool never contacts the professional network, never looks people up, and never sends a message.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { formatDollars, nowMs, OUTREACH_STAGE_LABELS, OUTREACH_STAGES, type OutreachStage } from '@jobleft/contracts';
import { AiError } from '@jobleft/ai-engine';
import { resolveCompanyKey } from './company.ts';
import { openNetworkDatabase } from './db.ts';
import { draftFacts, draftFromTemplate, draftMessages, draftOutreach, profileSummary } from './draft.ts';
import { NetworkService, type NetworkContactView } from './service.ts';
import { decodeCsvBytes, displayDate, isIsoDate, localTimeZone } from './text.ts';
import { bridgeDestination, createBridgeClient, normalizeBaseUrl } from './dev/ai-bridge.ts';
import { demoFixture, demoNewerFixture, syntheticFixture } from './dev/fixture.ts';
import { feedPage } from './dev/feed.ts';
import { MOCK_MODES, startMockAi, type MockMode } from './dev/mock-ai.ts';
import { showDesktopNotification } from './dev/notify.ts';
import { startDevServer } from './dev/server.ts';
import { StandIn } from './dev/standin.ts';

// ---------------------------------------------------------------- arguments

interface Args { _: string[]; flags: Record<string, string | true> }

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { out.flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out.flags[name] = next; i++; } else out.flags[name] = true;
    } else out._.push(a);
  }
  return out;
}

const BOOLEAN_FLAGS = new Set(['json', 'yes', 'template', 'due', 'in-plan', 'no-company', 'clear', 'copy', 'publik', 'no-notify', 'like', 'offline', 'keep']);

function flag(a: Args, name: string): string | undefined {
  const v = a.flags[name];
  return typeof v === 'string' ? v : undefined;
}
function has(a: Args, name: string): boolean {
  return a.flags[name] !== undefined;
}

class UsageError extends Error {}

function fail(msg: string): never { throw new UsageError(msg); }

// ---------------------------------------------------------------- context

function defaultHome(): string {
  if (process.env.JOBLEFT_HOME) return resolve(process.env.JOBLEFT_HOME);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'jobleft');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? homedir(), 'jobleft');
  return join(homedir(), '.local', 'share', 'jobleft');
}

interface Ctx { home: string; service: NetworkService; standin: StandIn; keyFn: (n: string) => string; keySource: string; close(): void }

function open(): Ctx {
  const home = defaultHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const k = resolveCompanyKey();
  const db = openNetworkDatabase(join(home, 'data', 'jobleft.db'));
  const service = new NetworkService({ db, companyKey: k.fn });
  const standin = new StandIn(home, k.fn);
  return { home, service, standin, keyFn: k.fn, keySource: k.source, close: () => db.close() };
}

const out = (s = '') => process.stdout.write(s + '\n');
const json = (v: unknown) => out(JSON.stringify(v, null, 2));

function fullName(c: { firstName: string; lastName: string }): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name in the file)';
}

function contactLine(c: NetworkContactView): string {
  const bits = [
    `${c.id}  ${fullName(c)}${c.maybeGarbled ? '  [name may be garbled by the export; shown as in the file]' : ''}`,
    `    ${c.position ?? '(no title in the file)'} | ${c.company ?? '(no company in the file)'}`,
    `    email: ${c.email ?? '(none in the file)'} | connected: ${c.connectedOn ? displayDate(c.connectedOn) : '(unknown)'} | stage: ${OUTREACH_STAGE_LABELS[c.stage]}`
      + `${c.followUpOn ? ` | follow-up: ${c.followUpOn}${c.followUpDue ? ' (due)' : ''}` : ''}${c.inPlan ? ' | in plan' : ''}${c.inLatestFile ? '' : ' | not in latest file'}`,
  ];
  if (c.note) bits.push(`    note: ${c.note}`);
  if (c.profileUrl) bits.push(`    profile link (opens only if you open it): ${c.profileUrl}`);
  return bits.join('\n');
}

/** A contact from an id, an id prefix, or a unique name. */
function findContact(ctx: Ctx, ref: string | undefined): NetworkContactView {
  if (!ref) fail('Give a contact id (from `list`) or a name in quotes.');
  const exact = ctx.service.get(ref);
  if (exact) return exact;
  const all = ctx.service.list({ q: ref });
  const byPrefix = ref.startsWith('c_') ? ctx.service.list().filter((c) => c.id.startsWith(ref)) : [];
  const hits = byPrefix.length ? byPrefix : all.filter((c) => fullName(c).toLowerCase() === ref.toLowerCase());
  const pool = hits.length ? hits : all;
  if (pool.length === 1) return pool[0]!;
  if (!pool.length) fail(`No contact matches "${ref}".`);
  fail(`${pool.length} contacts match "${ref}". Use an id:\n${pool.slice(0, 10).map((c) => `  ${c.id}  ${fullName(c)} (${c.company ?? 'no company'})`).join('\n')}`);
}

function companyKeyFromArgs(ctx: Ctx, a: Args, pos: number): { key: string; name: string } {
  const key = flag(a, 'key');
  if (key) return { key, name: flag(a, 'name') ?? key };
  const name = a._.slice(pos).join(' ').trim();
  if (!name) fail('Give a company name, for example: rank "Stripe, Inc."');
  let k = '';
  try { k = ctx.keyFn(name); } catch { k = ''; }
  if (!k) fail(`"${name}" gives no company key.`);
  return { key: k, name };
}

function jobFromArgs(ctx: Ctx, a: Args) {
  const id = flag(a, 'job');
  if (!id) return null;
  const found = ctx.standin.findJob(id);
  const j = found ? ctx.standin.asJob(found.id) : null;
  if (!j) fail(`No stand-in job "${id}" (give its id, or a title that only one job has). See \`jobs list\`.`);
  return j;
}

// ---------------------------------------------------------------- commands

const HELP = `jobleft-network: the Network tool on your own Connections.csv. Data: $JOBLEFT_HOME/data/jobleft.db.

Import and browse
  import <file> [--json]                  Import Connections.csv (the file is read, never copied or changed)
  status [--json]                         Data folder, people, last import, today's date, key function
  list [--company <name>] [--no-company] [--stage <s>] [--q <text>] [--due] [--in-plan] [--limit <n>] [--json]
  show <contact>                          One contact (id, id prefix, or "First Last")
  companies [--json]                      Companies in your network, with the names as written
  count <company name>                    "You know N people at <company>" and the names
  explain <company name> [--json]         How the count was made, and near names that are NOT counted

Who to contact, and the plan
  rank <company name> [--job <jobId>] [--json]   Who to message first, with reasons
  coverage [--json]                       Your target companies (liked stand-in jobs): known and "no one yet"
  plan [--json]                           The coffee-chat plan by company
  plan top <company name> [--n 2] [--job <jobId>]   Put the top N people there into the plan
  plan add <contact> | plan remove <contact>

Tracking
  stage <contact> <to_contact|messaged|replied|met|follow_up_due>
  note <contact> <text...> | note <contact> --clear
  follow-up <contact> <YYYY-MM-DD|today|tomorrow|clear>
  due [--json]                            Follow-ups due today or earlier
  remind                                  Show a desktop notification for due follow-ups (once per date)

Drafts (you copy and send them yourself; nothing is ever sent)
  ai show | ai use local|custom|publik --url <address> [--model <m>] | ai use none
  preview <contact> [--job <jobId>] [--variant short|long]   Exactly what a draft would send, and to whom
  draft <contact> [--job <jobId>] [--variant short|long] [--template] [--yes] [--copy] [--out <file>] [--json]

Delete
  delete <contact>                        Delete one contact and everything about it
  delete-all --yes                        Delete all network data (your own file is not touched)

Stand-ins (until the app wires the job store, profile and AI settings)
  jobs list [--liked] [--q <text>] [--json] | jobs add --title <t> --company <c> [--department <d>] [--like]
  jobs like <jobId> | jobs unlike <jobId> | jobs remove <jobId> | jobs clear
  jobs import <file.json> | jobs seed --synthetic <n>
  profile show | profile set [--first <f>] [--last <l>] [--title <t>] [--company <c>] [--school <s>] [--skills a,b]

Tools
  serve [--port <p>] [--no-notify] [--offline]   The screens and the local API (token-protected, 127.0.0.1 only)
  mock-ai [--port 4031] [--mode ok] [--publik] [--balance 5] [--price 0.01] [--log <file>]
  fixture demo --out <file> | fixture demo-newer --out <file> | fixture synthetic --rows <n> [--seed 42] --out <file>
  bench [--rows 30000] [--jobs 2000]      Import and feed timings on a made-up file (in a temp folder)
`;

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); } finally { rl.close(); }
}

function printSummary(s: ReturnType<NetworkService['import']>): void {
  if (s.notAConnectionsFile) {
    out('Not imported.');
    for (const w of s.warnings) out(`  ${w}`);
    return;
  }
  out(`Imported ${s.inFile} ${s.inFile === 1 ? 'person' : 'people'} from the file: ${s.imported} new, ${s.updated} updated, ${s.unchanged} unchanged.`);
  out(`Skipped ${s.skipped.length} ${s.skipped.length === 1 ? 'row' : 'rows'}${s.skipped.length ? ':' : '.'}`);
  for (const k of s.skipped) out(`  line ${k.line}: ${k.reason}`);
  if (s.missingFromFile) out(`Kept ${s.missingFromFile} ${s.missingFromFile === 1 ? 'person' : 'people'} from an earlier import who ${s.missingFromFile === 1 ? 'is' : 'are'} not in this file.`);
  out(`People in your network now: ${s.total}.`);
  if (s.warnings.length) { out('Notes:'); for (const w of s.warnings) out(`  ${w}`); }
}

async function run(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  for (const f of Object.keys(a.flags)) if (BOOLEAN_FLAGS.has(f) && typeof a.flags[f] === 'string') {
    // "--json list" style: a boolean flag took the next word; give it back.
    a._.push(a.flags[f] as string);
    a.flags[f] = true;
  }
  const cmd = a._[0] ?? 'help';

  if (cmd === 'help' || cmd === '--help' || has(a, 'help')) { out(HELP); return 0; }

  if (cmd === 'fixture') {
    const kind = a._[1];
    const file = flag(a, 'out');
    if (!file) fail('Give --out <file>.');
    if (kind === 'demo') {
      const f = demoFixture(nowMs());
      writeFileSync(file, f.text);
      out(`Wrote ${file}: ${f.expect.people} made-up people, then 2 rows that must be skipped (${f.expect.skipped.map((s) => `line ${s.line}: ${s.why}`).join('; ')}).`);
      return 0;
    }
    if (kind === 'demo-newer') {
      const f = demoNewerFixture(nowMs());
      writeFileSync(file, f.text);
      out(`Wrote ${file}: ${f.expect.people} made-up people. Changed: ${f.expect.updated.join(', ')} (new position). New: ${f.expect.added.join(', ')}. Gone from this file: ${f.expect.missing.join(', ')}.`);
      return 0;
    }
    if (kind === 'synthetic') {
      const rows = Number(flag(a, 'rows') ?? '30000');
      writeFileSync(file, syntheticFixture(rows, Number(flag(a, 'seed') ?? '42'), nowMs()));
      out(`Wrote ${file}: ${rows} made-up people.`);
      return 0;
    }
    fail('Use `fixture demo --out <file>` or `fixture synthetic --rows <n> --out <file>`.');
  }

  if (cmd === 'mock-ai') {
    const mode = (flag(a, 'mode') ?? 'ok') as MockMode;
    if (!(mode in MOCK_MODES)) fail(`Unknown mode. Modes: ${Object.keys(MOCK_MODES).join(', ')}.`);
    const m = await startMockAi({
      port: Number(flag(a, 'port') ?? '4031'), mode, publik: has(a, 'publik'),
      balanceUsd: Number(flag(a, 'balance') ?? '5'), priceUsd: Number(flag(a, 'price') ?? '0.01'), logFile: flag(a, 'log') ?? null,
    });
    out(`Mock AI provider${has(a, 'publik') ? ' (publik stand-in, balance $' + Number(flag(a, 'balance') ?? '5').toFixed(2) + ')' : ''} at ${m.origin} in mode "${mode}".`);
    out(`Every request is logged at ${m.origin}/__admin/log${flag(a, 'log') ? ` and in ${flag(a, 'log')}` : ''}. Change mode: POST ${m.origin}/__admin/mode {"mode":"bad"}. Ctrl-C stops it.`);
    await new Promise<void>((r) => { process.once('SIGINT', r); process.once('SIGTERM', r); });
    await m.close();
    return 0;
  }

  if (cmd === 'serve') {
    const s = await startDevServer({
      home: defaultHome(), ...(flag(a, 'port') ? { port: Number(flag(a, 'port')) } : {}),
      osNotifications: !has(a, 'no-notify'), offline: has(a, 'offline') || process.env.JOBLEFT_OFFLINE === '1',
    });
    out(`Network tool running. Open this address (the token is in the # part and never reaches a server):`);
    out(s.uiUrl);
    out(`API: ${s.origin}/api/v1/network/... with header x-jobleft-token (the token is also in $JOBLEFT_HOME/run/network-dev.json, mode 0600). Ctrl-C stops it.`);
    await new Promise<void>((r) => { process.once('SIGINT', r); process.once('SIGTERM', r); });
    await s.close();
    return 0;
  }

  if (cmd === 'bench') return bench(a);

  const ctx = open();
  try {
    return await command(ctx, cmd, a);
  } finally {
    ctx.close();
  }
}

async function command(ctx: Ctx, cmd: string, a: Args): Promise<number> {
  const s = ctx.service;
  switch (cmd) {
    case 'import': {
      const file = a._[1];
      if (!file) fail('Give the path of Connections.csv.');
      if (!existsSync(file)) fail(`No file at ${file}.`);
      const decoded = decodeCsvBytes(new Uint8Array(readFileSync(file)));
      const t0 = performance.now();
      const summary = s.import(decoded.text);
      const merged = { ...summary, warnings: [...decoded.warnings, ...summary.warnings] };
      if (has(a, 'json')) json({ ...merged, ms: Math.round(performance.now() - t0) });
      else { printSummary(merged); out(`Time: ${Math.round(performance.now() - t0)} ms.`); }
      return summary.notAConnectionsFile ? 2 : 0;
    }
    case 'status': {
      const st = {
        dataFolder: ctx.home, database: join(ctx.home, 'data', 'jobleft.db'), people: s.total(), lastImport: s.lastImport(),
        today: s.today(), timeZone: localTimeZone(), companyKey: ctx.keySource === 'static-data' ? '@jobleft/static-data companyKey' : 'interim key (static-data not built in this checkout)',
        due: s.due().length, inPlan: s.list({ inPlan: true }).length, standInJobs: ctx.standin.jobs().length,
        ai: bridgeDestination(ctx.standin.ai()),
      };
      if (has(a, 'json')) { json(st); return 0; }
      out(`Data folder: ${st.dataFolder}`);
      out(`People: ${st.people}. Due follow-ups: ${st.due}. In the plan: ${st.inPlan}.`);
      out(`Last import: ${st.lastImport ? `${st.lastImport.at}, ${st.lastImport.inFile} people in the file, ${st.lastImport.skipped} rows skipped` : 'none'}.`);
      out(`Today: ${st.today} (${st.timeZone}). Company key: ${st.companyKey}.`);
      out(`AI for drafts: ${st.ai ? st.ai.label : 'none set up (the plain template still works)'}.`);
      return 0;
    }
    case 'list': {
      const q = {
        ...(flag(a, 'company') ? { companyKey: companyKeyFromArgs(ctx, { _: [flag(a, 'company')!], flags: {} }, 0).key } : {}),
        ...(flag(a, 'key') ? { companyKey: flag(a, 'key')! } : {}),
        ...(has(a, 'no-company') ? { noCompany: true } : {}),
        ...(flag(a, 'stage') ? { stage: flag(a, 'stage') as OutreachStage } : {}),
        ...(flag(a, 'q') ? { q: flag(a, 'q')! } : {}),
        ...(has(a, 'due') ? { due: true } : {}),
        ...(has(a, 'in-plan') ? { inPlan: true } : {}),
      };
      if (q.stage && !(OUTREACH_STAGES as readonly string[]).includes(q.stage)) fail(`Stages: ${OUTREACH_STAGES.join(', ')}.`);
      const all = s.list(q);
      const limit = flag(a, 'limit') ? Number(flag(a, 'limit')) : 50;
      if (has(a, 'json')) { json(all.slice(0, flag(a, 'limit') ? limit : undefined)); return 0; }
      out(`${all.length} ${all.length === 1 ? 'person' : 'people'}${all.length > limit ? ` (showing ${limit}; use --limit)` : ''}.`);
      for (const c of all.slice(0, limit)) out(contactLine(c));
      return 0;
    }
    case 'show': { out(contactLine(findContact(ctx, a._.slice(1).join(' ')))); return 0; }
    case 'companies': {
      const groups = s.companies();
      if (has(a, 'json')) { json(groups); return 0; }
      for (const g of groups) {
        const label = g.kind === 'unknown' ? 'Unknown company (blank in the file)' : g.kind === 'placeholder' ? 'No specific company (Self-employed, Stealth and the like)' : g.names[0]!.name;
        const written = g.kind === 'unknown' ? '' : g.names.length > 1 || g.kind !== 'company' ? `  written as: ${g.names.map((n) => `"${n.name}" (${n.count})`).join(', ')}` : '';
        out(`${String(g.count).padStart(5)}  ${label}${g.kind === 'company' ? `  [key ${g.companyKey}]` : ''}${written}`);
      }
      return 0;
    }
    case 'count': {
      const { key, name } = companyKeyFromArgs(ctx, a, 1);
      const n = s.countFor(key);
      if (!n) { out(`You know no one at ${name} in your connections file.`); return 0; }
      out(`You know ${n} ${n === 1 ? 'person' : 'people'} at ${name}:`);
      for (const c of s.list({ companyKey: key })) out(`  ${c.id}  ${fullName(c)}  (${c.position ?? 'no title'}; file says "${c.company}")`);
      return 0;
    }
    case 'explain': {
      const { key, name } = companyKeyFromArgs(ctx, a, 1);
      const e = s.explain(key, name);
      if (has(a, 'json')) { json(e); return 0; }
      out(`${name}: ${e.count} ${e.count === 1 ? 'person' : 'people'} counted (company key "${key}").`);
      for (const m of e.matched) out(`  counted  "${m.name}" (${m.count}): ${m.how}`);
      for (const m of e.notCounted) out(`  not counted  "${m.name}" (${m.count}): ${m.why}`);
      if (!e.matched.length && !e.notCounted.length) out('  No names in your network are near this one.');
      return 0;
    }
    case 'rank': {
      const { key, name } = companyKeyFromArgs(ctx, a, 1);
      const job = jobFromArgs(ctx, a);
      const ranks = s.rank(key, job);
      if (has(a, 'json')) { json(ranks.map((r) => ({ ...r, contact: s.get(r.contactId) }))); return 0; }
      if (!ranks.length) { out(`You know no one at ${name}.`); return 0; }
      out(`Who to message first at ${name}${job ? ` for "${job.title}"` : ''}:`);
      ranks.forEach((r, i) => {
        const c = s.get(r.contactId)!;
        out(`${i + 1}. ${fullName(c)} (${c.position ?? 'no title'})  score ${r.score}  [${c.id}]`);
        for (const reason of r.reasons) out(`     - ${reason.text}`);
      });
      return 0;
    }
    case 'coverage': {
      const cov = s.coverage(ctx.standin.targets());
      if (has(a, 'json')) { json(cov); return 0; }
      if (!ctx.standin.targets().length) { out('No target companies yet. Like a stand-in job: `jobs add --title ... --company ... --like`.'); return 0; }
      if (!s.total()) out('No connections imported yet, so every target shows "no one yet". Import Connections.csv first.');
      out('Target companies where you know someone:');
      for (const c of cov.filter((x) => x.count > 0)) out(`  ${c.companyName}: ${c.count} (top: ${c.topContactIds.map((id) => fullName(s.get(id)!)).join(', ')})`);
      out('Target companies where you know no one yet:');
      for (const c of cov.filter((x) => x.count === 0)) out(`  ${c.companyName}: no one yet`);
      return 0;
    }
    case 'plan': {
      const sub = a._[1];
      if (sub === 'top') {
        const { key, name } = companyKeyFromArgs(ctx, a, 2);
        const added = s.addTopToPlan(key, Number(flag(a, 'n') ?? '2'), jobFromArgs(ctx, a));
        out(added.length ? `In the plan for ${name}: ${added.map((c) => `${fullName(c)} (${OUTREACH_STAGE_LABELS[c.stage]})`).join(', ')}.` : `You know no one at ${name}.`);
        return 0;
      }
      if (sub === 'add' || sub === 'remove') {
        const c = findContact(ctx, a._.slice(2).join(' '));
        s.update(c.id, { inPlan: sub === 'add' });
        out(`${fullName(c)} ${sub === 'add' ? 'is in' : 'is out of'} the plan.`);
        return 0;
      }
      const plan = s.plan();
      if (has(a, 'json')) { json(plan); return 0; }
      if (!plan.length) { out('The coffee-chat plan is empty. Add people with `plan top <company>` or `plan add <contact>`.'); return 0; }
      for (const p of plan) {
        out(`${p.companyName}`);
        p.contacts.forEach((c, i) => out(`  ${i + 1}. ${fullName(c)} (${c.position ?? 'no title'}) - ${OUTREACH_STAGE_LABELS[c.stage]}. Next: ${c.nextStep}`));
      }
      return 0;
    }
    case 'stage': {
      const stage = a._[a._.length - 1] as OutreachStage;
      if (!(OUTREACH_STAGES as readonly string[]).includes(stage)) fail(`Stages: ${OUTREACH_STAGES.join(', ')}.`);
      const c = findContact(ctx, a._.slice(1, -1).join(' '));
      const u = s.update(c.id, { stage });
      out(`${fullName(u)}: ${OUTREACH_STAGE_LABELS[u.stage]}.`);
      return 0;
    }
    case 'note': {
      const c = findContact(ctx, a._[1]);
      const text = has(a, 'clear') ? null : a._.slice(2).join(' ');
      if (text === '') fail('Give the note text, or --clear.');
      const u = s.update(c.id, { note: text });
      out(u.note ? `Note saved for ${fullName(u)}.` : `Note cleared for ${fullName(u)}.`);
      return 0;
    }
    case 'follow-up': {
      const c = findContact(ctx, a._[1]);
      let d = a._[2] ?? '';
      if (d === 'today') d = s.today();
      else if (d === 'tomorrow') { const t = new Date(s.today() + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); d = t.toISOString().slice(0, 10); }
      const value = d === 'clear' ? null : d;
      if (value !== null && !isIsoDate(value)) fail('Give a date written YYYY-MM-DD, or today, tomorrow or clear.');
      const u = s.update(c.id, { followUpOn: value });
      out(u.followUpOn ? `Follow-up with ${fullName(u)} on ${u.followUpOn}${u.followUpDue ? ' (due now)' : ''}.` : `Follow-up cleared for ${fullName(u)}.`);
      return 0;
    }
    case 'due': {
      const due = s.due();
      if (has(a, 'json')) { json(due); return 0; }
      out(due.length ? `${due.length} follow-up${due.length === 1 ? '' : 's'} due (today is ${s.today()}):` : `No follow-ups due (today is ${s.today()}).`);
      for (const c of due) out(`  ${c.followUpOn}  ${fullName(c)} (${c.company ?? 'no company'}) - ${OUTREACH_STAGE_LABELS[c.stage]}  [${c.id}]`);
      return 0;
    }
    case 'remind': {
      const r = s.takeReminders();
      if (!r.count || !r.text) { out('No new reminders (each follow-up date reminds once).'); return 0; }
      const shown = showDesktopNotification(r.text.title, r.text.body, { wait: true });
      out(`${r.text.body} ${shown === 'shown' ? '(desktop notification shown)' : shown === 'off' ? '(desktop notifications are off: JOBLEFT_NO_OS_NOTIFY=1)' : '(this system has no desktop notifications for this tool)'}`);
      return 0;
    }
    case 'ai': {
      if (a._[1] === 'use') {
        const p = a._[2];
        if (p === 'none') { ctx.standin.setAi({ provider: null, baseUrl: null, model: null }); out('No AI provider. Drafts can still use the plain template (--template).'); return 0; }
        if (p !== 'local' && p !== 'custom' && p !== 'publik') fail('Use `ai use local|custom|publik --url <address> [--model <m>]` or `ai use none`.');
        const url = flag(a, 'url') ?? (p === 'publik' ? process.env.JOBLEFT_PUBLIK_BASE_URL : undefined);
        if (!url) fail(p === 'publik' ? 'Give --url (the publik stand-in, for example http://127.0.0.1:4032/api/v1) or set JOBLEFT_PUBLIK_BASE_URL.' : 'Give --url, for example http://127.0.0.1:11434.');
        let base: string;
        try { base = normalizeBaseUrl(url, p); } catch (e) { fail((e as Error).message); }
        ctx.standin.setAi({ provider: p, baseUrl: base, model: flag(a, 'model') ?? null });
      }
      const cfg = ctx.standin.ai();
      const d = bridgeDestination(cfg);
      out(d ? `AI for drafts: ${d.label} (${d.remote ? 'the text leaves this computer' : 'stays on this computer'}), model ${cfg.model ?? '(server default)'}.` : 'AI for drafts: none set up.');
      const w = ctx.standin.wallet();
      if (cfg.provider === 'publik' && w.balanceMicros !== null) out(`publik balance: ${formatDollars(w.balanceMicros)} (read ${w.at}).`);
      return 0;
    }
    case 'preview':
    case 'draft': {
      const c = findContact(ctx, a._.slice(1).join(' '));
      const job = jobFromArgs(ctx, a);
      const variant = (flag(a, 'variant') ?? 'short') as 'short' | 'long';
      if (variant !== 'short' && variant !== 'long') fail('--variant is short or long.');
      const summary = profileSummary(ctx.standin.asProfile(new Date(nowMs()).toISOString()));
      const facts = draftFacts({ contact: c, job, profileSummary: summary, variant });
      const dest = bridgeDestination(ctx.standin.ai());
      if (cmd === 'preview') {
        const preview = { destination: dest, needsConfirmation: !!dest && dest.remote && !s.remoteApproved(dest.label), sends: { contact: facts.contact, job: facts.job, aboutMe: facts.aboutMe }, messages: draftMessages(facts) };
        if (has(a, 'json')) { json(preview); return 0; }
        out(dest ? `A draft goes to ${dest.label}${dest.remote ? ' (it leaves this computer)' : ' (it stays on this computer)'}. It sends exactly:` : 'No AI provider is set up. With one, a draft would send exactly:');
        out(JSON.stringify(preview.sends, null, 2));
        out('Nothing else: no other connection, no email address, no profile link.');
        return 0;
      }
      let draft;
      if (has(a, 'template')) {
        draft = draftFromTemplate({ contact: c, job, profileSummary: summary, variant });
      } else {
        if (!dest) fail('No AI provider is set up. Run `ai use local --url <address>` (a model on this computer works), or add --template for the plain template.');
        if (dest.remote && !s.remoteApproved(dest.label)) {
          out(`This first draft with ${dest.label} sends it: ${fullName(c)}'s name, title and company; ${job ? `the job "${job.title}" at ${job.company}` : 'no job'}; and this summary of you: "${facts.aboutMe}". Nothing else.`);
          const ok = has(a, 'yes') || await confirm(`Send to ${dest.label}?`);
          if (!ok) { out('Not sent. Add --yes to confirm, or use --template.'); return 3; }
          s.approveRemote(dest.label);
        }
        try {
          const ai = createBridgeClient(ctx.standin.ai(), { onWallet: (w) => ctx.standin.setWallet(w) });
          draft = await draftOutreach({ contact: c, job, profileSummary: summary, variant, ai });
        } catch (e) {
          if (e instanceof AiError) {
            out(`No draft: ${e.message}`);
            if (e.topUpUrl) out(`Add money: ${e.topUpUrl}`);
            return 4;
          }
          throw e;
        }
      }
      if (has(a, 'json')) { json(draft); } else {
        out(`Draft for ${fullName(c)} (${draft.variant}, ${[...draft.text].length}/${draft.charLimit} characters, by ${draft.provider}):`);
        out('-----');
        out(draft.text);
        out('-----');
        if (draft.ready) out('Ready: no unsupported claim found. Read it, change it if you like, and send it yourself.');
        else { out('NOT READY. Check these before you send anything:'); for (const w of draft.warnings) out(`  ! ${w}`); }
        if (draft.costMicros !== null) {
          const w = ctx.standin.wallet();
          out(`Cost: ${formatDollars(draft.costMicros)} from your publik balance.${w.balanceMicros !== null ? ` Balance left: ${formatDollars(w.balanceMicros)}.` : ''}`);
        }
      }
      if (flag(a, 'out')) writeFileSync(flag(a, 'out')!, draft.text);
      if (has(a, 'copy')) {
        if (process.platform === 'darwin') { execFileSync('/usr/bin/pbcopy', [], { input: draft.text }); out('Copied the exact text above to the clipboard.'); }
        else out('Copy is available on macOS only; use --out <file>.');
      }
      return 0;
    }
    case 'delete': {
      const c = findContact(ctx, a._.slice(1).join(' '));
      s.delete(c.id);
      out(`Deleted ${fullName(c)} and everything about them (stage, note, follow-up, plan).`);
      return 0;
    }
    case 'delete-all': {
      if (!has(a, 'yes')) fail('This deletes every connection, note, stage, date and plan entry. Your own Connections.csv is not touched. Add --yes to do it.');
      const n = s.deleteAll();
      out(`Deleted all network data: ${n} ${n === 1 ? 'person' : 'people'} with their notes, stages, dates and plan. Your own file was not touched.`);
      return 0;
    }
    case 'jobs': return jobs(ctx, a);
    case 'profile': {
      if (a._[1] === 'set') {
        const patch: Record<string, unknown> = {};
        if (flag(a, 'first')) patch.firstName = flag(a, 'first');
        if (flag(a, 'last')) patch.lastName = flag(a, 'last');
        if (flag(a, 'title')) patch.currentTitle = flag(a, 'title');
        if (flag(a, 'company')) patch.currentCompany = flag(a, 'company');
        if (flag(a, 'school')) patch.school = flag(a, 'school');
        if (flag(a, 'degree')) patch.degree = flag(a, 'degree');
        if (flag(a, 'targets')) patch.targetTitles = flag(a, 'targets')!.split(',').map((x) => x.trim()).filter(Boolean);
        if (flag(a, 'skills')) patch.skills = flag(a, 'skills')!.split(',').map((x) => x.trim()).filter(Boolean);
        ctx.standin.setProfile(patch);
      }
      json(ctx.standin.profile());
      out(`Summary a draft sends: ${profileSummary(ctx.standin.asProfile(new Date(nowMs()).toISOString()))}`);
      return 0;
    }
    default:
      fail(`Unknown command "${cmd}". Run \`help\`.`);
  }
}

function jobs(ctx: Ctx, a: Args): number {
  const sub = a._[1] ?? 'list';
  const st = ctx.standin;
  const now = new Date(nowMs()).toISOString();
  switch (sub) {
    case 'list': {
      const page = feedPage(st, ctx.service, { ...(flag(a, 'q') ? { q: flag(a, 'q')! } : {}), liked: has(a, 'liked'), limit: Number(flag(a, 'limit') ?? '200') });
      if (has(a, 'json')) { json(page); return 0; }
      out(`${page.total} stand-in jobs (page built in ${page.ms} ms):`);
      for (const j of page.items) {
        out(`  ${j.id}  ${j.title} | ${j.company}${j.liked ? ' | liked' : ''}`);
        if (j.networkCount) out(`      You know ${j.networkCount} ${j.networkCount === 1 ? 'person' : 'people'} at ${j.company}`);
      }
      return 0;
    }
    case 'add': {
      const title = flag(a, 'title');
      const company = flag(a, 'company');
      if (!title || !company) fail('Give --title and --company.');
      const j = st.addJob({ title, company, department: flag(a, 'department') ?? null, liked: has(a, 'like') }, now);
      const n = ctx.service.countFor(st.companyKeyOf(j));
      const end = (x: string) => (x.endsWith('.') ? x : `${x}.`);
      out(`Added ${j.id}: ${j.title} | ${end(`${j.company}${j.liked ? ' (liked)' : ''}`)}${n ? ` You know ${n} ${n === 1 ? 'person' : 'people'} at ${end(j.company)}` : ''}`);
      return 0;
    }
    case 'like':
    case 'unlike': {
      const j = st.like(st.findJob(a._.slice(2).join(' '))?.id ?? '', sub === 'like');
      if (!j) fail('No such stand-in job.');
      out(`${sub === 'like' ? 'Liked' : 'Unliked'} ${j.title} | ${j.company}.`);
      return 0;
    }
    case 'remove': {
      const j = st.findJob(a._.slice(2).join(' '));
      if (!j || !st.removeJob(j.id)) fail('No such stand-in job.');
      out(`Removed ${j.title} | ${j.company}.`);
      return 0;
    }
    case 'clear': { out(`Removed ${st.clearJobs()} stand-in jobs.`); return 0; }
    case 'import': {
      const file = a._[2];
      if (!file) fail('Give a JSON file: [{"title":"...","company":"...","department":"...","liked":true}, ...].');
      const list = JSON.parse(readFileSync(file, 'utf8')) as Array<{ title: string; company: string; department?: string; liked?: boolean }>;
      if (!Array.isArray(list)) fail('The file must hold a JSON array.');
      out(`Added ${st.addJobs(list, now)} stand-in jobs.`);
      return 0;
    }
    case 'seed': {
      const n = Number(flag(a, 'synthetic') ?? '0');
      if (!n) fail('Give --synthetic <n>.');
      const companies = ['Stripe', 'Apple', 'Initrode', 'Globex', 'Umbrella Health', 'Northwind Traders', 'Contoso', 'Fabrikam', 'Tailspin Toys', 'Litware', 'Proseware', 'Adventure Works', 'Woodgrove Bank', 'Nobody Knows Co', 'Metaview', 'Blockchain Labs'];
      const titles = ['Backend Engineer', 'Data Analyst', 'Product Designer', 'Account Executive', 'Registered Nurse', 'Recruiter', 'Engineering Manager', 'Financial Analyst'];
      const list = Array.from({ length: n }, (_, i) => ({ title: titles[i % titles.length]!, company: companies[(i * 7) % companies.length]! }));
      out(`Added ${st.addJobs(list, now)} stand-in jobs.`);
      return 0;
    }
    default: fail('jobs list|add|like|unlike|remove|clear|import|seed');
  }
}

async function bench(a: Args): Promise<number> {
  const rows = Number(flag(a, 'rows') ?? '30000');
  const jobsN = Number(flag(a, 'jobs') ?? '2000');
  const home = join('/private/tmp', `jobleft-network-bench-${process.pid}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  process.env.JOBLEFT_HOME = home;
  try {
    const text = syntheticFixture(rows, 7, nowMs());
    const file = join(home, 'Connections.csv');
    writeFileSync(file, text);
    const ctx = open();
    try {
      const companies = ['Stripe', 'Apple', 'Initrode', 'Globex', 'Umbrella Health', 'Northwind Traders', 'Contoso', 'Fabrikam', 'Nobody Knows Co'];
      ctx.standin.addJobs(Array.from({ length: jobsN }, (_, i) => ({ title: `Role ${i}`, company: companies[i % companies.length]! })), new Date().toISOString());
      const feed = () => {
        const times: number[] = [];
        for (let i = 0; i < 20; i++) {
          const t0 = performance.now();
          for (let off = 0; off < jobsN; off += 50) feedPage(ctx.standin, ctx.service, { limit: 50, offset: off });
          times.push(performance.now() - t0);
        }
        times.sort((x, y) => x - y);
        return times[Math.floor(times.length / 2)]!;
      };
      const before = feed();
      const t0 = performance.now();
      const decoded = decodeCsvBytes(new Uint8Array(readFileSync(file)));
      const summary = ctx.service.import(decoded.text);
      const importMs = performance.now() - t0;
      feedPage(ctx.standin, ctx.service, { limit: 1 });
      const after = feed();
      const res = {
        rows, imported: summary.imported, skipped: summary.skipped.length, importMs: Math.round(importMs), jobs: jobsN,
        feedAllPagesMsBefore: Math.round(before * 100) / 100, feedAllPagesMsAfter: Math.round(after * 100) / 100,
        feedGrowthPercent: Math.round(((after - before) / Math.max(before, 0.01)) * 100),
      };
      json(res);
      out(`Import of ${rows} rows: ${res.importMs} ms (bar: under 30,000 ms). Feed of ${jobsN} jobs in pages of 50: ${res.feedAllPagesMsBefore} ms before, ${res.feedAllPagesMsAfter} ms after the import.`);
    } finally {
      ctx.close();
    }
  } finally {
    if (!has(a, 'keep')) rmSync(home, { recursive: true, force: true });
  }
  return 0;
}

run(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  if (e instanceof UsageError) { process.stderr.write(`${e.message}\n`); process.exitCode = 1; return; }
  process.stderr.write(`Error: ${(e as Error).message}\n`);
  process.exitCode = 1;
});
