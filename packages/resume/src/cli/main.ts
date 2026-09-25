#!/usr/bin/env node
// jobleft-resume: the resume pipeline from the command line. Every command reads and writes only the data folder
// ($JOBLEFT_HOME). See packages/resume/README.md for a walk-through.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { AiClient } from '@jobleft/ai-engine';
import { AiError } from '@jobleft/ai-engine';
import type { Job, Profile, ProfileInput, ResumeDocument } from '@jobleft/contracts';
import { atsCheck } from '../index.ts';
import { ResumeError } from '../errors.ts';
import { builtinSkillDictionary } from '../gaps.ts';
import { ResumeService } from '../service.ts';
import { snapshotOf } from '../sync.ts';
import { checkLetter, checkText, buildProfileFacts, jobContext } from '../truth.ts';
import { checkProviderUrl, HttpAiClient } from './ai-client.ts';
import { atsText, costLine, gapsText, importReportText, letterText, profileText, proposalText, resumeListText, resumeText } from './format.ts';
import {
  ensureHome, hasProfile, htmlToPlain, jobFromText, openDb, paths, readAi, readJobs, readProfile, resolveHome, saveJob, writeAi,
  writeProfile, type CliAiSettings, type Paths,
} from './store.ts';

const HELP = `jobleft-resume — resume import, truth-gated tailoring, cover letters, readability check, PDF and Word export.
Data folder: $JOBLEFT_HOME (or --home <dir>). Nothing is written anywhere else.

  import <file> [--adopt] [--replace]           Read a PDF, Word (.docx) or text resume; --adopt saves it as your profile
  profile show [--json]                          Show the profile (the only source of truth) with field paths
  profile adopt <resumeId> [--replace]           Save an import's proposed profile as your profile
  profile set <path> <value>                     Correct one field, e.g.  profile set work.0.startDate 2021-02
  profile add-skill <name> | remove-skill <name> Add or remove a skill in your own words
  profile put <file.json> | export [--out f]     Replace the profile from JSON, or write it out
  job add --file <posting.txt|.html> --title <t> --company <c> [--city "Austin, TX"] [--url <u>]
  job list | job show <jobId>
  resume list                                    Base resumes and their tailored versions
  resume create --name <n> [--title <target>]    A base resume from the profile
  resume show <id> [--json] | rename <id> <name> | set-title <id> <title> | primary <id>
  resume hide-skill <id> <skill>                 Leave a profile skill off this one resume
  resume delete <id> [--with-versions]
  gaps <resumeId> <jobId> [--json]               Key terms: on the resume / in profile only / not in profile
  tailor <resumeId> <jobId> [--ask "<request>"] [--no-ai] [--json]
  accept <proposalId> (--all | --change c1,c2 | --none)
  fit <resumeId>                                 Does it fit one page; what would be left out
  export <resumeId> --format pdf|docx --out <file>
  ats <resumeId> | ats-file <file.pdf>           Readability score and findings of the exported PDF
  letter create <jobId> <resumeId> [--no-ai] | list <jobId> | show <letterId>
  letter edit <letterId> (--ask "<request>" | --text-file <file>) [--no-ai]
  letter export <letterId> --format pdf|docx --out <file>
  check-text <file.txt> [--job <jobId>]          Run the truth gate on any text (as a cover letter)
  ai show | ai off | ai set --provider local|custom|publik --url <base url> --model <m> [--key-env VAR] [--timeout 120]
`;

interface Args { _: string[]; flags: Record<string, string | true> }

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && !['json', 'adopt', 'replace', 'no-ai', 'all', 'none', 'with-versions'].includes(k)) { out.flags[k] = next; i++; } else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

class UsageError extends Error {}

function flag(a: Args, k: string): string | null {
  const v = a.flags[k];
  return typeof v === 'string' ? v : null;
}
function need(a: Args, k: string): string {
  const v = flag(a, k);
  if (!v) throw new UsageError(`missing --${k}`);
  return v;
}
function pos(a: Args, i: number, what: string): string {
  const v = a._[i];
  if (!v) throw new UsageError(`missing ${what}`);
  return v;
}

