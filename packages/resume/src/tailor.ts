// Tailoring (resume O3, O4, O6, O7): small, reviewable changes to a base resume for one job, never a free rewrite.
//   * without AI: add skills the profile has and the job names, and put the job's terms first (skills, bullets);
//   * with AI: also reworded bullets and summary. Every AI change passes the truth gate or is rejected and listed;
//     a reworded bullet may not carry a number that its original does not have.
// Nothing is saved here: the caller stores the proposal and saves a version only for the changes the person accepts.

import type { Job, Profile, ResumeDocument, ResumeItem, TailorProposal, TruthViolation } from '@jobleft/contracts';
import { nowIso } from '@jobleft/contracts';
import type { AiClient } from '@jobleft/ai-engine';
import type { SkillDictionary } from '@jobleft/static-data';
import { aiComplete, aiLabel, jobBlock, TRUTH_RULES } from './ai.ts';
import { dateRange, degreeLine } from './document.ts';
import { ResumeError } from './errors.ts';
import { canonicalSkill, findSkills, scanFacts } from './facts.ts';
import { jobTerms, keywordGaps, safeDictionary } from './gaps.ts';
import { buildProfileFacts, checkText, jobContext, refusedFacts, sameYm, workYears, type ProfileFacts } from './truth.ts';
import { foldKey, orgKey, similarity, stableId, termRegExp } from './text.ts';
import { REWORD_WORDS } from './lexicon.ts';

export type TailorOp =
  | { changeId: string; type: 'skills.add'; value: string }
  | { changeId: string; type: 'skills.order'; order: string[] }
  | { changeId: string; type: 'bullets.order'; sectionId: string; itemId: string; order: number[] }
  | { changeId: string; type: 'bullet'; sectionId: string; itemId: string; index: number; text: string }
  | { changeId: string; type: 'summary'; sectionId: string; text: string }
  /** The profile's corrected facts for one job or school entry (dates, title, name), offered as a change (resume O1). */
  | { changeId: string; type: 'item'; sectionId: string; itemId: string; set: Partial<Pick<ResumeItem, 'heading' | 'subheading' | 'startDate' | 'endDate' | 'current'>> }
  /** The profile's own spelling of a skill the resume names ("PostgreSQL" -> "Postgres"). */
  | { changeId: string; type: 'skills.rename'; from: string; to: string };

export interface TailorDraft { proposal: TailorProposal; ops: TailorOp[] }

export interface TailorInput {
  profile: Profile;
  job: Job;
  base: ResumeDocument;
  resumeId: string;
  skills: SkillDictionary | null;
  ai: AiClient | null;
  instruction?: string | null;
  proposalId?: string;
}

function relevanceTerms(job: Job, skills: SkillDictionary | null): Array<{ text: string; cs: boolean }> {
  const out: Array<{ text: string; cs: boolean }> = [];
  for (const t of jobTerms(job, safeDictionary(skills))) for (const f of t.forms) out.push({ text: f.text, cs: f.caseSensitive });
  return out;
}

function score(text: string, terms: Array<{ text: string; cs: boolean }>): number {
  let s = 0;
  for (const t of terms) if (termRegExp(t.text, t.cs, 'g').test(text)) s++;
  return s;
}

function stableOrder<T>(xs: T[], key: (x: T) => number): number[] {
  return xs.map((x, i) => ({ i, k: key(x) })).sort((a, b) => b.k - a.k || a.i - b.i).map((x) => x.i);
}

function skillsItem(doc: ResumeDocument): { sectionIndex: number; item: ResumeItem } | null {
  const si = doc.sections.findIndex((s) => s.kind === 'skills');
  if (si < 0) return null;
  const item = doc.sections[si]!.items[0];
  return item ? { sectionIndex: si, item } : null;
}

/** Which profile wording names this skill ("Postgres" in the profile for the job's "PostgreSQL"). */
function profileWording(profile: Profile, term: string, forms: Array<{ text: string; caseSensitive: boolean }>): string {
  for (const s of profile.skills) {
    const c = canonicalSkill(s.name);
    if ((c ?? s.name).toLowerCase() === term.toLowerCase()) return s.name;
  }
  for (const s of profile.skills) for (const f of forms) if (termRegExp(f.text, f.caseSensitive, 'g').test(s.name)) return s.name;
  return term;
}

