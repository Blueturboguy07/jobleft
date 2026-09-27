import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAnswer, profileQuestions } from '../src/lib/profileQuestions.ts';
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
  assert.deepEqual(qs.map((q) => q.kind), ['summary', 'skills', 'work_summary', 'work_bullet', 'education_achievement']);
  assert.match(qs[3]!.text, /Software Engineer at Northwind Sample Labs/);
});

test('answers land in the named field; a blank answer changes nothing; a full profile asks nothing', () => {
  let p = base;
  for (const q of profileQuestions(base)) p = applyAnswer(p, q, q.kind === 'skills' ? 'Python, SQL, python' : q.kind === 'work_bullet' ? 'Cut a nightly job from 3 hours to 40 minutes.' : 'Answer.');
  assert.equal(p.summary, 'Answer.');
  assert.deepEqual(p.skills.map((s) => s.name), ['Python', 'SQL']);
  assert.equal(p.work[0]!.summary, 'Answer.');
  assert.deepEqual(p.work[0]!.bullets, ['Built a billing API.', 'Cut a nightly job from 3 hours to 40 minutes.']);
  assert.deepEqual(p.education[0]!.achievements, ['Answer.']);
  assert.equal(applyAnswer(base, profileQuestions(base)[0]!, '   '), base);
  const full = { ...p, work: [{ ...p.work[0]!, bullets: [...p.work[0]!.bullets, 'Two.', 'Three.'] }] };
  assert.deepEqual(profileQuestions(full), []);
});
