// JL-onboarding-5, -15, -16: plain checks of what a person types into the profile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankToNull, emptyProfileLike, profileIssues, type ProfileInput } from './profile-check-fixture.ts';

const NOW = new Date('2026-09-27T12:00:00Z');

test('email, phone and names are checked, with the field named in each message', () => {
  const p = emptyProfileLike();
  const bad: ProfileInput = { ...p, personal: { ...p.personal, firstName: 'محمد 🚀', lastName: 'L'.repeat(10_000), email: 'not-an-email', phone: 'call me maybe' } };
  const msgs = profileIssues(bad, null, NOW).map((i) => i.message);
  assert.deepEqual(msgs, [
    'Last name: use at most 100 characters.',
    'Email: type an address like name@example.com.',
    'Phone: type the number with its digits, for example +1 555 010 0100.',
  ]);
  const good: ProfileInput = { ...p, personal: { ...p.personal, firstName: 'Jordan', lastName: 'Testwell', email: 'jordan.testwell@example.com', phone: '555-0100' } };
  assert.deepEqual(profileIssues(good, null, NOW), []);
  for (const phone of ['+1 (555) 010-0100', '+44 20 7946 0958', '555.010.0100 ext. 12']) assert.deepEqual(profileIssues({ ...good, personal: { ...good.personal, phone } }, null, NOW), [], phone);
  assert.equal(profileIssues({ ...good, personal: { ...good.personal, email: 'a@b.com\nBcc: x@y.com' } }, null, NOW).length, 1, 'a line break is never part of an email');
  assert.equal(profileIssues({ ...good, personal: { ...good.personal, firstName: '🚀🚀' } }, null, NOW)[0]?.message, 'First name: type a name with letters.');
});

test('blank-only text is empty', () => {
  const p = emptyProfileLike();
  const out = blankToNull({ ...p, personal: { ...p.personal, city: '   ', firstName: ' Jo ' }, summary: '  ' });
  assert.equal(out.personal.city, null);
  assert.equal(out.personal.firstName, ' Jo ', 'other text is kept as typed');
  assert.equal(out.summary, null);
});

test('a link row names its problem; end before start and a blank company are refused', () => {
  const p = emptyProfileLike();
  const links = profileIssues({ ...p, personal: { ...p.personal, links: [{ label: 'Portfolio', url: 'https://' }, { label: 'X', url: 'not a url at all' }] } }, null, NOW);
  assert.deepEqual(links.map((i) => i.path), ['/personal/links/0/url', '/personal/links/1/url']);
  assert.match(links[0]!.message, /^Links, row 1: type the full address/);
  const edu = { id: 'e1', school: 'Sample State University', degree: null, major: null, gpa: 'abc', startDate: '2030-09', endDate: '2025-01', current: false, achievements: [], coursework: [] };
  const work = { id: 'w2', company: '   ', title: 'Junior Developer', employmentType: null, location: null, startDate: '2027-03', endDate: '2020-01', current: false, summary: null, bullets: [] };
  const msgs = profileIssues({ ...p, education: [edu], work: [work] }, null, NOW).map((i) => i.message);
  assert.deepEqual(msgs, [
    'Education, Sample State University: the end (Jan 2025) is before the start (Sep 2030).',
    'Work experience, job 1: the end (Jan 2020) is before the start (Mar 2027).',
    'Work experience, job 1: add the company name.',
  ]);
  assert.match(profileIssues({ ...p, work: [{ ...work, company: 'Acme', endDate: null, current: true }] }, null, NOW)[0]!.message, /you marked it as now, but it starts in Mar 2027/);
  assert.deepEqual(profileIssues({ ...p, work: [{ ...work, company: 'Acme', startDate: '2020', endDate: '2020-06' }] }, null, NOW), [], 'a year alone is compared by its months');
});

test('with the stored profile, only new or changed values are checked; entries a resume brought in pass', () => {
  const p = emptyProfileLike();
  const stored: ProfileInput = { ...p, personal: { ...p.personal, email: 'old@localhost' } };
  const work = { id: 'w1', company: 'Acme', title: 'Analyst', employmentType: null, location: null, startDate: '2022-06', endDate: '2021-01', current: false, summary: null, bullets: [] };
  assert.deepEqual(profileIssues({ ...stored, personal: { ...stored.personal, firstName: 'Jordan' }, work: [work] }, stored, NOW), [], 'an old email and a new imported entry do not block a save');
  const edited = profileIssues({ ...stored, work: [{ ...work, endDate: '2020-01' }] }, { ...stored, work: [{ ...work, endDate: null }] }, NOW);
  assert.equal(edited.length, 1, 'an edited entry is checked');
  assert.equal(profileIssues({ ...stored, personal: { ...stored.personal, email: 'x' } }, stored, NOW).length, 1, 'a changed email is checked');
});
