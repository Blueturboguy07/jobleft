import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProfileInput } from '@jobleft/contracts';
import { cleanForSave, problemsIn, serverProblems, uniqueNames } from '../src/lib/profileErrors.ts';

const base: ProfileInput = {
  personal: { firstName: 'Jordan', middleName: null, lastName: 'Testwell', email: null, phone: null, addressLine: null, city: null, region: null, postalCode: null, country: null, links: [] },
  summary: null, education: [], work: [], projects: [], certifications: [], skills: [],
  preferences: { jobFunctions: [], targetTitles: [], employmentTypes: [], workModels: [], levels: [], countries: [], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
  workAuthorization: { usAuthorized: null, needsSponsorship: null, usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
  eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
};

test('an unfilled "Add a link" row never blocks the Personal save (JL-onboarding-15)', () => {
  const p = { ...base, personal: { ...base.personal, middleName: 'R', links: [{ label: 'LinkedIn', url: 'https://www.linkedin.com/in/jordan' }, { label: 'Portfolio', url: 'https://' }] } };
  assert.deepEqual(problemsIn(p, ['personal']), []);
  assert.deepEqual(cleanForSave(p).personal.links.map((l) => l.label), ['LinkedIn']);
  const wrong = { ...p, personal: { ...p.personal, links: [{ label: 'X', url: 'javascript:alert(1)' }] } };
  assert.deepEqual(problemsIn(wrong, ['personal']).map((x) => x.path), ['/personal/links/0/url']);
});

test('About you: bad email and phone are named; blank-only city is empty (JL-onboarding-5)', () => {
  const p = { ...base, personal: { ...base.personal, email: 'not-an-email', phone: 'call me maybe', city: '   ' } };
  const paths = ['firstName', 'lastName', 'email', 'phone', 'city', 'region'].map((k) => `/personal/${k}`);
  assert.deepEqual(problemsIn(p, ['personal'], paths).map((x) => x.path), ['/personal/email', '/personal/phone']);
  assert.equal(cleanForSave(p).personal.city, null);
});

test('a refused save is told in plain words, with the row named', () => {
  const out = serverProblems({ issues: [{ path: '/personal/links/1/url', message: 'must be an absolute URL' }, { path: '/personal/email', message: 'Email: type an address like name@example.com.' }] });
  assert.deepEqual(out.map((x) => x.message), [
    'Links, row 2: type the full address, for example https://example.com/you, or remove the row.',
    'Email: type an address like name@example.com.',
  ]);
  assert.deepEqual(serverProblems(null), []);
});

test('skills: blanks and letter-case duplicates are dropped (JL-onboarding-19)', () => {
  // A name longer than 100 characters is left out with a message, never cut to 100 in silence (JL-onboarding-19 residue).
  assert.deepEqual(uniqueNames(['TypeScript', 'typescript', '   ', ' SQL ', 'K'.repeat(500)]), ['TypeScript', 'SQL']);
  assert.deepEqual(uniqueNames(['K'.repeat(100)]).map((x) => x.length), [100]);
});

test('a too-long skill name, a negative or non-number amount are refused with a plain message (JL-onboarding-19, -21)', async () => {
  const { PAY_RULE, longSkillText, numberProblem, skillYearsRule } = await import('../src/lib/profileErrors.ts');
  assert.match(longSkillText(['SQL', 'K'.repeat(500)])!, /at most 100 characters.*has 500, so it was not added/);
  assert.equal(longSkillText(['SQL', 'K'.repeat(100)]), null);
  const years = skillYearsRule('TypeScript');
  assert.match(numberProblem(-3, years)!, /^Years of TypeScript: type a number from 0 to 60\. "-3" was not kept\.$/);
  assert.match(numberProblem('-3', years)!, /"-3" was not kept/);
  assert.ok(numberProblem(61, years));
  for (const ok of [0, 3, 2.5, 60, '', '  ']) assert.equal(numberProblem(ok, years), null, String(ok));
  assert.match(numberProblem('-5000', PAY_RULE)!, /^Minimum yearly pay: type an amount from \$0 to \$10,000,000\. "-5000" was not kept\.$/);
  assert.match(numberProblem('abc', PAY_RULE)!, /"abc" is not a number, so it was not kept/);
  assert.match(numberProblem('99999999999999999999999', PAY_RULE)!, /was not kept/);
  for (const ok of [0, 120000, '120,000', '$150,000', 10_000_000]) assert.equal(numberProblem(ok, PAY_RULE), null, String(ok));
});

test('work-authorization answers that cannot all be true are pointed out (JL-onboarding-20)', async () => {
  const { authConflicts } = await import('../src/lib/profileErrors.ts');
  const wa = { usAuthorized: 'no' as const, needsSponsorship: 'yes' as const, usCitizen: 'yes' as const, hasSecurityClearance: null, authorizedCountries: [] };
  assert.equal(authConflicts(wa).length, 2);
  assert.deepEqual(authConflicts({ ...wa, usCitizen: 'no' }), []);
});
