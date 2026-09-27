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
  assert.deepEqual(uniqueNames(['TypeScript', 'typescript', '   ', ' SQL ', 'K'.repeat(500)]).map((x) => x.slice(0, 5)), ['TypeS', 'SQL', 'KKKKK']);
  assert.equal(uniqueNames(['K'.repeat(500)])[0]!.length, 100);
});