function warnFor(before: string, after: string): string | null {
  const b = scanFacts(before);
  const a = scanFacts(after);
  const lost = [...b.numbers, ...b.dates, ...b.durations].map((m) => m.text).filter((t) => !after.includes(t));
  if (lost.length) return `Removes ${lost.join(', ')} from this line. Check that it still says what you did.`;
  const newSkills = a.skills.filter((m) => !b.skills.some((x) => x.key === m.key)).map((m) => m.text);
  if (newSkills.length) return `Adds ${newSkills.join(', ')} to this line. They are in your profile; check that you used them here.`;
  const had = new Set(foldKey(before).split(' ').map((w) => w.replace(/s$/, '')));
  const added = [...new Set(foldKey(after).split(' ').filter((w) => w.length > 2 && !/^\d/.test(w) && !had.has(w.replace(/s$/, '')) && !REWORD_WORDS.has(w)))];
  if (added.length) return `Adds words that are not in your original line (${added.slice(0, 5).join(', ')}). Check that the claim is still true.`;
  if (similarity(before, after) < 0.35) return 'This rewrite changes the wording a lot. Check that it makes the same claim as your original.';
  return null;
}

/** Numbers in a reworded bullet must be numbers of the original bullet (not borrowed from another line). */
function numbersKept(before: string, after: string): TruthViolation[] {
  const had = new Map<string, number>();
  for (const m of scanFacts(before).numbers) had.set(m.key, (had.get(m.key) ?? 0) + 1);
  const out: TruthViolation[] = [];
  for (const m of scanFacts(after).numbers) {
    const n = had.get(m.key) ?? 0;
    if (n > 0) { had.set(m.key, n - 1); continue; }
    out.push({ fact: m.text, kind: 'number', where: 'reworded bullet', reason: 'This number is not in the original bullet.' });
  }
  return out;
}

interface BulletRef { id: string; sectionId: string; itemId: string; index: number; text: string; entry: string }

function parseRewrites(text: string, ids: Set<string>): Map<string, string> | 'none' | null {
  const out = new Map<string, string>();
  const t = text.trim();
  if (/^none\.?$/i.test(t)) return 'none';
  const json = /\{[\s\S]*\}/.exec(t);
  if (json) {
    try {
      const obj = JSON.parse(json[0]) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) if (ids.has(k.toUpperCase()) && typeof v === 'string' && v.trim()) out.set(k.toUpperCase(), v.trim());
      if (out.size) return out;
    } catch { /* not JSON: read lines */ }
  }
  for (const line of t.split('\n')) {
    const m = /^\s*(?:[-*•]\s*)?\**\s*(B\d{1,3}|SUMMARY)\s*\**\s*[:.)\-–]\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const id = m[1]!.toUpperCase();
    if (id === 'SUMMARY' || ids.has(id)) out.set(id, m[2]!.replace(/^["“]|["”]$/g, '').trim());
  }
  if (out.size) return out;
  return /\bnone\b/i.test(t) && t.length < 80 ? 'none' : null;
}

function profileBlock(p: Profile): string {
  const L: string[] = ['<profile>'];
  if (p.summary) L.push(`Summary: ${p.summary}`);
  for (const w of p.work) {
    L.push(`Job: ${w.title} at ${w.company} (${dateRange({ startDate: w.startDate, endDate: w.endDate, current: w.current })})`);
    for (const b of w.bullets) L.push(`  - ${b}`);
  }
  for (const e of p.education) L.push(`Education: ${[e.degree, e.major].filter(Boolean).join(' in ')}, ${e.school}`);
  for (const pr of p.projects) L.push(`Project: ${pr.name}${pr.description ? ` - ${pr.description}` : ''}${pr.bullets.length ? ` (${pr.bullets.join(' ')})` : ''}`);
  for (const c of p.certifications) L.push(`Certification: ${c.name}`);
  if (p.skills.length) L.push(`Skills: ${p.skills.map((s) => s.name).join(', ')}`);
  L.push('</profile>');
  return L.join('\n');
}

