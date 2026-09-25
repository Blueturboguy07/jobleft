// Politeness that this lane adds or relies on: Retry-After, never-contact hosts, one pace per host (O3, O7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { HttpClient, Pacer, Store, crawl } from '@jobleft/crawler';
import { politeFetch, retryAfterMs } from '../src/polite-fetch.ts';
import { allSources } from '../src/registry.ts';
import { boardHost } from '../src/hosts.ts';
import { startStandin } from '../src/standin.ts';
import { tmp } from './helpers.ts';

test('Retry-After: no request reaches the host before the time has passed', async () => {
  let clock = 0;
  const hits: number[] = [];
  const base = (async () => { hits.push(clock); return new Response('', { status: hits.length === 1 ? 429 : 200, headers: { 'retry-after': '10' } }); }) as typeof fetch;
  const slept: number[] = [];
  const f = politeFetch({ fetchImpl: base, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; }, maxWaitMs: 60_000 });
  assert.equal((await f('https://a.example.org/x')).status, 429);
  clock += 2000;
  assert.equal((await f('https://a.example.org/y')).status, 200);
  assert.deepEqual(slept, [8000]);
  assert.deepEqual(hits, [0, 10_000]);
  // another host is not held back
  await f('https://b.example.org/z');
  assert.deepEqual(slept, [8000]);
});

test('Retry-After longer than the wait cap fails at once instead of holding the crawl', async () => {
  const base = (async () => new Response('', { status: 429, headers: { 'retry-after': '3600' } })) as typeof fetch;
  const f = politeFetch({ fetchImpl: base, maxWaitMs: 1000 });
  await f('https://a.example.org/x');
  await assert.rejects(f('https://a.example.org/y'), /Retry-After asks for 3600 s/);
  assert.equal(retryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('Wed, 21 Oct 2026 07:27:00 GMT')), 60_000);
  assert.equal(retryAfterMs('soon', 0), null);
});

test('never-contact hosts are refused before any request leaves', async () => {
  let calls = 0;
  const base = (async () => { calls++; return new Response('ok'); }) as typeof fetch;
  const f = politeFetch({ fetchImpl: base });
  for (const u of ['https://www.linkedin.com/jobs', 'https://api.smartrecruiters.com/v1/companies/x/postings', 'https://careers-acme.icims.com/jobs',
    'https://acme.wd5.myworkdayjobs.com/x', 'https://acme.taleo.net/careersection', 'https://x.fa.us2.oraclecloud.com/hcmUI', 'https://recruiting.ultipro.com/A',
    'https://www.indeed.com/viewjob', 'https://www.glassdoor.com/Job']) {
    await assert.rejects(f(u), /never-crawl list/, u);
  }
  assert.equal(calls, 0);
});

test('a board list with excluded families sends nothing for them', async () => {
  const t = tmp();
  const store = new Store(join(t.dir, 'jobs.db'));
  let calls = 0;
  const http = new HttpClient({ fetchImpl: politeFetch({ fetchImpl: (async () => { calls++; return new Response('{}'); }) as typeof fetch }), pacer: new Pacer(0) });
  try {
    const r = await crawl([
      { ats: 'workday' as never, board: 'acme', company: 'Acme' },
      { ats: 'smartrecruiters' as never, board: 'acme', company: 'Acme' },
      { ats: 'icims' as never, board: 'acme', company: 'Acme' },
      { ats: 'linkedin' as never, board: 'acme', company: 'Acme' },
    ], { store, http, sources: allSources() });
    assert.equal(calls, 0);
    for (const b of r.boards) assert.match(b.error ?? '', /no adapter/);
  } finally {
    store.close(); t.done();
  }
});

test('boards on one host are paced 1 s apart; boards on their own sub-domains are separate hosts', async () => {
  assert.equal(boardHost({ ats: 'recruitee', board: 'Acme' }), 'acme.recruitee.com');
  assert.equal(boardHost({ ats: 'personio', board: 'acme', region: 'com' }), 'acme.jobs.personio.com');
  assert.equal(boardHost({ ats: 'teamtailor', board: 'acme', region: 'na' }), 'acme.na.teamtailor.com');
  assert.equal(boardHost({ ats: 'workable', board: 'acme' }), 'apply.workable.com');
  const t = tmp();
  const dir = join(t.dir, 's');
  mkdirSync(join(dir, 'workable'), { recursive: true });
  for (const b of ['one', 'two', 'three']) writeFileSync(join(dir, 'workable', `${b}.json`), JSON.stringify({ name: b, jobs: [] }));
  const s = await startStandin(dir);
  const store = new Store(join(t.dir, 'jobs.db'));
  try {
    const http = new HttpClient({ hostMap: s.hostMap, pacer: new Pacer(1000), fetchImpl: politeFetch() });
    await crawl(s.boards.map(({ ats, board, company }) => ({ ats, board, company })), { store, http, sources: allSources() });
    const times = s.requests.map((q) => Date.parse(q.at));
    assert.equal(times.length, 4); // robots.txt + 3 boards, all on apply.workable.com
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 990, `gap ${times[i] - times[i - 1]} ms`);
  } finally {
    await s.close(); store.close(); t.done();
  }
});
