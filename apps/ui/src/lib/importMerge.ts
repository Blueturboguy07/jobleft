// What a resume upload may change in the profile. The person confirms first; then only the facts the file states are
// taken. Preferences, work authorization, equal-employment answers and "I don't have this" skills are never touched.
// Nothing the person entered is dropped: links and skills are only added (a skill keeps the person's years), and a
// job, school, project or certification the file does not mention stays (JL-resume-12). The dialog lines come from
// the difference between the profile now and the profile after the merge, so every change is listed and nothing
// else happens.

import type { ProfileInput } from '@jobleft/contracts';

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const urlKey = (u: string) => u.trim().toLowerCase().replace(/^https?:\/\/(?:www\.)?/, '').replace(/\/+$/, '');

/**
 * The file's entries in the file's order, each replacing the profile entry with the same key (keeping that entry's
 * id), then the profile's entries the file does not mention, unchanged.
 */
function mergeList<T>(cur: T[], file: T[], key: (x: T) => string): T[] {
  const used = new Set<number>();
  const out: T[] = [];
  for (const f of file) {
    const i = cur.findIndex((c, j) => !used.has(j) && key(c) !== '' && key(c) === key(f));
    if (i >= 0) {
      used.add(i);
      const id = (cur[i] as { id?: unknown }).id;
      out.push(id === undefined ? f : { ...f, id });
    } else out.push(f);
  }
  cur.forEach((c, j) => { if (!used.has(j)) out.push(c); });
  return out;
}

export function mergeImported(cur: ProfileInput, file: ProfileInput): ProfileInput {
  const personal = { ...cur.personal };
  for (const k of Object.keys(file.personal) as Array<keyof ProfileInput['personal']>) {
    if (k === 'links') continue;
    const v = file.personal[k];
    if (v !== null && v !== '') (personal as Record<string, unknown>)[k] = v;
  }
  personal.links = [...cur.personal.links, ...file.personal.links.filter((l) => !cur.personal.links.some((c) => urlKey(c.url) === urlKey(l.url)))];
  const declined = new Set((cur.declinedSkills ?? []).map(norm));
  const have = new Set(cur.skills.map((s) => norm(s.name)));
  const added = file.skills.filter((s) => !declined.has(norm(s.name)) && !have.has(norm(s.name)) && have.add(norm(s.name)));
  const extras = mergeList(cur.extraSections ?? [], file.extraSections ?? [], (x) => norm(x.title));
  return {
    ...cur,
    personal,
    summary: file.summary && file.summary.trim() ? file.summary : cur.summary,
    work: mergeList(cur.work, file.work, (w) => norm(w.company)),
    education: mergeList(cur.education, file.education, (e) => norm(e.school)),
    projects: mergeList(cur.projects, file.projects, (p) => norm(p.name)),
    certifications: mergeList(cur.certifications, file.certifications, (c) => norm(c.name)),
    skills: [...cur.skills, ...added],
    ...(extras.length || cur.extraSections ? { extraSections: extras } : {}),
  };
}

const ym = (d: string | null) => d ?? 'no date';
const q = (s: string, n = 90) => `“${s.length > n ? `${s.slice(0, n - 1)}…` : s}”`;
const PERSONAL_LABELS: Array<[keyof ProfileInput['personal'], string]> = [
  ['firstName', 'First name'], ['middleName', 'Middle name'], ['lastName', 'Last name'], ['email', 'Email'], ['phone', 'Phone'],
  ['addressLine', 'Address'], ['city', 'City'], ['region', 'State or region'], ['postalCode', 'Postal code'], ['country', 'Country'],
];

/** Line changes of one list of lines: what joins and what goes. */
function lineChanges(before: string[], after: string[], where: string, lines: string[], replaces: string[]): void {
  for (const b of after) if (!before.includes(b)) lines.push(`${where}: adds the line ${q(b)}`);
  for (const b of before) if (!after.includes(b)) { lines.push(`${where}: removes your line ${q(b)}`); replaces.push(`Your line ${q(b)} under ${where} would be removed`); }
}

