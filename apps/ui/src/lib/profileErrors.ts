// Plain words for the problems of a profile save (JL-onboarding-15): what the editors check before saving, and the
// problems the local service names in an error (`details.issues`), each with the field and what to do. Pure.

import { blankToNull, profileIssues, type ProfileBlock, type ProfileInput } from '@jobleft/contracts';

export interface FieldProblem { path: string; message: string }

/** A link row with no address typed ("" or just "https://") is not a link: it is dropped, not refused. */
export function dropEmptyLinks(p: ProfileInput): ProfileInput {
  const links = p.personal.links.filter((l) => !/^\s*(https?:\/\/)?\s*$/i.test(l.url));
  return links.length === p.personal.links.length ? p : { ...p, personal: { ...p.personal, links } };
}

/** What a save sends: blank-only text empty, empty link rows dropped. */
export function cleanForSave(p: ProfileInput): ProfileInput {
  return dropEmptyLinks(blankToNull(p));
}

/** The problems of the blocks being edited, checked in full (the person can fix each one there). */
export function problemsIn(p: ProfileInput, blocks: ProfileBlock[], paths?: string[]): FieldProblem[] {
  return profileIssues(cleanForSave(p), null)
    .filter((i) => blocks.includes(i.block) && (!paths || paths.includes(i.path)))
    .map(({ path, message }) => ({ path, message }));
}

const WORDS: Record<string, string> = {
  personal: 'Personal', links: 'Links', url: 'address', label: 'name', education: 'Education', work: 'Work experience', projects: 'Projects',
  skills: 'Skills', preferences: 'Job preferences', firstName: 'First name', lastName: 'Last name', middleName: 'Middle name',
  email: 'Email', phone: 'Phone', startDate: 'start', endDate: 'end', company: 'company', title: 'job title', school: 'school',
};

/** The problems a refused save names, in plain words (a technical check message becomes a sentence about the field). */
export function serverProblems(details: unknown): FieldProblem[] {
  const issues = (details as { issues?: Array<{ path?: unknown; message?: unknown }> } | null)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter((i) => typeof i.path === 'string').map((i) => {
    const path = i.path as string;
    const msg = typeof i.message === 'string' ? i.message : '';
    if (/[.!?]$/.test(msg) && /[A-Z]/.test(msg[0] ?? '')) return { path, message: msg };
    const link = /^\/personal\/links\/(\d+)\/url$/.exec(path);
    if (link) return { path, message: `Links, row ${Number(link[1]) + 1}: type the full address, for example https://example.com/you, or remove the row.` };
    const parts = path.split('/').filter(Boolean).map((x) => (/^\d+$/.test(x) ? `row ${Number(x) + 1}` : WORDS[x] ?? x));
    return { path, message: `${parts.join(', ')}: this value cannot be saved${msg ? ` (${msg})` : ''}. Change it or remove it.` };
  });
}

/** The longest skill name the editors take. */
export const SKILL_NAME_MAX = 100;

/**
 * Skill names as typed: trimmed, blanks dropped, and one per name whatever its letter case (JL-onboarding-19). A name
 * longer than SKILL_NAME_MAX is left out, never cut; longSkillText says why.
 */
export function uniqueNames(names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const t = n.trim().replace(/\s+/g, ' ');
    if (t && t.length <= SKILL_NAME_MAX && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/** The message for skill names that uniqueNames left out as too long, or null. */
export function longSkillText(names: string[]): string | null {
  const long = names.map((n) => n.trim().replace(/\s+/g, ' ')).filter((t) => t.length > SKILL_NAME_MAX);
  if (!long.length) return null;
  const first = long[0]!;
  return `A skill name can have at most ${SKILL_NAME_MAX} characters. "${first.slice(0, 30)}..." has ${first.length}, so it was not added. Type a shorter name.`;
}

/** What a number box takes (JL-onboarding-19, -21). */
export interface NumberRule { label: string; min: number; max: number; money?: boolean }

export const PAY_RULE: NumberRule = { label: 'Minimum yearly pay', min: 0, max: 10_000_000, money: true };
export const skillYearsRule = (skill: string): NumberRule => ({ label: `Years of ${skill}`, min: 0, max: 60 });

function shown(v: number, r: NumberRule): string {
  return r.money ? `$${v.toLocaleString('en-US')}` : v.toLocaleString('en-US');
}

/**
 * The problem with a number typed in a box, or null when the box may keep it. A number out of range or text that is
 * not a number is refused with a plain message and never becomes 0 or the nearest limit on its own.
 */
export function numberProblem(typed: number | string, r: NumberRule): string | null {
  const text = typeof typed === 'number' ? typed.toLocaleString('en-US', { maximumFractionDigits: 2 }) : typed.trim();
  if (!text) return null;
  const range = `${r.label}: type ${r.money ? 'an amount' : 'a number'} from ${shown(r.min, r)} to ${shown(r.max, r)}.`;
  const v = typeof typed === 'number' ? typed : Number(text.replace(/[$,\s]/g, ''));
  if (!Number.isFinite(v)) return `${range} "${text.slice(0, 30)}" is not a number, so it was not kept.`;
  if (v < r.min || v > r.max) return `${range} "${text.slice(0, 30)}" was not kept.`;
  return null;
}

/**
 * Work-authorization answers that cannot all be true (JL-onboarding-20): a US citizen may work in the US and never
 * needs a visa. A warning only; the person decides.
 */
export function authConflicts(wa: ProfileInput['workAuthorization']): string[] {
  const out: string[] = [];
  if (wa.usCitizen === 'yes' && wa.usAuthorized === 'no') out.push('You said you are a US citizen but not allowed to work in the US. A US citizen may work in the US.');
  if (wa.usCitizen === 'yes' && wa.needsSponsorship === 'yes') out.push('You said you are a US citizen and need visa sponsorship. A US citizen never needs a visa to work in the US.');
  return out;
}
