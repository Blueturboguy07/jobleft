// Bad boards (O4), failed fetches that must not close jobs (O5), and paged boards (O11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError, Store, crawl } from '@jobleft/crawler';
import type { BoardRef } from '@jobleft/crawler';
import { recruitee, recruiteeUrl } from '../src/adapters/recruitee.ts';
import { personio, personioUrl } from '../src/adapters/personio.ts';
import { TEAMTAILOR_MAX_PAGES, teamtailor, teamtailorPageUrl } from '../src/adapters/teamtailor.ts';
import { workable } from '../src/adapters/workable.ts';
import { BoardTokenError, PagingError } from '../src/errors.ts';
import { allSources } from '../src/registry.ts';
import { buildHealthReport } from '../src/report.ts';
import { crawlStandin, fakeHttp, rows, STANDIN, tmp } from './helpers.ts';

function offer(i: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 100 + i, title: `Role ${i}`, company_name: 'Fault Demo', careers_url: `https://fault-demo.recruitee.com/o/role-${i}`,
    published_at: '2026-09-01 10:00:00 UTC', description: `<p>Job ${i}</p>`, locations: [], ...extra,
  };
}

test('a bad board never stops the crawl; each one is named with a plain reason (O4)', async () => {
  const t = tmp();
  const dir = join(t.dir, 'standin');
  mkdirSync(join(dir, 'recruitee'), { recursive: true });
  mkdirSync(join(dir, 'personio'), { recursive: true });
  mkdirSync(join(dir, 'teamtailor'), { recursive: true });
  cpSync(join(STANDIN, 'gem'), join(dir, 'gem'), { recursive: true });
  const good = JSON.stringify({ offers: [offer(1), offer(2)] });
  const bad: Record<string, Record<string, unknown>> = {
    r404: { status: 404 },
    r429: { status: 429, headers: { 'retry-after': '10' } },
    r500: { status: 500 },
    rslow: { delayMs: 3000 },
    rempty: { body: '' },
    rinvalid: { body: '{"offers": [ {"id": 1,' },
    rhtml: { body: '<!DOCTYPE html><html><body><h1>Careers</h1></body></html>' },
    rrenamed: { body: JSON.stringify({ items: [offer(1)] }) },
    rredirect: { status: 302, headers: { location: '/api/offers/' } },
    rbig: { body: 'x'.repeat(30 * 1024 * 1024) },
    rtrickle: { bytesPerSecond: 20 },
  };
  for (const [b, meta] of Object.entries(bad)) {
    writeFileSync(join(dir, 'recruitee', `${b}.json`), good);
    writeFileSync(join(dir, 'recruitee', `${b}.meta.json`), JSON.stringify(meta));
  }
  writeFileSync(join(dir, 'recruitee', 'rgood.json'), good);
  writeFileSync(join(dir, 'personio', 'pcut.xml'), '<workzag-jobs><position><id>1</id><name>Cut');
  writeFileSync(join(dir, 'teamtailor', 'thtml.rss'), '<html><body>Not found</body></html>');

  const run = await crawlStandin(dir, join(t.dir, 'jobs.db'), undefined, { timeoutMs: 1000 });
  try {
    const health = buildHealthReport(run.report, run.store);
    const by = Object.fromEntries(health.boards.map((b) => [b.board, b]));
    assert.equal(by.rgood.status, 'ok');
    assert.equal(by.rgood.read, 2);
    assert.equal(by['acme-demo'].status, 'ok'); // the gem board
    const expect: Record<string, RegExp> = {
      r404: /not found \(HTTP 404\)/,
      r429: /slow down \(HTTP 429\)/,
      r500: /server failed \(HTTP 500\)/,
      rslow: /did not answer in time/,
      rempty: /empty or cut off/,
      rinvalid: /empty or cut off|not valid JSON/,
      rhtml: /web page \(HTML\)/,
      rrenamed: /no "offers" list/,
      rredirect: /redirect \(HTTP 302\)/,
      rbig: /not valid JSON|web page/,
      rtrickle: /did not answer in time/,
      pcut: /cut off/,
      thtml: /HTML page/,
    };
    for (const [b, re] of Object.entries(expect)) {
      assert.notEqual(by[b].status, 'ok', `${b} should fail`);
      assert.match(by[b].reason ?? '', re, `${b}: ${by[b].reason}`);
      assert.ok(!/stack|at .*\.ts:\d+/.test(by[b].reason ?? ''), `${b} reason is not plain`);
    }
    assert.equal(by.r429.status, 'blocked'); // 429 is "slow down", never "board gone"
    assert.equal(rows(run.store, "SELECT id FROM jobs WHERE board = 'rgood'").length, 2);
    // per-ATS totals equal the sum of the boards (O13)
    const rc = health.byAts.find((a) => a.ats === 'recruitee')!;
    assert.equal(rc.read, health.boards.filter((b) => b.ats === 'recruitee').reduce((s, b) => s + b.read, 0));
    assert.equal(rc.failed, Object.keys(bad).length);
  } finally {
    await run.standin.close(); run.store.close(); t.done();
  }
});

