// Jobs feed fixes from the black-box findings (feed.md): the Top Matched order across pages (JL-feed-6), hidden jobs
// out of results and counts at once and after a reload (JL-feed-11), and the country filter by the job's own country
// (JL-feed-2). One loopback board server, one crawl, one server for every test here.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { greenhouseJob, startBoards, type Mock } from '../scripts/mocks.ts';
import { cleanup, PERSONA, scratchHome, startTest, type TestServer } from './helpers.ts';

const ANALYST = '<p>We need a data analyst with 3+ years of experience in SQL, Python and Tableau. You build dashboards and A/B tests.</p>';
const OTHER = '<p>Prepare food on the line. Food handler card required.</p>';

let s: TestServer;
let boards: Mock;
let dir: string;

async function waitCrawl(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const st = (await s.call('GET', '/api/v1/crawl/status')).json;
    if (!st.running && st.lastRun) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('crawl did not finish');
}

async function all(body: Record<string, unknown>, limit = 4): Promise<{ items: any[]; total: number; fit: any }> {
  const items: any[] = [];
  let r = await s.call('POST', '/api/v1/jobs/search', { ...body, limit });
  assert.equal(r.status, 200, r.text);
  const { total, fit } = r.json;
  for (;;) {
    items.push(...r.json.items);
    if (!r.json.nextCursor) break;
    r = await s.call('POST', '/api/v1/jobs/search', { ...body, limit, cursor: r.json.nextCursor });
    assert.equal(r.status, 200, r.text);
  }
  return { items, total, fit };
}

before(async () => {
  dir = scratchHome('feedfix');
  const file = join(dir, 'boards.json');
  const big = Array.from({ length: 10 }, (_, i) => greenhouseJob(100 + i, { board: 'bigco', title: i % 2 ? 'Data Analyst' : 'Senior Data Analyst', location: 'Austin, TX', content: ANALYST }));
  const small = [
    greenhouseJob(201, { board: 'smallco', title: 'Line Cook', location: 'Austin, TX', content: OTHER }),
    greenhouseJob(202, { board: 'smallco', title: 'Dishwasher', location: 'Denver, CO', content: OTHER }),
    greenhouseJob(203, { board: 'smallco', title: 'Data Analyst', location: 'Toronto, ON, Canada', content: ANALYST }),
    greenhouseJob(204, { board: 'smallco', title: 'Data Analyst', location: 'London, United Kingdom', content: ANALYST }),
    greenhouseJob(205, { board: 'smallco', title: 'Data Analyst', location: 'Singapore', content: ANALYST }),
    greenhouseJob(206, { board: 'smallco', title: 'Prep Cook', location: '', content: OTHER }),
  ];
  writeFileSync(file, JSON.stringify({ greenhouse: { bigco: big, smallco: small } }));
  boards = await startBoards({ file });
  s = await startTest('feedfix', { env: { JOBLEFT_HOST_MAP: JSON.stringify({ 'boards-api.greenhouse.io': boards.origin }) } });
  for (const b of ['bigco', 'smallco']) assert.equal((await s.call('POST', '/api/v1/boards', { ats: 'greenhouse', board: b })).status, 200);
  assert.equal((await s.call('POST', '/api/v1/crawl/run', {})).json.started, true);
  await waitCrawl();
  const profile = {
    ...PERSONA,
    work: [{ id: 'w1', company: 'Acme Payments', title: 'Data Analyst', employmentType: 'full_time', location: 'Austin, TX', startDate: '2019-01', endDate: null, current: true, summary: 'Analytics.', bullets: ['SQL and Python pipelines', 'Tableau dashboards'] }],
    skills: ['SQL', 'Python', 'Tableau', 'A/B testing'].map((name) => ({ name, years: 4, source: 'user' })),
    preferences: { ...PERSONA.preferences, countries: [] },
  };
  assert.equal((await s.call('PUT', '/api/v1/profile', profile)).status, 200);
});

after(async () => {
  await s.stop(); await boards.close(); cleanup(s.home); cleanup(dir);
});

