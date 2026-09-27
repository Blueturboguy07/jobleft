import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OnboardingState, Profile, ProfileInput } from '@jobleft/contracts';
import { addJobFunction, bodyToSave, closedState, keptState, resumeSetup, setupPending, toInput } from '../src/lib/onboarding.ts';

const input: ProfileInput = {
  personal: { firstName: null, middleName: null, lastName: null, email: null, phone: null, addressLine: null, city: null, region: null, postalCode: null, country: null, links: [] },
  summary: null, education: [], work: [], projects: [], certifications: [], skills: [],
  preferences: { jobFunctions: [], targetTitles: [], employmentTypes: [], workModels: [], levels: [], countries: [], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
  workAuthorization: { usAuthorized: null, needsSponsorship: null, usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
  eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
};
const profile: Profile = { id: 'default', version: 'v1', updatedAt: '2026-09-27T00:00:00.000Z', ...input };
const fresh: OnboardingState = { status: 'new', step: 0, draft: null, pendingImport: null };

test('a reload opens the step the person was on, with what they chose and did not save yet (JL-onboarding-2, -11)', () => {
  const typed = { ...input, preferences: { ...input.preferences, employmentTypes: ['full_time' as const], workModels: ['remote' as const], minAnnualPayUsd: 150000 } };
  const kept = keptState('new', 1, typed, null, profile);
  assert.equal(kept.status, 'active', 'the first change starts the setup');
  assert.equal(kept.step, 1);
  assert.deepEqual(kept.draft, typed);
  const back = resumeSetup(JSON.parse(JSON.stringify(kept)) as OnboardingState, profile);
  assert.equal(back.step, 1);
  assert.deepEqual(back.d, typed);
  // nothing typed beyond the saved profile: no draft is kept, the profile is the answer
  assert.equal(keptState('active', 2, toInput(profile), null, profile).draft, null);
  assert.deepEqual(resumeSetup(fresh, profile), { step: 0, d: toInput(profile), pending: null });
  assert.equal(resumeSetup({ ...fresh, step: 99 }, profile).step, 5);
});

test('the setup opens at launch until it is finished or skipped', () => {
  assert.equal(setupPending(fresh, false), true);
  assert.equal(setupPending({ ...fresh, status: 'active', step: 1 }, false), true, 'a quit after step 1 continues the setup');
  assert.equal(setupPending({ ...fresh, status: 'active', step: 1 }, true), true);
  assert.equal(setupPending({ ...fresh, status: 'done' }, false), false);
  assert.equal(setupPending({ ...fresh, status: 'skipped' }, false), false);
  assert.equal(setupPending(fresh, true), false, 'a skip kept by jobleft 0.1.2 in the browser still counts');
});

test('skip and finish keep what was chosen, and leave nothing waiting (JL-onboarding-14)', () => {
  const chosen = { ...input, preferences: { ...input.preferences, jobFunctions: ['Sales'] } };
  assert.deepEqual(bodyToSave(chosen, null), chosen);
  const pending = { resumeId: 'res_1', report: {} as never, useFacts: true, proposed: { ...input, personal: { ...input.personal, firstName: 'Jordan' }, skills: [{ name: 'SQL', years: null, source: 'resume' as const }] } };
  const merged = bodyToSave(chosen, pending);
  assert.equal(merged.personal.firstName, 'Jordan');
  assert.deepEqual(merged.preferences.jobFunctions, ['Sales'], 'a resume never changes the preferences');
  assert.deepEqual(bodyToSave(chosen, { ...pending, useFacts: false }), chosen);
  assert.deepEqual(closedState('active', 'skipped'), { status: 'skipped', step: 0, draft: null, pendingImport: null });
  assert.equal(closedState('done', 'skipped').status, 'done', 'skipping a reopened setup keeps it finished');
  assert.equal(closedState('active', 'done').status, 'done');
});

test('a typed job function never duplicates a listed or chosen one (JL-onboarding-24)', () => {
  const listed = ['Software Engineering', 'Sales'];
  assert.deepEqual(addJobFunction(['Software Engineering'], 'software engineering', listed), ['Software Engineering']);
  assert.deepEqual(addJobFunction([], 'SALES', listed), ['Sales']);
  assert.deepEqual(addJobFunction(['Robotics QA'], ' robotics  qa ', listed), ['Robotics QA']);
  assert.deepEqual(addJobFunction([], '   ', listed), []);
  assert.equal(addJobFunction([], 'Z'.repeat(400), listed)[0]!.length, 100);
});

test('"Use another file" replaces the file, and the kept file becomes primary when the replaced one was (JL-onboarding-4)', async () => {
  const { replaceUpload } = await import('../src/lib/onboarding.ts');
  const rows = new Map([['res_a', true], ['res_old', false]]);
  const api = {
    isPrimary: async (id: string) => rows.get(id) ?? false,
    remove: async (id: string) => { rows.delete(id); },
    makePrimary: async (id: string) => { for (const k of rows.keys()) rows.set(k, false); rows.set(id, true); },
  };
  rows.set('res_b', false);
  await replaceUpload(api, 'res_a', 'res_b');
  assert.deepEqual([...rows.entries()].sort(), [['res_b', true], ['res_old', false]]);
  rows.set('res_c', false);
  await replaceUpload(api, 'res_b', 'res_c');
  assert.deepEqual([...rows.entries()].sort(), [['res_c', true], ['res_old', false]]);
  await replaceUpload(api, null, 'res_c');
  assert.equal(rows.size, 2);
});
