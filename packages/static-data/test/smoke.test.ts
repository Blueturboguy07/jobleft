import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_NAME } from '../src/index.ts';

test('@jobleft/static-data loads under Node type stripping', () => {
  assert.equal(PACKAGE_NAME, '@jobleft/static-data');
});
