import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_NAME, boardId } from '../src/index.ts';

test('@jobleft/boards loads under Node type stripping', () => {
  assert.equal(PACKAGE_NAME, '@jobleft/boards');
});

test('boardId: lower case, region only when given', () => {
  assert.equal(boardId('greenhouse', 'Stripe'), 'greenhouse:stripe');
  assert.equal(boardId('lever', 'Acme', 'EU'), 'lever:eu:acme');
});
