import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pay } from '@jobleft/contracts';
import { payText } from '../src/lib/format.ts';

test('pay: both ends of a range in one form (JL-tracker-22)', () => {
  assert.equal(payText({ min: 141773, max: 162000, currency: 'USD', period: 'year' } as never), '$141,773/yr - $162,000/yr');
  assert.equal(payText({ min: 135000, max: 200000, currency: 'USD', period: 'year' } as never), '$135K/yr - $200K/yr');
  assert.equal(payText({ min: 38.5, max: 52, currency: 'USD', period: 'hour' } as never), '$38.50/hr - $52/hr');
});

const year = (min: number | null, max: number | null): Pay => ({ min, max, currency: 'USD', period: 'year', source: 'board_field', annualMin: min, annualMax: max } as Pay);

test('both ends of a pay range use one format (JL-onboarding-25)', () => {
  assert.equal(payText(year(187200, 295520)), '$187,200/yr - $295,520/yr');
  assert.equal(payText(year(150000, 200000)), '$150K/yr - $200K/yr');
  assert.equal(payText(year(88500, null)), 'From $88.5K/yr');
});