test('a failed, empty or unreadable fetch never closes stored jobs; only a proven absence does (O5)', async () => {
  const t = tmp();
  const store = new Store(join(t.dir, 'jobs.db'));
  const board: BoardRef = { ats: 'recruitee', board: 'fault-demo', company: 'Fault Demo' };
  const url = recruiteeUrl('fault-demo');
  const five = { offers: [1, 2, 3, 4, 5].map((i) => offer(i)) };
  const H = 3600 * 1000;
  const t0 = Date.parse('2026-09-25T00:00:00Z');
  let answer: string | Error = JSON.stringify(five);
  const http = fakeHttp({ [url]: () => answer });
  const run = async (hours: number) => {
    const r = await crawl([board], { store, http, sources: allSources(), now: () => t0 + hours * H });
    return r.boards[0];
  };
  const open = () => rows<{ job_id: string }>(store, 'SELECT job_id FROM jobs WHERE closed_at IS NULL ORDER BY job_id').map((r) => r.job_id);
  try {
    assert.equal((await run(0)).stats.inserted, 5);
    const steps: Array<[string, string | Error]> = [
      ['HTTP 500', new HttpError(500, url)],
      ['an empty list', JSON.stringify({ offers: [] })],
      ['garbage', 'garbage'],
      ['a renamed field', JSON.stringify({ jobs: five.offers })],
      ['every job unreadable', JSON.stringify({ offers: five.offers.map((o) => ({ ...o, id: null })) })],
      ['one job left, the rest unreadable', JSON.stringify({ offers: [offer(1), ...five.offers.slice(1).map((o) => ({ ...o, title: '' }))] })],
    ];
    let h = 50;
    for (const [what, a] of steps) {
      answer = a;
      await run(h);
      assert.deepEqual(open(), ['101', '102', '103', '104', '105'], `after ${what}`);
      h += 50;
    }
    // The good board without job 105, crawled after the 48-hour grace: only 105 closes, with a date.
    answer = JSON.stringify({ offers: five.offers.slice(0, 4) });
    const r = await run(h);
    assert.equal(r.closed, 1);
    assert.deepEqual(open(), ['101', '102', '103', '104']);
    const closed = rows<{ closed_at: string; closed_reason: string }>(store, "SELECT closed_at, closed_reason FROM jobs WHERE job_id = '105'")[0];
    assert.equal(closed.closed_reason, 'unseen');
    assert.equal(closed.closed_at, new Date(t0 + h * H).toISOString());
    // It comes back on a later crawl: it is open again.
    answer = JSON.stringify(five);
    await run(h + 10);
    assert.deepEqual(open(), ['101', '102', '103', '104', '105']);
  } finally {
    store.close(); t.done();
  }
});

test('one malformed job inside a good board is counted, never silently dropped, and never sinks the board', async () => {
  const board: BoardRef = { ats: 'recruitee', board: 'fault-demo', company: 'Fault Demo' };
  const http = fakeHttp({ [recruiteeUrl('fault-demo')]: JSON.stringify({ offers: [offer(1), { title: 'no id' }, offer(3), 'not an object'] }) });
  const jobs = await recruitee.fetchBoard(board, http);
  assert.equal(jobs.length, 4);
  assert.deepEqual(jobs.map((j) => !!j.unreadable), [false, true, false, true]);
});

