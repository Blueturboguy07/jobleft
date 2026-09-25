// Regression tests for defects found by the independent evaluators (places, dedupe, pay figures, pace, identity).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePayFromText } from '@jobleft/parsers';
import { DEFAULT_USER_AGENT, makeConfig } from '../src/config.ts';
import { HttpClient, Pacer, USER_AGENT } from '../src/http.ts';
import { normalizeJob } from '../src/job.ts';
import { canonicalizeUrl } from '../src/normalize.ts';
import { mapLever } from '../src/sources/lever.ts';
import { unmappable } from '../src/sources/util.ts';
import type { BoardRef } from '../src/types.ts';
import { allJobs, crawlOnce, serveBoards, tempStore } from './helpers.ts';

const gh: BoardRef = { ats: 'greenhouse', board: 'acme', company: 'Acme' };
const emptyRaw = () => unmappable({});

test('isUs: a US place that shares a foreign city name is US (the state code wins)', () => {
  for (const loc of ['Dublin, OH', 'Dublin, CA', 'Melbourne, FL', 'Vancouver, WA', 'Paris, TX', 'London, KY', 'Berlin, CT']) {
    const j = normalizeJob(gh, { ...emptyRaw(), externalId: '1', title: 'Clerk', url: 'https://x.example/1', location: loc });
    assert.ok(j);
    assert.equal(j.isUs, true, loc);
    assert.equal(j.places?.[0]?.country, 'US', loc);
  }
  for (const loc of ['Vancouver, BC', 'London, UK', 'Dublin, Ireland', 'Toronto, ON, CA', 'Paris']) {
    const j = normalizeJob(gh, { ...emptyRaw(), externalId: '1', title: 'Clerk', url: 'https://x.example/1', location: loc });
    assert.equal(j?.isUs, false, loc);
  }
});

test('pay: board figures keep their cents (Lever 18.5-19.5 per hour stays 18.5-19.5, also after the store)', async () => {
  const lv: BoardRef = { ats: 'lever', board: 'bb', company: 'BB' };
  const raw = mapLever({ id: 'e5', text: 'Barista', hostedUrl: 'https://jobs.lever.co/bb/e5', categories: { location: 'Oakland, CA' },
    salaryRange: { min: 18.5, max: 19.5, currency: 'USD', interval: 'per-hour-wage' } }, lv);
  assert.deepEqual(raw?.pay, { min: 18.5, max: 19.5, currency: 'USD', period: 'hour' });
  const m = await serveBoards({ cents: { ats: 'lever', jobs: [{ id: 'a1', title: 'Barista', pay: { min: 15.25, max: 15.25, period: 'hour' } }] } });
  const { store, cleanup } = tempStore();
  try {
    await crawlOnce(store, m.boards);
    const p = allJobs(store).items[0]!.pay;
    assert.deepEqual([p?.min, p?.max, p?.period], [15.25, 15.25, 'hour']);
  } finally { cleanup(); await m.close(); }
});

test('pay: a single stated wage in the text is pay with the same number and unit; benefit money never is', () => {
  const yes: Array<[string, number, string]> = [
    ['Pay: $45 per hour.', 45, 'hour'],
    ['Compensation is $20/hour with an additional monthly stipend of $300.', 20, 'hour'],
    ['Compensation for this role is $30/hour.', 30, 'hour'],
    ['Starting at $20/hr.', 20, 'hour'],
    ['Salary: $65,000 per year', 65000, 'year'],
    ['Salary: $6,000 per month.', 6000, 'month'],
    ['Wage: $17 an hour.', 17, 'hour'],
  ];
  for (const [t, v, period] of yes) {
    const p = parsePayFromText(t);
    assert.deepEqual([p?.min, p?.max, p?.period], [v, v, period], t);
  }
  // A line that is only the figure and its unit, next to a line about pay (a real Lever posting).
  const alone = parsePayFromText('Program requirements.\n\n$30 per hour.\n\nThe hourly pay range is posted and you will be eligible for benefits.');
  assert.deepEqual([alone?.min, alone?.max, alone?.period], [30, 30, 'hour']);
  assert.equal(parsePayFromText('Commuter benefit:\n$500 per month\nWe pay for transit.'), null);
  assert.equal(parsePayFromText('Great team.\n$30 per hour.\nFun work.'), null);
  for (const t of ['Fertility HRA (up to $10,000 per year).', 'Learning stipend of $1,500 per year.', 'Up to $500 per month in commuter benefits.',
    'We process $200B in annualized spend.', 'Referral bonus: $1,000 per hire.', 'Earn up to $10,000 per year in bonuses.', 'It costs $45 per hour to run.']) {
    assert.equal(parsePayFromText(t), null, t);
  }
});

