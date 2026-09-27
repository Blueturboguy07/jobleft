import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAllPages } from '../src/lib/pages.ts';

// JL-settings-1: "All boards · 120 boards" but the table held only the first 100 (the next cursor was never read).
test('every page is read: 120 boards come back as 120 rows', async () => {
  const all = Array.from({ length: 120 }, (_, i) => `board-${i}`);
  const asked: Array<string | undefined> = [];
  const r = await readAllPages(async (cursor) => {
    asked.push(cursor);
    const start = cursor ? Number(cursor) : 0;
    const next = start + 100 < all.length ? String(start + 100) : null;
    return { items: all.slice(start, start + 100), total: all.length, nextCursor: next };
  });
  assert.equal(r.items.length, 120);
  assert.equal(r.total, 120);
  assert.deepEqual(r.items, all);
  assert.deepEqual(asked, [undefined, '100']);
});

test('a cursor that repeats, or too many pages, ends the loop', async () => {
  let n = 0;
  const r = await readAllPages(async () => { n++; return { items: [n], total: 999, nextCursor: 'same' }; });
  assert.equal(n, 2);
  assert.deepEqual(r.items, [1, 2]);
  let m = 0;
  await readAllPages(async () => { m++; return { items: [], total: 0, nextCursor: String(m) }; }, 5);
  assert.equal(m, 5);
});
