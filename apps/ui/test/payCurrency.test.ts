// The pay filter in the person's currency (web search lane).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFilter, payCurrencyFor, payLabel } from '../src/lib/filters.ts';

test('the pay filter in your currency: euros for the Netherlands, the sign in the label, no currency without a minimum', () => {
  assert.equal(payCurrencyFor('NL'), 'EUR');
  assert.equal(payCurrencyFor('gb'), 'GBP');
  assert.equal(payCurrencyFor('US'), 'USD');
  assert.equal(payCurrencyFor(null), 'USD');
  assert.equal(payLabel({ minAnnualPayUsd: 50000, payCurrency: 'EUR' }), '€50K+ a year');
  assert.equal(payLabel({ minAnnualPayUsd: 80000 }), '$80K+ a year');
  assert.deepEqual(cleanFilter({ payCurrency: 'EUR' }), {});
  assert.deepEqual(cleanFilter({ minAnnualPayUsd: 80000, payCurrency: 'USD' }), { minAnnualPayUsd: 80000 });
  assert.deepEqual(cleanFilter({ minAnnualPayUsd: 50000, payCurrency: 'EUR' }), { minAnnualPayUsd: 50000, payCurrency: 'EUR' });
});
