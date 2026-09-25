import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_NAME, SCREENS, takeTokenFromFragment } from '../src/index.ts';

test('@jobleft/ui loads under Node type stripping', () => {
  assert.equal(PACKAGE_NAME, '@jobleft/ui');
  assert.ok(Object.values(SCREENS).every((s) => s.startsWith('#/')));
});

test('the launch token is read from the URL fragment and removed from it', () => {
  assert.deepEqual(takeTokenFromFragment('#token=abc&x=1'), { token: 'abc', rest: 'x=1' });
  assert.deepEqual(takeTokenFromFragment(''), { token: null, rest: '' });
});
