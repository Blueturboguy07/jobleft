// A facts-only draft writer with no AI: the stand-in app's local provider, and a safe fallback.
// It copies profile facts word for word into fixed sentences. It adds no number, award, employer, title, skill or
// degree that the profile does not hold, and it never includes contact details (phone, email, address), whatever
// the question says. Page text never reaches it: it sees only the question's label.

import type { FormField, Profile } from '@jobleft/contracts';
import { words } from './text.ts';

export interface DraftJob {
  title: string | null;
  company: string | null;
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A blank the person fills in: the draft says what goes there and never makes it up. */
function blank(what: string): string {
  return `[${what}]`;
}

/**
 * One draft for one open question, from profile facts only. Where the answer needs something the profile does not
 * hold (why this company, which project), the draft is a short frame with [blanks] that say what to write. A
 * question the profile facts do not answer gets no draft (empty string): the panel says to write it yourself.
 * Empty string too when the profile has too few facts to say anything true.
 */
export function templateDraft(field: FormField, profile: Profile, job: DraftJob | null): string {
  const q = words(field.label);
  const current = profile.work.find((w) => w.current) ?? null;
  const recent = current ?? profile.work[0] ?? null;
  const skills = profile.skills.map((s) => s.name).filter(Boolean).slice(0, 4);
  const edu = profile.education[0] ?? null;
  const parts: string[] = [];

  if (recent) {
    parts.push(current
      ? `I work as a ${recent.title} at ${recent.company}.`
      : `Most recently, I worked as a ${recent.title} at ${recent.company}.`);
  }
  if (skills.length > 0) parts.push(`My skills include ${listOf(skills)}.`);
  if (edu) {
    const what = [edu.degree, edu.major ? `in ${edu.major}` : null].filter(Boolean).join(' ');
    parts.push(what ? `I studied at ${edu.school} (${what}).` : `I studied at ${edu.school}.`);
  }
  if (parts.length === 0) return '';

  const role = job?.title ? `the ${job.title} role` : 'this role';
  const at = job?.company ? ` at ${job.company}` : '';
  // Skills alone are not "experience".
  const bring = recent || edu ? `I would like to bring this experience to ${role}${at}.` : `I would like to use these skills in ${role}${at}.`;
  const why = blank(`Say what draws you to ${job?.company ?? 'this company'} and to this role.`);
  if (/\bcover letter\b/.test(q)) {
    return [`I am applying for ${role}${at}.`, why, ...parts, bring].join(' ');
  }
  if (/\bwhy\b|\binterest|\bexcite|\bmotivat|\bwant to (work|join)\b/.test(q)) {
    return [why, ...parts, bring].join(' ');
  }
  if (/\bproject\b/.test(q)) {
    const pr = profile.projects[0];
    if (pr) return [`One project I worked on is ${pr.name}.`, pr.description ?? '', ...parts.slice(0, 1)].filter(Boolean).join(' ');
    // No project in the profile: a frame, never a made-up project.
    const tools = skills.length ? ` (your profile lists ${listOf(skills)})` : '';
    return [`One project I am proud of is ${blank('name the project')}.`, blank(`Say what you built and your part in it, with the tools you used${tools}.`), blank('Say what came of it.')].join(' ');
  }
  if (/\babout (yourself|you)\b|\bintroduce\b|\bbackground\b|\bsummary\b/.test(q)) {
    return profile.summary ? [profile.summary, ...parts.slice(1)].join(' ') : parts.join(' ');
  }
  if (/\bfit\b|\bqualif|\bstrength|\bexperience\b|\bskills?\b|\bstand out\b|\bhire you\b/.test(q)) {
    return [...parts, blank('Say how this matches what the role asks for.')].join(' ');
  }
  // Any other question: profile facts do not answer it. No draft; the panel says to write it yourself.
  return '';
}

/** Words a draft must never contain: the person's own contact details. Used by the stand-in and in tests. */
export function contactLeaks(text: string, profile: Profile): string[] {
  const p = profile.personal;
  const out: string[] = [];
  const t = text.toLowerCase();
  for (const v of [p.phone, p.email, p.addressLine, p.postalCode]) {
    if (v && v.trim() && t.includes(v.trim().toLowerCase())) out.push(v);
  }
  if (p.phone) {
    const digits = p.phone.replace(/\D/g, '');
    if (digits.length >= 7 && text.replace(/\D/g, '').includes(digits)) out.push(p.phone);
  }
  return [...new Set(out)];
}