test('JL-feed-6: Top Matched is ordered by the match percent across every page, one employer or many', async () => {
  const r = await all({ sort: 'top_matched', filter: {} });
  assert.equal(r.items.length, 16);
  assert.equal(r.total, 16);
  assert.equal(r.fit.state, 'ready');
  const pcts = r.items.map((it) => it.match?.percent);
  assert.ok(pcts.every((p) => typeof p === 'number'), JSON.stringify(pcts));
  for (let i = 1; i < pcts.length; i++) assert.ok(pcts[i] <= pcts[i - 1], `place ${i}: ${pcts[i]} after ${pcts[i - 1]} (${pcts.join(',')})`);
  // The card percent is the Top Matched score (fitScore) and the detail's percent.
  for (const it of r.items) assert.equal(Math.round(it.fitScore * 100), it.match.percent);
  const top = r.items[0];
  const d = (await s.call('GET', `/api/v1/jobs/${encodeURIComponent(top.job.id)}`)).json;
  assert.equal(d.match.percent, top.match.percent);
  // The big employer holds the best matches and keeps them at the top (no employer spreading in this order).
  assert.ok(r.items.slice(0, 5).every((it) => it.job.company.toLowerCase().includes('bigco') || it.job.title === 'Data Analyst'), JSON.stringify(r.items.slice(0, 5).map((x) => x.job.title)));
});

test('JL-feed-11: a hidden job leaves the results and the count at once, stays out on the next load, and comes back when shown again', async () => {
  const before1 = await all({ sort: 'recommended', filter: {} });
  assert.equal(before1.total, 16);
  const victim = before1.items[1].job.id;
  assert.equal((await s.call('PATCH', `/api/v1/tracker/${encodeURIComponent(victim)}`, { hidden: true })).status, 200);
  for (const sort of ['recommended', 'top_matched', 'most_recent']) {
    for (let reload = 0; reload < 2; reload++) {
      const r = await all({ sort, filter: {} });
      assert.equal(r.total, 15, `${sort} total after hide (load ${reload + 1})`);
      assert.equal(r.items.length, 15);
      assert.ok(!r.items.some((it) => it.job.id === victim), `${sort}: the hidden job is listed`);
    }
  }
  const hiddenView = (await s.call('GET', '/api/v1/tracker?view=hidden')).json;
  assert.deepEqual(hiddenView.items.map((x: any) => x.entry.jobId), [victim]);
  assert.equal((await s.call('PATCH', `/api/v1/tracker/${encodeURIComponent(victim)}`, { hidden: false })).status, 200);
  const back = await all({ sort: 'recommended', filter: {} });
  assert.equal(back.total, 16);
  assert.ok(back.items.some((it) => it.job.id === victim));
});

test('JL-feed-2: a country filter matches the job\'s own country; unknown places and other countries never match', async () => {
  const ids = async (filter: Record<string, unknown>) => (await all({ sort: 'most_recent', filter }, 100)).items.map((it) => it.job.id).sort();
  assert.deepEqual(await ids({ countries: ['CA'] }), ['greenhouse:smallco:203']);
  assert.deepEqual(await ids({ countries: ['GB'] }), ['greenhouse:smallco:204']);
  assert.deepEqual(await ids({ countries: ['SG'] }), ['greenhouse:smallco:205']);
  assert.deepEqual(await ids({ countries: ['DE'] }), []);
  assert.deepEqual(await ids({ countries: ['CA', 'GB'] }), ['greenhouse:smallco:203', 'greenhouse:smallco:204']);
  // The United States keeps its rule (is_us): the twelve US jobs, none of the others.
  const us = await ids({ countries: ['US'] });
  assert.equal(us.length, 12);
  assert.ok(!us.some((id) => ['greenhouse:smallco:203', 'greenhouse:smallco:204', 'greenhouse:smallco:205', 'greenhouse:smallco:206'].includes(id)));
  // A job with no place counts only when the person asks for unknown places.
  assert.deepEqual(await ids({ countries: ['CA'], includeUnknown: ['place'] }), ['greenhouse:smallco:203', 'greenhouse:smallco:206']);
  // The same in the personal order (a profile exists): totals agree.
  const personal = await all({ sort: 'recommended', filter: { countries: ['CA'] } });
  assert.equal(personal.total, 1);
});

test('JL-feed-7: role type uses the stated level; industry and company stage (no facts in this build) match nothing', async () => {
  const ic = (await all({ sort: 'most_recent', filter: { roleTypes: ['ic'] } }, 100)).items;
  const mgr = (await all({ sort: 'most_recent', filter: { roleTypes: ['manager'] } }, 100)).items;
  assert.ok(ic.length > 0, 'individual contributors are found');
  for (const it of ic) assert.ok(['intern', 'entry', 'mid', 'senior', 'staff', 'principal'].includes(it.job.level), `${it.job.title}: ${it.job.level}`);
  for (const it of mgr) assert.ok(['manager', 'director', 'vp', 'exec'].includes(it.job.level), `${it.job.title}: ${it.job.level}`);
  assert.equal((await all({ sort: 'most_recent', filter: { industries: ['Software'] } })).total, 0);
  assert.equal((await all({ sort: 'most_recent', filter: { companyStages: ['public'] } })).total, 0);
});
