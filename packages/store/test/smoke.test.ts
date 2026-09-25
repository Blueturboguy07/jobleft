import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_NAME, makeJobId, openDatabase } from '../src/index.ts';

test('@jobleft/store loads under Node type stripping', () => {
  assert.equal(PACKAGE_NAME, '@jobleft/store');
});

test('openDatabase: a new file gets 16 KB pages; job ids are stable', () => {
  const db = openDatabase(':memory:');
  assert.equal((db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size, 16384);
  db.close();
  assert.equal(makeJobId('Greenhouse', 'AcmeHealth', '4001'), 'greenhouse:acmehealth:4001');
});
