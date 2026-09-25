import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkModel } from '../src/index.ts';

const wm = (text: string, fields: Parameters<typeof parseWorkModel>[1] = {}) => parseWorkModel(text, fields).workModel;

test('work model: the job itself, not the word "remote" (O9 angle 1)', () => {
  assert.equal(wm('You will run our remote patient monitoring program from our clinic.'), null);
  assert.equal(wm('Our remote sensing team analyses satellite images.'), null);
  assert.equal(wm('You will work with remote teams across three time zones.'), null);
  assert.equal(wm('Provide remote support to users and travel to remote locations.'), null);
  assert.equal(wm('We use hybrid cloud infrastructure and hybrid apps.'), null);
  assert.equal(wm('This is a fully remote position.'), 'remote');
  assert.equal(wm('This role is 100% remote within the US.'), 'remote');
  assert.equal(wm('This is a hybrid role: 3 days a week in our Austin office.'), 'hybrid');
  assert.equal(wm('This position is on-site at our plant.'), 'onsite');
  assert.equal(wm('This is not a remote position.'), 'onsite');
});

test('work model: nothing stated is unknown, never Onsite (O1 angle 2)', () => {
  assert.equal(wm('Great team. Competitive pay.'), null);
  assert.equal(wm('', {}), null);
  assert.equal(wm('', { workplaceType: 'unspecified' }), null);
});

test('work model: the stricter reading wins when the posting says two things (O9 angles 2 and 4)', () => {
  assert.equal(wm('You will be in the office 3 days a week.', { workplaceType: 'remote' }), 'hybrid');
  assert.equal(wm('', { workplaceType: 'Remote', location: 'Denver, CO - Hybrid' }), 'hybrid');
  assert.equal(wm('', { location: 'Remote - US' }), 'remote');
  assert.equal(wm('', { location: 'Austin, TX (Hybrid)' }), 'hybrid');
  assert.equal(wm('Coinbase is a remote-first, but not remote-only company.'), null);
  assert.equal(wm('If you are within commuting distance of an office, you are expected to work onsite at least 50% of the time.', { workplaceType: 'remote' }), 'remote');
});

test('remote area: the limit stays with the job (O8 angle 4, O9 angle 3)', () => {
  const scope = (text: string, fields: Parameters<typeof parseWorkModel>[1] = {}) => parseWorkModel(text, fields).remoteScope;
  assert.deepEqual(scope('', { location: 'Remote - Canada' })?.regions, ['CA']);
  assert.deepEqual(scope('This is a fully remote role. EMEA only.')?.regions, ['EMEA']);
  assert.deepEqual(scope('This is a fully remote role open to candidates in India only.')?.regions, ['IN']);
  const denver = scope('Remote, but you must live within 50 miles of Denver, CO.', { workplaceType: 'remote' });
  assert.deepEqual(denver?.regions, ['US']);
  assert.match(denver?.text ?? '', /50 miles of Denver/);
  const states = scope('This is a fully remote role. We can only hire in the following states: AZ, CO, FL, GA and TX.');
  assert.deepEqual(states?.regions, ['US']);
  assert.match(states?.text ?? '', /AZ, CO, FL, GA and TX/);
  assert.deepEqual(scope('This position is fully remote, but you must work EU hours.')?.regions, ['EU']);
  assert.equal(scope('This is a fully remote role.', {})?.regions.length ?? 0, 0);
  assert.equal(scope('Must be authorized to work in the US. This is a fully remote role.')?.regions.length ?? 0, 0, 'work authorisation is not an area limit');
});
