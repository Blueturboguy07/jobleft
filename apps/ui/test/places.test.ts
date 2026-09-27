import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Place } from '@jobleft/contracts';
import { placeOptions, placeText } from '../src/lib/places.ts';
import { ALL_COUNTRIES, countryName } from '../src/lib/countries.ts';

const austin = (region: string, id: string): Place => ({ text: 'Austin', city: 'Austin', region, country: 'US', placeId: id });

test('city picker rows name the state and country, so two Austins never look the same (JL-onboarding-3)', () => {
  const rows = placeOptions([austin('TX', 'gnis:1384879'), austin('AR', 'gnis:45979'), austin('MN', 'gnis:639531'), austin('MN', 'gnis:639531')]);
  assert.deepEqual(rows.map((r) => r.label), ['Austin, TX, United States', 'Austin, AR, United States', 'Austin, MN, United States']);
  assert.equal(new Set(rows.map((r) => r.label)).size, rows.length);
  const london = placeOptions([
    { text: 'London', city: 'London', region: 'Westminster', country: 'GB', placeId: 'ne:1' },
    { text: 'London', city: 'London', region: 'ON', country: 'CA', placeId: 'ne:2' },
  ]);
  assert.deepEqual(london.map((r) => r.label), ['London, Westminster, United Kingdom', 'London, ON, Canada']);
});

test('the saved place keeps its state or country', () => {
  assert.equal(placeText(austin('MN', 'gnis:639531')), 'Austin, MN');
  assert.equal(placeText({ text: 'Toronto', city: 'Toronto', region: 'ON', country: 'CA', placeId: 'ne:3' }), 'Toronto, ON, Canada');
  assert.equal(placeText({ text: 'London', city: 'London', region: 'Westminster', country: 'GB', placeId: 'ne:1' }), 'London, United Kingdom');
});

test('every country can be chosen, the common ones first (JL-onboarding-27)', () => {
  assert.ok(ALL_COUNTRIES.length > 240);
  assert.deepEqual(ALL_COUNTRIES.slice(0, 6).map((c) => c.value), ['US', 'CA', 'GB', 'IE', 'DE', 'AU']);
  for (const c of ['IN', 'FR', 'NL', 'SG', 'MX', 'JP']) assert.ok(ALL_COUNTRIES.some((x) => x.value === c), c);
  assert.equal(new Set(ALL_COUNTRIES.map((c) => c.value)).size, ALL_COUNTRIES.length);
  assert.equal(countryName('IN'), 'India');
});

test('a country search lists names that start with the typed text first', async () => {
  const { countrySort } = await import('../src/lib/countries.ts');
  const found = [{ label: 'British Indian Ocean Territory' }, { label: 'India' }].sort((a, b) => countrySort(a, b, { searchValue: 'India' }));
  assert.equal(found[0]!.label, 'India');
});
