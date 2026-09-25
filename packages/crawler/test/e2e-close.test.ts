// Outcomes O3, O4, O5: removed jobs close (only when confirmed), come back when listed again and keep their details;
// a failed crawl never closes anything; each job appears once and two jobs never merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getJobById } from '../src/contract.ts';
import { DAY, HOUR, allJobs, cfg, crawlOnce, jobsOf, serveBoards, tempStore } from './helpers.ts';
import type { MockMode } from './helpers.ts';

const T0 = Date.parse('2026-10-01T08:00:00Z');

test('O3: removed jobs close only after a confirming reading, carry a close time, keep their details, and reopen when listed again', async () => {
  const jobs = jobsOf(20, 'j');
  const m = await serveBoards({ acme: { ats: 'greenhouse', jobs: [...jobs] } });
  const board = m.servers.acme!.boards.acme!;
  const { store, cleanup } = tempStore();
  let now = T0;
  const clock = () => now;
  try {
    await crawlOnce(store, m.boards, { clock });
    assert.equal(allJobs(store, 'open').total, 20);
    board.jobs = jobs.filter((j) => !['j3', 'j7', 'j11'].includes(String(j.id)));
    now = T0 + 6 * HOUR;
    let out = await crawlOnce(store, m.boards, { clock });
    assert.equal(out.run.closed, 0, 'a first miss never closes (even with the in-run second reading)');
    assert.equal(allJobs(store, 'open').total, 20);
    now = T0 + 9 * HOUR;
    out = await crawlOnce(store, m.boards, { clock });
    assert.equal(out.run.closed, 3);
    const closed = allJobs(store, 'closed').items;
    assert.deepEqual(closed.map((j) => j.externalId).sort(), ['j11', 'j3', 'j7']);
    for (const j of closed) {
      assert.equal(j.closedAt, new Date(T0 + 9 * HOUR).toISOString());
      assert.equal(j.closedReason, 'unseen');
      assert.equal(j.title.startsWith('Role j'), true, 'a closed job keeps its title');
      assert.match(j.description, /Job j/, 'and its description');
    }
    assert.equal(allJobs(store, 'open').total, 17);
    // The employer lists j7 again: it is open again.
    board.jobs = [...board.jobs, jobs[7]!];
    now = T0 + 10 * HOUR;
    await crawlOnce(store, m.boards, { clock });
    const j7 = getJobById(store.db, 'greenhouse:acme:j7')!;
    assert.equal(j7.status, 'open');
    assert.equal(j7.closedAt, null);
    assert.equal(allJobs(store, 'open').total, 18);
    // One quick miss, then the job is back: it never closes.
    board.jobs = board.jobs.filter((j) => j.id !== 'j0');
    now = T0 + 11 * HOUR;
    await crawlOnce(store, m.boards, { clock });
    board.jobs = [...board.jobs, jobs[0]!];
    now = T0 + 11.5 * HOUR;
    await crawlOnce(store, m.boards, { clock });
    now = T0 + 20 * HOUR;
    await crawlOnce(store, m.boards, { clock });
    assert.equal(getJobById(store.db, 'greenhouse:acme:j0')!.status, 'open');
    // After a long break, one run (with its own second reading) closes what is really gone.
    board.jobs = board.jobs.filter((j) => j.id !== 'j1' && j.id !== 'j2');
    now = T0 + 20 * HOUR + 3 * DAY;
    out = await crawlOnce(store, m.boards, { clock });
    assert.equal(out.run.closed, 2);
    assert.equal(getJobById(store.db, 'greenhouse:acme:j1')!.status, 'closed');
  } finally {
    cleanup();
    await m.close();
  }
});