function rss(ids: number[], title = (i: number) => ['Registered Nurse', 'Delivery Driver', 'Software Engineer', 'Cashier – Kraków'][i % 4]): string {
  return `<?xml version="1.0"?><rss version="2.0" xmlns:tt="x"><channel><title>Big Demo</title>${ids.map((i) =>
    `<item><title>${title(i)} ${i}</title><description>&lt;p&gt;Job ${i}&lt;/p&gt;</description><link>https://big-demo.teamtailor.com/jobs/${i}-role</link><guid>g-${i}</guid>` +
    `<tt:locations><tt:location><tt:city>${i % 3 ? 'Kraków' : 'Austin'}</tt:city><tt:country>${i % 3 ? 'Poland' : 'United States'}</tt:country></tt:location></tt:locations></item>`).join('')}</channel></rss>`;
}

test('a paged board of 250 jobs is read in full: no gap, no copy, no category filter (O11)', async () => {
  const t = tmp();
  const dir = join(t.dir, 'standin');
  mkdirSync(join(dir, 'teamtailor'), { recursive: true });
  const ids = Array.from({ length: 250 }, (_, i) => 1000 + i);
  writeFileSync(join(dir, 'teamtailor', 'big-demo.rss'), rss(ids));
  const run = await crawlStandin(dir, join(t.dir, 'jobs.db'));
  try {
    assert.equal(run.report.boards[0].status, 'ok', run.report.boards[0].error ?? '');
    const got = rows<{ job_id: string }>(run.store, 'SELECT job_id FROM jobs ORDER BY job_id').map((r) => Number(r.job_id));
    assert.deepEqual(got, ids);
    const feedCalls = run.standin.requests.filter((q) => q.path.startsWith('/jobs.rss')).map((q) => q.path);
    assert.deepEqual(feedCalls, ['/jobs.rss?offset=0&per_page=100', '/jobs.rss?offset=100&per_page=100', '/jobs.rss?offset=200&per_page=100']);
  } finally {
    await run.standin.close(); run.store.close(); t.done();
  }
});

test('a feed whose next page never ends fails the board with a reason and closes nothing', async () => {
  const board: BoardRef = { ats: 'teamtailor', board: 'loop-demo', company: 'Loop Demo' };
  // The same 100 jobs on every page.
  const same = rss(Array.from({ length: 100 }, (_, i) => i));
  const routes: Record<string, string> = {};
  for (let o = 0; o <= 200; o += 100) routes[teamtailorPageUrl('loop-demo', null, o)] = same;
  await assert.rejects(teamtailor.fetchBoard(board, fakeHttp(routes)), (e: unknown) => e instanceof PagingError && /does not advance/.test(e.message));
  // New jobs on every page, forever: stopped at the page cap.
  const endless = fakeHttp({});
  const handler = (url: string) => { const o = Number(new URL(url).searchParams.get('offset')); return rss(Array.from({ length: 100 }, (_, i) => o + i)); };
  const endlessHttp = { ...endless, getText: async (url: string) => handler(url), getJson: async () => null };
  await assert.rejects(teamtailor.fetchBoard(board, endlessHttp), (e: unknown) => e instanceof PagingError && new RegExp(`after ${TEAMTAILOR_MAX_PAGES} pages`).test(e.message));
});

test('page 2 failing fails the whole board, so page-2 jobs are never closed', async () => {
  const t = tmp();
  const store = new Store(join(t.dir, 'jobs.db'));
  const board: BoardRef = { ats: 'teamtailor', board: 'paged-demo', company: 'Paged Demo' };
  const p1 = rss(Array.from({ length: 100 }, (_, i) => i));
  const p2 = rss(Array.from({ length: 30 }, (_, i) => 100 + i));
  let fail = false;
  const http = fakeHttp({
    [teamtailorPageUrl('paged-demo', null, 0)]: p1,
    [teamtailorPageUrl('paged-demo', null, 100)]: () => (fail ? new HttpError(500, 'page 2') : p2),
  });
  try {
    await crawl([board], { store, http, sources: allSources(), now: () => Date.parse('2026-09-25T00:00:00Z') });
    assert.equal(rows(store, 'SELECT id FROM jobs WHERE closed_at IS NULL').length, 130);
    fail = true;
    const r = await crawl([board], { store, http, sources: allSources(), now: () => Date.parse('2026-09-28T00:00:00Z') });
    assert.equal(r.boards[0].status, 'failed');
    assert.equal(rows(store, 'SELECT id FROM jobs WHERE closed_at IS NULL').length, 130);
  } finally {
    store.close(); t.done();
  }
});

test('a board token that is not a plain slug sends nothing (no host injection)', async () => {
  for (const [src, bad] of [[recruitee, 'evil.com/x?'], [personio, 'a.b'], [teamtailor, 'x@evil.com'], [workable, '../admin']] as const) {
    const http = fakeHttp({});
    await assert.rejects(src.fetchBoard({ ats: src.ats, board: bad, company: 'x' }, http), BoardTokenError);
    assert.deepEqual(http.calls, [], `${src.ats} sent a request for "${bad}"`);
  }
});

test('Personio fills empty bodies from the English feed once, and survives its failure', async () => {
  const board: BoardRef = { ats: 'personio', board: 'lang-demo', company: 'Lang Demo' };
  const base = (body: string) => `<workzag-jobs><position><id>7</id><name>Koch</name><office>Wien</office><jobDescriptions><jobDescription><name>Aufgaben</name><value>${body}</value></jobDescription></jobDescriptions></position></workzag-jobs>`;
  const http = fakeHttp({ [personioUrl('lang-demo')]: base(''), [personioUrl('lang-demo', null, 'en')]: base('<![CDATA[<p>Cook meals.</p>]]>') });
  const jobs = await personio.fetchBoard(board, http);
  assert.equal(http.calls.length, 2);
  assert.match(jobs[0].descriptionHtml, /Cook meals/);
  const failing = fakeHttp({ [personioUrl('lang-demo')]: base(''), [personioUrl('lang-demo', null, 'en')]: new HttpError(500, 'en') });
  const again = await personio.fetchBoard(board, failing);
  assert.equal(again.length, 1);
  assert.equal(again[0].descriptionHtml, '');
  // The .com host is read when the board says so.
  const com = fakeHttp({ 'https://lang-demo.jobs.personio.com/xml': base('<![CDATA[<p>x</p>]]>') });
  assert.equal((await personio.fetchBoard({ ...board, region: 'com' }, com)).length, 1);
});
