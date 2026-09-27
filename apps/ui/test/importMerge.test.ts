import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProfileInput } from '@jobleft/contracts';
import { importChanges, mergeImported } from '../src/lib/importMerge.ts';

const empty = (): ProfileInput => ({
  personal: { firstName: 'Jordan', middleName: null, lastName: 'Testwell', email: 'jordan.testwell@example.com', phone: '+1 555 0100', addressLine: null, city: 'Austin', region: 'TX', postalCode: null, country: 'US', links: [] },
  summary: null, education: [], certifications: [], projects: [], work: [], skills: [],
  preferences: { jobFunctions: [], targetTitles: [], employmentTypes: [], workModels: [], levels: [], countries: [], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
  workAuthorization: { usAuthorized: null, needsSponsorship: null, usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
  eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
  extraSections: [],
});

// The person's profile (JL-resume-12): LinkedIn and Portfolio links, "SQL · 3 yr" typed by the person, own summary.
const mine = (): ProfileInput => ({
  ...empty(),
  personal: { ...empty().personal, links: [{ label: 'LinkedIn', url: 'https://www.linkedin.com/in/jordan-testwell-example' }, { label: 'Portfolio', url: 'https://example.com/jordan' }] },
  summary: 'Backend engineer (my own words).',
  skills: [{ name: 'SQL', years: 3, source: 'user' }],
  work: [{ id: 'w-own', company: 'Fabrikam Sample Inc', title: 'Analyst', employmentType: null, location: null, startDate: '2019-01', endDate: '2020-12', current: false, summary: null, bullets: ['Built weekly reports.'] }],
});

// What jordan-one-column.pdf gives: Website and GitHub links, 12 skills with SQL, the file's summary, two jobs.
const file = (): ProfileInput => ({
  ...empty(),
  personal: { ...empty().personal, phone: '555-0100', links: [{ label: 'Website', url: 'https://example.com/jordan' }, { label: 'GitHub', url: 'https://github.com/jordan-testwell-example' }] },
  summary: 'Software engineer with 3 years of backend experience building APIs and data pipelines.',
  skills: ['TypeScript', 'Python', 'SQL', 'Linux'].map((name) => ({ name, years: null, source: 'resume' as const })),
  work: [{ id: 'w-file', company: 'Northwind Sample Labs', title: 'Software Engineer', employmentType: null, location: 'Austin, TX', startDate: '2023-06', endDate: null, current: true, summary: null, bullets: ['Cut batch-job time by 40%.'] }],
});

test('links and the person\'s skill years stay; a job the file does not mention stays (JL-resume-12)', () => {
  const next = mergeImported(mine(), file());
  assert.deepEqual(next.personal.links.map((l) => l.url), ['https://www.linkedin.com/in/jordan-testwell-example', 'https://example.com/jordan', 'https://github.com/jordan-testwell-example']);
  assert.deepEqual(next.skills.find((s) => s.name === 'SQL'), { name: 'SQL', years: 3, source: 'user' });
  assert.deepEqual(next.skills.map((s) => s.name), ['SQL', 'TypeScript', 'Python', 'Linux']);
  assert.deepEqual(next.work.map((w) => w.company), ['Northwind Sample Labs', 'Fabrikam Sample Inc']);
  assert.deepEqual(next.preferences, mine().preferences);
});

test('the dialog lists every change, shows the new summary text, and says what it replaces', () => {
  const { lines, replaces } = importChanges(mine(), file());
  const all = lines.join('\n');
  assert.match(all, /Phone: “\+1 555 0100” becomes “555-0100”/);
  assert.match(all, /Links added: https:\/\/github.com\/jordan-testwell-example/);
  assert.doesNotMatch(all, /linkedin/i, 'no link is removed, so none is listed as going');
  assert.match(all, /Summary: “Software engineer with 3 years/);
  assert.match(all, /New job from the file: Software Engineer at Northwind Sample Labs/);
  assert.match(all, /Skills added: TypeScript, Python, Linux/);
  assert.ok(replaces.some((r) => /Your summary “Backend engineer \(my own words\)\.” would be replaced/.test(r)));
  assert.ok(replaces.some((r) => /Your phone/.test(r)));
  // Every area the merge changes has a line (the button does nothing the dialog does not list).
  const cur = mine();
  const next = mergeImported(cur, file());
  for (const k of Object.keys(next) as Array<keyof ProfileInput>) {
    if (JSON.stringify(next[k]) === JSON.stringify(cur[k])) continue;
    const words: Partial<Record<keyof ProfileInput, RegExp>> = { personal: /Phone|Links|name|Email|City/, summary: /Summary/, work: /job/, skills: /Skills/, education: /school/, projects: /project/ };
    assert.ok(words[k] && words[k]!.test(all), `a change to ${String(k)} is not listed`);
  }
});

test('no false "skills you removed" warning when the person removed none (JL-resume-2)', () => {
  const cur = { ...empty(), skills: [{ name: 'SQL', years: null, source: 'user' as const }] };
  const { lines, replaces } = importChanges(cur, file());
  assert.ok(lines.some((l) => /Skills added: TypeScript, Python, Linux/.test(l)));
  assert.ok(!replaces.some((r) => /removed|come back/i.test(r)), replaces.join('\n'));
});

test('an entry the file also has is updated in place, keeping its id, and each changed field is listed', () => {
  const cur = { ...empty(), work: [{ id: 'w1', company: 'Northwind Sample Labs', title: 'Engineer', employmentType: null, location: 'Austin, TX', startDate: '2023-06', endDate: null, current: true, summary: 'asdf', bullets: ['Cut batch-job time by 40%.', 'My own line.'] }] };
  const next = mergeImported(cur, file());
  assert.equal(next.work.length, 1);
  assert.equal(next.work[0]!.id, 'w1');
  const { lines, replaces } = importChanges(cur, file());
  assert.ok(lines.some((l) => /title “Engineer” becomes “Software Engineer”/.test(l)));
  assert.ok(replaces.some((r) => /Your line “My own line\.”/.test(r)));
  assert.ok(replaces.some((r) => /one-line summary “asdf”/.test(r)));
  assert.deepEqual(importChanges(next, file()).lines, [], 'nothing left to change the second time');
});