test('O4: a server error, a timeout, a cut-off reply, a web page, broken data, an empty list, "not found" and a refusal never close a job', async () => {
  const m = await serveBoards({ acme: { ats: 'greenhouse', jobs: jobsOf(30, 'a') } });
  const b = m.servers.acme!.boards.acme!;
  const { store, cleanup } = tempStore();
  let now = T0;
  const clock = () => now;
  try {
    await crawlOnce(store, m.boards, { clock });
    const expect: Array<[MockMode, string]> = [
      ['error500', 'server_error'], ['timeout', 'timeout'], ['cutoff', 'cut_off'], ['html', 'not_job_data'], ['broken', 'broken_reply'],
      ['empty', 'empty'], ['notfound', 'not_found'], ['forbidden403', 'blocked'], ['redirect', 'redirect'],
    ];
    for (const [mode, code] of expect) {
      b.mode = mode;
      now += 3 * DAY;
      // A manual run (as `jobleft-crawl run`): a board in back-off after failures is still asked, once.
      await crawlOnce(store, m.boards, { clock, config: cfg({ requestTimeoutSeconds: 2 }) });
      assert.equal(allJobs(store, 'open').total, 30, `after ${mode} the 30 jobs are still open`);
      const row = store.getBoard('greenhouse', 'acme')!;
      assert.equal(row.last_reason_code, code, `${mode} is named`);
      assert.ok((row.last_reason ?? '').length > 10, `${mode} has a reason in words: ${row.last_reason}`);
    }
    // A reply that lists only a third of the board (a half-finished system move) is held, not applied.
    b.mode = 'ok';
    b.jobs = jobsOf(10, 'a');
    now += 3 * DAY;
    const out = await crawlOnce(store, m.boards, { clock, force: true }); // the 403 before left a refusal back-off
    assert.equal(out.run.closed, 0);
    assert.match(out.report.boards[0]!.closeHeld ?? '', /held/);
    assert.equal(allJobs(store, 'open').total, 30);
  } finally {
    cleanup();
    await m.close();
  }
});

test('O5: five crawls, a board listed twice, 12 same-title jobs, same ids on two employers: each job once, none merged', async () => {
  const strategists = Array.from({ length: 12 }, (_, i) => ({
    id: 700 + i, title: 'Deployment Strategist', location: i < 6 ? ['New York, NY', 'Denver, CO', 'Austin, TX', 'Remote - US', 'Chicago, IL', 'Boston, MA'][i]! : 'New York, NY',
    description: '<p>Deploy software.</p>',
  }));
  const m = await serveBoards({
    palantir: { ats: 'lever', jobs: strategists },
    shared1: { ats: 'greenhouse', jobs: [{ id: 1, title: 'Cashier', location: 'Reno, NV', url: 'https://one.example/careers' }, { id: 2, title: 'Stocker', location: 'Reno, NV', url: 'https://one.example/careers' }] },
    shared2: { ats: 'greenhouse', jobs: [{ id: 1, title: 'Cashier', location: 'Reno, NV' }] },
  });
  const { store, cleanup } = tempStore();
  try {
    const twice = [...m.boards, m.boards[0]!];
    for (let i = 0; i < 5; i++) await crawlOnce(store, twice, { clock: () => T0 + i * HOUR });
    const page = allJobs(store);
    assert.equal(page.total, 12 + 2 + 1, 'every job once after five crawls with a board listed twice');
    assert.equal(page.items.filter((j) => j.title === 'Deployment Strategist').length, 12, 'all 12 same-title jobs are visible');
    assert.equal(page.items.filter((j) => j.title === 'Cashier').length, 2, 'the same job number on two employers is two jobs');
    assert.equal(page.items.filter((j) => j.board === 'shared1').length, 2, 'two ids sharing one careers-page URL stay two jobs');
    // An edited title (case and spaces) updates the same job.
    m.servers.palantir!.boards.palantir!.jobs[0]!.title = 'deployment   STRATEGIST';
    await crawlOnce(store, m.boards, { clock: () => T0 + 6 * HOUR });
    assert.equal(allJobs(store).total, 15);
    assert.equal(getJobById(store.db, 'lever:palantir:700')!.title, 'deployment STRATEGIST');
  } finally {
    cleanup();
    await m.close();
  }
});
