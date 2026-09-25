// Cover letters (resume O8): name the right company and role, use only facts from the profile, and keep the truth
// rules after every hand edit and every request. Without AI the letter is built from the profile by rules; with AI,
// every sentence the model writes is checked, and a sentence that holds an untraceable fact is left out.

import type { Job, Profile, ResumeDocument } from '@jobleft/contracts';
import type { AiClient } from '@jobleft/ai-engine';
import type { SkillDictionary } from '@jobleft/static-data';
import { aiComplete, aiLabel, jobBlock, TRUTH_RULES } from './ai.ts';
import { scanFacts } from './facts.ts';
import { jobTerms, keywordGaps, safeDictionary } from './gaps.ts';
import { buildProfileFacts, checkLetter, checkText, headerFromProfile, jobContext, refusedFacts, workYears, type ProfileFacts } from './truth.ts';
import { foldKey, splitSentences, termRegExp } from './text.ts';

export interface LetterResult {
  text: string;
  gaps: string[];
  notice: string | null;
  provider: string;
  costMicros: number | null;
}

/** A company or title from a posting, cleaned so text hidden in the field cannot ride into the letter (O14). */
export function cleanJobField(value: string, fallback: string): { value: string; odd: boolean } {
  let v = value.replace(/\s+/g, ' ').trim();
  v = v.replace(/\s*[([{].*$/, '').replace(/\s+(?:[-–—|:]\s+).{25,}$/, '').trim();
  const scan = scanFacts(v);
  const odd = v.length === 0 || v.length > 80 || /\b(?:ignore|instruction|prompt|rules?|system|assistant|add|list|include)\b/i.test(v)
    || scan.degrees.length > 0 || scan.contacts.length > 0 || scan.numbers.length > 0 || v.split(' ').length > 9;
  return odd ? { value: fallback, odd: true } : { value: v, odd: false };
}

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}

function asSentence(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** Past-tense action bullets read well after "I": "Cut batch-job time by 40%." -> "I cut batch-job time by 40%." */
function bulletAsClause(b: string): string | null {
  const t = b.trim().replace(/[.;]$/, '');
  const first = t.split(' ')[0] ?? '';
  if (/^[A-Z][a-z]+(?:ed|t)$/.test(first) || /^(?:Led|Built|Cut|Ran|Won|Made|Set|Wrote|Grew|Drove|Taught|Sold|Kept|Took|Held|Began|Found|Brought|Rebuilt|Shipped)$/.test(first)) return `I ${lowerFirst(t)}`;
  return null;
}

function headerBlock(p: Profile): string {
  const h = headerFromProfile(p);
  const contact = [h.email, h.phone, h.city, ...h.links.map((l) => l.url)].filter((x): x is string => !!x && !!x.trim()).join(' | ');
  return contact ? `${h.name}\n${contact}` : h.name;
}

interface Ctx { profile: Profile; job: Job; resume: ResumeDocument; skills: SkillDictionary | null; pf: ProfileFacts }

function jobNames(job: Job): { company: string; title: string; odd: boolean } {
  const c = cleanJobField(job.company, 'your company');
  const t = cleanJobField(job.title, 'this role');
  return { company: c.value, title: t.value, odd: c.odd || t.odd };
}

function relevantBullets(ctx: Ctx, max: number): Array<{ text: string; company: string; title: string; current: boolean }> {
  const terms = jobTerms(ctx.job, safeDictionary(ctx.skills)).flatMap((t) => t.forms);
  const all: Array<{ text: string; company: string; title: string; current: boolean; score: number; order: number }> = [];
  let order = 0;
  for (const s of ctx.resume.sections) {
    if (s.kind !== 'experience') continue;
    for (const it of s.items) for (const b of it.bullets) {
      const score = terms.reduce((n, f) => n + (termRegExp(f.text, f.caseSensitive, 'g').test(b) ? 1 : 0), 0);
      all.push({ text: b, company: it.heading ?? '', title: it.subheading ?? '', current: it.current, score, order: order++ });
    }
  }
  return all.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, max);
}

function matchingSkills(ctx: Ctx, max: number): string[] {
  const gaps = keywordGaps(ctx.job, ctx.resume, ctx.profile, safeDictionary(ctx.skills));
  const covered = gaps.terms.filter((t) => t.status !== 'not_in_profile' && t.matchedAs).map((t) => t.matchedAs!);
  const own = ctx.profile.skills.map((s) => s.name).filter((s) => !covered.some((c) => c.toLowerCase() === s.toLowerCase()));
  return [...new Set([...covered, ...own])].slice(0, max);
}

/** The letter jobleft writes without AI: every sentence is made from the profile or names the job. */
export function ruleLetterBody(ctx: Ctx): string[] {
  const { company, title } = jobNames(ctx.job);
  const paras: string[] = [];
  const role = title === 'this role' ? 'this role' : `the ${title} role`;
  const current = ctx.profile.work.find((w) => w.current) ?? ctx.profile.work[0];
  const opener = [`I am writing to apply for ${role} at ${company}.`];
  if (ctx.profile.summary) opener.push(asSentence(ctx.profile.summary.split(/(?<=[.!?])\s+/)[0]!));
  else if (current) opener.push(`I work as a ${current.title} at ${current.company}.`.replace(/^I work as a (?=[AEIOU])/, 'I work as an '));
  paras.push(opener.join(' '));
  const bullets = relevantBullets(ctx, 3);
  if (bullets.length) {
    const parts: string[] = [];
    let lastCompany = '';
    for (const b of bullets) {
      const clause = bulletAsClause(b.text);
      const lead = b.company !== lastCompany ? (b.current ? `In my current role as ${b.title} at ${b.company}, ` : `As ${b.title} at ${b.company}, `) : '';
      lastCompany = b.company;
      if (clause) parts.push(asSentence(lead ? lead + lowerFirst(clause) : clause));
      else parts.push(asSentence(lead ? `${lead}one result I am proud of: ${lowerFirst(b.text.replace(/\.$/, ''))}` : `Another result: ${lowerFirst(b.text.replace(/\.$/, ''))}`));
    }
    paras.push(parts.join(' '));
  }
  const skills = matchingSkills(ctx, 6);
  if (skills.length) paras.push(`My skills include ${skills.length > 1 ? `${skills.slice(0, -1).join(', ')} and ${skills[skills.length - 1]}` : skills[0]}.`);
  paras.push(`Thank you for considering my application. I would welcome the chance to talk about how I can help ${company}.`);
  return paras;
}

export function assembleLetter(profile: Profile, bodyParas: string[]): string {
  const name = headerFromProfile(profile).name;
  return [headerBlock(profile), 'Dear Hiring Manager,', ...bodyParas, `Sincerely,\n${name}`].join('\n\n');
}

/** Body paragraphs of an existing letter (between the greeting and the sign-off). */
export function letterBody(text: string): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const start = paras.findIndex((p) => /^dear\b|^to whom\b|^hello\b/i.test(p));
  const end = paras.findIndex((p) => /^(?:sincerely|best regards|regards|kind regards|thank you,|best,|yours)/i.test(p));
  return paras.slice(start >= 0 ? start + 1 : 1, end >= 0 ? end : paras.length);
}

function jobGaps(ctx: Ctx): string[] {
  const g = keywordGaps(ctx.job, ctx.resume, ctx.profile, safeDictionary(ctx.skills));
  const out = g.terms.filter((t) => t.status === 'not_in_profile').map((t) => t.term);
  if (ctx.job.yearsRequired?.min && ctx.job.yearsRequired.min > Math.floor(workYears(ctx.profile) + 1e-9)) out.push(`${ctx.job.yearsRequired.min}+ years of experience`);
  return out;
}

/** Keeps only the sentences that pass the truth gate; returns what was left out. */
function gateSentences(paras: string[], ctx: Ctx): { paras: string[]; removed: string[] } {
  const jc = jobContext(ctx.job);
  const removed: string[] = [];
  const out: string[] = [];
  for (const p of paras) {
    const keep: string[] = [];
    for (const s of splitSentences(p)) {
      const v = checkText(s, 'Letter', ctx.pf, jc, 'letter');
      const names = /\b(?:\[[^\]]+\]|\{[^}]+\}|your name|company name|hiring manager's name)\b/i.test(s);
      if (v.length || names) removed.push(...(v.length ? v.map((x) => x.fact) : ['a placeholder']));
      else keep.push(s);
    }
    if (keep.length) out.push(keep.join(' '));
  }
  return { paras: out, removed: [...new Set(removed)] };
}

