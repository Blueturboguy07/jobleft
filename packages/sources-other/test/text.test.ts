import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countryCode, fixMojibake, parseRemoteScope, payFromSalaryField, placeFromText, safeHttpUrl, scopeOpenToUs,
} from '../src/text.ts';

test('mojibake is repaired only when the bytes are really double-encoded UTF-8', () => {
  assert.equal(fixMojibake('MecÃ¡nico Automotriz DiagnÃ³stico'), 'Mecánico Automotriz Diagnóstico');
  assert.equal(fixMojibake('MÃ©xico'), 'México');
  assert.equal(fixMojibake('café'), 'café'); // genuine Latin-1 text stays
  assert.equal(fixMojibake('Mecánico MecÃ¡nico'), 'Mecánico MecÃ¡nico'); // mixed text is left alone
  assert.equal(fixMojibake('plain ascii'), 'plain ascii');
});

test('remote scope keeps the words and names only stated regions', () => {
  assert.deepEqual(parseRemoteScope('USA Only')?.regions, ['US']);
  assert.deepEqual(parseRemoteScope('Remote - US')?.regions, ['US']);
  assert.deepEqual(parseRemoteScope('Europe only')?.regions, ['EU']);
  assert.deepEqual(parseRemoteScope('Worldwide')?.regions, ['WORLDWIDE']);
  assert.deepEqual(parseRemoteScope('Remote in USA')?.regions, ['US']);
  assert.deepEqual(parseRemoteScope('USA, Canada')?.regions, ['US', 'CA']);
  assert.deepEqual(parseRemoteScope('Americas')?.regions, ['NA', 'LATAM']);
  assert.deepEqual(parseRemoteScope('Remote')?.regions, []);
  assert.equal(parseRemoteScope(''), null);
  // "join us" is not the US; time zones are working hours, not regions
  assert.deepEqual(parseRemoteScope('Remote, come join us')?.regions, []);
  assert.deepEqual(parseRemoteScope('Remote, PT/ET hours preferred')?.regions, []);
  assert.deepEqual(parseRemoteScope('REMOTE (2h overlap with US Pacific)')?.regions, []);
  assert.equal(parseRemoteScope('Europe only')?.text, 'Europe only');
});

test('open to US applicants: US, worldwide and North America yes; Europe only no; unstated unknown', () => {
  assert.equal(scopeOpenToUs(parseRemoteScope('USA only')), true);
  assert.equal(scopeOpenToUs(parseRemoteScope('Worldwide')), true);
  assert.equal(scopeOpenToUs(parseRemoteScope('Europe only')), false);
  assert.equal(scopeOpenToUs(parseRemoteScope('Remote')), null);
  assert.equal(scopeOpenToUs(null), null);
});

test('pay from a salary field keeps the period and the currency as written', () => {
  const hour = payFromSalaryField('$30 an hour');
  assert.equal(hour?.period, 'hour');
  assert.equal(hour?.min, 30);
  assert.equal(hour?.currency, 'USD');
  assert.equal(payFromSalaryField('$60/hr')?.period, 'hour');
  const eur = payFromSalaryField('€50k - €60k');
  assert.deepEqual([eur?.min, eur?.max, eur?.currency, eur?.period], [50000, 60000, 'EUR', 'year']);
  assert.equal(payFromSalaryField('£3,000/mo')?.period, 'month');
  assert.equal(payFromSalaryField('£3,000/mo')?.currency, 'GBP');
  assert.equal(payFromSalaryField('$130,000 – $210,000 CAD')?.currency, 'CAD');
  assert.equal(payFromSalaryField('$30'), null, 'no period and too small to be a yearly salary');
  assert.equal(payFromSalaryField('competitive'), null);
  assert.equal(payFromSalaryField('145k-165k'), null, 'no currency written');
  assert.equal(payFromSalaryField('Junior ($300k), Mid ($350k), Senior ($300k-$400k)'), null, 'several roles');
});

test('places: only what the text says', () => {
  assert.deepEqual(placeFromText('Austin, TX'), { text: 'Austin, TX', city: 'Austin', region: 'TX', country: 'US', placeId: null });
  assert.equal(placeFromText('Austin, Austin, Texas, United States')?.country, 'US');
  assert.equal(placeFromText('Mendip, United Kingdom')?.country, 'GB');
  assert.equal(placeFromText('Germany')?.country, 'DE');
  assert.equal(placeFromText('Remote'), null);
  assert.equal(placeFromText('Remote - US'), null);
  assert.equal(placeFromText('Mexico City, Mexico - Remote')?.country, 'MX');
  const unknown = placeFromText('Toronto, ON');
  assert.equal(unknown?.country, null, 'ON is not guessed');
  assert.equal(countryCode('CA'), null, 'CA is California or Canada: not guessed');
  assert.equal(countryCode('México'), 'MX');
});

test('links: only absolute http(s)', () => {
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('data:text/html,hi'), null);
  assert.equal(safeHttpUrl('/relative'), null);
  assert.equal(safeHttpUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
});
