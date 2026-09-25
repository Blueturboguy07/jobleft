// Probe match/ranking-pairs (serves match O3; store O3): do strong fits rank above weak fits, in tech and non-tech
// jobs alike? For each job family, one test profile and 16 postings labelled strong / possible / poor BEFORE any
// score was seen (one labeller: the match lane; see README.md for the limits of that).
// Pass marks per family (from docs/outcomes/match.md, O3):
//   (a) every strong-fit job ranks above every poor-fit job in "Top Matched" order;
//   (b) at least 80% of strong-fit jobs are in the Strong or Good band;
//   (c) no poor-fit job is in the Strong band.
// Offline and deterministic: fixed date, local files, no AI.
//
//   node evals/match/ranking-pairs/run.ts            summary per family, then one JSON line
//   node evals/match/ranking-pairs/run.ts --verbose  every job with its label, percent and band

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankTopMatched, scoreMatch } from '../../../packages/match/src/index.ts';
import { readJobs, readProfile } from '../../../packages/match/src/io.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, 'data');
const verbose = process.argv.includes('--verbose');
const NOW = Date.parse('2026-09-25T12:00:00Z');

type Label = 'strong' | 'possible' | 'poor';
const families = readdirSync(dataDir).filter((f) => !f.startsWith('.')).sort();
let passAll = true;
let n = 0;
const report: unknown[] = [];
for (const fam of families) {
  const dir = join(dataDir, fam);
  const profile = readProfile(join(dir, 'profile.json'));
  const labels = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8')) as Record<string, Label>;
  const jobs = readJobs([join(dir, 'jobs')]);
  const scored = jobs.map((job) => ({ job, match: scoreMatch({ profile, job, company: null, now: NOW }) }));
  const ranked = rankTopMatched(scored);
  const rows = ranked.map((x, i) => {
    const file = x.job.id.replace(/^file:/, '') + '.txt';
    return { rank: i + 1, file, label: labels[file], percent: x.match.percent, band: x.match.band, complete: x.match.complete, E: x.match.subScores.experienceLevel.percent, S: x.match.subScores.skills.percent, I: x.match.subScores.industryExperience.percent, blockers: x.match.blockers.length };
  });
  for (const r of rows) if (!r.label) throw new Error(`${fam}: no label for ${r.file}`);
  const strong = rows.filter((r) => r.label === 'strong');
  const poor = rows.filter((r) => r.label === 'poor');
  const lowestStrong = Math.max(...strong.map((r) => r.rank));
  const highestPoor = Math.min(...poor.map((r) => r.rank));
  const a = lowestStrong < highestPoor;
  const bShare = strong.filter((r) => r.band === 'strong' || r.band === 'good').length / strong.length;
  const b = bShare >= 0.8;
  const c = poor.every((r) => r.band !== 'strong');
  const ok = a && b && c;
  passAll &&= ok;
  n += rows.length;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${fam.padEnd(12)} (a) strong above poor: ${a ? 'yes' : 'NO'}   (b) strong fits in Strong/Good: ${Math.round(bShare * 100)}%   (c) no poor fit in Strong: ${c ? 'yes' : 'NO'}`);
  if (verbose || !ok) {
    for (const r of rows) console.log(`    ${String(r.rank).padStart(2)}. ${r.label.padEnd(8)} ${String(r.percent).padStart(3)}% ${r.band.padEnd(6)} ${r.complete ? ' ' : 'i'} E${r.E ?? '-'} S${r.S ?? '-'} I${r.I ?? '-'} ${r.blockers ? `!${r.blockers}` : '  '} ${r.file}`);
  }
  report.push({ family: fam, a, b: bShare, c, rows });
}
mkdirSync(join(here, 'out'), { recursive: true });
writeFileSync(join(here, 'out', 'last-run.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ probe: 'match/ranking-pairs', n, score: report.filter((r) => (r as { a: boolean; b: number; c: boolean }).a && (r as { b: number }).b >= 0.8 && (r as { c: boolean }).c).length / families.length, pass: passAll, bar: 'every family: strong above poor, >=80% of strong fits Strong/Good, no poor fit Strong' }));
if (!passAll) process.exitCode = 1;
