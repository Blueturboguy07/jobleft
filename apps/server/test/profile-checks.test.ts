// JL-onboarding-5, -15, -16 on the local API: a profile save that brings a wrong email, phone, name, link or dates is
// refused in plain words that name the field, and nothing is saved; blank-only text is saved as empty.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, PERSONA, startTest } from './helpers.ts';

test('the profile route refuses what a person could not mean, and names the field', async () => {
  const s = await startTest('profile-checks');
  try {
    const bad = await s.call('PUT', '/api/v1/profile', { ...PERSONA, personal: { ...PERSONA.personal, email: 'not-an-email', phone: 'call me maybe', lastName: 'L'.repeat(10_000) } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.message, /^Last name: use at most 100 characters\. \(2 more problems to fix\.\) Nothing was saved\.$/);
    assert.deepEqual(bad.json.error.details.issues.map((i: { path: string }) => i.path), ['/personal/lastName', '/personal/email', '/personal/phone']);
    assert.equal((await s.call('GET', '/api/v1/profile')).json.personal.email, null, 'nothing was saved');

    const blank = await s.call('PUT', '/api/v1/profile', { ...PERSONA, personal: { ...PERSONA.personal, city: '   ', middleName: ' ' } });
    assert.equal(blank.status, 200, blank.text);
    assert.equal(blank.json.personal.city, null);
    assert.equal(blank.json.personal.middleName, null);

    // an edited entry with its end before its start, or its company emptied, is refused
    const work = { id: 'w1', company: 'Northwind Sample Labs', title: 'Junior Developer', employmentType: null, location: null, startDate: '2019-03', endDate: '2020-01', current: false, summary: null, bullets: [] };
    const withWork = await s.call('PUT', '/api/v1/profile', { ...PERSONA, work: [work] });
    assert.equal(withWork.status, 200, withWork.text);
    const swapped = await s.call('PUT', '/api/v1/profile', { ...PERSONA, work: [{ ...work, startDate: '2027-03', company: '   ' }] });
    assert.equal(swapped.status, 400);
    assert.deepEqual(swapped.json.error.details.issues.map((i: { message: string }) => i.message), [
      'Work experience, job 1: the end (Jan 2020) is before the start (Mar 2027).',
      'Work experience, job 1: add the company name.',
    ]);
    // a link with no address is refused with its row named (the editor drops such a row before it saves)
    const link = await s.call('PUT', '/api/v1/profile', { ...PERSONA, personal: { ...PERSONA.personal, links: [...PERSONA.personal.links, { label: 'Portfolio', url: 'https://' }] } });
    assert.equal(link.status, 400);
    assert.match(JSON.stringify(link.json.error.details.issues), /links\/2\/url/);
  } finally { await s.stop(); cleanup(s.home); }
});