/** "Junior Developer, Contoso Example Corp · Jan 2021 – May 2023" (how an entry reads in a change). */
function entryLine(it: Pick<ResumeItem, 'heading' | 'subheading' | 'startDate' | 'endDate' | 'current'>): string {
  return [[it.subheading, it.heading].filter(Boolean).join(', '), dateRange(it)].filter(Boolean).join(' · ');
}

/**
 * The fields of a resume entry that the profile holds in another (corrected) form: dates of the same job or school,
 * and, for an entry the profile adopted from this resume (same id), its title and name. null = nothing to correct.
 * Leaving a date out is never corrected; an entry the profile does not have is never touched.
 */
function correctionFor(kind: 'experience' | 'education', it: ResumeItem, p: Profile): Extract<TailorOp, { type: 'item' }>['set'] | null {
  const set: Extract<TailorOp, { type: 'item' }>['set'] = {};
  const dates = (start: string | null, end: string | null, current: boolean) => {
    if (!sameYm(it.startDate, start) && start) set.startDate = start;
    if (it.current !== current) { set.current = current; set.endDate = current ? null : end; }
    else if (!current && !sameYm(it.endDate, end) && end) set.endDate = end;
  };
  if (kind === 'experience') {
    const byId = p.work.find((w) => w.id === it.id);
    const w = byId ?? p.work.find((x) => it.heading !== null && orgKey(x.company) === orgKey(it.heading) && (it.subheading === null || foldKey(x.title) === foldKey(it.subheading)));
    if (!w) return null;
    if (byId && it.heading !== null && orgKey(it.heading) !== orgKey(w.company)) set.heading = w.company;
    if (byId && it.subheading !== null && foldKey(it.subheading) !== foldKey(w.title)) set.subheading = w.title;
    dates(w.startDate, w.endDate, w.current);
  } else {
    const byId = p.education.find((e) => e.id === it.id);
    const e = byId ?? p.education.find((x) => it.heading !== null && orgKey(x.school) === orgKey(it.heading));
    if (!e) return null;
    if (byId && it.heading !== null && orgKey(it.heading) !== orgKey(e.school)) set.heading = e.school;
    const deg = degreeLine(e.degree, e.major);
    if (byId && it.subheading !== null && deg && foldKey(it.subheading) !== foldKey(deg)) set.subheading = deg;
    dates(e.startDate, e.endDate, e.current);
  }
  return Object.keys(set).length ? set : null;
}

/** The profile's own spelling of a skill the resume names in another form, or null. */
function profileSpelling(tag: string, p: Profile): string | null {
  if (p.skills.some((s) => foldKey(s.name) === foldKey(tag))) return null;
  const c = canonicalSkill(tag);
  if (!c) return null;
  return p.skills.find((s) => (canonicalSkill(s.name) ?? s.name).toLowerCase() === c.toLowerCase())?.name ?? null;
}

/** Facts of the profile plus one line of the person's own resume (a reworded line may keep that line's facts). */
function withLine(profile: Profile, line: string): ProfileFacts {
  return buildProfileFacts({ ...profile, extraSections: [...(profile.extraSections ?? []), { id: 'tailor-line', title: '', lines: [line] }] });
}

