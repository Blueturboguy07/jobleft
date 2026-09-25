import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyKey, splitDba } from '../src/company-key.ts';

test('variants of one company give one key (O4)', () => {
  for (const v of ['Stripe', 'Stripe, Inc.', 'STRIPE INC', 'stripe inc', 'Stripe LLC', 'Stripe L.L.C.', 'Stripe, L.L.C', 'Stripe Corp.', 'Stripe Corporation', 'Stripe Co', 'Stripe Ltd', 'Stripe LLP', 'Stripe PLC', 'Stripe PBC', 'Stripe GmbH', 'The Stripe', 'Stripe, Inc.,']) {
    assert.equal(companyKey(v), 'stripe', v);
  }
  assert.equal(companyKey('Procter & Gamble'), companyKey('Procter and Gamble'));
  assert.equal(companyKey('RVi Planning + Landscape Architecture'), companyKey('RVI PLANNING AND LANDSCAPE ARCHITECTURE'));
  assert.equal(companyKey('Nestlé USA'), companyKey('NESTLE USA'));
  assert.equal(companyKey('The Home Depot'), 'homedepot');
  assert.equal(companyKey('Ramp Business Corporation'), 'rampbusiness');
});

test('ordinary words are never removed (O5)', () => {
  assert.notEqual(companyKey('Robinhood Group'), companyKey('Robinhood Markets, Inc.'));
  assert.notEqual(companyKey('Silvus Technologies'), companyKey('SVS Technologies'));
  assert.notEqual(companyKey('Lamb Insurance Services'), companyKey('ABA Insurance Services'));
  assert.notEqual(companyKey('Baltimore Orioles'), companyKey('Baltimore Aircoil Company, Inc.'));
  assert.equal(companyKey('Acme Technologies'), 'acmetechnologies');
  assert.equal(companyKey('Acme Holdings Group Services'), 'acmeholdingsgroupservices');
  assert.equal(companyKey('Bank of America'), 'bankofamerica');
  assert.equal(companyKey('Inc.'), 'inc');
});

test('doing-business-as names split', () => {
  assert.deepEqual(splitDba('People Center, Inc. d/b/a Rippling'), { legal: 'People Center, Inc.', others: ['Rippling'] });
  assert.deepEqual(splitDba('Foo LLC (DBA Bar Labs)'), { legal: 'Foo LLC', others: ['Bar Labs'] });
  assert.deepEqual(splitDba('Adbase LLC'), { legal: 'Adbase LLC', others: [] });
});
