// Notification history: shown and unshown ones newest first, and Clear hides them without letting an alert repeat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SERVER_MIGRATIONS } from '../src/db/schema.ts';
import { NotificationService } from '../src/services/notifications.ts';

test('history keeps shown notifications; clear hides them all and the dedupe key still holds', () => {
  const db = new DatabaseSync(':memory:');
  for (const m of SERVER_MIGRATIONS) db.exec(m.sql);
  const s = new NotificationService(db);
  new NotificationService(db); // a second start finds the column already there
  const a = s.add({ kind: 'reminder', title: 'A', body: '', target: '/jobs/j1' }, 'k-a')!;
  s.add({ kind: 'new_matches', title: 'B', body: '', target: '/jobs' }, 'k-b');
  s.ack(a.id);
  assert.deepEqual(s.pending().map((n) => n.title), ['B']);
  assert.deepEqual(s.history().map((n) => n.title).sort(), ['A', 'B']);

  assert.equal(s.clear(), 2);
  assert.deepEqual(s.history(), []);
  assert.deepEqual(s.pending(), [], 'clearing marks the unshown ones shown too');
  assert.equal(s.add({ kind: 'reminder', title: 'A again', body: '', target: null }, 'k-a'), null, 'a cleared alert never repeats');
  s.add({ kind: 'reminder', title: 'C', body: '', target: null }, 'k-c');
  assert.deepEqual(s.history().map((n) => n.title), ['C']);
});
