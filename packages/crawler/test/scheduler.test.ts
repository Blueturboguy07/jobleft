// The scheduler (outcomes O3, O13, O14, O15): the retry ladder, when boards are due, the time-skip (simulate), the
// catch-up after a break, small replies for unchanged boards, and the progress and report records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CrawlBoardReportSchema, CrawlProgressSchema, CrawlRunSummarySchema, validate } from '@jobleft/contracts';
import { Pacer } from '../src/http.ts';
import {
  Scheduler, crawlProgress, jitterMs, lastRunReport, planDue, retryDelayMs, scheduleSettings, simulate,
} from '../src/scheduler.ts';
import { Runs } from '../src/runs.ts';
import { DAY, HOUR, allJobs, cfg, crawlOnce, jobsOf, serveBoards, tempStore } from './helpers.ts';

const T0 = Date.parse('2026-09-01T09:00:00Z');

test('retry ladder: a failing board is asked less and less often, never more often than a healthy one after 4 failures', () => {
  const r = 24 * HOUR;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map((f) => retryDelayMs(f, r) / HOUR), [1, 4, 12, 24, 48, 96, 168, 168]);
  assert.equal(retryDelayMs(0, r), r);
  const j = jitterMs('greenhouse:acme', r);
  assert.ok(j >= 0 && j <= HOUR);
  assert.equal(jitterMs('greenhouse:acme', r), j, 'the offset is stable');
  assert.notEqual(jitterMs('greenhouse:acme', r), jitterMs('greenhouse:beta', r));
  const s = scheduleSettings(cfg());
  assert.equal(s.refreshMs, 24 * HOUR);
  assert.equal(s.confirmGapMs, 2 * HOUR);
  assert.equal(scheduleSettings(cfg({ refreshHours: 2 / 60 })).confirmGapMs, 60_000, 'a confirmation never waits past half a refresh');
});

test('O3 by time-skip: simulate 48 hours; the removed jobs close well inside 48 hours of the removal; the others stay open', async () => {
  const jobs = jobsOf(20, 'r');
  const m = await serveBoards({ acme: { ats: 'lever', jobs: [...jobs] } });
  const { store, cleanup } = tempStore();
  try {
    await crawlOnce(store, m.boards, { clock: () => T0 });
    m.servers.acme!.boards.acme!.jobs = jobs.slice(3);
    const res = await simulate({ store, config: cfg(), clock: () => T0 + HOUR, boards: m.boards, pacer: new Pacer(20) }, 48 * HOUR);
    assert.ok(res.runs >= 2, `refresh then confirmation (${res.runs} runs)`);
    const closed = allJobs(store, 'closed').items;
    assert.deepEqual(closed.map((j) => j.externalId).sort(), ['r0', 'r1', 'r2']);
    for (const j of closed) assert.ok(Date.parse(j.closedAt!) - (T0 + HOUR) <= 30 * HOUR, `closed ${j.closedAt}, within 30 h of the removal`);
    assert.equal(allJobs(store, 'open').total, 17);
  } finally {
    cleanup();
    await m.close();
  }
});

test('O14 + O15: a board that fails for 3 days keeps its jobs with an old last-seen time; after a break every board is caught up; an unchanged board costs a small 304', async () => {
  const m = await serveBoards({
    flaky: { ats: 'greenhouse', jobs: jobsOf(4, 'f', (i) => ({ postedAt: new Date(T0 - [1, 30, 200, 2][i]! * DAY).toISOString() })) },
    steady: { ats: 'ashby', jobs: jobsOf(4, 's') },
  });
  const { store, cleanup } = tempStore();
  try {
    await crawlOnce(store, m.boards, { clock: () => T0 });
    m.servers.flaky!.boards.flaky!.mode = 'error500';
    await simulate({ store, config: cfg(), clock: () => T0 + HOUR, boards: m.boards, pacer: new Pacer(20) }, 3 * DAY);
    const flaky = allJobs(store).items.filter((j) => j.board === 'flaky');
    assert.equal(flaky.length, 4);
    for (const j of flaky) {
      assert.equal(j.status, 'open', 'a failing board closes nothing');
      assert.equal(j.lastSeenAt, new Date(T0).toISOString(), 'last seen stays at the last good reading');
    }
    assert.deepEqual(flaky.map((j) => j.postedAt!.slice(0, 10)).sort(), ['2026-02-13', '2026-08-02', '2026-08-30', '2026-08-31']);
    const flakyTries = m.servers.flaky!.requests.filter((r) => r.path.startsWith('/v1')).length;
    assert.ok(flakyTries <= 12, `the failing board was asked less and less often (${flakyTries} requests in 3 days)`);
    const steadyAll = m.servers.steady!.requests.filter((r) => r.path.startsWith('/posting-api'));
    assert.ok(steadyAll.slice(1).every((r) => r.status === 304), 'every later reading of the unchanged board was a small 304');
    const steady = allJobs(store).items.filter((j) => j.board === 'steady');
    for (const j of steady) assert.ok(Date.parse(j.lastSeenAt) > T0 + 2 * DAY, '304 still confirms the jobs');
    const words = JSON.stringify(allJobs(store).items).toLowerCase();
    assert.doesNotMatch(words, /\bfake\b|\bghost\b/);
    // Three days off, then launch: every board is due at once (the catch-up), spread only by the pace.
    const s = scheduleSettings(cfg());
    m.servers.flaky!.boards.flaky!.mode = 'ok';
    const plan = planDue(store, m.boards, T0 + 10 * DAY, s);
    assert.deepEqual(plan.map((d) => d.dueAt <= T0 + 10 * DAY), [true, true]);
  } finally {
    cleanup();
    await m.close();
  }
});

