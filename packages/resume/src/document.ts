// Resume documents built from the profile, date formatting, and plain-text views of a document.

import type { Profile, ResumeDocument, ResumeItem, ResumeSection } from '@jobleft/contracts';
import { MONTH_ABBR } from './lexicon.ts';
import { stableId } from './text.ts';
import { headerFromProfile } from './truth.ts';

export const SECTION_TITLES: Readonly<Record<ResumeSection['kind'], string>> = {
  summary: 'Summary', experience: 'Experience', education: 'Education', skills: 'Skills', projects: 'Projects',
  certifications: 'Certifications', custom: 'Other',
};

export function degreeLine(degree: string | null, major: string | null): string | null {
  if (degree && major) return `${degree} in ${major}`;
  return degree ?? major ?? null;
}

/** A base resume document from the profile. The header is copied character for character (resume O5). */
export function documentFromProfile(p: Profile): ResumeDocument {
  const sections: ResumeSection[] = [];
  if (p.summary && p.summary.trim()) sections.push({ id: 'summary', kind: 'summary', title: SECTION_TITLES.summary, text: p.summary, items: [] });
  if (p.work.length) {
    sections.push({
      id: 'experience', kind: 'experience', title: SECTION_TITLES.experience, text: null,
      items: p.work.map((w): ResumeItem => ({
        id: w.id, heading: w.company, subheading: w.title, location: w.location, startDate: w.startDate, endDate: w.current ? null : w.endDate,
        current: w.current, bullets: [...(w.summary && w.summary.trim() ? [w.summary] : []), ...w.bullets], tags: [],
      })),
    });
  }
  if (p.education.length) {
    sections.push({
      id: 'education', kind: 'education', title: SECTION_TITLES.education, text: null,
      items: p.education.map((e): ResumeItem => ({
        id: e.id, heading: e.school, subheading: degreeLine(e.degree, e.major), location: null, startDate: e.startDate,
        endDate: e.current ? null : e.endDate, current: e.current,
        bullets: [
          ...(e.gpa ? [`GPA: ${e.gpa}`] : []),
          ...e.achievements,
          ...(e.coursework.length ? [`Relevant coursework: ${e.coursework.join(', ')}`] : []),
        ],
        tags: [],
      })),
    });
  }
  if (p.skills.length) {
    sections.push({
      id: 'skills', kind: 'skills', title: SECTION_TITLES.skills, text: null,
      items: [{ id: 'skills-list', heading: null, subheading: null, location: null, startDate: null, endDate: null, current: false, bullets: [], tags: p.skills.map((s) => s.name) }],
    });
  }
  if (p.projects.length) {
    sections.push({
      id: 'projects', kind: 'projects', title: SECTION_TITLES.projects, text: null,
      items: p.projects.map((pr): ResumeItem => ({
        id: pr.id, heading: pr.name, subheading: pr.description, location: null, startDate: pr.startDate, endDate: pr.endDate, current: false,
        bullets: [...pr.bullets], tags: pr.url ? [pr.url] : [],
      })),
    });
  }
  if (p.certifications.length) {
    sections.push({
      id: 'certifications', kind: 'certifications', title: SECTION_TITLES.certifications, text: null,
      items: p.certifications.map((c): ResumeItem => ({
        id: stableId('cert-', c.name), heading: c.name, subheading: c.issuer, location: null, startDate: c.date, endDate: null, current: false, bullets: [], tags: [],
      })),
    });
  }
  for (const x of p.extraSections ?? []) {
    if (!x.lines.length) continue;
    sections.push({
      id: `x-${x.id}`, kind: 'custom', title: x.title, text: null,
      items: [{ id: `${x.id}-lines`, heading: null, subheading: null, location: null, startDate: null, endDate: null, current: false, bullets: [...x.lines], tags: [] }],
    });
  }
  return { header: headerFromProfile(p), sections };
}

export function formatYm(ym: string | null): string {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  if (!m) return y!;
  return `${MONTH_ABBR[Number(m) - 1]} ${y}`;
}

/** "Jun 2023 – Present", "2019 – 2021", "May 2021". */
export function dateRange(item: Pick<ResumeItem, 'startDate' | 'endDate' | 'current'>): string {
  const a = formatYm(item.startDate);
  const b = item.current ? 'Present' : formatYm(item.endDate);
  if (a && b) return a === b ? a : `${a} – ${b}`;
  return a || b;
}

/** Plain text of a document in reading order (what an exported file says). */
export function documentText(doc: ResumeDocument): string {
  const lines: string[] = [];
  const h = doc.header;
  lines.push(h.name);
  lines.push([h.email, h.phone, h.city, ...h.links.map((l) => l.url)].filter(Boolean).join(' | '));
  for (const s of doc.sections) {
    lines.push('', s.title);
    if (s.text) lines.push(s.text);
    for (const it of s.items) {
      if (s.kind === 'skills') {
        lines.push([it.heading ? `${it.heading}:` : '', it.tags.join(', ')].filter(Boolean).join(' '));
        for (const b of it.bullets) lines.push(`• ${b}`);
        continue;
      }
      const bold = s.kind === 'projects' || s.kind === 'certifications' ? it.heading : (it.subheading ?? it.heading);
      const rest = s.kind === 'projects' || s.kind === 'certifications' ? [it.subheading] : it.subheading ? [it.heading] : [];
      const head = [bold, ...rest].filter(Boolean).join(' — ');
      if (head) lines.push(head);
      const second = s.kind === 'certifications' ? formatYm(it.startDate ?? it.endDate)
        : [dateRange(it), ...(s.kind === 'projects' ? it.tags : [it.location])].filter((x) => x && String(x).trim()).join(' | ');
      if (second) lines.push(second);
      for (const b of it.bullets) lines.push(`• ${b}`);
    }
  }
  return lines.join('\n');
}

export function cloneDoc(doc: ResumeDocument): ResumeDocument {
  return structuredClone(doc);
}
