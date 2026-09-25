import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_NAME } from '../src/index.ts';

test('@jobleft/sources-other loads under Node type stripping', () => {
  assert.equal(PACKAGE_NAME, '@jobleft/sources-other');
});
