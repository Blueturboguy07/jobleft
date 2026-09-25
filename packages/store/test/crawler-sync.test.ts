// The store fed by the real crawler (same database file, two connections), with a fake network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { crawl, HttpError, Store, type Ats, type BoardRef, type HttpGetter, type RawJob, type Source } from '@jobleft/crawler';
import { JobStore, migrate, openDatabase, TrackerStore } from '../src/index.ts';

const D = 86_400_000;
const START = Date.parse('2026-09-01T00:00:00Z');

function raw(id: string, title: string): RawJob {
  return {
    externalId: id, url: `https://boards.greenhouse.io/acme/jobs/${id}`, applyUrl: '', title, company: 'Acme', location: 'Austin, TX; Remote - US',
    descriptionHtml: `<p>${title}. Pay: $40 - $50 per hour.</p>`, remote: false, workMode: 'hybrid', countries: ['US'], postedAt: '2026-08-30T10:00:00Z',
    employmentType: 'full_time', department: 'Ops', pay: { min: 40, max: 50, currency: 'USD', period: 'hour' },
  };
}

test('crawler rows mirror into the store: new, unchanged, closed after the grace window, and a failing board closes nothing', async () => {
  const dir = mkdtempSync('/private/tmp/jobleft-sync-test-');
  const path = join(dir, 'jobleft.db');
  const db = openDatabase(path);
  migrate(db);
  const crawlStore = new Store(path, { fts: false });
  const store = new JobStore(db);
  const script = new Map<string, RawJob[] | Error>();
  const source: Source = { ats: 'greenhouse', fullBoardListing: true, async fetchBoard(b: BoardRef) { const v = script.get(b.board)!; if (v instanceof Error) throw v; return v; } };
  const http: HttpGetter = { getJson: async () => { throw new Error('no network in tests'); } };
  const boards: BoardRef[] = [{ ats: 'greenhouse' as Ats, board: 'acme', company: 'Acme' }];
  const run = (now: number) => crawl(boards, { store: crawlStore, http, sources: { greenhouse: source }, now: () => now, graceMs: 2 * D });
  const ctx = { profileVector: null, h1b: null, places: null, now: START + 5 * D };
  try {
    const jobs = Array.from({ length: 50 }, (_, i) => raw(String(4_000_000 + i), `Dispatcher ${i}`));
    script.set('acme', jobs);
    await run(START);
    let r = store.syncFromCrawler(START);
    assert.equal(r.inserted, 50);
    assert.equal(store.search({ sort: 'recommended' }, ctx).total, 50);
    const one = store.get('greenhouse:acme:4000001')!;
    assert.equal(one.pay!.period, 'hour');
    assert.deepEqual(one.places.map((p) => p.text), ['Austin, TX', 'Remote - US']);
    assert.equal(one.workModel, 'hybrid');
    new TrackerStore(db).patch('greenhouse:acme:4000001', { liked: true }, START);
    script.set('acme', jobs.slice(10));
    await run(START + 1 * D);
    store.syncFromCrawler(START + D);
    assert.equal(store.search({ sort: 'recommended' }, ctx).total, 50, 'inside the grace window nothing closes');
    await run(START + 3 * D);
    r = store.syncFromCrawler(START + 3 * D);
    assert.equal(r.closed, 10);
    for (const sort of ['recommended', 'most_recent'] as const) assert.equal(store.search({ sort }, ctx).total, 40);
    assert.deepEqual(new TrackerStore(db).list('closed').items.map((i) => i.job.id), ['greenhouse:acme:4000001']);
    script.set('acme', new HttpError(500, 'down'));
    await run(START + 10 * D);
    store.syncFromCrawler(START + 10 * D);
    assert.equal(store.search({ sort: 'recommended' }, ctx).total, 40);
    script.set('acme', []);
    await run(START + 11 * D);
    store.syncFromCrawler(START + 11 * D);
    assert.equal(store.search({ sort: 'recommended' }, ctx).total, 40, 'an empty answer closes nothing');
  } finally {
    crawlStore.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
