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

// Changed by the crawler lane (outcome crawler O5: "two different jobs never merge"). The S1 rule merged two ids on
// ONE board when they shared a page URL; some boards give every posting the same careers-page URL, so that rule lost
// real jobs. Now a board's own ids are the identity, and a shared URL merges only postings from two routes.
test('dedupe layer 1: the same canonical URL on ANOTHER board is the same posting: credited to the first, not stored twice', () => {
  const s = new Store(':memory:');
  assert.equal(s.upsertJob(job('a1'), T0).status, 'inserted');
  const other: BoardRef = { ats: 'lever', board: 'acme-careers', company: 'Acme Health' };
  const same = job('zz9', { url: 'https://jobs.lever.co/acme/a1?utm_source=twitter' }, other);
  assert.equal(s.upsertJob(same, T0).status, 'dupUrl');
  assert.equal(s.count(), 1);
  const credits = s.db.prepare('SELECT board FROM job_sources ORDER BY board').all() as Array<{ board: string }>;
  assert.deepEqual(credits.map((c) => c.board), ['acme', 'acme-careers'], 'both routes are credited');
});

test('dedupe layer 1 (O5): on ONE board, two ids that share a page URL are two different jobs', () => {
  const s = new Store(':memory:');
  assert.equal(s.upsertJob(job('a1', { url: 'https://acme.example/careers' }), T0).status, 'inserted');
  assert.equal(s.upsertJob(job('a2', { url: 'https://acme.example/careers', title: 'Cashier' }), T0).status, 'inserted');
  assert.equal(s.count(), 2);
});

// Changed by the crawler lane (outcome crawler O5: "two jobs with the same title in two cities merge, so the one in the
// user's city disappears"). The S1 rule flagged every same-title posting as a duplicate and hid it from search.
test('dedupe layer 2 (O5): the same title in other cities on one board is three jobs, all visible in search', () => {
  const s = new Store(':memory:');
  const r1 = s.upsertJob(job('a1', { location: 'Austin, TX' }), T0);
  const r2 = s.upsertJob(job('a2', { location: 'Dallas, TX' }), T0);
  const r3 = s.upsertJob(job('a3', { location: 'Houston, TX' }), T0);
  assert.deepEqual([r1.dupRole, r2.dupRole, r3.dupRole], [false, false, false]);
  assert.equal(s.count(), 3);
  assert.equal(s.count('duplicate_of IS NOT NULL'), 0);
  assert.equal(s.search('nurse').length, 3, 'every city keeps its card');
});

test('dedupe layer 2: the same company, title and places on ANOTHER board is a repeat: stored, flagged and hidden from search', () => {
  const s = new Store(':memory:');
  const other: BoardRef = { ats: 'greenhouse', board: 'acmehealth', company: 'Acme Health' };
  s.upsertJob(job('a1', { location: 'Austin, TX' }), T0);
  const r = s.upsertJob(job('g1', { location: 'Austin, TX', url: 'https://boards.greenhouse.io/acmehealth/jobs/1' }, other), T0);
  assert.equal(r.dupRole, true);
  assert.equal(s.count(), 2, 'no row is dropped');
  const first = s.db.prepare("SELECT id FROM jobs WHERE job_id = 'a1'").get() as { id: number };
  assert.equal(s.count('duplicate_of = ?', first.id), 1);
  assert.equal(s.search('nurse').length, 1, 'search shows one card for the repeated role');
  // When the first copy closes, the repeat stops hiding.
  s.closeUnseenForBoard('lever', 'acme', T5, T5);
  assert.equal(s.search('nurse').length, 1);
  assert.equal(s.count('duplicate_of IS NOT NULL'), 0);
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
