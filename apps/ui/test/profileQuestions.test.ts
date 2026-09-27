import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerProblem, applyAnswer, parseJob, profileQuestions } from '../src/lib/profileQuestions.ts';
import type { ProfileInput } from '@jobleft/contracts';

const base: ProfileInput = {
  personal: { firstName: 'Jordan', middleName: null, lastName: 'Testwell', email: null, phone: null, addressLine: null, city: null, region: null, postalCode: null, country: null, links: [] },
  summary: null, education: [{ id: 'e1', school: 'Sample State University', degree: null, major: null, gpa: null, startDate: null, endDate: null, current: false, achievements: [], coursework: [] }],
  certifications: [], projects: [],
  work: [{ id: 'w1', company: 'Northwind Sample Labs', title: 'Software Engineer', employmentType: null, location: null, startDate: null, endDate: null, current: true, summary: null, bullets: ['Built a billing API.'] }],
  skills: [], preferences: { jobFunctions: [], targetTitles: [], employmentTypes: [], workModels: [], levels: [], countries: [], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
  workAuthorization: { usAuthorized: null, needsSponsorship: null, usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
  eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
};

test('questions come only from real gaps, one field each, in order', () => {
  const qs = profileQuestions(base);
  assert.deepEqual(qs.map((q) => q.kind), ['summary', 'job_functions', 'skills', 'work_summary', 'work_bullet', 'education_achievement']);
  assert.match(qs[4]!.text, /Software Engineer at Northwind Sample Labs/);
});

test('answers land in the named field; a blank answer changes nothing; a full profile asks nothing', () => {
  let p = base;
  const say = { skills: 'Python, SQL, python', work_bullet: 'Cut a nightly job from 3 hours to 40 minutes.', job_functions: 'Data analysis, Software engineering' } as Record<string, string>;
  for (const q of profileQuestions(base)) p = applyAnswer(p, q, say[q.kind] ?? 'A real answer.');
  assert.equal(p.summary, 'A real answer.');
  assert.deepEqual(p.skills.map((s) => s.name), ['Python', 'SQL']);
  assert.deepEqual(p.preferences.jobFunctions, ['Data analysis', 'Software engineering']);
  assert.equal(p.work[0]!.summary, 'A real answer.');
  assert.deepEqual(p.work[0]!.bullets, ['Built a billing API.', 'Cut a nightly job from 3 hours to 40 minutes.']);
  assert.deepEqual(p.education[0]!.achievements, ['A real answer.']);
  assert.equal(applyAnswer(base, profileQuestions(base)[0]!, '   '), base);
  const full = { ...p, work: [{ ...p.work[0]!, bullets: [...p.work[0]!.bullets, 'Two.', 'Three.'] }] };
  assert.ok(full.preferences.jobFunctions.length > 0);
  assert.deepEqual(profileQuestions(full), []);
});

test('a profile with no jobs, no schools and no job functions gets questions for them (JL-resume-11)', () => {
  // The golden store: a summary and one skill, nothing else.
  const golden = { ...base, summary: 'Data analyst.', skills: [{ name: 'SQL', years: null, source: 'user' as const }], work: [], education: [] };
  const qs = profileQuestions(golden);
  assert.deepEqual(qs.map((q) => q.kind), ['work_new', 'education_new', 'job_functions']);
  let p = applyAnswer(golden, qs[0]!, 'Data Analyst at Contoso Example Corp');
  assert.deepEqual([p.work[0]!.title, p.work[0]!.company, p.work[0]!.startDate], ['Data Analyst', 'Contoso Example Corp', null]);
  p = applyAnswer(p, qs[1]!, 'Sample State University, B.S. in Computer Science');
  assert.deepEqual([p.education[0]!.school, p.education[0]!.degree, p.education[0]!.major], ['Sample State University', 'B.S.', 'Computer Science']);
  p = applyAnswer(p, qs[2]!, 'Data analysis');
  assert.deepEqual(p.preferences.jobFunctions, ['Data analysis']);
  assert.ok(!profileQuestions(p).some((q) => ['work_new', 'education_new', 'job_functions'].includes(q.kind)), 'the new entries now get their own follow-up questions');
  assert.deepEqual(parseJob('Contoso'), null);
  assert.match(answerProblem(qs[0]!, 'Contoso') ?? '', /title and the employer/);
});

test('placeholders, one key held down and far too long answers are not saved; other languages are (JL-resume-20)', () => {
  const qs = profileQuestions(base);
  const ws = qs.find((q) => q.kind === 'work_summary')!;
  const ach = qs.find((q) => q.kind === 'education_achievement')!;
  for (const junk of ['asdf', 'x'.repeat(5000), 'xxxxxxxx', '....', 'test', 'n/a']) {
    assert.ok(answerProblem(junk.length > 300 ? ach : ws, junk), junk.slice(0, 20));
    assert.equal(applyAnswer(base, junk.length > 300 ? ach : ws, junk), base, 'nothing saved');
  }
  assert.equal(answerProblem(ws, '🎯 تحسين الأداء — improved performance 日本語'), null);
  assert.equal(answerProblem(ws, 'Built the billing API for small shops.'), null);
  assert.equal(answerProblem(qs.find((q) => q.kind === 'skills')!, 'Go'), null, 'a one-word skill is fine');
});
