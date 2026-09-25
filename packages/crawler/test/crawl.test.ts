// End-to-end crawl with a fake network and the real store: proves the close-vanished logic and the
// mass-close guard as they run in the pipeline, not only as pure functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawl } from '../src/crawl.ts';
import { HttpError, NotFoundError } from '../src/http.ts';
import { Store } from '../src/store.ts';
import type { Ats, BoardRef, HttpGetter, RawJob, Source } from '../src/types.ts';

const D = 24 * 3600 * 1000;
const START = Date.parse('2026-09-01T00:00:00Z');

function raw(id: string, title = 'Registered Nurse'): RawJob {
  return {
    externalId: id, url: `https://jobs.lever.co/x/${id}`, applyUrl: '', title, company: 'X', location: 'Austin, TX',
    descriptionHtml: `<p>${title} ${id}</p>`, remote: false, workMode: '', countries: [], postedAt: null, employmentType: '',
    department: '', pay: null,
  };
}

/** A programmable source: each board returns a list or throws. */
function fakeSource(script: Map<string, RawJob[] | Error>, ats: Ats = 'lever', full = true): Source {
  return {
    ats, fullBoardListing: full,
    async fetchBoard(b: BoardRef): Promise<RawJob[]> {
      const v = script.get(b.board);
      if (v === undefined) throw new NotFoundError(404, b.board);
      if (v instanceof Error) throw v;
      return v;
    },
  };
}
const http: HttpGetter = { getJson: async () => { throw new Error('no network in tests'); } };
const boards = (...names: string[]): BoardRef[] => names.map((n) => ({ ats: 'lever' as Ats, board: n, company: n }));
const sources = (s: Source) => ({ greenhouse: s, lever: s, ashby: s }) as Record<Ats, Source>;

async function run(store: Store, script: Map<string, RawJob[] | Error>, names: string[], nowMs: number, full = true) {
  return crawl(boards(...names), { store, http, sources: sources(fakeSource(script, 'lever', full)), now: () => nowMs, graceMs: 2 * D });
}

test('e2e: a job that vanishes from a healthy board is closed once it is unseen past the 48h grace window', async () => {
  const s = new Store(':memory:');
  const jobs = Array.from({ length: 12 }, (_, i) => raw('j' + i, 'Role ' + i));
  await run(s, new Map([['acme', jobs]]), ['acme'], START);
  assert.equal(s.count('closed_at IS NULL'), 12);
  // Day 1: one job gone. Only 24h unseen, so still open.
  let r = await run(s, new Map([['acme', jobs.slice(1)]]), ['acme'], START + D);
  assert.equal(r.totals.closed, 0);
  // Day 3: 72h unseen, past the grace window.
  r = await run(s, new Map([['acme', jobs.slice(1)]]), ['acme'], START + 3 * D);
  assert.equal(r.totals.closed, 1);
  assert.equal(s.count('closed_at IS NULL'), 11);
});

test('e2e MASS-CLOSE GUARD: a board that fails on a later run closes nothing, however old its postings are', async () => {
  const s = new Store(':memory:');
  await run(s, new Map([['acme', Array.from({ length: 20 }, (_, i) => raw('j' + i, 'Role ' + i))]]), ['acme'], START);
  const r = await run(s, new Map<string, RawJob[] | Error>([['acme', new HttpError(500, 'x')]]), ['acme'], START + 10 * D);
  assert.equal(r.boards[0].status, 'failed');
  assert.equal(r.totals.closed, 0);
  assert.equal(s.count('closed_at IS NULL'), 20);
});

test('e2e MASS-CLOSE GUARD: a board that suddenly lists zero postings closes nothing (empty answer is not evidence)', async () => {
  const s = new Store(':memory:');
  await run(s, new Map([['acme', Array.from({ length: 20 }, (_, i) => raw('j' + i, 'Role ' + i))]]), ['acme'], START);
  const r = await run(s, new Map([['acme', []]]), ['acme'], START + 10 * D);
  assert.equal(r.boards[0].status, 'ok');
  assert.equal(r.totals.closed, 0);
  assert.equal(s.count('closed_at IS NULL'), 20);
});

