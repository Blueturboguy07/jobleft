#!/usr/bin/env node
// jobleft-match: the match engine from the command line. Offline: it reads files and prints results; the only
// network use is `serve`, which listens on 127.0.0.1 and never makes a request.
// Run `node packages/match/src/cli.ts help` for the commands.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Company, Job, Profile } from '@jobleft/contracts';
import { MatchResultSchema, nowMs, validate } from '@jobleft/contracts';
import {
  bandCounts, bucketOf, cardText, detailText, rankTopMatched, scoreMatch, setSkillClaim, summarize, taxonomyStats, undoSkillClaim,
  ENGINE_VERSION, type FullMatchResult, type MatchConfigInput, type SkillClaimChange,
} from './index.ts';
import { readCompanies, readJobs, readProfile } from './io.ts';
import { readJob } from './job.ts';
import { skillName } from './taxonomy.ts';

const HELP = `jobleft-match ${ENGINE_VERSION}: the jobleft match score, offline.

Usage: node packages/match/src/cli.ts <command> [options]

Commands
  score    --profile P --job J [--view card|detail|json|all]   one job: card, detail and the endpoint JSON
  feed     --profile P --jobs DIR [--band B] [--limit N] [--json] "Top Matched" order and band counts
  claim    --profile P --skill NAME --have|--not                 "I have this" / "I don't have this" (edits P)
  undo     --profile P                                           undo the last claim on P
  explain  --job J                                               what the engine read from a posting
  check    --profile P --jobs DIR                                self-checks on every job (schema, determinism,
                                                                 quotes, bands, card = detail = endpoint)
  serve    --profile P --jobs DIR [--port N]                     local preview: feed, detail, the endpoint,
                                                                 skill claims (127.0.0.1 only, token required)
  stats                                                          size of the skill and title dictionaries

Common options
  --companies FILE   company facts (H-1B history, industries, stage, investors) as JSON
  --now ISO          the date to count years up to (default: now, or JOBLEFT_NOW)
  --config FILE      other weights (JSON; see DEFAULT_CONFIG in src/config.ts)

Files
  profile: a contract Profile JSON, or a shorter one (missing lists are empty, missing answers stay "not in your
           profile"). Dates as YYYY-MM, "Jan 2020" or "present".
  jobs:    .json (one job, a list, or {"jobs": [...]}; a contract Job or {title, company, location, description, ...}),
           .ndjson, .txt/.md ("Title:", "Company:", "Location:" lines, a blank line, then the posting), .html
`;

type Args = { _: string[]; [k: string]: string | boolean | string[] };

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else (out._ as string[]).push(a);
  }
  return out;
}

function need(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v) fail(`missing --${key}`);
  return v as string;
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(2);
}

function nowOf(args: Args): number {
  if (typeof args.now === 'string') {
    const t = Date.parse(args.now);
    if (!Number.isFinite(t)) fail(`--now is not a date: ${args.now}`);
    return t;
  }
  return nowMs();
}

function configOf(args: Args): MatchConfigInput | null {
  return typeof args.config === 'string' ? JSON.parse(readFileSync(args.config, 'utf8')) as MatchConfigInput : null;
}

function jobsOf(args: Args): Job[] {
  const list = [...(args._ as string[]).slice(1)];
  if (typeof args.jobs === 'string') list.unshift(args.jobs);
  if (typeof args.job === 'string') list.unshift(args.job);
  if (!list.length) fail('missing --jobs (a folder or files)');
  return readJobs(list);
}

interface Ctx { profile: Profile; companyOf: (j: Job) => Company | null; now: number; config: MatchConfigInput | null }

function ctxOf(args: Args): Ctx {
  return { profile: readProfile(need(args, 'profile')), companyOf: readCompanies(typeof args.companies === 'string' ? args.companies : undefined), now: nowOf(args), config: configOf(args) };
}

function score(ctx: Ctx, job: Job): FullMatchResult {
  return scoreMatch({ profile: ctx.profile, job, company: ctx.companyOf(job), now: ctx.now, config: ctx.config });
}

function cmdScore(args: Args): void {
  const ctx = ctxOf(args);
  const jobs = jobsOf(args);
  const view = typeof args.view === 'string' ? args.view : 'all';
  for (const job of jobs) {
    const r = score(ctx, job);
    if (view === 'json') { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); continue; }
    if (view === 'card' || view === 'all') process.stdout.write(`CARD\n${cardText(r, job)}\n\n`);
    if (view === 'detail' || view === 'all') process.stdout.write(`DETAIL\n${detailText(r, job)}\n\n`);
    if (view === 'all') process.stdout.write(`ENDPOINT (GET /api/v1/match/${encodeURIComponent(job.id)})\n${JSON.stringify(r, null, 2)}\n\n`);
  }
}

