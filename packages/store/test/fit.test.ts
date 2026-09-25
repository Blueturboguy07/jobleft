import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FitIndex } from '../src/index.ts';
import { CTX, NOW, WordEmbedder, freshStore, ids, job } from './helpers.ts';

test('fit indexing embeds each job once; unchanged refreshes cause no work; changed text is embedded again', async () => {
  const s = freshStore();
  const e = new WordEmbedder();
  const fit = new FitIndex(s.db, e);
  const jobs = Array.from({ length: 120 }, (_, i) => job({ id: `f:${i}`, title: `Warehouse Associate ${i}`, description: `Pick and pack orders. Shift ${i}.` }));
  s.upsertJobs(jobs, { now: NOW });
  let st = fit.status();
  assert.equal(st.waiting, 120);
  assert.equal((await fit.runAll()).indexed, 120);
  st = fit.status();
  assert.equal(st.indexed, 120);
  assert.equal(st.waiting, 0);
  // Same listing again (new seen time only): nothing to embed, and the run says 0.
  s.upsertJobs(jobs, { now: NOW + 3600_000 });
  assert.equal((await fit.runAll()).indexed, 0);
  assert.equal(fit.status().lastRun!.indexed, 0);
  // A pay change is not an embed-text change.
  s.upsertJobs([{ ...jobs[0]!, pay: { min: 20, max: 25, currency: 'USD', period: 'hour' } }], { now: NOW });
  assert.equal(fit.status().waiting, 0);
  // Five description changes: five new vectors, and the old vectors stop counting at once.
  s.upsertJobs(jobs.slice(0, 5).map((j) => ({ ...j, description: 'Drive a forklift and load trucks.' })), { now: NOW });
  assert.equal(fit.status().waiting, 5);
  const before = e.texts;
  assert.equal((await fit.runAll()).indexed, 5);
  assert.equal(e.texts - before, 5);
  assert.equal(fit.status().lastRun!.indexed, 5);
});

test('Top Matched ranks by fit, keeps not-yet-scored jobs (marked), and obeys filters', async () => {
  const s = freshStore();
  const e = new WordEmbedder();
  const fit = new FitIndex(s.db, e);
  s.upsertJobs([
    job({ id: 'ap', title: 'AP Specialist', description: 'Process vendor invoices and payments, month-end close.', workModel: 'remote' }),
    job({ id: 'nurse', title: 'Registered Nurse', description: 'Patient care in the ICU.', workModel: 'remote' }),
    job({ id: 'dev', title: 'Backend Developer', description: 'Build services in Go.', workModel: 'onsite' }),
  ], { now: NOW });
  await fit.runAll();
  s.upsertJobs([job({ id: 'late', title: 'Payments Clerk', description: 'Vendor invoices.', workModel: 'remote' })], { now: NOW });
  const [pv] = await e.embed(['vendor invoices payments month-end close']);
  const ctx = { ...CTX, profileVector: pv!, fit };
  const r = s.search({ sort: 'top_matched', filter: { workModels: ['remote'] } }, ctx);
  assert.equal(r.total, 3);
  assert.equal(r.items[0]!.job.id, 'ap');
  assert.ok(r.items[0]!.fitScore! > r.items[1]!.fitScore!);
  const late = r.items.find((i) => i.job.id === 'late')!;
  assert.equal(late.fitScore, null, 'a job that waits for indexing is shown as not scored');
  assert.equal(r.fit.state, 'indexing');
  assert.equal(r.fit.waiting, 1);
  assert.ok(!ids(r.items).includes('dev'));
  // The same job opened again: the same score.
  const again = s.search({ sort: 'top_matched', filter: { workModels: ['remote'] } }, ctx);
  assert.equal(again.items[0]!.fitScore, r.items[0]!.fitScore);
});

test('the fit queue does the jobs that pass the person\'s hard filters first', async () => {
  const s = freshStore();
  const e = new WordEmbedder();
  const fit = new FitIndex(s.db, e, { priorityFilter: () => ({ workModels: ['remote'] }) });
  s.upsertJobs([
    job({ id: 'o1', workModel: 'onsite', postedAt: '2026-09-25T10:00:00Z' }),
    job({ id: 'r1', workModel: 'remote', postedAt: '2026-09-01T10:00:00Z' }),
    job({ id: 'o2', workModel: 'onsite', postedAt: '2026-09-24T10:00:00Z' }),
  ], { now: NOW });
  const q = fit.queue();
  const byId = new Map((s.db.prepare('SELECT rid, id FROM store_jobs').all() as Array<{ rid: number; id: string }>).map((r) => [Number(r.rid), r.id]));
  assert.deepEqual(q.map((rid) => byId.get(rid)), ['r1', 'o1', 'o2']);
});