function mimeFor(file: string): string {
  const f = file.toLowerCase();
  if (f.endsWith('.pdf')) return 'application/pdf';
  if (f.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (f.endsWith('.txt') || f.endsWith('.md')) return 'text/plain';
  return 'application/octet-stream';
}

function makeAi(s: CliAiSettings): { client: AiClient | null; http: HttpAiClient | null } {
  if (s.provider === 'none' || !s.baseUrl || !s.model) return { client: null, http: null };
  const key = s.keyEnv ? process.env[s.keyEnv] ?? null : null;
  const http = new HttpAiClient({ provider: s.provider, baseUrl: s.baseUrl, model: s.model, key, timeoutMs: s.timeoutSeconds * 1000 });
  return { client: http, http };
}

function adoptInto(p: Paths, proposed: ProfileInput, replace: boolean): { saved: boolean; message: string } {
  if (hasProfile(p) && !replace) {
    return { saved: false, message: 'You already have a profile (with any corrections you made). It was NOT replaced. Run "profile adopt <resumeId> --replace" to replace it with this import.' };
  }
  const existing = hasProfile(p) ? readProfile(p) : null;
  const next: ProfileInput = { ...structuredClone(proposed), ...(existing ? { preferences: existing.preferences, workAuthorization: existing.workAuthorization, eeo: existing.eeo } : {}) };
  writeProfile(p, next);
  return { saved: true, message: 'Saved as your profile. Correct any field with "profile set <path> <value>".' };
}

function setPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    const next = Array.isArray(cur) ? (cur as unknown[])[Number(k)] : cur[k];
    if (next === undefined || next === null || typeof next !== 'object') throw new UsageError(`no field at "${keys.slice(0, i + 1).join('.')}" (see "profile show" for paths)`);
    cur = next as Record<string, unknown>;
  }
  const last = keys[keys.length - 1]!;
  if (Array.isArray(cur)) {
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0 || idx > cur.length) throw new UsageError(`bad list index "${last}"`);
    (cur as unknown[])[idx] = value;
  } else {
    if (!(last in cur)) throw new UsageError(`no field "${last}" at "${path}" (see "profile show" for paths)`);
    cur[last] = value;
  }
}