function cmdFeed(args: Args): void {
  const ctx = ctxOf(args);
  const jobs = jobsOf(args);
  const results = jobs.map((job) => ({ job, match: score(ctx, job) }));
  const ranked = rankTopMatched(results);
  const left = results.length - ranked.length;
  const counts = bandCounts(ranked.map((x) => x.match));
  const band = typeof args.band === 'string' ? args.band.toLowerCase() : null;
  if (band && !['strong', 'good', 'fair', 'incomplete'].includes(band)) fail('--band is strong, good, fair or incomplete');
  const shown = ranked.filter((x) => !band || bucketOf(x.match) === band);
  const limit = typeof args.limit === 'string' ? Number(args.limit) : shown.length;
  if (args.json) {
    process.stdout.write(JSON.stringify({
      profileVersion: ctx.profile.version, engineVersion: ENGINE_VERSION, counts, leftOut: left,
      items: shown.slice(0, limit).map((x, i) => ({ rank: i + 1, jobId: x.job.id, title: x.job.title, company: x.job.company, percent: x.match.percent, band: x.match.band, bucket: bucketOf(x.match), complete: x.match.complete, summary: summarize(x.match) })),
    }, null, 2) + '\n');
    return;
  }
  process.stdout.write(`Top Matched for profile ${ctx.profile.version} (engine ${ENGINE_VERSION})\n`);
  process.stdout.write(`Strong ${counts.strong} · Good ${counts.good} · Fair ${counts.fair} · Incomplete ${counts.incomplete} · Total ${counts.total}${left ? ` (${left} closed or duplicate left out)` : ''}\n`);
  if (band) process.stdout.write(`Filter: ${band} (${shown.length})\n`);
  process.stdout.write('\n');
  shown.slice(0, limit).forEach((x, i) => {
    process.stdout.write(`${String(i + 1).padStart(3)}. [${x.job.id}]\n${cardText(x.match, x.job)}\n\n`);
  });
}

function undoPath(profilePath: string): string {
  return profilePath.replace(/\.json$/i, '') + '.undo.json';
}