test('dedupe: two different openings (same company, title and place, other text and pay) on two boards both stay visible', async () => {
  const m = await serveBoards({
    acmehosp: { ats: 'greenhouse', jobs: [{ id: 900001, title: 'Registered Nurse', location: 'Austin, TX', description: '<p>ICU nurse. Pay: $45 - $60 per hour.</p>' }] },
    acmehospitaler: { ats: 'greenhouse', jobs: [{ id: 800002, title: 'Registered Nurse', location: 'Austin, TX', description: '<p>ER nurse. Pay: $39 - $52 per hour.</p>' }] },
    acmecopy: { ats: 'greenhouse', jobs: [{ id: 700003, title: 'Registered Nurse', location: 'Austin, TX', description: '<p>ICU nurse. Pay: $45 - $60 per hour.</p>' }] },
  });
  const boards = m.boards.map((b) => ({ ...b, company: 'Acme Hospital' }));
  const { store, cleanup } = tempStore();
  try {
    await crawlOnce(store, boards);
    const visible = allJobs(store).items.map((j) => j.id).sort();
    // The ICU and ER openings are two jobs; the exact copy of the ICU posting on a third board is its repeat.
    assert.deepEqual(visible, ['greenhouse:acmehosp:900001', 'greenhouse:acmehospitaler:800002']);
  } finally { cleanup(); await m.close(); }
});

test('dedupe: two employers whose boards share one generic job link keep all their postings', async () => {
  const shared = 'https://careers.shared-host.example/';
  const m = await serveBoards({
    pco: { ats: 'greenhouse', jobs: ['Cashier', 'Stocker', 'Baker'].map((t, i) => ({ id: 100 + i, title: t, url: shared })) },
    qco: { ats: 'greenhouse', jobs: ['Nurse Aide', 'Welder', 'Janitor'].map((t, i) => ({ id: 200 + i, title: t, url: shared })) },
    frag: { ats: 'greenhouse', jobs: ['Cook', 'Host'].map((t, i) => ({ id: 300 + i, title: t, url: `https://one.example/#/jobs/${300 + i}` })) },
  });
  const { store, cleanup } = tempStore();
  try {
    await crawlOnce(store, m.boards);
    const items = allJobs(store).items;
    assert.equal(items.length, 8);
    assert.deepEqual(items.filter((j) => j.id.startsWith('greenhouse:pco:')).map((j) => j.title).sort(), ['Baker', 'Cashier', 'Stocker']);
    for (const j of items.filter((x) => x.id.startsWith('greenhouse:qco:'))) {
      assert.ok(!JSON.stringify(j).includes('pco Co careers'), 'Q Corp postings are not credited to P Corp');
    }
  } finally { cleanup(); await m.close(); }
  assert.equal(canonicalizeUrl('https://one.example/#/jobs/7'), 'https://one.example/#/jobs/7');
  assert.equal(canonicalizeUrl('https://one.example/jobs/7#apply'), 'https://one.example/jobs/7');
});

test('pace: a robots.txt Crawl-delay counts from the request before it, even when that request used a shorter gap', async () => {
  let t = 0;
  const starts: number[] = [];
  const p = new Pacer(1000, () => t, async (ms) => { t += ms; });
  await p.wait('h'); starts.push(t); // the robots.txt request (delay not known yet)
  await p.wait('h', 5000); starts.push(t); // the first board request, after reading Crawl-delay: 5
  await p.wait('h', 5000); starts.push(t);
  assert.ok(starts[1]! - starts[0]! >= 5000, `gap after robots.txt ${starts[1]! - starts[0]!}`);
  assert.ok(starts[2]! - starts[1]! >= 5000);
  // A new run (a new pacer) seeded from the last request keeps the delay too.
  const q = new Pacer(1000, () => t, async (ms) => { t += ms; });
  q.seed('h', starts[2]!);
  await q.wait('h', 5000);
  assert.ok(t - starts[2]! >= 5000, `gap across runs ${t - starts[2]!}`);
});

test('identity: fixed in code; a config or client that names another identity is refused', () => {
  assert.equal(DEFAULT_USER_AGENT, USER_AGENT);
  assert.equal(makeConfig().userAgent, USER_AGENT);
  assert.throws(() => makeConfig({ userAgent: 'jobleft/0.1 (contact: TBD)' }), /fixed in code/);
  assert.throws(() => new HttpClient({ userAgent: 'jobleft/0.1 (contact: TBD)' }), /fixed in code/);
  assert.equal(new HttpClient().userAgent, USER_AGENT);
});

test('ids above 2^53 keep their exact digits when a board reply is read', async () => {
  const { keepBigIntegers } = await import('../src/http.ts');
  const v = JSON.parse('{"jobs":[{"id":9007199254740992},{"id":9007199254740993},{"id":42}]}', keepBigIntegers as never) as { jobs: Array<{ id: unknown }> };
  assert.deepEqual(v.jobs.map((j) => j.id), ['9007199254740992', '9007199254740993', 42]);
});

test('description: a list item whose text sits in a paragraph keeps its "-" marker on the same line', async () => {
  const { htmlToText } = await import('@jobleft/parsers');
  const t = htmlToText('<ul><li><p>RN license</p></li><li><p><strong>BLS</strong> card</p></li></ul>');
  assert.ok(!t.split('\n').includes('-'), t);
  assert.match(t, /^- RN license$/m);
  assert.match(t, /^- BLS card$/m);
});