function profileBlockForLetter(p: Profile): string {
  const L: string[] = ['<profile>'];
  if (p.summary) L.push(`Summary: ${p.summary}`);
  for (const w of p.work) {
    L.push(`Job: ${w.title} at ${w.company}${w.current ? ' (current)' : ''}`);
    for (const b of w.bullets) L.push(`  - ${b}`);
  }
  for (const e of p.education) L.push(`Education: ${[e.degree, e.major].filter(Boolean).join(' in ')}, ${e.school}`);
  for (const pr of p.projects) L.push(`Project: ${pr.name}${pr.description ? ` - ${pr.description}` : ''}${pr.bullets.length ? ` (${pr.bullets.join(' ')})` : ''}`);
  if (p.skills.length) L.push(`Skills: ${p.skills.map((s) => s.name).join(', ')}`);
  L.push('</profile>');
  return L.join('\n');
}

function parseBody(text: string): string[] {
  const t = text.replace(/\r/g, '').trim();
  const m = /BODY:\s*([\s\S]*?)(?:\n\s*END\b|$)/i.exec(t);
  const body = (m ? m[1]! : t)
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter((p) => p && !/^(?:dear|sincerely|best regards|regards|thank you,)\b/i.test(p) && !/^\[|^\{/.test(p));
  return body;
}

export async function draftLetter(input: { profile: Profile; job: Job; resume: ResumeDocument; skills: SkillDictionary | null; ai: AiClient | null }): Promise<LetterResult> {
  const ctx: Ctx = { ...input, pf: buildProfileFacts(input.profile) };
  const names = jobNames(input.job);
  let notice: string | null = names.odd ? 'The company or job title in the posting looked unusual, so the letter uses plain words for it. Edit it by hand if needed.' : null;
  const gaps = jobGaps(ctx);
  if (!input.ai) {
    return { text: assembleLetter(input.profile, ruleLetterBody(ctx)), gaps, notice, provider: 'none', costMicros: null };
  }
  const opener = `I am writing to apply for ${names.title === 'this role' ? 'this role' : `the ${names.title} role`} at ${names.company}.`;
  const system = `You write the middle of a cover letter: two short paragraphs, under 170 words in total. Rules:\n${TRUTH_RULES}\nDo not greet and do not sign. Do not name any company except as "${names.company}". Answer as:\nBODY:\n<paragraphs>\nEND`;
  const user = [profileBlockForLetter(input.profile), jobBlock(input.job.title, input.job.company, input.job.description), `Write why this person fits the ${names.title} role at ${names.company}, using only the PROFILE.`].join('\n\n');
  const res = await aiComplete(input.ai, system, user, { maxTokens: 700 });
  const body = parseBody(res.text);
  const gated = gateSentences(body, ctx);
  let paras = gated.paras;
  if (gated.removed.length) {
    notice = `Left out AI sentences with facts that are not in your profile (${gated.removed.slice(0, 6).join(', ')}).`;
    for (const r of gated.removed) if (r !== 'a placeholder' && !gaps.includes(r)) gaps.push(r);
  }
  const sentences = paras.join(' ').split(/(?<=[.!?])\s+/).filter(Boolean).length;
  if (sentences < 2) {
    paras = ruleLetterBody(ctx).slice(1);
    notice = (notice ? notice + ' ' : '') + 'The AI text could not be used, so the middle of the letter is built from your profile.';
  }
  const closing = `Thank you for considering my application. I would welcome the chance to talk about how I can help ${names.company}.`;
  return { text: assembleLetter(input.profile, [opener, ...paras, closing]), gaps, notice, provider: aiLabel(input.ai), costMicros: res.costMicros };
}

// ------------------------------------------------------------------------------------------------ edits

type Intent = { kind: 'shorter' } | { kind: 'project'; name: string | null } | { kind: 'other' };

function intentOf(instruction: string): Intent {
  const t = instruction.toLowerCase();
  if (/\b(shorter|shorten|concise|brief|trim|cut it down|less long|too long)\b/.test(t)) return { kind: 'shorter' };
  const pm = /\b(?:mention|add|include|talk about|highlight|describe)\b.*\bproject\b\s*(?:called|named|:)?\s*["“]?([^"”.]*)["”]?/i.exec(instruction);
  if (pm) return { kind: 'project', name: pm[1]!.trim() || null };
  return { kind: 'other' };
}

function findProject(p: Profile, name: string | null, instruction: string): Profile['projects'][number] | null {
  if (!p.projects.length) return null;
  const hay = foldKey(`${name ?? ''} ${instruction}`);
  const scored = p.projects.map((pr) => {
    const words = foldKey(pr.name).split(' ').filter((w) => w.length > 2);
    const hits = words.filter((w) => hay.includes(w)).length;
    return { pr, s: words.length ? hits / words.length : 0 };
  }).sort((a, b) => b.s - a.s);
  if (scored[0]!.s >= 0.5) return scored[0]!.pr;
  return name && name.length > 2 ? null : (scored[0]?.pr ?? null);
}

function shorten(paras: string[]): string[] {
  if (paras.length <= 2) return paras.map((p) => splitSentences(p).slice(0, 2).join(' '));
  const first = splitSentences(paras[0]!).slice(0, 2).join(' ');
  const middle = paras.slice(1, -1).sort((a, b) => b.length - a.length)[0]!;
  const last = paras[paras.length - 1]!;
  return [first, splitSentences(middle).slice(0, 2).join(' '), splitSentences(last).slice(0, 1).join(' ')];
}

export async function editLetter(input: {
  current: string; instruction: string; profile: Profile; job: Job; resume: ResumeDocument; skills: SkillDictionary | null; ai: AiClient | null;
}): Promise<LetterResult & { changed: boolean }> {
  const ctx: Ctx = { profile: input.profile, job: input.job, resume: input.resume, skills: input.skills, pf: buildProfileFacts(input.profile) };
  const gaps = jobGaps(ctx);
  const refused = refusedFacts(input.instruction, input.profile, ctx.pf);
  if (refused.length) {
    for (const r of refused) if (!gaps.includes(r)) gaps.push(r);
    return {
      text: input.current, gaps, changed: false, provider: 'none', costMicros: null,
      notice: `Not done: ${refused.join(', ')} ${refused.length === 1 ? 'is' : 'are'} not in your profile, so jobleft will not write ${refused.length === 1 ? 'it' : 'them'} into a letter. If ${refused.length === 1 ? 'it is' : 'they are'} true, add ${refused.length === 1 ? 'it' : 'them'} to your profile in your own words first.`,
    };
  }
  const intent = intentOf(input.instruction);
  const body = letterBody(input.current);
  if (intent.kind === 'shorter' && !input.ai) {
    return { text: assembleLetter(input.profile, shorten(body)), gaps, changed: true, provider: 'none', costMicros: null, notice: null };
  }
  if (intent.kind === 'project') {
    const pr = findProject(input.profile, intent.name, input.instruction);
    if (!pr) {
      return { text: input.current, gaps, changed: false, provider: 'none', costMicros: null, notice: `No project like that is in your profile${intent.name ? ` ("${intent.name}")` : ''}. Add it to your profile first, then ask again.` };
    }
    if (!input.ai) {
      const clause = pr.bullets[0] ? bulletAsClause(pr.bullets[0]) : null;
      const sentence = asSentence(`I also built ${pr.name}${pr.description ? `, ${lowerFirst(pr.description.replace(/\.$/, ''))}` : ''}`) + (clause ? ` ${asSentence(clause.replace(/^I built with/, 'I built it with'))}` : '');
      const next = [...body];
      next.splice(Math.max(1, next.length - 1), 0, sentence);
      const gated = gateSentences(next, ctx);
      return { text: assembleLetter(input.profile, gated.paras), gaps, changed: true, provider: 'none', costMicros: null, notice: null };
    }
  }
  if (!input.ai) {
    return { text: input.current, gaps, changed: false, provider: 'none', costMicros: null, notice: 'Without an AI provider, jobleft can make the letter shorter or add one of your projects. Set up a provider for other requests.' };
  }
  const names = jobNames(input.job);
  const system = `You edit the middle of a cover letter as the person asks. Rules:\n${TRUTH_RULES}\nDo not greet and do not sign. Do not name any company except "${names.company}". Answer as:\nBODY:\n<paragraphs>\nEND`;
  const user = [
    profileBlockForLetter(input.profile), jobBlock(input.job.title, input.job.company, input.job.description),
    `Current letter middle:\n${body.join('\n\n')}`,
    `The person asks: ${input.instruction.slice(0, 500)}`,
  ].join('\n\n');
  const res = await aiComplete(input.ai, system, user, { maxTokens: 700 });
  const gated = gateSentences(parseBody(res.text), ctx);
  if (!gated.paras.length) {
    return { text: input.current, gaps, changed: false, provider: aiLabel(input.ai), costMicros: res.costMicros, notice: 'The AI edit could not be used (it held facts that are not in your profile, or no text). The letter is unchanged.' };
  }
  const notice = gated.removed.length ? `Left out AI sentences with facts that are not in your profile (${gated.removed.slice(0, 6).join(', ')}).` : null;
  for (const r of gated.removed) if (r !== 'a placeholder' && !gaps.includes(r)) gaps.push(r);
  return { text: assembleLetter(input.profile, gated.paras), gaps, changed: true, provider: aiLabel(input.ai), costMicros: res.costMicros, notice };
}

export function letterViolations(text: string, profile: Profile, job: Job | null) {
  return checkLetter(text, profile, job);
}