function coerce(raw: string, path: string): unknown {
  if (raw === 'null') return null;
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (/\.years$|minAnnualPayUsd$/.test(path) && /^\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

async function run(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const cmd = a._[0];
  if (!cmd || cmd === 'help' || a.flags.help) { process.stdout.write(HELP); return 0; }
  const home = typeof a.flags.home === 'string' ? a.flags.home : resolveHome();
  const p = paths(home);
  ensureHome(p);
  const ai = readAi(p);
  const { client, http } = makeAi(ai);
  const db = openDb(p.db);
  const say = (s: string) => process.stdout.write(s + '\n');
  const json = (x: unknown) => process.stdout.write(JSON.stringify(x, null, 2) + '\n');
  const useAi = !a.flags['no-ai'];
  const svc = new ResumeService({
    db, filesDir: p.files, profile: () => readProfile(p), job: (id) => readJobs(p).find((j) => j.id === id) ?? null,
    ai: () => { if (!client) throw new AiError('no_provider', 'No AI provider is set up.'); return client; },
    skills: builtinSkillDictionary(),
  });
  const aiNote = () => { if (client && useAi) process.stderr.write(`Asking ${client.provider} (${client.model}); up to ${ai.timeoutSeconds} s. Press Ctrl-C to cancel.\n`); };
  const label = (resumeId: string) => (sectionId: string, itemId: string | null) => {
    const r = svc.get(resumeId);
    const s = r?.document.sections.find((x) => x.id === sectionId);
    const it = s?.items.find((i) => i.id === itemId);
    return [s?.title ?? sectionId, it ? [it.heading, it.subheading].filter(Boolean).join(', ') : null].filter(Boolean).join(' › ');
  };
  try {
    switch (cmd) {
      case 'import': {
        const file = pos(a, 1, 'a file');
        if (!existsSync(file)) throw new UsageError(`no such file: ${file}`);
        const bytes = new Uint8Array(readFileSync(file));
        let res;
        try {
          res = await svc.import(bytes, basename(file), mimeFor(file));
        } catch (e) {
          if (e instanceof ResumeError && (e.details as { report?: unknown } | null)?.report) {
            say(importReportText((e.details as { report: import('@jobleft/contracts').ImportReport }).report, basename(file)));
            say('Nothing was saved.');
            return 2;
          }
          throw e;
        }
        say(importReportText(res.resume.importReport!, basename(file)));
        say(`\nSaved as base resume ${res.resume.id} ("${res.resume.name}").`);
        say('\nProposed profile (check every field against your file):\n');
        say(profileText(res.proposedProfile));
        if (a.flags.adopt) {
          const r = adoptInto(p, res.proposedProfile, !!a.flags.replace);
          say(`\n${r.message}`);
          if (!r.saved) return 2;
        } else say(`\nTo save it as your profile: profile adopt ${res.resume.id}`);
        return 0;
      }
      case 'profile': {
        const sub = pos(a, 1, 'a profile command');
        if (sub === 'show') {
          if (!hasProfile(p)) { say('No profile yet. Import a resume with --adopt, or "profile put <file.json>".'); return 0; }
          const prof = readProfile(p);
          if (a.flags.json) json(prof); else say(profileText(prof));
          return 0;
        }
        if (sub === 'adopt') {
          const proposed = svc.proposedProfile(pos(a, 2, 'a resume id'));
          if (!proposed) throw new ResumeError('bad_request', 'That resume was not imported from a file, so it has no proposed profile.');
          const r = adoptInto(p, proposed, !!a.flags.replace);
          say(r.message);
          return r.saved ? 0 : 2;
        }
        if (sub === 'set') {
          const path = pos(a, 2, 'a field path');
          const raw = a._[3];
          if (raw === undefined) throw new UsageError('missing value');
          const prof = snapshotOf(readProfile(p));
          setPath(prof, path, coerce(raw, path));
          writeProfile(p, prof);
          say(`Saved ${path} = ${JSON.stringify(coerce(raw, path))}. It is used in every later resume and letter.`);
          return 0;
        }
        if (sub === 'add-skill' || sub === 'remove-skill') {
          const name = pos(a, 2, 'a skill');
          const prof = snapshotOf(readProfile(p));
          if (sub === 'add-skill') {
            if (!prof.skills.some((s) => s.name.toLowerCase() === name.toLowerCase())) prof.skills.push({ name, years: null, source: 'user' });
          } else {
            const before = prof.skills.length;
            prof.skills = prof.skills.filter((s) => s.name.toLowerCase() !== name.toLowerCase());
            if (prof.skills.length === before) { say(`"${name}" is not in your profile.`); return 2; }
          }
          writeProfile(p, prof);
          say(sub === 'add-skill' ? `Added "${name}" to your profile (in your words). Tailoring may now use it.` : `Removed "${name}" from your profile.`);
          return 0;
        }
        if (sub === 'put') {
          const file = pos(a, 2, 'a JSON file');
          writeProfile(p, JSON.parse(readFileSync(file, 'utf8')) as ProfileInput);
          say('Profile saved.');
          return 0;
        }
        if (sub === 'export') {
          const text = JSON.stringify(readProfile(p), null, 2) + '\n';
          const out = flag(a, 'out');
          if (out) { writeFileSync(out, text, { mode: 0o600 }); say(`Wrote ${out}`); } else process.stdout.write(text);
          return 0;
        }
        throw new UsageError(`unknown profile command "${sub}"`);
      }
      case 'job': {
        const sub = pos(a, 1, 'a job command');
        if (sub === 'add') {
          const file = need(a, 'file');
          const raw = readFileSync(file, 'utf8');
          const text = /\.html?$/i.test(file) || /<\/?[a-z][\s\S]*>/i.test(raw.slice(0, 2000)) ? htmlToPlain(raw) : raw;
          const job: Job = jobFromText({ title: need(a, 'title'), company: need(a, 'company'), text, city: flag(a, 'city'), url: flag(a, 'url') });
          saveJob(p, job);
          say(`Added job ${job.id}: ${job.title} at ${job.company}`);
          return 0;
        }
        if (sub === 'list') {
          const jobs = readJobs(p);
          if (!jobs.length) say('No jobs yet. Add one with "job add --file <posting.txt> --title <t> --company <c>".');
          for (const j of jobs) say(`${j.id}  ${j.title} — ${j.company}${j.places[0] ? ` (${j.places[0].text})` : ''}`);
          return 0;
        }
        if (sub === 'show') {
          const j = readJobs(p).find((x) => x.id === pos(a, 2, 'a job id'));
          if (!j) throw new ResumeError('not_found', 'No job with that id.');
          say(`${j.title} — ${j.company}\n\n${j.description}`);
          return 0;
        }
        throw new UsageError(`unknown job command "${sub}"`);
      }
      case 'resume': {
        const sub = pos(a, 1, 'a resume command');
        if (sub === 'list') {
          const list = svc.list();
          if (a.flags.json) json(list); else say(resumeListText(list, (r) => { const l = svc.jobLabel(r.id); return l ? `${l.title} at ${l.company}` : null; }));
          return 0;
        }
        if (sub === 'create') {
          const r = svc.create({ name: need(a, 'name'), ...(flag(a, 'title') ? { targetTitle: flag(a, 'title')! } : {}) });
          say(`Created base resume ${r.id} ("${r.name}")${r.targetTitle ? ` with target title "${r.targetTitle}"` : ''}.`);
          return 0;
        }
        if (sub === 'show') {
          const r = svc.get(pos(a, 2, 'a resume id'));
          if (!r) throw new ResumeError('not_found', 'No resume with that id.');
          if (a.flags.json) json(r); else say(resumeText(r));
          return 0;
        }
        if (sub === 'rename') { const r = svc.update(pos(a, 2, 'a resume id'), { name: pos(a, 3, 'a name') }); say(`Renamed to "${r.name}".`); return 0; }
        if (sub === 'set-title') { const r = svc.update(pos(a, 2, 'a resume id'), { targetTitle: a._[3] ?? null }); say(`Target title: ${r.targetTitle ?? '(none)'}`); return 0; }
        if (sub === 'primary') { svc.update(pos(a, 2, 'a resume id'), { isPrimary: true }); say('This is now the primary resume.'); return 0; }
        if (sub === 'hide-skill') {
          const id = pos(a, 2, 'a resume id');
          const skill = pos(a, 3, 'a skill');
          const r = svc.get(id);
          if (!r) throw new ResumeError('not_found', 'No resume with that id.');
          const doc: ResumeDocument = structuredClone(r.document);
          const sk = doc.sections.find((s) => s.kind === 'skills')?.items[0];
          if (!sk || !sk.tags.some((t) => t.toLowerCase() === skill.toLowerCase())) { say(`"${skill}" is not on this resume.`); return 2; }
          sk.tags = sk.tags.filter((t) => t.toLowerCase() !== skill.toLowerCase());
          svc.update(id, { document: doc });
          say(`"${skill}" is no longer on this resume (it stays in your profile).`);
          return 0;
        }
        if (sub === 'put-document') {
          const r = svc.update(pos(a, 2, 'a resume id'), { document: JSON.parse(readFileSync(pos(a, 3, 'a JSON file'), 'utf8')) as ResumeDocument });
          say(`Saved the document of ${r.id}.`);
          return 0;
        }
        if (sub === 'delete') {
          const deleted = svc.delete(pos(a, 2, 'a resume id'), !!a.flags['with-versions']);
          say(`Deleted: ${deleted.join(', ')}`);
          return 0;
        }
        throw new UsageError(`unknown resume command "${sub}"`);
      }
      case 'gaps': {
        const g = svc.keywordGaps(pos(a, 2, 'a job id'), pos(a, 1, 'a resume id'));
        if (a.flags.json) json(g); else say(gapsText(g));
        return 0;
      }
      case 'tailor': {
        const resumeId = pos(a, 1, 'a resume id');
        if (useAi) aiNote();
        const ask = flag(a, 'ask');
        const prop = await svc.tailor(resumeId, pos(a, 2, 'a job id'), { useAi, ...(ask ? { instruction: ask } : {}) });
        if (a.flags.json) { json(prop); return 0; }
        say(proposalText(prop, label(resumeId)));
        const c = costLine(prop.costMicros, prop.provider, http?.lastBalanceMicros ?? null);
        if (c && prop.provider !== 'none') say(`\n${c}`);
        say(`\nAccept with: accept ${prop.id} --all   (or --change ${prop.changes.slice(0, 2).map((x) => x.id).join(',') || 'c1'}, or --none)`);
        return 0;
      }
      case 'accept': {
        const pid = pos(a, 1, 'a proposal id');
        const found = svc.proposal(pid);
        if (!found) throw new ResumeError('not_found', 'No tailoring draft with that id.');
        const ids = a.flags.all ? found.proposal.changes.map((c) => c.id) : a.flags.none ? [] : (flag(a, 'change') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        if (!a.flags.all && !a.flags.none && !ids.length) throw new UsageError('give --all, --none or --change c1,c2');
        const v = svc.accept(found.proposal.resumeId, pid, ids);
        say(`Saved tailored version ${v.id} (version ${v.version} for job ${v.jobId}, from base ${v.baseResumeId}) with ${ids.length} change${ids.length === 1 ? '' : 's'}.`);
        return 0;
      }
      case 'fit': {
        const f = await svc.fitCheck(pos(a, 1, 'a resume id'));
        say(f.fitsOnePage ? 'It fits on one page; nothing is left out.' : `It does not fit on one page at the smallest print size. The one-page PDF and Word file leave out:\n${f.leftOut.map((x) => `  - ${x}`).join('\n')}`);
        return 0;
      }
      case 'export': {
        const format = need(a, 'format');
        if (format !== 'pdf' && format !== 'docx') throw new UsageError('--format must be pdf or docx');
        const f = await svc.export(pos(a, 1, 'a resume id'), format);
        const out = flag(a, 'out') ?? f.fileName;
        writeFileSync(out, f.bytes, { mode: 0o600 });
        say(`Wrote ${out} (${f.bytes.byteLength} bytes${format === 'pdf' ? ', 1 page' : ''}).`);
        if (f.leftOut.length) say(`To fit one page, these were left out (nothing else was cut):\n${f.leftOut.map((x) => `  - ${x}`).join('\n')}`);
        return 0;
      }
      case 'ats': {
        const r = await svc.atsCheck(pos(a, 1, 'a resume id'));
        if (a.flags.json) json(r); else say(atsText(r));
        return 0;
      }
      case 'ats-file': {
        const r = await atsCheck(new Uint8Array(readFileSync(pos(a, 1, 'a PDF file'))));
        if (a.flags.json) json(r); else say(atsText(r));
        return 0;
      }
      case 'letter': {
        const sub = pos(a, 1, 'a letter command');
        if (sub === 'create') {
          if (useAi) aiNote();
          const l = await svc.createCoverLetter(pos(a, 2, 'a job id'), pos(a, 3, 'a resume id'), { useAi });
          if (a.flags.json) json(l); else say(letterText(l, http?.lastBalanceMicros ?? null));
          return 0;
        }
        if (sub === 'list') {
          for (const l of svc.coverLetters(pos(a, 2, 'a job id'))) say(`${l.id}  ${l.ready ? 'ready' : 'NOT READY'}  resume ${l.resumeId}  updated ${l.updatedAt}`);
          return 0;
        }
        if (sub === 'show') {
          const l = svc.getCoverLetter(pos(a, 2, 'a letter id'));
          if (a.flags.json) json(l); else say(letterText(l, http?.lastBalanceMicros ?? null));
          return 0;
        }
        if (sub === 'edit') {
          const id = pos(a, 2, 'a letter id');
          const tf = flag(a, 'text-file');
          const ask = flag(a, 'ask');
          if (!tf && !ask) throw new UsageError('give --ask "<request>" or --text-file <file>');
          if (ask && useAi) aiNote();
          const l = await svc.updateCoverLetter(id, { ...(tf ? { text: readFileSync(tf, 'utf8') } : {}), ...(ask ? { instruction: ask } : {}) }, { useAi });
          if (a.flags.json) json(l); else say(letterText(l, http?.lastBalanceMicros ?? null));
          return 0;
        }
        if (sub === 'export') {
          const format = need(a, 'format');
          if (format !== 'pdf' && format !== 'docx') throw new UsageError('--format must be pdf or docx');
          const f = await svc.exportCoverLetter(pos(a, 2, 'a letter id'), format);
          const out = flag(a, 'out') ?? f.fileName;
          writeFileSync(out, f.bytes, { mode: 0o600 });
          say(`Wrote ${out} (${f.bytes.byteLength} bytes${format === 'pdf' ? ', 1 page' : ''}).`);
          return 0;
        }
        throw new UsageError(`unknown letter command "${sub}"`);
      }
      case 'check-text': {
        const text = readFileSync(pos(a, 1, 'a text file'), 'utf8');
        const jobId = flag(a, 'job');
        const job = jobId ? readJobs(p).find((j) => j.id === jobId) ?? null : null;
        const prof: Profile = readProfile(p);
        const v = /^\s*dear\b/im.test(text) ? checkLetter(text, prof, job) : checkText(text, 'text', buildProfileFacts(prof), jobContext(job), 'letter');
        if (!v.length) say('Every fact traces to your profile.');
        for (const x of v) say(`- ${x.kind} "${x.fact}" (${x.where}): ${x.reason}`);
        return v.length ? 2 : 0;
      }
      case 'ai': {
        const sub = pos(a, 1, 'an ai command');
        if (sub === 'show') { say(ai.provider === 'none' ? 'No AI provider: every step uses jobleft\'s rules (no AI).' : `Provider: ${ai.provider}  URL: ${ai.baseUrl}  model: ${ai.model}  key from: ${ai.keyEnv ?? '(no key)'}  time limit: ${ai.timeoutSeconds} s`); return 0; }
        if (sub === 'off') { writeAi(p, { provider: 'none', baseUrl: null, model: null, keyEnv: null, timeoutSeconds: 120 }); say('AI is off. Every step uses jobleft\'s rules.'); return 0; }
        if (sub === 'set') {
          const provider = need(a, 'provider');
          if (!['local', 'custom', 'publik'].includes(provider)) throw new UsageError('--provider must be local, custom or publik');
          const url = need(a, 'url');
          const problem = checkProviderUrl(provider as 'local', url);
          if (problem) throw new ResumeError('bad_request', problem);
          const timeout = Number(flag(a, 'timeout') ?? 120);
          writeAi(p, { provider: provider as CliAiSettings['provider'], baseUrl: url, model: need(a, 'model'), keyEnv: flag(a, 'key-env'), timeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? timeout : 120 });
          say(`AI provider set: ${provider} at ${url}. Resume text goes only to this provider, and only for tailoring and letters.`);
          return 0;
        }
        throw new UsageError(`unknown ai command "${sub}"`);
      }
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) { process.stderr.write(`${e.message}\n\n${HELP}`); return 1; }
    if (e instanceof ResumeError) {
      process.stderr.write(`${e.message}\n`);
      if (e.link) process.stderr.write(`Add to your balance: ${e.link}\n`);
      const d = e.details as { violations?: Array<{ kind: string; fact: string; where: string; reason: string }>; versions?: string[]; letters?: string[] } | null;
      if (d?.violations) for (const v of d.violations.slice(0, 10)) process.stderr.write(`  - ${v.kind} "${v.fact}" (${v.where}): ${v.reason}\n`);
      if (d?.versions?.length) process.stderr.write(`  versions: ${d.versions.join(', ')}\n`);
      if (d?.letters?.length) process.stderr.write(`  letters: ${d.letters.join(', ')}\n`);
      return 2;
    }
    if (e instanceof AiError) { process.stderr.write(`${e.message}\n`); return 2; }
    // Never print a stack trace or file content: one plain sentence.
    process.stderr.write(`Something went wrong: ${e instanceof Error ? e.message.split('\n')[0]!.slice(0, 200) : 'unknown error'}\n`);
    return 3;
  } finally {
    db.close();
  }
}

// A closed pipe (for example "| head") ends the program quietly, never with a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0); });
}

const code = await run(process.argv.slice(2));
process.exitCode = code;
