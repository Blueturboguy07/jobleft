// "Answer a few questions": plain questions built from concrete gaps in the stored profile, one field each. No model
// is involved: the person types into the field the question names, so nothing needs a truth check.
import type { ProfileInput } from '@jobleft/contracts';

export type Question =
  | { kind: 'summary'; text: string; hint: string }
  | { kind: 'work_summary'; workId: string; text: string; hint: string }
  | { kind: 'work_bullet'; workId: string; text: string; hint: string }
  | { kind: 'skills'; text: string; hint: string }
  | { kind: 'education_achievement'; educationId: string; text: string; hint: string };

const MIN_BULLETS = 3;

/** Questions for the gaps that lower a match score or leave a resume thin, in the order they matter. */
export function profileQuestions(p: ProfileInput): Question[] {
  const out: Question[] = [];
  if (!p.summary?.trim()) out.push({ kind: 'summary', text: 'In one or two sentences, what do you do and what are you looking for?', hint: 'This becomes the summary at the top of your resume.' });
  if (p.skills.length === 0) out.push({ kind: 'skills', text: 'Which tools, languages or skills do you use most?', hint: 'Separate them with commas. They drive the Skills part of your match score.' });
  for (const w of p.work) {
    const at = `${w.title || 'your role'} at ${w.company || 'that employer'}`;
    if (!w.summary?.trim()) out.push({ kind: 'work_summary', workId: w.id, text: `In one sentence, what was ${at} about?`, hint: 'The one-line summary under that job.' });
    if (w.bullets.length < MIN_BULLETS) {
      const n = MIN_BULLETS - w.bullets.length;
      out.push({ kind: 'work_bullet', workId: w.id, text: `What is one thing you did as ${at}? A result with a number is best.`, hint: `${w.bullets.length} of ${MIN_BULLETS} bullets so far; ${n} more would help.` });
    }
  }
  for (const e of p.education) {
    if (e.achievements.length === 0) out.push({ kind: 'education_achievement', educationId: e.id, text: `Anything notable from ${e.school || 'that school'}? Honours, a thesis, a project, a club.`, hint: 'Skip it if there is nothing to add.' });
  }
  return out;
}

/** The profile with one answer written into the field its question names. An empty answer changes nothing. */
export function applyAnswer(p: ProfileInput, q: Question, answer: string): ProfileInput {
  const a = answer.trim();
  if (!a) return p;
  switch (q.kind) {
    case 'summary': return { ...p, summary: a };
    case 'skills': {
      const have = new Set(p.skills.map((s) => s.name.toLowerCase()));
      const add: string[] = [];
      for (const s of a.split(/[,;\n]/).map((x) => x.trim())) { if (s && !have.has(s.toLowerCase())) { have.add(s.toLowerCase()); add.push(s); } }
      return { ...p, skills: [...p.skills, ...add.map((name) => ({ name, years: null, source: 'user' as const }))] };
    }
    case 'work_summary': return { ...p, work: p.work.map((w) => (w.id === q.workId ? { ...w, summary: a } : w)) };
    case 'work_bullet': return { ...p, work: p.work.map((w) => (w.id === q.workId ? { ...w, bullets: [...w.bullets, a] } : w)) };
    case 'education_achievement': return { ...p, education: p.education.map((e) => (e.id === q.educationId ? { ...e, achievements: [...e.achievements, a] } : e)) };
  }
}
