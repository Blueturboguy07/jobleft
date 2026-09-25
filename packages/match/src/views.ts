// Text views of one result: the card (percent, band, two chips, the first warning) and the detail (every part, every
// reason, every must-have with the posting's words, what the posting does not state, and the years counted).
// Both are drawn from the same MatchResult as the endpoint, so the numbers and the band are always the same.

import type { Job, MatchResult } from '@jobleft/contracts';
import { MATCH_BAND_LABELS } from '@jobleft/contracts';
import type { FullMatchResult } from './score.ts';

const pctText = (p: number | null) => (p === null ? 'not enough information' : `${p}%`);

function where(job: Job): string {
  const bits: string[] = [];
  if (job.places.length) bits.push(job.places.slice(0, 2).map((p) => p.text).join('; '));
  if (job.workModel) bits.push(job.workModel);
  return bits.join(' · ');
}

export function cardText(r: MatchResult, job: Job): string {
  const f = r as FullMatchResult;
  const lines: string[] = [];
  const band = MATCH_BAND_LABELS[r.band];
  lines.push(`${String(r.percent).padStart(3)}%  ${band}${f.complete === false ? '  (INCOMPLETE)' : ''}   ${job.title} · ${job.company}${where(job) ? ` · ${where(job)}` : ''}`);
  const chips = r.whyFit.slice(0, 2).map((c) => `${c.positive ? '✓' : '●'} ${c.label}`);
  if (chips.length) lines.push(`      ${chips.join('   ')}`);
  if (r.blockers.length) lines.push(`      ! ${r.blockers[0].message}${r.blockers.length > 1 ? ` (+${r.blockers.length - 1} more warning${r.blockers.length > 2 ? 's' : ''})` : ''}`);
  if (f.complete === false && f.unknownParts?.length) {
    const names = f.unknownParts.map((p) => (p === 'experienceLevel' ? 'Experience Level' : p === 'skills' ? 'Skills' : 'Industry Experience'));
    lines.push(`      Incomplete: not enough information for ${names.join(', ')}`);
  }
  return lines.join('\n');
}

export function detailText(r: MatchResult, job: Job): string {
  const f = r as FullMatchResult;
  const out: string[] = [];
  const h = (t: string) => { out.push(''); out.push(t); out.push('-'.repeat(Math.min(72, t.length))); };
  out.push(`${job.title} · ${job.company}${where(job) ? ` · ${where(job)}` : ''}`);
  out.push(`${r.percent}%  ${MATCH_BAND_LABELS[r.band]}${f.complete === false ? '  (INCOMPLETE: the percent counts only what could be judged)' : ''}`);
  out.push(`  Experience Level      ${pctText(r.subScores.experienceLevel.percent)}`);
  out.push(`  Skills                ${pctText(r.subScores.skills.percent)}`);
  out.push(`  Industry Experience   ${pctText(r.subScores.industryExperience.percent)}`);
  for (const reason of r.reasons) out.push(`  · ${reason.text}`);

  if (r.blockers.length) {
    h('Warnings');
    for (const b of r.blockers) out.push(`  ! ${b.message}`);
  }
  if (r.whyFit.length) {
    h('Why you fit (from the job data)');
    out.push('  ' + r.whyFit.map((c) => `${c.positive ? '✓' : '●'} ${c.label}`).join('   '));
  }
  const part = (title: string, s: MatchResult['subScores']['skills']) => {
    h(`${title}: ${pctText(s.percent)}`);
    for (const reason of s.reasons) out.push(`  - ${reason.text}`);
  };
  part('Experience Level', r.subScores.experienceLevel);
  part('Skills', r.subScores.skills);
  if (f.skillDetail?.length) {
    out.push('  Skills and credentials the posting names:');
    for (const c of f.skillDetail) {
      const mark = c.state === 'met' ? '✓' : c.state === 'missing' ? '✗' : '~';
      const why = c.state === 'met' ? `from ${c.heldFrom}` : c.state === 'related' ? `not in your profile; related: ${c.via} (half credit)` : c.state === 'implied' ? `not in your profile; your role "${c.via}" suggests it (half credit)` : 'not in your profile';
      out.push(`    ${mark} ${c.name} (${c.importance}) — posting: "${c.quote}" — ${why}`);
    }
  }
  part('Industry Experience', r.subScores.industryExperience);

  if (f.mustHaves?.length) {
    h('Must-haves the posting states');
    const label = { met: 'met', unmet: 'NOT MET', not_in_profile: 'not in your profile', in_progress: 'in progress', info: 'note' } as const;
    for (const m of f.mustHaves) out.push(`  [${label[m.state]}] ${m.requirement} (${m.importance}): ${m.message}`);
  }
  if (f.dealBreakers?.length) {
    h('Your firm preferences');
    const label = { ok: 'ok', broken: 'BROKEN', not_stated: 'not stated', not_in_profile: 'not in your profile' } as const;
    for (const d of f.dealBreakers) out.push(`  [${label[d.state]}] ${d.message}`);
  }
  if (f.jobFacts) {
    h('What the posting states');
    const names: Record<string, string> = { level: 'Level', years: 'Years of experience', pay: 'Pay', sponsorship: 'Visa sponsorship', industry: 'Industry', workModel: 'Work model', employmentType: 'Job type' };
    for (const [k, v] of Object.entries(f.jobFacts)) out.push(`  ${names[k].padEnd(20)} ${v.text}${v.quote && v.quote !== v.text ? `  — "${v.quote}"` : ''}`);
  }
  if (f.experience) {
    h(`Years of experience used: ${f.experience.text}`);
    for (const x of f.experience.rolesCounted) out.push(`  counted: ${x.title} at ${x.company}, ${x.from} to ${x.to} (${x.months} months)`);
    for (const x of f.experience.rolesNotCounted) out.push(`  not counted: ${x.title} at ${x.company} (${x.why})`);
    out.push('  Overlapping months are counted once. A current role counts up to this month.');
  }
  if (f.notes?.length) {
    h('Notes');
    for (const n of f.notes) out.push(`  ${n}`);
  }
  out.push('');
  out.push(`engine ${r.engineVersion} · profile ${r.profileVersion} · job ${r.jobId}`);
  return out.join('\n');
}