test('e2e: a failed board does not stop its healthy neighbour from closing its own vanished postings', async () => {
  const s = new Store(':memory:');
  const good = Array.from({ length: 12 }, (_, i) => raw('g' + i, 'Good ' + i));
  const bad = Array.from({ length: 12 }, (_, i) => raw('b' + i, 'Bad ' + i));
  await run(s, new Map([['good', good], ['bad', bad]]), ['good', 'bad'], START);
  const r = await run(s, new Map<string, RawJob[] | Error>([['good', good.slice(1)], ['bad', new HttpError(503, 'x')]]), ['good', 'bad'], START + 3 * D);
  assert.equal(r.totals.closed, 1);
  assert.equal(s.count("board = 'bad' AND closed_at IS NULL"), 12);
  assert.equal(s.count("board = 'good' AND closed_at IS NULL"), 11);
});

test('e2e: an adapter that is not fullBoardListing never closes by absence', async () => {
  const s = new Store(':memory:');
  const jobs = Array.from({ length: 12 }, (_, i) => raw('j' + i, 'Role ' + i));
  await run(s, new Map([['acme', jobs]]), ['acme'], START, false);
  const r = await run(s, new Map([['acme', jobs.slice(1)]]), ['acme'], START + 3 * D, false);
  assert.equal(r.totals.closed, 0);
});

test('e2e LOCAL GUARD: a run that would close over half of a big board at once is held for review', async () => {
  const s = new Store(':memory:');
  const jobs = Array.from({ length: 20 }, (_, i) => raw('j' + i, 'Role ' + i));
  await run(s, new Map([['acme', jobs]]), ['acme'], START);
  const r = await run(s, new Map([['acme', jobs.slice(0, 5)]]), ['acme'], START + 3 * D);
  assert.equal(r.totals.closed, 0);
  assert.match(r.boards[0].closeHeld ?? '', /held for review/);
  assert.equal(s.count('closed_at IS NULL'), 20);
});

test('e2e: three consecutive failures put a board in cooldown and the next run skips it without touching the network', async () => {
  const s = new Store(':memory:');
  const script = new Map<string, RawJob[] | Error>([['flaky', new HttpError(500, 'x')]]);
  for (let i = 0; i < 3; i++) await run(s, script, ['flaky'], START + i * 1000);
  const r = await run(s, script, ['flaky'], START + 4000);
  assert.equal(r.boards[0].status, 'cooled');
});

test('e2e: empty-feed net closes a board only after the 7 day window AND three clean empty crawls', async () => {
  const s = new Store(':memory:');
  const jobs = Array.from({ length: 6 }, (_, i) => raw('j' + i, 'Role ' + i));
  await run(s, new Map([['acme', jobs]]), ['acme'], START);
  const empty = new Map([['acme', [] as RawJob[]]]);
  let r = await run(s, empty, ['acme'], START + 3 * D); // streak 1, window not over
  assert.equal(r.totals.closed, 0);
  r = await run(s, empty, ['acme'], START + 8 * D); // streak 2, window over
  assert.equal(r.totals.closed, 0, 'two empty answers are still not enough');
  r = await run(s, empty, ['acme'], START + 9 * D); // streak 3
  assert.equal(r.totals.closed, 6);
  assert.equal(s.count("closed_reason = 'board_empty'"), 6);
});

test('e2e dedupe: a re-crawl of an unchanged board stores nothing new and reports every job as unchanged', async () => {
  const s = new Store(':memory:');
  const jobs = Array.from({ length: 9 }, (_, i) => raw('j' + i, 'Role ' + i));
  const r1 = await run(s, new Map([['acme', jobs]]), ['acme'], START);
  const r2 = await run(s, new Map([['acme', jobs]]), ['acme'], START + 1000);
  assert.equal(r1.totals.inserted, 9);
  assert.equal(r2.totals.inserted, 0);
  assert.equal(r2.totals.unchanged, 9);
  assert.equal(s.count(), 9);
});

test('e2e: postings with no title or id are counted as skipped, and skipped alone never lets a board close anything', async () => {
  const s = new Store(':memory:');
  const bad = [raw('', 'No id'), raw('x1', '   ')];
  const r = await run(s, new Map([['acme', bad]]), ['acme'], START);
  assert.equal(r.totals.skipped, 2);
  assert.equal(r.totals.ingested, 0);
  assert.equal(r.totals.closed, 0);
});
