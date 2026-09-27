import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payText } from '../src/lib/format.ts';

test('pay: both ends of a range in one form (JL-tracker-22)', () => {
  assert.equal(payText({ min: 141773, max: 162000, currency: 'USD', period: 'year' } as never), '$141,773/yr - $162,000/yr');
  assert.equal(payText({ min: 135000, max: 200000, currency: 'USD', period: 'year' } as never), '$135K/yr - $200K/yr');
  assert.equal(payText({ min: 38.5, max: 52, currency: 'USD', period: 'hour' } as never), '$38.50/hr - $52/hr');
});
