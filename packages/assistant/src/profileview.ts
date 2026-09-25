// The person's profile as the model may see it (O11): skills, work history, education, summary and search preferences.
// NEVER: equal-employment answers (disability, veteran, gender, race, ...), work authorization answers, or contact
// details (email, phone, street address, links). The name is left out too: a question about a job never needs it.

import type { Profile } from '@jobleft/contracts';
import { clip } from './views.ts';

export interface ProfileForModel {
  summary: string | null;
  skills: string[];
  work: Array<{ title: string; company: string; from: string | null; to: string | null; current: boolean; highlights: string[] }>;
  education: Array<{ school: string; degree: string | null; major: string | null }>;
  certifications: string[];
  wants: { titles: string[]; workModels: string[]; levels: string[]; minAnnualPayUsd: number | null; places: string[] };
}

export function profileForModel(p: Profile): ProfileForModel {
  return {
    summary: p.summary ? clip(p.summary, 600) : null,
    skills: p.skills.map((s) => s.name).slice(0, 60),
    work: p.work.slice(0, 8).map((w) => ({
      title: w.title, company: w.company, from: w.startDate, to: w.current ? null : w.endDate, current: w.current,
      highlights: w.bullets.slice(0, 4).map((b) => clip(b, 200)),
    })),
    education: p.education.slice(0, 4).map((e) => ({ school: e.school, degree: e.degree, major: e.major })),
    certifications: p.certifications.map((c) => c.name).slice(0, 10),
    wants: {
      titles: p.preferences.targetTitles.slice(0, 5), workModels: p.preferences.workModels, levels: p.preferences.levels,
      minAnnualPayUsd: p.preferences.minAnnualPayUsd, places: p.preferences.places.map((x) => x.text).slice(0, 5),
    },
  };
}

/** All the person's own words that a practice sample may quote (used to check a sample answer for invented facts). */
export function profileWords(p: Profile | null): string {
  if (!p) return '';
  const v = profileForModel(p);
  return [v.summary ?? '', v.skills.join(' '), ...v.work.flatMap((w) => [w.title, w.company, ...w.highlights]), ...v.education.flatMap((e) => [e.school, e.degree ?? '', e.major ?? '']), v.certifications.join(' ')].join(' ');
}
