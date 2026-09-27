import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pay } from '@jobleft/contracts';
import { payText } from '../src/lib/format.ts';

const year = (min: number | null, max: number | null): Pay => ({ min, max, currency: 'USD', period: 'year', source: 'board_field', annualMin: min, annualMax: max } as Pay);

test('both ends of a pay range use one format (JL-onboarding-25)', () => {
  assert.equal(payText(year(187200, 295520)), '$187,200/yr - $295,520/yr');
  assert.equal(payText(year(150000, 200000)), '$150K/yr - $200K/yr');
  assert.equal(payText(year(88500, null)), 'From $88.5K/yr');
});
