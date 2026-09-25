// Server O13 at the adapter seam: a board's pay comes back to the cent, and Greenhouse's last-edit time is never a
// posted date. Uses the real built-in adapters with a fake HTTP getter (no network, no server).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, normalizeJob, type BoardRef, type HttpGetter } from '@jobleft/crawler';
import { exactSources } from '../src/interim/exact-sources.ts';

const fake = (answer: unknown): HttpGetter => ({ getJson: async () => structuredClone(answer) });
const ref = (ats: 'greenhouse' | 'lever' | 'ashby'): BoardRef => ({ ats, board: 'mockco', company: 'Mockco' });

test('Greenhouse: cents stay cents, and updated_at is never the posted date', async () => {
  const answer = { jobs: [
    { id: 1, title: 'Barista', absolute_url: 'https://boards.greenhouse.io/mockco/jobs/1', location: { name: 'Austin, TX' }, content: '', metadata: [], departments: [],
      updated_at: '2026-09-24T10:00:00-04:00', pay_input_ranges: [{ min_cents: 1850, max_cents: 2225, currency_type: 'USD' }] },
    { id: 2, title: 'Analyst', absolute_url: 'https://boards.greenhouse.io/mockco/jobs/2', location: { name: '' }, content: '', metadata: [], departments: [],
      first_published: '2026-09-20T23:30:00-04:00', updated_at: '2026-09-24T10:00:00-04:00', pay_input_ranges: [{ min_cents: 12000000, max_cents: 15000050, currency_type: 'USD' }] },
  ] };
  const plain = await SOURCES.greenhouse!.fetchBoard(ref('greenhouse'), fake(answer));
  assert.equal(plain[0]!.pay!.min, 19, 'the foundation adapter rounds (the reason for the correction)');
  const [a, b] = await exactSources(SOURCES).greenhouse!.fetchBoard(ref('greenhouse'), fake(answer));
  assert.deepEqual([a!.pay!.min, a!.pay!.max, a!.pay!.period], [18.5, 22.25, 'hour']);
  assert.equal(a!.postedAt, null, 'no first_published: the posted date stays unknown');
  assert.deepEqual([b!.pay!.min, b!.pay!.max, b!.pay!.period], [120000, 150000.5, 'year']);
  assert.equal(b!.postedAt, '2026-09-21T03:30:00.000Z');
});

test('Lever and Ashby: the stated amounts come back unrounded; no pay stays null', async () => {
  const lever = [
    { id: 'a1', text: 'Tutor', hostedUrl: 'https://jobs.lever.co/mockco/a1', categories: { location: 'Remote' }, createdAt: 1758000000000, salaryRange: { min: 18.75, max: 24.5, currency: 'USD', interval: 'per-hour-wage' } },
    { id: 'a2', text: 'Cook', hostedUrl: 'https://jobs.lever.co/mockco/a2', categories: {}, createdAt: 1758000000000 },
  ];
  const [l1, l2] = await exactSources(SOURCES).lever!.fetchBoard(ref('lever'), fake(lever));
  assert.deepEqual([l1!.pay!.min, l1!.pay!.max, l1!.pay!.period], [18.75, 24.5, 'hour']);
  assert.equal(l2!.pay, null);
  const ashby = { jobs: [
    { id: 'b1', title: 'Driver', jobUrl: 'https://jobs.ashbyhq.com/mockco/b1', publishedAt: '2026-09-19T12:00:00Z',
      compensation: { compensationTiers: [{ components: [{ compensationType: 'EquityPercentage', interval: 'NONE', minValue: 0.1 }, { compensationType: 'Salary', interval: '1 HOUR', minValue: 21.25, maxValue: 23.4, currencyCode: 'USD' }] }] } },
  ] };
  const [s1] = await exactSources(SOURCES).ashby!.fetchBoard(ref('ashby'), fake(ashby));
  assert.deepEqual([s1!.pay!.min, s1!.pay!.max, s1!.pay!.period], [21.25, 23.4, 'hour']);
  // The normalised job (what the store saves and the API serves) keeps the same amounts.
  const n = normalizeJob(ref('ashby'), s1!);
  assert.deepEqual([n!.payMin, n!.payMax], [21.25, 23.4]);
});