export async function draftTailoring(input: TailorInput): Promise<TailorDraft> {
  const { profile, job, base } = input;
  const pf = buildProfileFacts(profile);
  // The base is the person's own document: an upload or their own edits may hold facts the profile does not have yet.
  // Tailoring keeps those lines as the person wrote them and adds nothing to them; every change below uses profile
  // facts only (an AI rewrite of a line may also keep that line's own facts, never borrow another's).
  const ops: TailorOp[] = [];
  const changes: TailorProposal['changes'] = [];
  const proposalId = input.proposalId ?? stableId('tp-', input.resumeId, job.id, nowIso(), String(Math.random()));
  let n = 0;
  const cid = () => `c${++n}`;
  const dict = safeDictionary(input.skills);
  const gaps = keywordGaps(job, base, profile, dict, input.resumeId);
  const terms = relevanceTerms(job, input.skills);

  // 0. Where this resume states a job, a school or a skill that the profile holds in corrected form, the profile's
  //    version, as changes the person accepts or not (resume O1: a correction appears in later outputs).
  for (const s of base.sections) {
    if (s.kind !== 'experience' && s.kind !== 'education') continue;
    for (const it of s.items) {
      const set = correctionFor(s.kind, it, profile);
      if (!set) continue;
      const id = cid();
      ops.push({ changeId: id, type: 'item', sectionId: s.id, itemId: it.id, set });
      changes.push({ id, sectionId: s.id, itemId: it.id, field: 'item', before: entryLine(it), after: entryLine({ ...it, ...set }), warning: null });
    }
  }
  const sk = skillsItem(base);
  if (sk) {
    for (const t of sk.item.tags) {
      const to = profileSpelling(t, profile);
      if (!to || sk.item.tags.some((x) => foldKey(x) === foldKey(to))) continue;
      const id = cid();
      ops.push({ changeId: id, type: 'skills.rename', from: t, to });
      changes.push({ id, sectionId: base.sections[sk.sectionIndex]!.id, itemId: sk.item.id, field: 'skills.rename', before: t, after: to, warning: null });
    }
  }

  // 1. Skills the profile has and the job names, but this resume does not show.
  const allTerms = jobTerms(job, dict);
  for (const t of gaps.terms) {
    if (t.status !== 'in_profile_not_resume') continue;
    const jt = allTerms.find((x) => x.term === t.term);
    if (!jt || jt.kind === 'degree') continue;
    const value = profileWording(profile, t.term, jt.forms);
    const id = cid();
    ops.push({ changeId: id, type: 'skills.add', value });
    changes.push({ id, sectionId: sk ? base.sections[sk.sectionIndex]!.id : 'skills', itemId: sk?.item.id ?? null, field: 'skills.add', before: '', after: value, warning: null });
  }

  // 2. Put the job's terms first in the skills list.
  if (sk && sk.item.tags.length > 1) {
    const order = stableOrder(sk.item.tags, (t) => score(t, terms));
    if (order.some((v, i) => v !== i)) {
      const next = order.map((i) => sk.item.tags[i]!);
      const id = cid();
      ops.push({ changeId: id, type: 'skills.order', order: next });
      changes.push({ id, sectionId: base.sections[sk.sectionIndex]!.id, itemId: sk.item.id, field: 'skills.order', before: sk.item.tags.join(', '), after: next.join(', '), warning: null });
    }
  }

  // 3. Within each job, the bullets that match the posting first.
  for (const s of base.sections) {
    if (s.kind !== 'experience' && s.kind !== 'projects') continue;
    for (const it of s.items) {
      if (it.bullets.length < 2) continue;
      const order = stableOrder(it.bullets, (b) => score(b, terms));
      if (!order.some((v, i) => v !== i)) continue;
      const id = cid();
      ops.push({ changeId: id, type: 'bullets.order', sectionId: s.id, itemId: it.id, order });
      changes.push({ id, sectionId: s.id, itemId: it.id, field: 'bullets.order', before: it.bullets.join('\n'), after: order.map((i) => it.bullets[i]!).join('\n'), warning: null });
    }
  }

  // Requests the person made: facts that are not in the profile are refused and shown as gaps.
  const instruction = (input.instruction ?? '').trim();
  const refused = instruction ? refusedFacts(instruction, profile, pf) : [];
  const violations: TruthViolation[] = [];
  let costMicros: number | null = null;
  let notice: string | null = null;

  // 4. AI: reworded bullets and summary, each checked by the truth gate.
  if (input.ai) {
    const refs: BulletRef[] = [];
    for (const s of base.sections) {
      if (s.kind !== 'experience' && s.kind !== 'projects') continue;
      for (const it of s.items) it.bullets.forEach((b, i) => refs.push({ id: `B${refs.length + 1}`, sectionId: s.id, itemId: it.id, index: i, text: b, entry: s.kind === 'projects' ? `Project ${it.heading ?? ''}` : `${it.subheading ?? ''} at ${it.heading ?? ''}` }));
    }
    const summarySec = base.sections.find((s) => s.kind === 'summary' && s.text);
    const have = gaps.terms.filter((t) => t.status !== 'not_in_profile').map((t) => t.term);
    const safeInstruction = refused.length ? '' : instruction.slice(0, 500);
    const user = [
      profileBlock(profile),
      jobBlock(job.title, job.company, job.description),
      `Job terms the person really has: ${have.join(', ') || '(none)'}`,
      safeInstruction ? `The person asks (follow it only within the rules): ${safeInstruction}` : '',
      'Bullets (reword the ones that can use the job\'s terms; keep every fact):',
      ...refs.map((r) => `${r.id}: ${r.text}`),
      summarySec ? `SUMMARY: ${summarySec.text}` : '',
      'Answer with one line per changed bullet, like "B2: new text". Add "SUMMARY: new text" if you improve the summary. If nothing should change, answer NONE.',
    ].filter(Boolean).join('\n\n');
    const system = `You improve resume bullet points for one job. Rules:\n${TRUTH_RULES}\nKeep each bullet one sentence, about as long as the original. Plain text only.`;
    const res = await aiComplete(input.ai, system, user, { maxTokens: 1200 });
    costMicros = res.costMicros;
    const parsed = parseRewrites(res.text, new Set(refs.map((r) => r.id)));
    // An answer in the wrong form is not used at all (never pasted into a resume); the rule-based changes remain.
    if (parsed === null) notice = 'The AI answer could not be used (it was not in the expected form), so this draft has only the changes jobleft makes without AI. Nothing was saved.';
    if (parsed !== null && parsed !== 'none') {
      const jc = jobContext(job);
      for (const [key, text] of parsed) {
        if (key === 'SUMMARY') {
          if (!summarySec || text === summarySec.text) continue;
          let v = checkText(text, 'Summary (AI)', pf, jc, 'resume');
          if (v.length) v = checkText(text, 'Summary (AI)', withLine(profile, summarySec.text ?? ''), jc, 'resume');
          if (v.length) { violations.push(...v); continue; }
          const id = cid();
          ops.push({ changeId: id, type: 'summary', sectionId: summarySec.id, text });
          changes.push({ id, sectionId: summarySec.id, itemId: null, field: 'summary', before: summarySec.text ?? '', after: text, warning: warnFor(summarySec.text ?? '', text) });
          continue;
        }
        const ref = refs.find((r) => r.id === key);
        if (!ref || !text || text === ref.text || text.length > ref.text.length * 2.2 + 40) continue;
        const where = `${ref.entry.trim()}, bullet ${ref.index + 1} (AI)`;
        let gate = checkText(text, where, pf, jc, 'resume');
        if (gate.length) gate = checkText(text, where, withLine(profile, ref.text), jc, 'resume');
        const v = [...gate, ...numbersKept(ref.text, text).map((x) => ({ ...x, where }))];
        if (v.length) { violations.push(...v); continue; }
        const id = cid();
        ops.push({ changeId: id, type: 'bullet', sectionId: ref.sectionId, itemId: ref.itemId, index: ref.index, text });
        changes.push({ id, sectionId: ref.sectionId, itemId: ref.itemId, field: `bullets[${ref.index}]`, before: ref.text, after: text, warning: warnFor(ref.text, text) });
      }
    }
  } else if (instruction && !refused.length) {
    notice = 'No AI provider is set up, so jobleft could not follow the request in words. These are the changes it makes without AI.';
  }

  // Gaps: what the job asks for that the profile does not have (shown, never added).
  const gapList: string[] = [];
  for (const t of gaps.terms) if (t.status === 'not_in_profile') gapList.push(t.term);
  if (job.yearsRequired?.min && job.yearsRequired.min > Math.floor(workYears(profile) + 1e-9)) gapList.push(`${job.yearsRequired.min}+ years of experience (your profile dates show about ${Math.floor(workYears(profile))})`);
  if (job.statements.clearanceRequired === true && profile.workAuthorization.hasSecurityClearance !== 'yes' && !gapList.includes('Security clearance')) gapList.push('Security clearance');
  for (const r of refused) if (!gapList.some((g) => g.toLowerCase() === r.toLowerCase())) gapList.push(r);
  if (refused.length) notice = `Not added: ${refused.join(', ')}. ${refused.length === 1 ? 'It is' : 'They are'} not in your profile, so jobleft will not put ${refused.length === 1 ? 'it' : 'them'} on a resume or a letter. If ${refused.length === 1 ? 'it is' : 'they are'} true, add ${refused.length === 1 ? 'it' : 'them'} to your profile in your own words first.`;
  if (!gaps.requirementsFound) notice = (notice ? notice + ' ' : '') + 'jobleft could not read the requirements of this posting, so it found no terms to compare.';

  const seenV = new Set<string>();
  const uniqueViolations = violations.filter((x) => { const k = `${x.kind}|${x.fact}|${x.where}`; if (seenV.has(k)) return false; seenV.add(k); return true; });
  const proposal: TailorProposal = {
    id: proposalId, resumeId: input.resumeId, jobId: job.id, changes, gaps: gapList, violations: uniqueViolations,
    provider: aiLabel(input.ai), createdAt: nowIso(), costMicros, notice, refused,
  };
  return { proposal, ops };
}

