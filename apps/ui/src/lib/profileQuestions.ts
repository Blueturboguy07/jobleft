// "Answer a few questions": plain questions built from concrete gaps in the stored profile, one field each. No model
// is involved: the person types into the field the question names, so nothing needs a truth check. An answer that is
// clearly not an answer (a placeholder, a run of one key, far too long for one line) is not saved (JL-resume-20).
import type { ProfileInput } from '@jobleft/contracts';

export type Question =
  | { kind: 'summary'; text: string; hint: string }
  | { kind: 'work_new'; text: string; hint: string }
  | { kind: 'education_new'; text: string; hint: string }
  | { kind: 'job_functions'; text: string; hint: string }
  | { kind: 'work_summary'; workId: string; text: string; hint: string }
  | { kind: 'work_bullet'; workId: string; text: string; hint: string }
  | { kind: 'skills'; text: string; hint: string }
  | { kind: 'education_achievement'; educationId: string; text: string; hint: string };

const MIN_BULLETS = 3;

/** Longest answer each question takes (one line on a resume, or one short list). */
export const ANSWER_MAX: Record<Question['kind'], number> = {
  summary: 600, work_new: 200, education_new: 200, job_functions: 300, work_summary: 300, work_bullet: 300, skills: 500, education_achievement: 300,
};

/** Questions for the gaps that lower a match score or leave a resume thin, in the order they matter. */
export function profileQuestions(p: ProfileInput): Question[] {
  const out: Question[] = [];
  if (!p.summary?.trim()) out.push({ kind: 'summary', text: 'In one or two sentences, what do you do and what are you looking for?', hint: 'This becomes the summary at the top of your resume.' });
  // An empty section is the biggest gap of all (JL-resume-11): ask for one entry; the rest can be added on the Profile screen.
  if (p.work.length === 0) out.push({ kind: 'work_new', text: 'What is your most recent job? Write the title and the employer.', hint: 'For example: Data Analyst at Contoso. Add dates and more jobs on the Profile screen.' });
  if (p.education.length === 0) out.push({ kind: 'education_new', text: 'Which school did you last attend, and what did you study?', hint: 'For example: Sample State University, B.S. in Computer Science. Skip it if you have no degree.' });
  if (p.preferences.jobFunctions.length === 0) out.push({ kind: 'job_functions', text: 'What kind of work are you looking for?', hint: 'One or more job functions, separated by commas. For example: Data analysis, Software engineering. They drive your job feed and match scores.' });
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

const PLACEHOLDER = /^(?:asdf\w*|qwer\w*|zxcv\w*|test(?:ing)?|lorem|ipsum|foo|bar|baz|abc|xyz|n\/?a|none|nothing|tbd|todo|blah|idk|\.+|-+|\?+)$/i;

/** "Data Analyst at Contoso" -> title and employer; null when the answer does not name both. */
export function parseJob(answer: string): { title: string; company: string } | null {
  const m = /^(.+?)\s+(?:at|@|with|for)\s+(.+)$/i.exec(answer.trim()) ?? /^(.+?)\s*[,–—|-]\s+(.+)$/.exec(answer.trim());
  if (!m) return null;
  const title = m[1]!.trim().replace(/[.,;]+$/, '');
  const company = m[2]!.trim().replace(/[.,;]+$/, '');
  return title && company ? { title, company } : null;
}

/**
 * Why an answer cannot be saved, in one plain sentence, or null when it can. Only what is plainly not an answer is
 * refused; words in any language are the person's own and are kept as written.
 */
export function answerProblem(q: Question, answer: string): string | null {
  const a = answer.trim();
  if (!a) return null;
  const max = ANSWER_MAX[q.kind];
  if ([...a].length > max) return `This answer is ${[...a].length} characters long; this field takes at most ${max}. Shorten it to one line.`;
  if (!/\p{L}/u.test(a)) return 'Write the answer in words.';
  if (/(\S)\1{5,}/u.test(a)) return 'This looks like one key held down, not an answer. Write it in your own words, or skip the question.';
  if (a.split(/[,;\n]/).every((part) => PLACEHOLDER.test(part.trim()))) return 'This looks like a placeholder, not an answer. Write it in your own words, or skip the question.';
  const sentence = q.kind === 'summary' || q.kind === 'work_summary' || q.kind === 'work_bullet' || q.kind === 'education_achievement';
  if (sentence && a.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length < 2 && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u.test(a)) {
    return 'Write a short sentence (a few words), or skip the question.';
  }
  if (q.kind === 'work_new' && !parseJob(a)) return 'Write the title and the employer, for example: Data Analyst at Contoso.';
  return null;
}

let seq = 0;
const newId = (prefix: string) => `${prefix}-q-${Date.now().toString(36)}-${++seq}`;
const list = (a: string) => [...new Set(a.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean))];

/** The profile with one answer written into the field its question names. An empty or refused answer changes nothing. */
export function applyAnswer(p: ProfileInput, q: Question, answer: string): ProfileInput {
  const a = answer.trim();
  if (!a || answerProblem(q, a)) return p;
  switch (q.kind) {
    case 'summary': return { ...p, summary: a };
    case 'work_new': {
      const j = parseJob(a)!;
      return { ...p, work: [{ id: newId('w'), company: j.company, title: j.title, employmentType: null, location: null, startDate: null, endDate: null, current: false, summary: null, bullets: [] }, ...p.work] };
    }
    case 'education_new': {
      const [school, ...rest] = a.split(',').map((x) => x.trim());
      const study = rest.join(', ');
      const dm = /^(.+?)\s+in\s+(.+)$/i.exec(study);
      return { ...p, education: [{ id: newId('e'), school: school!, degree: dm ? dm[1]! : null, major: dm ? dm[2]! : (study || null), gpa: null, startDate: null, endDate: null, current: false, achievements: [], coursework: [] }, ...p.education] };
    }
    case 'job_functions': return { ...p, preferences: { ...p.preferences, jobFunctions: list(a) } };
    case 'skills': {
      const have = new Set(p.skills.map((s) => s.name.toLowerCase()));
      const add: string[] = [];
      for (const s of list(a)) { if (!have.has(s.toLowerCase())) { have.add(s.toLowerCase()); add.push(s); } }
      return { ...p, skills: [...p.skills, ...add.map((name) => ({ name, years: null, source: 'user' as const }))] };
    }
    case 'work_summary': return { ...p, work: p.work.map((w) => (w.id === q.workId ? { ...w, summary: a } : w)) };
    case 'work_bullet': return { ...p, work: p.work.map((w) => (w.id === q.workId ? { ...w, bullets: [...w.bullets, a] } : w)) };
    case 'education_achievement': return { ...p, education: p.education.map((e) => (e.id === q.educationId ? { ...e, achievements: [...e.achievements, a] } : e)) };
  }
}
