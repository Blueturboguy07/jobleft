// Plain-text views for the resume CLI: import reports, the profile, change reviews with word-level before/after,
// keyword gaps, letters and readability reports.

import type { AtsReport, CoverLetter, ImportReport, KeywordGapReport, Profile, ProfileInput, Resume, TailorProposal } from '@jobleft/contracts';
import { dateRange, documentText } from '../document.ts';

export function dollars(micros: number): string {
  const d = micros / 1e6;
  if (micros > 0 && d < 0.01) return `$${d.toFixed(4)}`;
  return `$${d.toFixed(2)}`;
}

export function costLine(costMicros: number | null | undefined, provider: string, balanceMicros: number | null): string | null {
  if (!provider.startsWith('publik')) return null;
  const cost = costMicros ?? 0;
  const bal = balanceMicros === null ? '' : ` Balance left: ${dollars(balanceMicros)}.`;
  return `Cost of this step: ${dollars(cost)} from your publik balance.${bal}`;
}

export function importReportText(r: ImportReport, file: string): string {
  const L: string[] = [];
  const word = r.outcome === 'ok' ? 'Read in full' : r.outcome === 'partial' ? 'Read, with parts to check' : 'Could not be read';
  L.push(`${word}: ${file}`);
  if (r.outcome !== 'failed') {
    L.push(`  Jobs: ${r.counts.jobs}   Bullets: ${r.counts.bullets}   Skills: ${r.counts.skills}   Degrees: ${r.counts.education}`);
  }
  if (r.unreadSections.length) L.push(`  Sections not read into profile fields (kept word for word): ${r.unreadSections.join(', ')}`);
  for (const w of r.warnings) L.push(`  ! ${w}`);
  return L.join('\n');
}

export function profileText(p: Profile | ProfileInput): string {
  const L: string[] = [];
  const pe = p.personal;
  const name = [pe.firstName, pe.middleName, pe.lastName].filter(Boolean).join(' ');
  L.push(`Name:      ${name || '(not set)'}        [personal.firstName, personal.middleName, personal.lastName]`);
  L.push(`Email:     ${pe.email ?? '(not set)'}        [personal.email]`);
  L.push(`Phone:     ${pe.phone ?? '(not set)'}        [personal.phone]`);
  L.push(`City:      ${[pe.city, pe.region].filter(Boolean).join(', ') || '(not set)'}        [personal.city, personal.region]`);
  pe.links.forEach((l, i) => L.push(`Link ${i}:    ${l.url}        [personal.links.${i}.url]`));
  if (p.summary) L.push(`Summary:   ${p.summary}        [summary]`);
  L.push('', 'Work:');
  p.work.forEach((w, i) => {
    L.push(`  work.${i}  ${w.title} — ${w.company} | ${dateRange({ startDate: w.startDate, endDate: w.endDate, current: w.current })}${w.location ? ` | ${w.location}` : ''}`);
    L.push(`          [work.${i}.title, .company, .startDate=${w.startDate ?? 'null'}, .endDate=${w.endDate ?? 'null'}, .current=${w.current}, .location]`);
    w.bullets.forEach((b, j) => L.push(`    work.${i}.bullets.${j}: ${b}`));
  });
  L.push('', 'Education:');
  p.education.forEach((e, i) => {
    L.push(`  education.${i}  ${[e.degree, e.major].filter(Boolean).join(' in ')} — ${e.school} | ${dateRange({ startDate: e.startDate, endDate: e.endDate, current: e.current })}${e.gpa ? ` | GPA ${e.gpa}` : ''}`);
    e.achievements.forEach((a, j) => L.push(`    education.${i}.achievements.${j}: ${a}`));
  });
  L.push('', `Skills (${p.skills.length}): ${p.skills.map((s, i) => `${s.name} [${i}]`).join(', ')}`);
  if (p.projects.length) {
    L.push('', 'Projects:');
    p.projects.forEach((pr, i) => {
      L.push(`  projects.${i}  ${pr.name}${pr.description ? ` — ${pr.description}` : ''}${pr.url ? ` | ${pr.url}` : ''}`);
      pr.bullets.forEach((b, j) => L.push(`    projects.${i}.bullets.${j}: ${b}`));
    });
  }
  if (p.certifications.length) {
    L.push('', 'Certifications:');
    p.certifications.forEach((c, i) => L.push(`  certifications.${i}  ${c.name}${c.issuer ? ` — ${c.issuer}` : ''}${c.date ? ` | ${c.date}` : ''}`));
  }
  for (const [i, x] of (p.extraSections ?? []).entries()) {
    L.push('', `${x.title} (kept as written):  [extraSections.${i}]`);
    x.lines.forEach((l, j) => L.push(`    extraSections.${i}.lines.${j}: ${l}`));
  }
  return L.join('\n');
}

/** Word-level diff: removed words in [-...-], added words in {+...+}, so a changed number is never hidden. */
export function wordDiff(a: string, b: string): string {
  const A = a.split(/\s+/).filter(Boolean);
  const B = b.split(/\s+/).filter(Boolean);
  const dp: number[][] = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  const del: string[] = [];
  const ins: string[] = [];
  const flush = () => { if (del.length) out.push(`[-${del.join(' ')}-]`); if (ins.length) out.push(`{+${ins.join(' ')}+}`); del.length = 0; ins.length = 0; };
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { flush(); out.push(A[i]!); i++; j++; }
    else if (j < B.length && (i >= A.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) ins.push(B[j++]!);
    else del.push(A[i++]!);
  }
  flush();
  return out.join(' ');
}

