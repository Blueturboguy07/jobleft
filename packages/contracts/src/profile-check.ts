// Plain checks of the facts a person types into the profile (JL-onboarding-5, -15, -16), shared by the UI (which
// shows them next to the boxes) and the local service (which refuses a save that breaks them). Each problem names
// the field and says what to type. Blank-only text counts as empty.
//
// `profileIssues(next, prev)` checks only what is new or changed since `prev`, so a value stored before these checks
// (or a fact a resume import brought in) never blocks saving something else; pass `prev = null` to check everything.
// Entries a resume brings in are new, so the service checks dates and company names only of entries the person
// edited (same id as before); the editors check every entry of the block the person is editing.

import type { ProfileInput } from './profile.ts';

export type ProfileBlock = 'personal' | 'education' | 'work' | 'projects' | 'preferences';
export interface ProfileIssue { block: ProfileBlock; path: string; message: string }

export const PROFILE_LIMITS = { name: 100, email: 254, text: 200, linkLabel: 100, minAnnualPayUsd: 10_000_000 } as const;

const PERSONAL_TEXT: Array<[keyof ProfileInput['personal'], string]> = [
  ['firstName', 'First name'], ['middleName', 'Middle name'], ['lastName', 'Last name'], ['email', 'Email'], ['phone', 'Phone'],
  ['addressLine', 'Street address'], ['city', 'City'], ['region', 'State or region'], ['postalCode', 'Postal code'],
];

/** Blank-only text in the personal details and the summary becomes empty (null). Other text is kept as typed. */
export function blankToNull(p: ProfileInput): ProfileInput {
  const personal = { ...p.personal };
  let changed = false;
  for (const [k] of PERSONAL_TEXT) {
    const v = personal[k];
    if (typeof v === 'string' && !v.trim()) { (personal as Record<string, unknown>)[k] = null; changed = true; }
  }
  const summary = typeof p.summary === 'string' && !p.summary.trim() ? null : p.summary;
  return changed || summary !== p.summary ? { ...p, personal, summary } : p;
}

const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:".]+(\.[^\s@<>()[\],;:".]+)+$/u;
const LETTER = /\p{L}/u;

export function emailProblem(v: string): string | null {
  if (v.length > PROFILE_LIMITS.email || !EMAIL.test(v)) return 'Email: type an address like name@example.com.';
  return null;
}

/**
 * Digits with spaces, dashes, dots, brackets and a leading +, 6 to 20 digits (loose on purpose: a number a resume
 * import found must pass); an extension ("ext. 12", "x12") may follow.
 */