/** One entry list (jobs, schools, projects, certifications): new entries, and each changed field of a kept entry. */
function entryChanges<T extends object>(before: T[], after: T[], o: {
  id: (x: T) => string; name: (x: T) => string; noun: string;
  fields: Array<[string, (x: T) => string | null]>; lists?: Array<[string, (x: T) => string[]]>;
}, lines: string[], replaces: string[]): void {
  for (const a of after) {
    const b = before.find((x) => o.id(x) === o.id(a));
    if (!b) { lines.push(`New ${o.noun} from the file: ${o.name(a)}`); continue; }
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const where = `${o.noun} ${o.name(b)}`;
    for (const [label, get] of o.fields) {
      const x = get(b); const y = get(a);
      if ((x ?? '') === (y ?? '')) continue;
      lines.push(`${where}: ${label} ${x ? `${q(x)} becomes ` : ''}${y ? q(y) : 'empty'}`);
      if (x) replaces.push(`Your ${label} ${q(x)} for ${where} would become ${y ? q(y) : 'empty'}`);
    }
    for (const [label, get] of o.lists ?? []) lineChanges(get(b), get(a), `${where} (${label})`, lines, replaces);
  }
}

/**
 * Plain lines for every change "use these facts" would make, and the subset that replaces or removes something the
 * person has. Both come from comparing the profile now with the merged profile, so the button does only what is listed.
 */
export function importChanges(cur: ProfileInput | undefined, file: ProfileInput): { lines: string[]; replaces: string[] } {
  const lines: string[] = [];
  const replaces: string[] = [];
  const now = cur ?? { ...file, personal: { ...file.personal, links: [] }, summary: null, work: [], education: [], projects: [], certifications: [], skills: [], extraSections: [] };
  const next = mergeImported(now, file);
  for (const [k, label] of PERSONAL_LABELS) {
    const x = now.personal[k] as string | null; const y = next.personal[k] as string | null;
    if ((x ?? '') === (y ?? '')) continue;
    lines.push(`${label}: ${x ? `${q(x)} becomes ` : ''}${q(y ?? '')}`);
    if (x) replaces.push(`Your ${label.toLowerCase()} ${q(x)} would become ${q(y ?? '')}`);
  }
  const newLinks = next.personal.links.filter((l) => !now.personal.links.some((c) => c.url === l.url));
  if (newLinks.length) lines.push(`Links added: ${newLinks.map((l) => l.url).join(', ')} (your links stay)`);
  if ((now.summary ?? '') !== (next.summary ?? '')) {
    lines.push(`Summary: ${q(next.summary ?? '', 200)}`);
    if (now.summary) replaces.push(`Your summary ${q(now.summary, 200)} would be replaced`);
  }
  entryChanges(now.work, next.work, {
    id: (w) => w.id, name: (w) => `${w.title || 'no title'} at ${w.company || 'no employer'}`, noun: 'job',
    fields: [['employer', (w) => w.company], ['title', (w) => w.title], ['place', (w) => w.location], ['start', (w) => ym(w.startDate)], ['end', (w) => (w.current ? 'now' : ym(w.endDate))], ['one-line summary', (w) => w.summary]],
    lists: [['bullets', (w) => w.bullets]],
  }, lines, replaces);
  entryChanges(now.education, next.education, {
    id: (e) => e.id, name: (e) => e.school || 'no school', noun: 'school',
    fields: [['school', (e) => e.school], ['degree', (e) => e.degree], ['major', (e) => e.major], ['GPA', (e) => e.gpa], ['start', (e) => ym(e.startDate)], ['end', (e) => (e.current ? 'now' : ym(e.endDate))]],
    lists: [['achievements', (e) => e.achievements], ['coursework', (e) => e.coursework]],
  }, lines, replaces);
  entryChanges(now.projects, next.projects, {
    id: (p) => p.id, name: (p) => p.name || 'no name', noun: 'project',
    fields: [['name', (p) => p.name], ['description', (p) => p.description], ['link', (p) => p.url], ['start', (p) => ym(p.startDate)], ['end', (p) => ym(p.endDate)]],
    lists: [['bullets', (p) => p.bullets]],
  }, lines, replaces);
  entryChanges(now.certifications, next.certifications, {
    id: (c) => norm(c.name), name: (c) => c.name, noun: 'certification',
    fields: [['issuer', (c) => c.issuer], ['date', (c) => c.date]],
  }, lines, replaces);
  const addedSkills = next.skills.filter((s) => !now.skills.some((c) => norm(c.name) === norm(s.name))).map((s) => s.name);
  if (addedSkills.length) lines.push(`Skills added: ${addedSkills.join(', ')} (your skills stay as they are)`);
  entryChanges(now.extraSections ?? [], next.extraSections ?? [], {
    id: (x) => x.id, name: (x) => x.title, noun: 'section', fields: [['title', (x) => x.title]], lists: [['lines', (x) => x.lines]],
  }, lines, replaces);
  return { lines, replaces };
}
