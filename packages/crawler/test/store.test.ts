import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJob } from '../src/job.ts';
import { Store } from '../src/store.ts';
import type { BoardRef, RawJob } from '../src/types.ts';

const board: BoardRef = { ats: 'lever', board: 'acme', company: 'Acme Health' };
const T0 = '2026-09-01T00:00:00.000Z';
const T1 = '2026-09-02T00:00:00.000Z';
const T5 = '2026-09-06T00:00:00.000Z';

function raw(id: string, over: Partial<RawJob> = {}): RawJob {
  return {
    externalId: id, url: `https://jobs.lever.co/acme/${id}`, applyUrl: `https://jobs.lever.co/acme/${id}/apply`,
    title: 'Registered Nurse', company: 'Acme Health', location: 'Austin, TX', descriptionHtml: '<p>Care for patients.</p>',
    remote: false, workMode: '', countries: [], postedAt: '2026-08-20T00:00:00.000Z', employmentType: 'full_time',
    department: 'Clinical', pay: null, ...over,
  };
}
const job = (id: string, over: Partial<RawJob> = {}, b: BoardRef = board) => {
  const j = normalizeJob(b, raw(id, over));
  assert.ok(j, 'job must normalise');
  return j;
};

test('store: first save inserts, identical re-crawl is the cheap refresh (only last_seen moves)', () => {
  const s = new Store(':memory:');
  assert.equal(s.upsertJob(job('a1'), T0).status, 'inserted');
  const before = s.db.prepare('SELECT updated_at, last_seen FROM jobs').get() as { updated_at: string; last_seen: string };
  assert.equal(s.upsertJob(job('a1'), T1).status, 'unchanged');
  const after = s.db.prepare('SELECT updated_at, last_seen, first_seen FROM jobs').get() as { updated_at: string; last_seen: string; first_seen: string };
  assert.equal(after.updated_at, before.updated_at, 'content untouched');
  assert.equal(after.last_seen, T1);
  assert.equal(after.first_seen, T0);
  assert.equal(s.count(), 1);
});

test('store: an edited posting is updated in place and the full-text index follows the edit', () => {
  const s = new Store(':memory:');
  s.upsertJob(job('a1', { descriptionHtml: '<p>Care for patients on a night shift.</p>' }), T0);
  assert.equal(s.search('night').length, 1);
  assert.equal(s.upsertJob(job('a1', { descriptionHtml: '<p>Care for patients on a day shift.</p>' }), T1).status, 'updated');
  assert.equal(s.search('night').length, 0, 'old text leaves the index');
  assert.equal(s.search('day').length, 1);
  assert.equal(s.count(), 1);
});

test('dedupe layer 1: a different identity with the same canonical URL is the same posting and is not stored twice', () => {
  const s = new Store(':memory:');
  assert.equal(s.upsertJob(job('a1'), T0).status, 'inserted');
  const other = job('a2', { url: 'https://jobs.lever.co/acme/a1?utm_source=twitter' });
  assert.equal(s.upsertJob(other, T0).status, 'dupUrl');
  assert.equal(s.count(), 1);
});

test('dedupe layer 2: the same role in another city is stored, flagged duplicate_of the oldest open copy, and hidden from search', () => {
  const s = new Store(':memory:');
  const r1 = s.upsertJob(job('a1', { location: 'Austin, TX' }), T0);
  const r2 = s.upsertJob(job('a2', { location: 'Dallas, TX' }), T0);
  const r3 = s.upsertJob(job('a3', { location: 'Houston, TX' }), T0);
  assert.deepEqual([r1.dupRole, r2.dupRole, r3.dupRole], [false, true, true]);
  assert.equal(s.count(), 3, 'no row is dropped: the city differs');
  assert.equal(s.count('duplicate_of IS NOT NULL'), 2);
  const first = s.db.prepare("SELECT id FROM jobs WHERE job_id = 'a1'").get() as { id: number };
  assert.equal(s.count('duplicate_of = ?', first.id), 2);
  assert.equal(s.search('nurse').length, 1, 'search shows one card per role');
});

