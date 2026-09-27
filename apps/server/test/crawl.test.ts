// Server O5 (a crawl never overwrites the person's changes; a closed posting keeps its tracker row and notes),
// O10 (an offline crawl closes nothing) and O13 (facts as the board states them), against a loopback board.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { greenhouseJob, startBoards } from '../scripts/mocks.ts';
import { cleanup, scratchHome, startTest } from './helpers.ts';

async function waitCrawl(call: (m: string, p: string, b?: unknown) => Promise<{ json: any }>): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const st = (await call('GET', '/api/v1/crawl/status')).json;
    if (!st.running && st.lastRun) return st.lastRun;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('crawl did not finish');
}

test('crawl, track, change the board, crawl again: the person\'s status, like and note stay; a removed job closes but stays tracked', async () => {
  const dir = scratchHome('mockboards');
  const file = join(dir, 'boards.json');
  const jobs = [
    greenhouseJob(1, { board: 'mockco', title: 'Data Analyst', location: 'Austin, TX', posted: '2026-09-20T23:30:00-04:00', pay: { min: 80000, max: 100000 } }),
    greenhouseJob(2, { board: 'mockco', title: 'Nurse', location: '', posted: null }),
    greenhouseJob(3, { board: 'mockco', title: 'Chef', location: 'Denver, CO' }),
  ];
  writeFileSync(file, JSON.stringify({ greenhouse: { mockco: jobs } }));
  const boards = await startBoards({ file });
  const s = await startTest('crawl', { env: { JOBLEFT_HOST_MAP: JSON.stringify({ 'boards-api.greenhouse.io': boards.origin }) } });
  try {
    assert.equal((await s.call('POST', '/api/v1/boards', { ats: 'greenhouse', board: 'MockCo' })).status, 200);
    assert.equal((await s.call('POST', '/api/v1/boards', { ats: 'greenhouse', board: 'mockco' })).status, 409);
    const run = await s.call('POST', '/api/v1/crawl/run', {});
    assert.equal(run.json.started, true, run.text);
    const first = await waitCrawl(s.call);
    assert.equal(first.inserted, 3);
    const id = 'greenhouse:mockco:1';
    const j = (await s.call('GET', `/api/v1/jobs/${encodeURIComponent(id)}`)).json.job;
    assert.equal(j.postedAt, '2026-09-21T03:30:00.000Z', 'the posted instant is kept (late evening in New York is the next day in UTC)');
    assert.deepEqual([j.pay.min, j.pay.max, j.pay.period, j.pay.currency], [80000, 100000, 'year', 'USD']);
    const nurse = (await s.call('GET', `/api/v1/jobs/${encodeURIComponent('greenhouse:mockco:2')}`)).json.job;
    assert.equal(nurse.postedAt, null, 'no posted date stays unknown: never the crawl time, never the last edit (updated_at)');
    assert.deepEqual(nurse.places, []);

    await s.call('PATCH', `/api/v1/tracker/${encodeURIComponent(id)}`, { liked: true, status: 'applied', notes: [{ text: 'my note' }] });
    // The board changes the posting.
    jobs[0] = greenhouseJob(1, { board: 'mockco', title: 'Data Analyst (changed)', location: 'Austin, TX', posted: '2026-09-20T23:30:00-04:00' });
    writeFileSync(file, JSON.stringify({ greenhouse: { mockco: jobs } }));
    await s.call('POST', '/api/v1/crawl/run', {});
    const second = await waitCrawl(s.call);
    assert.equal(second.updated >= 1, true);
    let t = (await s.call('GET', `/api/v1/jobs/${encodeURIComponent(id)}`)).json;
    assert.equal(t.job.title, 'Data Analyst (changed)');
    assert.deepEqual([t.tracker.liked, t.tracker.status, t.tracker.notes[0].text], [true, 'applied', 'my note']);

    // The board is unreachable: nothing closes.
    await boards.close();
    await s.call('POST', '/api/v1/dev/clock', { offset: '96h' });
    await s.call('POST', '/api/v1/crawl/run', {});
    const failed = await waitCrawl(s.call);
    assert.equal(failed.failed, 1);
    assert.equal(failed.closed, 0);
    assert.equal((await s.call('GET', `/api/v1/jobs/${encodeURIComponent(id)}`)).json.job.status, 'open');

    // The board comes back without job 1; after the closing window (48 h) job 1 closes but stays in the tracker.
    const boards2 = await startBoards({ file, port: boards.port });
    try {
      writeFileSync(file, JSON.stringify({ greenhouse: { mockco: jobs.slice(1) } }));
      await s.call('POST', '/api/v1/crawl/run', {});
      const third = await waitCrawl(s.call);
      assert.equal(third.closed, 1);
      t = (await s.call('GET', `/api/v1/jobs/${encodeURIComponent(id)}`)).json;
      assert.equal(t.job.status, 'closed');
      assert.equal(t.tracker.notes[0].text, 'my note');
      const liked = (await s.call('GET', '/api/v1/tracker?view=liked')).json;
      assert.equal(liked.items[0].job.status, 'closed');
      assert.equal(liked.counts.closed, 1);
      const search = (await s.call('GET', '/api/v1/jobs?q=analyst')).json;
      assert.equal(search.total, 0, 'a closed job leaves search');
      // Every request to the board carried the fixed User-Agent and nothing about the person.
      for (const e of [...boards.log, ...boards2.log]) {
        assert.equal(e.headers['user-agent'], 'jobleft/0.1.0 (+https://github.com/Blueturboguy07/jobleft; no personal data)');
        assert.ok(!JSON.stringify(e).includes('Testwell'));
      }
    } finally { await boards2.close(); }
  } finally {
    await s.call('POST', '/api/v1/dev/clock', {});
    await s.stop(); await boards.close(); cleanup(s.home); cleanup(dir);
  }
});