function writeProfile(path: string, data: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

function cmdClaim(args: Args): void {
  const path = resolve(need(args, 'profile'));
  const skill = need(args, 'skill');
  if (!args.have && !args.not) fail('say --have or --not');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  readProfile(path); // validates
  const base = raw.profile ?? raw;
  base.skills = (base.skills ?? []).map((s: unknown) => (typeof s === 'string' ? { name: s, years: null, source: 'user' } : s));
  const { profile, change, notice } = setSkillClaim(base, skill, Boolean(args.have));
  const history: SkillClaimChange[] = existsSync(undoPath(path)) ? JSON.parse(readFileSync(undoPath(path), 'utf8')) : [];
  history.push(change);
  writeProfile(path, raw.profile ? { ...raw, profile } : profile);
  writeProfile(undoPath(path), history);
  process.stdout.write(`${notice}\nProfile saved: ${path}\nUndo with: node packages/match/src/cli.ts undo --profile ${path}\n`);
}

function cmdUndo(args: Args): void {
  const path = resolve(need(args, 'profile'));
  if (!existsSync(undoPath(path))) fail('nothing to undo');
  const history: SkillClaimChange[] = JSON.parse(readFileSync(undoPath(path), 'utf8'));
  const last = history.pop();
  if (!last) fail('nothing to undo');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const base = raw.profile ?? raw;
  const profile = undoSkillClaim(base, last);
  writeProfile(path, raw.profile ? { ...raw, profile } : profile);
  writeProfile(undoPath(path), history);
  process.stdout.write(`Undone: ${last.has ? 'I have' : "I don't have"} ${last.skill}. Profile saved: ${path}\n`);
}

function cmdExplain(args: Args): void {
  const jobs = jobsOf(args);
  for (const job of jobs) {
    const jf = readJob(job, null);
    const out: string[] = [`${job.title} · ${job.company} [${job.id}]`];
    out.push(`language: ${jf.language ?? 'too little text to tell'} · words: ${jf.words} · kind of work: ${jf.family ?? 'unknown'}${jf.familySource ? ` (from the ${jf.familySource})` : ''} · level: ${jf.level ?? 'not stated'}${jf.levelSource ? ` (${jf.levelSource})` : ''}`);
    out.push(`work model: ${jf.workModel ?? 'not stated'} · job type: ${jf.employmentType ?? 'not stated'} · industries: ${jf.industries.map((i) => `${i.industry} (${i.source})`).join(', ') || 'not stated'}`);
    out.push('lines (section):');
    for (const l of jf.text.lines) if (l.text.trim()) out.push(`  [${l.section}${l.heading ? ', heading' : ''}] ${l.text.slice(0, 110)}`);
    const ignored = jf.text.sentences.filter((s) => s.ignored);
    out.push(`ignored as text aimed at automated screeners (${ignored.length}):`);
    for (const s of ignored) out.push(`  - ${s.text}`);
    out.push('must-haves stated:');
    for (const r of jf.requirements) out.push(`  - ${r.kind} (${r.importance}): ${r.label} — "${r.quote}"`);
    out.push('skills and credentials named:');
    for (const s of jf.skills) out.push(`  - ${skillName(s.id)} (${s.importance}) — "${s.quote}"`);
    process.stdout.write(out.join('\n') + '\n\n');
  }
}

function cmdCheck(args: Args): void {
  const ctx = ctxOf(args);
  const jobs = jobsOf(args);
  let failures = 0;
  const fails = (msg: string) => { failures++; process.stdout.write(`  FAIL ${msg}\n`); };
  for (const job of jobs) {
    const a = score(ctx, job);
    const b = score(ctx, JSON.parse(JSON.stringify(job)));
    const v = validate(MatchResultSchema, a);
    if (!v.ok) fails(`${job.id}: result does not match the MatchResult contract: ${JSON.stringify(v.issues.slice(0, 3))}`);
    if (JSON.stringify(a) !== JSON.stringify(b)) fails(`${job.id}: two runs differ`);
    const expectBand = a.percent >= 85 ? 'strong' : a.percent >= 70 ? 'good' : 'fair';
    if (a.band !== expectBand) fails(`${job.id}: band ${a.band} does not fit ${a.percent}%`);
    const s = summarize(a);
    if (s.percent !== a.percent || s.band !== a.band) fails(`${job.id}: card and endpoint differ`);
    if (!detailText(a, job).includes(`${a.percent}%`)) fails(`${job.id}: detail does not show ${a.percent}%`);
    if (a.blockers.length && !cardText(a, job).includes(a.blockers[0].message)) fails(`${job.id}: the card does not show the first warning`);
    const sources = [job.description, job.title, ...job.places.map((p) => p.text), job.remoteScope?.text ?? ''];
    const quotes: string[] = [
      ...a.mustHaves.map((m) => m.quote), ...a.skillDetail.map((c) => c.quote),
      ...a.blockers.map((x) => x.evidence?.text ?? '').filter(Boolean),
      ...Object.values(a.jobFacts).map((f) => f.quote ?? '').filter(Boolean),
    ];
    for (const qt of quotes) if (!sources.some((src) => src.includes(qt)) && !(job.skills ?? []).includes(qt)) fails(`${job.id}: quote not in the posting: "${qt}"`);
    for (const [name, part] of Object.entries(a.subScores)) if (!part.reasons.length) fails(`${job.id}: ${name} has no reason`);
    if (a.band === 'strong' && a.blockers.length) fails(`${job.id}: Strong band with a warning`);
  }
  process.stdout.write(`${jobs.length} jobs checked, ${failures} failure${failures === 1 ? '' : 's'}\n`);
  if (failures) process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = (args._ as string[])[0];
  switch (cmd) {
    case 'score': return cmdScore(args);
    case 'feed': return cmdFeed(args);
    case 'claim': return cmdClaim(args);
    case 'undo': return cmdUndo(args);
    case 'explain': return cmdExplain(args);
    case 'check': return cmdCheck(args);
    case 'stats': process.stdout.write(JSON.stringify(taxonomyStats(), null, 2) + '\n'); return;
    case 'serve': {
      const { startPreview } = await import('./serve.ts');
      const port = typeof args.port === 'string' ? Number(args.port) : 0;
      const srv = await startPreview({
        profilePath: resolve(need(args, 'profile')), jobPaths: [...(typeof args.jobs === 'string' ? [args.jobs] : []), ...(args._ as string[]).slice(1)].map((p) => resolve(p)),
        companiesPath: typeof args.companies === 'string' ? resolve(args.companies) : undefined, port, now: typeof args.now === 'string' ? nowOf(args) : undefined,
        config: configOf(args),
      });
      process.stdout.write(`jobleft match preview on ${srv.origin}\nOpen: ${srv.origin}/#token=${srv.token}\nAPI:  curl -H 'x-jobleft-token: ${srv.token}' ${srv.origin}/api/v1/match/<jobId>\nStop with Ctrl+C.\n`);
      return;
    }
    case undefined: case 'help': case '--help': process.stdout.write(HELP); return;
    default: fail(`unknown command "${cmd}" (see: help)`);
  }
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