/** The base document with the accepted changes applied. Unknown change ids are refused. */
export function applyChanges(base: ResumeDocument, ops: TailorOp[], acceptIds: string[]): ResumeDocument {
  const known = new Set(ops.map((o) => o.changeId));
  for (const id of acceptIds) if (!known.has(id)) throw new ResumeError('bad_request', `There is no change "${id}" in this draft.`);
  const accept = new Set(acceptIds);
  const doc = structuredClone(base);
  // Bullet rewrites use the original positions, so apply them before any reordering.
  for (const op of ops) {
    if (!accept.has(op.changeId)) continue;
    if (op.type === 'item') {
      const it = doc.sections.find((s) => s.id === op.sectionId)?.items.find((i) => i.id === op.itemId);
      if (it) Object.assign(it, op.set);
    } else if (op.type === 'bullet') {
      const it = doc.sections.find((s) => s.id === op.sectionId)?.items.find((i) => i.id === op.itemId);
      if (it && op.index < it.bullets.length) it.bullets[op.index] = op.text;
    } else if (op.type === 'summary') {
      const s = doc.sections.find((x) => x.id === op.sectionId);
      if (s) s.text = op.text;
    }
  }
  for (const op of ops) {
    if (!accept.has(op.changeId)) continue;
    if (op.type === 'bullets.order') {
      const it = doc.sections.find((s) => s.id === op.sectionId)?.items.find((i) => i.id === op.itemId);
      if (it && op.order.length === it.bullets.length) it.bullets = op.order.map((i) => it.bullets[i]!);
    } else if (op.type === 'skills.order') {
      const sk = skillsItem(doc);
      if (sk && op.order.length === sk.item.tags.length && op.order.every((t) => sk.item.tags.includes(t))) sk.item.tags = [...op.order];
    }
  }
  for (const op of ops) {
    if (!accept.has(op.changeId) || op.type !== 'skills.rename') continue;
    const sk = skillsItem(doc);
    const i = sk ? sk.item.tags.indexOf(op.from) : -1;
    if (sk && i >= 0 && !sk.item.tags.includes(op.to)) sk.item.tags[i] = op.to;
  }
  for (const op of ops) {
    if (!accept.has(op.changeId) || op.type !== 'skills.add') continue;
    let sk = skillsItem(doc);
    if (!sk) {
      doc.sections.push({ id: 'skills', kind: 'skills', title: 'Skills', text: null, items: [{ id: 'skills-list', heading: null, subheading: null, location: null, startDate: null, endDate: null, current: false, bullets: [], tags: [] }] });
      sk = skillsItem(doc)!;
    }
    if (!sk.item.tags.some((t) => t.toLowerCase() === op.value.toLowerCase())) sk.item.tags.push(op.value);
  }
  return doc;
}

export function describeOps(ops: TailorOp[]): string {
  return ops.map((o) => `${o.changeId}:${o.type}`).join(', ');
}

export { findSkills };
export type { ProfileFacts };