export function proposalText(p: TailorProposal, labels: (sectionId: string, itemId: string | null) => string): string {
  const L: string[] = [];
  L.push(`Tailoring draft ${p.id} (made by: ${p.provider === 'none' ? 'jobleft rules, no AI' : p.provider})`);
  L.push('Nothing is saved until you accept changes. Your base resume and your profile do not change.');
  if (p.notice) L.push('', `NOTE: ${p.notice}`);
  L.push('', p.changes.length ? `Changes (${p.changes.length}):` : 'No changes to propose.');
  for (const c of p.changes) {
    const where = labels(c.sectionId, c.itemId);
    if (c.field === 'skills.add') {
      L.push(`  [${c.id}] ${where}: add "${c.after}" (it is in your profile, the job asks for it)`);
    } else if (c.field === 'skills.order' || c.field === 'bullets.order') {
      L.push(`  [${c.id}] ${where}: new order (job terms first)`);
      L.push(`        before: ${c.before.split('\n').join(' / ')}`);
      L.push(`        after:  ${c.after.split('\n').join(' / ')}`);
    } else {
      L.push(`  [${c.id}] ${where}: ${c.field === 'summary' ? 'reworded summary' : 'reworded bullet'}`);
      L.push(`        before: ${c.before}`);
      L.push(`        after:  ${c.after}`);
      L.push(`        diff:   ${wordDiff(c.before, c.after)}`);
    }
    if (c.warning) L.push(`        WARNING: ${c.warning}`);
  }
  if (p.gaps.length) L.push('', `Gaps (the job asks for these; they are not in your profile, so they are never added): ${p.gaps.join('; ')}`);
  if (p.refused?.length) L.push(`Refused requests (not in your profile): ${p.refused.join(', ')}`);
  if (p.violations.length) {
    L.push('', `AI suggestions rejected by the truth gate (${p.violations.length}):`);
    for (const v of p.violations) L.push(`  - ${v.kind} "${v.fact}" in ${v.where}: ${v.reason}`);
  }
  return L.join('\n');
}

export function gapsText(g: KeywordGapReport): string {
  if (!g.requirementsFound) return 'jobleft could not read the requirements of this posting (no key terms found). This is not "no gaps".';
  const groups: Record<string, string[]> = { covered: [], in_profile_not_resume: [], not_in_profile: [] };
  for (const t of g.terms) groups[t.status]!.push(t.matchedAs && t.matchedAs.toLowerCase() !== t.term.toLowerCase() ? `${t.term} (as "${t.matchedAs}")` : t.term);
  return [
    `Key terms of the job: ${g.terms.length}`,
    `  On this resume (${groups.covered!.length}): ${groups.covered!.join(', ') || '-'}`,
    `  In your profile but not on this resume (${groups.in_profile_not_resume!.length}) — tailoring can add these: ${groups.in_profile_not_resume!.join(', ') || '-'}`,
    `  Not in your profile (${groups.not_in_profile!.length}) — never added: ${groups.not_in_profile!.join(', ') || '-'}`,
  ].join('\n');
}

export function resumeListText(list: Resume[], jobLabel: (r: Resume) => string | null): string {
  if (!list.length) return 'No resumes yet. Import one ("import <file>") or create one from your profile ("resume create --name ...").';
  const L: string[] = [];
  for (const r of list) {
    if (r.kind === 'base') {
      L.push(`${r.isPrimary ? '*' : ' '} ${r.id}  ${r.name}${r.targetTitle ? `  (target: ${r.targetTitle})` : ''}  base, updated ${r.updatedAt.slice(0, 10)}`);
    } else {
      L.push(`    └ ${r.id}  version ${r.version} for job ${r.jobId}${jobLabel(r) ? ` — ${jobLabel(r)}` : ''}  (from ${r.baseResumeId}, ${r.createdAt.slice(0, 16).replace('T', ' ')})`);
    }
  }
  L.push('', '* = primary');
  return L.join('\n');
}

export function resumeText(r: Resume): string {
  return `${r.name} (${r.kind}${r.kind === 'tailored' ? ` of ${r.baseResumeId} for job ${r.jobId}, version ${r.version}` : ''})\n\n${documentText(r.document)}`;
}

export function letterText(l: CoverLetter, balance: number | null): string {
  const L: string[] = [];
  L.push(`Cover letter ${l.id} for job ${l.jobId} (resume ${l.resumeId}) — ${l.ready ? 'ready' : 'NOT READY'} — written by: ${l.provider === 'none' ? 'jobleft rules, no AI' : l.provider}`);
  if (l.notice) L.push(`NOTE: ${l.notice}`);
  if (l.violations.length) for (const v of l.violations) L.push(`  ! ${v.kind} "${v.fact}" (${v.where}): ${v.reason}`);
  if (l.gaps?.length) L.push(`Gaps (not in your profile, never written): ${l.gaps.join('; ')}`);
  const c = costLine(l.costMicros, l.provider ?? 'none', balance);
  if (c && l.costMicros !== null) L.push(c);
  L.push('', l.text);
  return L.join('\n');
}

export function atsText(r: AtsReport): string {
  const L = [`Readability: ${r.score}/100 (grade ${r.grade})   file sha256 ${r.fileSha256.slice(0, 16)}…`];
  if (!r.findings.length) L.push('No problems found.');
  for (const f of r.findings) L.push(`  [${f.severity}] ${f.rule}: ${f.message}\n      evidence: ${f.evidence}`);
  return L.join('\n');
}
