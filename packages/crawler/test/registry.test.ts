// Foundation addition (not part of the 76 ported S1 tests): the crawler accepts every contract ATS id, and a board
// whose ATS has no adapter in the registry fails with a plain reason, sends no request and closes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawl } from '../src/crawl.ts';
import { SOURCES, hostFor } from '../src/sources/index.ts';
import { Store } from '../src/store.ts';
import type { BoardRef, HttpGetter, RawJob, Source } from '../src/types.ts';

test('registry: a board on an ATS with no adapter fails with a reason and no request', async () => {
  const s = new Store(':memory:');
  let requests = 0;
  const http: HttpGetter = { getJson: async () => { requests++; return {}; } };
  const r = await crawl([{ ats: 'workable', board: 'acme', company: 'Acme' }], { store: s, http, sources: SOURCES });
  assert.equal(r.boards[0]?.status, 'failed');
  assert.match(r.boards[0]?.error ?? '', /no adapter for ATS "workable"/);
  assert.equal(requests, 0);
  assert.equal(r.totals.closed, 0);
});

test('registry: an adapter from another package plugs in and names its own host', async () => {
  const s = new Store(':memory:');
  const job: RawJob = {
    externalId: 'w1', url: 'https://apply.workable.com/acme/j/w1', applyUrl: '', title: 'Warehouse Associate', company: 'Acme',
    location: 'Reno, NV', descriptionHtml: '<p>Pick and pack.</p>', remote: false, workMode: '', countries: [], postedAt: null,
    employmentType: '', department: '', pay: null,
  };
  const workable: Source = {
    ats: 'workable', fullBoardListing: true,
    host: (b: BoardRef) => `apply.workable.com#${b.board}`,
    fetchBoard: async () => [job],
  };
  const http: HttpGetter = { getJson: async () => ({}) };
  const r = await crawl([{ ats: 'workable', board: 'acme', company: 'Acme' }], { store: s, http, sources: { ...SOURCES, workable } });
  assert.equal(r.boards[0]?.status, 'ok');
  assert.equal(r.totals.inserted, 1);
  assert.equal(hostFor('workable'), 'ats:workable', 'built-in hostFor gives a queue key for adapters it does not know');
});
