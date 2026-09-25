#!/usr/bin/env node
// Builds the starting board directory from JobSync's bundled company lists (MIT). No network.
//
//   node scripts/build-directory.ts --jobsync <path to a JobSync checkout> [--out data/board-directory.json]
//
// It reads src/lib/scraper/{greenhouse,lever,ashby}/companies.json ({ name, token, host? }), normalises each row to
// { ats, slug, name, region, source, lastVerified, status }, drops blank names, bad tokens, forbidden hosts and
// duplicates (and prints each drop), and writes the file with a header that names the source and its licence.
// Every row starts as "unverified"; `jobleft-boards directory refresh` checks rows against their providers.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DIRECTORY_FORMAT, BUNDLED_DIRECTORY_PATH, parseDirectoryFile, type DirectoryFile, type DirectoryFileRow } from '../src/directory.ts';
import { directoryJson, writeJsonAtomic } from '../src/refresh.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const jobsync = arg('jobsync');
if (!jobsync) { console.error('usage: node scripts/build-directory.ts --jobsync <JobSync checkout> [--out <file>]'); process.exit(2); }
const out = resolve(arg('out') ?? BUNDLED_DIRECTORY_PATH);
const root = resolve(jobsync);
const licence = readFileSync(join(root, 'LICENSE'), 'utf8');
if (!/MIT License/.test(licence)) { console.error('The JobSync checkout does not carry the MIT licence; refusing to build from it.'); process.exit(1); }
let commit = 'unknown';
try { commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
const copyright = /Copyright \(c\) [^\n]+/.exec(licence)?.[0] ?? null;

const rows: DirectoryFileRow[] = [];
for (const ats of ['greenhouse', 'lever', 'ashby'] as const) {
  const p = join(root, 'src', 'lib', 'scraper', ats, 'companies.json');
  if (!existsSync(p)) { console.error(`missing ${p}`); process.exit(1); }
  const list = JSON.parse(readFileSync(p, 'utf8')) as Array<{ name?: string; token?: string; host?: string }>;
  for (const r of list) {
    rows.push({
      ats, slug: String(r.token ?? '').trim().toLowerCase(), name: String(r.name ?? '').trim(),
      region: ats === 'lever' && r.host === 'eu' ? 'eu' : null, source: 'jobsync', lastVerified: null, status: 'unverified',
    });
  }
}

const file: DirectoryFile = {
  format: DIRECTORY_FORMAT,
  version: new Date().toISOString().slice(0, 10) + '.0',
  generatedAt: new Date().toISOString(),
  notice: [
    'jobleft board directory. Each row names one employer\'s public job board: the provider (ats), the board token (slug),',
    'the employer name, the region, the source of the row, the date jobleft last checked the board (lastVerified) and',
    'what that check saw (status: live, suspect = answered "not found" once, unverified = not checked yet).',
    'Every source is named in "sources" with its licence and a public page. No row comes from a source whose licence',
    'forbids commercial use. Employer names of checked Greenhouse rows are the names the boards report in their own',
    'public API. A row is removed only after two "not found" answers at different times; data/board-directory-pruned.json',
    'lists every removed row with both dates.',
    'The job boards and their postings belong to the providers and the employers; jobleft reads only their public job feeds.',
  ].join(' '),
  sources: [{
    id: 'jobsync',
    name: 'JobSync bundled company board lists (src/lib/scraper/greenhouse, lever and ashby companies.json)',
    url: 'https://github.com/Gsync/jobsync',
    licence: 'MIT',
    licenceUrl: `https://github.com/Gsync/jobsync/blob/${commit}/LICENSE`,
    commit,
    copyright,
    note: 'The upstream repository does not say how the lists were made. Each row is checked against the provider\'s public API before jobleft treats it as live.',
    rows: rows.length,
  }],
  counts: {},
  rows,
};

// Parse through the same checks the app uses; print every refused row.
const { entries, refused } = parseDirectoryFile(file);
for (const r of refused) console.error(`refused row ${r.row}: ${r.reason}`);
file.rows = entries.map((e) => ({ ats: e.ats, slug: e.board, name: e.company, region: e.region, source: e.source, lastVerified: null, status: 'unverified' }));
file.sources[0]!.rows = file.rows.length;
const counts: Record<string, number> = { total: file.rows.length };
for (const r of file.rows) counts[r.ats] = (counts[r.ats] ?? 0) + 1;
counts.status_unverified = file.rows.length;
file.counts = counts;
writeJsonAtomic(out, file);
console.log(`wrote ${out}: ${file.rows.length} rows (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}), ${refused.length} refused`);
void directoryJson;