export function phoneProblem(v: string): string | null {
  const main = v.trim().replace(/\s*(?:ext\.?|extension|x|#)\s*\d{1,6}$/i, '');
  const digits = main.replace(/\D/g, '').length;
  if (!/^\+?[\d\s().\-/]+$/.test(main) || digits < 6 || digits > 20) return 'Phone: type the number with its digits, for example +1 555 010 0100.';
  return null;
}

export function linkProblem(url: string): boolean {
  return !/^https?:\/\/[^\s/?#.]+(\.[^\s/?#.]+)+([/?#]\S*)?$/i.test(url.trim()) && !/^https?:\/\/(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]\S*)?$/i.test(url.trim());
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthText(ym: string): string {
  const [y, m] = ym.split('-');
  return m ? `${MONTHS[Number(m) - 1] ?? m} ${y}` : `${y}`;
}
/** true when the end is before the start ("2020" counts as January for a start and December for an end). */
export function endsBeforeStart(start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  const s = start.length === 4 ? `${start}-01` : start;
  const e = end.length === 4 ? `${end}-12` : end;
  return e < s;
}

interface Dated { id: string; startDate: string | null; endDate: string | null; current?: boolean }

function datesProblem(what: string, x: Dated, now: string): string | null {
  if (!x.current && endsBeforeStart(x.startDate, x.endDate)) return `${what}: the end (${monthText(x.endDate!)}) is before the start (${monthText(x.startDate!)}).`;
  if (x.current && x.startDate && (x.startDate.length === 4 ? `${x.startDate}-01` : x.startDate) > now) return `${what}: you marked it as now, but it starts in ${monthText(x.startDate)}.`;
  return null;
}

/** Problems with what the person typed, one plain sentence each. */
export function profileIssues(next: ProfileInput, prev: ProfileInput | null, now: Date = new Date()): ProfileIssue[] {
  const out: ProfileIssue[] = [];
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const p = next.personal;
  const was = prev?.personal ?? null;
  const changed = (k: keyof ProfileInput['personal']) => !was || JSON.stringify(was[k]) !== JSON.stringify(p[k]);
  for (const [k, label] of PERSONAL_TEXT) {
    const v = p[k];
    if (typeof v !== 'string' || !v.trim() || !changed(k)) continue;
    const path = `/personal/${k}`;
    const limit = k === 'firstName' || k === 'middleName' || k === 'lastName' ? PROFILE_LIMITS.name : k === 'email' ? PROFILE_LIMITS.email : PROFILE_LIMITS.text;
    if (v.length > limit) { out.push({ block: 'personal', path, message: `${label}: use at most ${limit} characters.` }); continue; }
    if ((k === 'firstName' || k === 'middleName' || k === 'lastName') && !LETTER.test(v)) out.push({ block: 'personal', path, message: `${label}: type a name with letters.` });
    if (k === 'email') { const m = emailProblem(v.trim()); if (m) out.push({ block: 'personal', path, message: m }); }
    if (k === 'phone') { const m = phoneProblem(v); if (m) out.push({ block: 'personal', path, message: m }); }
  }
  p.links.forEach((l, i) => {
    const old = was?.links[i];
    if (old && old.url === l.url && old.label === l.label) return;
    if (l.label.length > PROFILE_LIMITS.linkLabel) out.push({ block: 'personal', path: `/personal/links/${i}/label`, message: `Links, row ${i + 1}: use at most ${PROFILE_LIMITS.linkLabel} characters for the name.` });
    if (linkProblem(l.url)) out.push({ block: 'personal', path: `/personal/links/${i}/url`, message: `Links, row ${i + 1}: type the full address, for example https://example.com/you, or remove the row.` });
  });
  const entries = <T extends Dated>(block: ProfileBlock, key: 'education' | 'work' | 'projects', list: T[], name: (x: T, i: number) => string, extra?: (x: T, what: string, old: T | undefined) => ProfileIssue | null) => {
    const before = new Map(((prev?.[key] ?? []) as T[]).map((x) => [x.id, x]));
    list.forEach((x, i) => {
      const old = before.get(x.id);
      // with a previous profile, only entries the person edited are checked (an imported entry is new, and it can
      // carry the file's own dates; the editor checks it when the person opens it)
      if (prev && (!old || JSON.stringify(old) === JSON.stringify(x))) return;
      const what = name(x, i);
      const datesMoved = !old || old.startDate !== x.startDate || old.endDate !== x.endDate || old.current !== x.current;
      const m = datesMoved ? datesProblem(what, x, ym) : null;
      if (m) out.push({ block, path: `/${key}/${i}/endDate`, message: m });
      const e = extra?.(x, what, old);
      if (e) out.push(e);
    });
  };
  entries('education', 'education', next.education, (x, i) => `Education, ${x.school.trim() || `school ${i + 1}`}`);
  entries('work', 'work', next.work, (x, i) => `Work experience, ${x.company.trim() || `job ${i + 1}`}`, (x, _what, old) => {
    if (x.company.trim() || (old && old.company === x.company)) return null;
    const i = next.work.indexOf(x);
    return { block: 'work', path: `/work/${i}/company`, message: `Work experience, job ${i + 1}: add the company name.` };
  });
  entries('projects', 'projects', next.projects, (x, i) => `Projects, ${x.name.trim() || `project ${i + 1}`}`);
  const pay = next.preferences.minAnnualPayUsd;
  if (pay !== null && pay > PROFILE_LIMITS.minAnnualPayUsd && (!prev || prev.preferences.minAnnualPayUsd !== pay)) {
    out.push({ block: 'preferences', path: '/preferences/minAnnualPayUsd', message: `Minimum yearly pay: type an amount up to $${PROFILE_LIMITS.minAnnualPayUsd.toLocaleString('en-US')}.` });
  }
  return out;
}