test('close: a posting unseen past the grace window is closed by the board sweep, a fresh one stays open', () => {
  const s = new Store(':memory:');
  s.upsertJob(job('gone', { title: 'Cashier' }), T0);
  s.upsertJob(job('kept', { title: 'Pharmacist' }), T0);
  s.upsertJob(job('kept', { title: 'Pharmacist' }), T5); // seen again on day 5
  const closed = s.closeUnseenForBoard('lever', 'acme', '2026-09-04T00:00:00.000Z', T5);
  assert.equal(closed, 1);
  assert.equal(s.count('closed_at IS NULL'), 1);
  const g = s.db.prepare("SELECT closed_reason FROM jobs WHERE job_id = 'gone'").get() as { closed_reason: string };
  assert.equal(g.closed_reason, 'unseen');
});

test('close: the sweep is scoped to one board and never touches another board of the same ATS', () => {
  const s = new Store(':memory:');
  const other: BoardRef = { ats: 'lever', board: 'beta', company: 'Beta Bank' };
  s.upsertJob(job('a1'), T0);
  s.upsertJob(job('b1', { title: 'Teller', url: 'https://jobs.lever.co/beta/b1' }, other), T0);
  assert.equal(s.closeUnseenForBoard('lever', 'acme', T5, T5), 1);
  assert.equal(s.count("board = 'beta' AND closed_at IS NULL"), 1);
});

test('reopen: a closed posting that reappears is reopened even when its content is identical', () => {
  const s = new Store(':memory:');
  s.upsertJob(job('a1'), T0);
  s.closeUnseenForBoard('lever', 'acme', T5, T5);
  assert.equal(s.count('closed_at IS NULL'), 0);
  assert.equal(s.upsertJob(job('a1'), T5).status, 'updated');
  const r = s.db.prepare('SELECT closed_at, closed_reason FROM jobs').get() as { closed_at: string | null; closed_reason: string | null };
  assert.equal(r.closed_at, null);
  assert.equal(r.closed_reason, null);
});

test('board health: cooldown starts at the 3rd consecutive failure and success clears it', () => {
  const s = new Store(':memory:');
  s.ensureBoard('lever', 'acme', 'Acme');
  const now = Date.parse(T0);
  assert.equal(s.recordFailure('lever', 'acme', 'boom', T0), 1);
  assert.equal(s.recordFailure('lever', 'acme', 'boom', T0), 2);
  assert.equal(s.isCooledDown('lever', 'acme', now + 1), false);
  assert.equal(s.recordFailure('lever', 'acme', 'boom', T0), 3);
  assert.equal(s.isCooledDown('lever', 'acme', now + 1), true);
  assert.equal(s.isCooledDown('lever', 'acme', now + 7 * 3600 * 1000), false, 'cooldown is 6h at the threshold');
  s.recordSuccess('lever', 'acme', 10, true, T1);
  assert.equal(s.getBoard('lever', 'acme')?.consecutive_failures, 0);
  assert.equal(s.isCooledDown('lever', 'acme', now + 1), false);
});

test('store keeps non-IT jobs untouched: nurse, cashier, teller, teacher, barista all persist with description and level', () => {
  const s = new Store(':memory:');
  const titles = ['Registered Nurse II', 'Cashier', 'Teller Supervisor', 'Middle School Math Teacher', 'Barista', 'Warehouse Associate', 'Medical Assistant'];
  titles.forEach((t, i) => s.upsertJob(job('x' + i, { title: t, location: `City${i}, TX` }), T0));
  assert.equal(s.count(), titles.length);
  assert.equal(s.count("length(description) > 0"), titles.length);
  const lv = Object.fromEntries((s.db.prepare('SELECT title, level FROM jobs').all() as Array<{ title: string; level: string | null }>).map((r) => [r.title, r.level]));
  assert.deepEqual(lv, {
    'Registered Nurse II': 'mid', 'Cashier': null, 'Teller Supervisor': 'lead', 'Middle School Math Teacher': null,
    'Barista': null, 'Warehouse Associate': 'entry', 'Medical Assistant': 'entry',
  });
});