test('O15: over 6 simulated hours with a 1-hour refresh, each board is read about 6 times and not more', async () => {
  const m = await serveBoards({ a: { ats: 'greenhouse', jobs: jobsOf(2, 'a') }, b: { ats: 'lever', jobs: jobsOf(2, 'b') } });
  const { store, cleanup } = tempStore();
  try {
    await crawlOnce(store, m.boards, { clock: () => T0 });
    await simulate({ store, config: cfg({ refreshHours: 1 }), clock: () => T0, boards: m.boards, pacer: new Pacer(20) }, 6 * HOUR);
    for (const k of ['a', 'b']) {
      const n = m.servers[k]!.requests.filter((r) => !r.path.startsWith('/robots')).length;
      assert.ok(n >= 6 && n <= 7, `board ${k} read ${n} times in 6 hours`);
    }
  } finally {
    cleanup();
    await m.close();
  }
});

test('O13: progress and reports have the contract shapes; progress counts boards done while a run is going', async () => {
  const m = await serveBoards({ one: { ats: 'greenhouse', jobs: jobsOf(3, 'o') }, two: { ats: 'greenhouse', jobs: jobsOf(3, 't') } });
  const { store, cleanup } = tempStore();
  try {
    const seen: number[] = [];
    const s = scheduleSettings(cfg());
    const { runOnce } = await import('../src/scheduler.ts');
    await runOnce({
      store, config: cfg(), clock: () => T0, pacer: new Pacer(20),
      onProgress: () => { const p = crawlProgress(store, T0, s, m.boards); seen.push(p.boardsDone); assert.ok(validate(CrawlProgressSchema, p).ok); },
    }, { reason: 'first_run', boards: m.boards });
    assert.deepEqual(seen, [1, 2], 'progress rises while the run goes');
    const p = crawlProgress(store, T0, s, m.boards);
    assert.equal(p.running, false);
    assert.ok(validate(CrawlProgressSchema, p).ok, JSON.stringify(validate(CrawlProgressSchema, p)));
    assert.ok(p.lastRun && validate(CrawlRunSummarySchema, p.lastRun).ok);
    const rep = lastRunReport(store);
    assert.equal(rep.boards.length, 2);
    for (const b of rep.boards) assert.ok(validate(CrawlBoardReportSchema, b).ok, JSON.stringify(validate(CrawlBoardReportSchema, b)));
  } finally {
    cleanup();
    await m.close();
  }
});

test('Scheduler: catches up on start, holds the lease (a second crawler is refused), stops cleanly', async () => {
  const m = await serveBoards({ one: { ats: 'greenhouse', jobs: jobsOf(3, 'o') } });
  const { store, path, cleanup } = tempStore();
  try {
    const { Store } = await import('../src/store.ts');
    const other = new Store(path);
    // Another live process (the test runner's parent) holds the lease: the scheduler refuses to start.
    other.setMeta('lease', JSON.stringify({ pid: process.ppid, since: new Date().toISOString(), beat: new Date().toISOString() }));
    const sched = new Scheduler({ store, config: cfg({ refreshHours: 2 / 60 }), clock: () => Date.now(), boards: () => m.boards, pacer: new Pacer(20) });
    assert.throws(() => sched.start({ catchUp: true }), /another jobleft crawler/);
    other.setMeta('lease', null);
    await sched.start({ catchUp: true });
    for (let i = 0; i < 50 && allJobs(store).total < 3; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(allJobs(store).total, 3, 'the catch-up ran at start');
    assert.match(other.getMeta('lease') ?? '', new RegExp(`"pid":${process.pid}`));
    await sched.stop();
    assert.equal(other.getMeta('lease'), null, 'the lease is released on stop');
    assert.equal(new Runs(other).acquireLease().ok, true);
    other.close();
    assert.throws(() => new Scheduler({ store, config: cfg({ refreshHours: 2 / 60 }), clock: () => Date.now(), boards: () => [{ ats: 'greenhouse', board: 'real', company: 'Real' }] }), /under 1 hour/);
  } finally {
    cleanup();
    await m.close();
  }
});
