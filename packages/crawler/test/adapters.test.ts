// Adapter mapping tests. Fixtures follow the payload shapes in freehire's Go adapters and the audit (2026-09-24).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greenhouse, mapGreenhouse } from '../src/sources/greenhouse.ts';
import { lever, mapLever } from '../src/sources/lever.ts';
import { ashby, mapAshby } from '../src/sources/ashby.ts';
import { normalizeJob } from '../src/job.ts';
import type { BoardRef, HttpGetter } from '../src/types.ts';

const gh: BoardRef = { ats: 'greenhouse', board: 'acme', company: 'Acme' };
const lv: BoardRef = { ats: 'lever', board: 'acme', company: 'Acme' };
const ab: BoardRef = { ats: 'ashby', board: 'acme', company: 'Acme' };
const getter = (payload: unknown, seen: string[] = []): HttpGetter => ({ getJson: async (u) => { seen.push(u); return payload; } });

test('greenhouse: content arrives entity-encoded and is decoded; first_published beats updated_at; metadata gives employment type', async () => {
  const seen: string[] = [];
  const payload = { jobs: [{
    id: 4001, title: 'Store Manager', absolute_url: 'https://boards.greenhouse.io/acme/jobs/4001', location: { name: 'Denver, CO' },
    first_published: '2026-08-01T10:00:00-04:00', updated_at: '2026-09-20T10:00:00-04:00',
    content: '&lt;p&gt;Lead the store team.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Hire &amp;amp; train&lt;/li&gt;&lt;/ul&gt;',
    metadata: [{ name: 'Employment Type', value: 'Full-time' }], departments: [{ name: 'Retail Ops' }],
  }] };
  const jobs = await greenhouse.fetchBoard(gh, getter(payload, seen));
  assert.equal(seen[0], 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].externalId, '4001');
  assert.equal(jobs[0].postedAt, '2026-08-01T14:00:00.000Z');
  assert.equal(jobs[0].employmentType, 'full_time');
  assert.equal(jobs[0].department, 'Retail Ops');
  const n = normalizeJob(gh, jobs[0]);
  assert.ok(n);
  assert.match(n.description, /Lead the store team\./);
  assert.match(n.description, /- Hire & train/);
  assert.equal(n.level, 'manager');
  assert.equal(n.isUs, true);
});

test('greenhouse: pay_input_ranges keep their cents and the unit the range states; no unit stated means no board pay', () => {
  const j = mapGreenhouse({ id: 1, title: 'Cook', absolute_url: 'https://x/1', location: { name: 'Austin, TX' }, content: '',
    pay_input_ranges: [{ title: 'Hourly pay range', min_cents: 1850, max_cents: 2275, currency_type: 'USD' }] }, gh);
  assert.ok(j);
  assert.deepEqual(j.pay, { min: 18.5, max: 22.75, currency: 'USD', period: 'hour' });
  const y = mapGreenhouse({ id: 2, title: 'Analyst', absolute_url: 'https://x/2', location: { name: 'Austin, TX' }, content: '',
    pay_input_ranges: [{ title: 'Annual base salary', min_cents: 9000000, max_cents: 12000000, currency_type: 'USD' }] }, gh);
  assert.deepEqual(y?.pay, { min: 90000, max: 120000, currency: 'USD', period: 'year' });
  // Regression: a unit was guessed from the size of the figures ("Pay range", 45-55 USD became "per hour").
  for (const [lo, hi] of [[4500, 5500], [15000, 20000], [6500000, 7500000]]) {
    const u = mapGreenhouse({ id: 3, title: 'Clerk', absolute_url: 'https://x/3', location: { name: 'Austin, TX' }, content: '',
      pay_input_ranges: [{ title: 'Pay range', blurb: '', min_cents: lo, max_cents: hi, currency_type: 'USD' }] }, gh);
    assert.equal(u?.pay, null, `no unit stated for ${lo}-${hi}`);
  }
});