test('offline mode refuses a crawl with a plain message and changes nothing', async () => {
  const s = await startTest('crawloff', { offline: true });
  try {
    await s.call('POST', '/api/v1/boards', { ats: 'greenhouse', board: 'acme' });
    const r = await s.call('POST', '/api/v1/crawl/run', {});
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'offline');
  } finally { await s.stop(); cleanup(s.home); }
});

test('a job added by link reads the page once, politely; never-crawl sites get no request', async () => {
  const dir = scratchHome('extlink');
  const file = join(dir, 'boards.json');
  const ld = { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Pastry Chef', hiringOrganization: { '@type': 'Organization', name: 'Crumb & Co' }, datePosted: '2026-09-19', description: '<p>Bake things.</p>', employmentType: 'FULL_TIME', jobLocation: { '@type': 'Place', address: { addressLocality: 'Portland', addressRegion: 'OR', addressCountry: 'US' } }, baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: 22, maxValue: 26, unitText: 'HOUR' } } };
  writeFileSync(file, JSON.stringify({ pages: { '/careers/pastry-chef': `<html><head><title>Careers</title><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>x</body></html>` } }));
  const boards = await startBoards({ file });
  const s = await startTest('extlink', { env: { JOBLEFT_HOST_MAP: JSON.stringify({ 'jobs.example.com': boards.origin }) } });
  try {
    const r = await s.call('POST', '/api/v1/jobs/external', { url: 'https://jobs.example.com/careers/pastry-chef' });
    assert.equal(r.status, 200, r.text);
    const j = r.json.job;
    assert.deepEqual([j.title, j.company, j.employmentType], ['Pastry Chef', 'Crumb & Co', 'full_time']);
    assert.deepEqual([j.pay.min, j.pay.max, j.pay.period, j.pay.currency], [22, 26, 'hour', 'USD']);
    assert.equal(j.places[0].text, 'Portland, OR, US');
    assert.equal(r.json.tracker.external, true);
    assert.equal((await s.call('GET', '/api/v1/tracker?view=external')).json.items.length, 1);
    const before = boards.log.length;
    const li = await s.call('POST', '/api/v1/jobs/external', { url: 'https://www.linkedin.com/jobs/view/123' });
    assert.equal(li.status, 422);
    assert.equal(li.json.error.code, 'forbidden_source');
    assert.equal(boards.log.length, before, 'nothing was sent');
    for (const e of boards.log) assert.equal(e.headers['user-agent'], 'jobleft/0.1.0 (+https://github.com/Blueturboguy07/jobleft; no personal data)');
  } finally { await s.stop(); await boards.close(); cleanup(s.home); cleanup(dir); }
});
