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

/** One draft for one open question. Empty string when the profile has too few facts to say anything true. */
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
  if (/\bcover letter\b/.test(q)) {
    return [`I am applying for ${role}${at}.`, ...parts, `I would like to bring this experience to ${role}${at}.`].join(' ');
  }
  if (/\bwhy\b|\binterest|\bexcite|\bmotivat|\bwant to (work|join)\b/.test(q)) {
    return [...parts, `I would like to bring this experience to ${role}${at}.`].join(' ');
  }
  if (/\bproject\b/.test(q) && profile.projects[0]) {
    const pr = profile.projects[0];
    return [`One project I worked on is ${pr.name}.`, pr.description ?? '', ...parts.slice(0, 1)].filter(Boolean).join(' ');
  }
  if (/\babout (yourself|you)\b|\bintroduce\b|\bbackground\b|\bsummary\b/.test(q) && profile.summary) {
    return [profile.summary, ...parts.slice(1)].join(' ');
  }
  return parts.join(' ');
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