test('lever: body is assembled from description + lists + additional; salaryRange, workplaceType, country, createdAt map across', async () => {
  const seen: string[] = [];
  const payload = [{
    id: 'abc-1', text: 'Registered Nurse - ICU', hostedUrl: 'https://jobs.lever.co/acme/abc-1', applyUrl: 'https://jobs.lever.co/acme/abc-1/apply',
    createdAt: 1787000000000, description: '<div>Care for ICU patients.</div>',
    lists: [{ text: 'Requirements', content: '<li>RN license</li><li>BLS</li>' }], additional: '<p>EOE employer.</p>',
    workplaceType: 'onsite', country: 'US', categories: { location: 'Chicago, IL', commitment: 'Full-time', department: 'Nursing' },
    salaryRange: { min: 38.5, max: 52, currency: 'USD', interval: 'per-hour-wage' },
  }];
  const jobs = await lever.fetchBoard(lv, getter(payload, seen));
  assert.equal(seen[0], 'https://api.lever.co/v0/postings/acme?mode=json');
  const j = jobs[0];
  assert.deepEqual(j.pay, { min: 38.5, max: 52, currency: 'USD', period: 'hour' }); // the board's own figures, cents kept
  assert.equal(j.workMode, 'onsite');
  assert.deepEqual(j.countries, ['US']);
  assert.equal(j.employmentType, 'full_time');
  const n = normalizeJob(lv, j);
  assert.ok(n);
  assert.match(n.description, /Requirements\n+- RN license\n- BLS/);
  assert.equal(n.paySource, 'api');
  assert.equal(n.applyUrl, 'https://jobs.lever.co/acme/abc-1/apply');
  assert.equal(n.canonicalUrl, 'https://jobs.lever.co/acme/abc-1', 'canonical uses the job page, not the /apply page');
});

test('lever: a one-time bonus interval is not a wage and a zero range means "not set"', () => {
  const bonus = mapLever({ id: 'a', text: 'x', hostedUrl: 'https://x/a', salaryRange: { min: 5000, max: 5000, currency: 'USD', interval: 'one-time-bonus' }, categories: {} }, lv);
  assert.equal(bonus?.pay, null);
  const zero = mapLever({ id: 'b', text: 'x', hostedUrl: 'https://x/b', salaryRange: { min: 0, max: 0, currency: 'USD', interval: 'per-year-salary' }, categories: {} }, lv);
  assert.equal(zero?.pay, null);
});

test('lever: the EU host is used for region eu', async () => {
  const seen: string[] = [];
  await lever.fetchBoard({ ...lv, region: 'eu' }, getter([], seen));
  assert.equal(seen[0], 'https://api.eu.lever.co/v0/postings/acme?mode=json');
});

test('ashby: compensation is asked for, only a Salary component counts, and intervals map', async () => {
  const seen: string[] = [];
  const payload = { jobs: [{
    id: 'u-1', title: 'Senior Loan Officer', jobUrl: 'https://jobs.ashbyhq.com/acme/u-1', applyUrl: 'https://jobs.ashbyhq.com/acme/u-1/application',
    location: 'Remote - US', secondaryLocations: [{ location: 'Austin, TX' }], publishedAt: '2026-09-01T00:00:00.000+00:00',
    descriptionHtml: '<p>Originate loans.</p>', isRemote: true, workplaceType: 'Remote', employmentType: 'FullTime',
    address: { postalAddress: { addressCountry: 'United States' } },
    compensation: { compensationTiers: [{ components: [
      { compensationType: 'Bonus', interval: 'NONE', currencyCode: 'USD', minValue: 5000, maxValue: 5000 },
      { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 90000, maxValue: 120000 },
    ] }] },
  }] };
  const jobs = await ashby.fetchBoard(ab, getter(payload, seen));
  assert.equal(seen[0], 'https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true');
  const j = jobs[0];
  assert.deepEqual(j.pay, { min: 90000, max: 120000, currency: 'USD', period: 'year' });
  assert.equal(j.workMode, 'remote');
  assert.deepEqual(j.countries, ['US']);
  assert.equal(j.location, 'Remote - US; Austin, TX');
  const n = normalizeJob(ab, j);
  assert.ok(n);
  assert.equal(n.level, 'senior');
  assert.equal(n.payMinAnnual, 90000);
  assert.equal(n.employmentType, 'full_time');
});

test('ashby: workplaceType decides the mode; isRemote alone is only the fallback', () => {
  const hybrid = mapAshby({ id: '1', title: 't', jobUrl: 'https://x/1', isRemote: true, workplaceType: 'Hybrid' }, ab);
  assert.equal(hybrid?.workMode, 'hybrid');
  const fallback = mapAshby({ id: '2', title: 't', jobUrl: 'https://x/2', isRemote: true }, ab);
  assert.equal(fallback?.workMode, 'remote');
});

test('adapters keep NON-IT postings untouched: there is no dictionary gate anywhere in the mapping', async () => {
  const titles = ['Registered Nurse', 'Cashier', 'Bank Teller', 'Truck Driver', 'Line Cook', 'Kindergarten Teacher', 'Dental Hygienist', 'Barista'];
  const payload = { jobs: titles.map((t, i) => ({ id: 100 + i, title: t, absolute_url: `https://boards.greenhouse.io/acme/jobs/${100 + i}`, location: { name: 'Tulsa, OK' }, content: `<p>${t} needed.</p>` })) };
  const jobs = await greenhouse.fetchBoard(gh, getter(payload));
  assert.equal(jobs.length, titles.length);
  assert.equal(jobs.map((j) => normalizeJob(gh, j)).filter(Boolean).length, titles.length);
});
