// What a resume upload may change in the profile. The person confirms first; then only the facts the file states are
// taken. Preferences, work authorization, equal-employment answers and "I don't have this" skills are never touched,
// and a skill the person added by hand stays.

import type { ProfileInput } from '@jobleft/contracts';

const norm = (s: string) => s.trim().toLowerCase();

export function mergeImported(cur: ProfileInput, file: ProfileInput): ProfileInput {
  const personal = { ...cur.personal };
  for (const k of Object.keys(file.personal) as Array<keyof ProfileInput['personal']>) {
    const v = file.personal[k];
    if (k === 'links') { if (file.personal.links.length) personal.links = file.personal.links; continue; }
    if (v !== null && v !== '') (personal as Record<string, unknown>)[k] = v;
  }
  const declined = new Set((cur.declinedSkills ?? []).map(norm));
  const fromFile = file.skills.filter((s) => !declined.has(norm(s.name)));
  const kept = cur.skills.filter((s) => !fromFile.some((f) => norm(f.name) === norm(s.name)));
  return {
    ...cur,
    personal,
    summary: file.summary ?? cur.summary,
    work: file.work.length ? file.work : cur.work,
    education: file.education.length ? file.education : cur.education,
    projects: file.projects.length ? file.projects : cur.projects,
    certifications: file.certifications.length ? file.certifications : cur.certifications,
    skills: [...fromFile, ...kept],
    ...((file.extraSections?.length ? { extraSections: file.extraSections } : {})),
  };
}

const ym = (d: string | null) => d ?? 'no date';

/** Plain lines that say what "use these facts" would change, including what would replace the person's own edits. */
export function importChanges(cur: ProfileInput | undefined, file: ProfileInput): { lines: string[]; replaces: string[] } {
  const lines: string[] = [];
  const replaces: string[] = [];
  const name = (p?: ProfileInput) => [p?.personal.firstName, p?.personal.lastName].filter(Boolean).join(' ');
  if (name(file) && name(file) !== name(cur)) lines.push(`Name: ${name(file)}`);
  if (file.personal.email && file.personal.email !== cur?.personal.email) lines.push(`Email: ${file.personal.email}`);
  if (file.personal.phone && file.personal.phone !== cur?.personal.phone) lines.push(`Phone: ${file.personal.phone}`);
  if (file.personal.city && file.personal.city !== cur?.personal.city) lines.push(`City: ${[file.personal.city, file.personal.region].filter(Boolean).join(', ')}`);
  if (file.summary && file.summary !== cur?.summary) lines.push('Summary');
  const had = cur?.work ?? [];
  if (file.work.length && JSON.stringify(file.work.map((w) => [w.company, w.title, w.startDate, w.endDate])) !== JSON.stringify(had.map((w) => [w.company, w.title, w.startDate, w.endDate]))) {
    lines.push(`Work experience: ${file.work.length} job${file.work.length === 1 ? '' : 's'} from the file`);
    for (const w of had) {
      const same = file.work.find((f) => norm(f.company) === norm(w.company));
      if (!same) replaces.push(`Your job at ${w.company} (${w.title}) is not in the file, so it would be replaced`);
      else if (norm(same.title) !== norm(w.title)) replaces.push(`Your title "${w.title}" at ${w.company} would become "${same.title}"`);
      else if (same.startDate !== w.startDate || same.endDate !== w.endDate) replaces.push(`Your dates at ${w.company} (${ym(w.startDate)} to ${ym(w.endDate)}) would become ${ym(same.startDate)} to ${ym(same.endDate)}`);
    }
  }
  if (file.education.length && JSON.stringify(file.education.map((e) => [e.school, e.degree, e.major])) !== JSON.stringify((cur?.education ?? []).map((e) => [e.school, e.degree, e.major]))) lines.push(`Education: ${file.education.length} school${file.education.length === 1 ? '' : 's'} from the file`);
  const declined = new Set((cur?.declinedSkills ?? []).map(norm));
  const back = file.skills.map((s) => s.name).filter((s) => !cur?.skills.some((c) => norm(c.name) === norm(s)) && !declined.has(norm(s)));
  if (back.length) lines.push(`Skills added: ${back.join(', ')}`);
  if (cur && cur.skills.length) replaces.push(...back.length ? [`Skills you removed from your profile would come back if they are in the file: ${back.join(', ')}`] : []);
  return { lines, replaces };
}
