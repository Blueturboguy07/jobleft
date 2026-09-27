// Why-fit location reasons of the Recommended feed (JL-onboarding-17 and -18): a chosen city counts only within its
// radius of THAT city (its place id), never the whole state and never another city with the same name; a remote job
// open in the US is a plus only for a person who wants the US.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Profile, ProfileInput } from '@jobleft/contracts';
import { prefModel, scoreRow, type FeedPlaces } from '../src/core/feed.ts';
import type { CandidateRow } from '../src/interim/jobs.ts';

const persona = JSON.parse(readFileSync(new URL('./persona-profile.json', import.meta.url), 'utf8')) as ProfileInput;

function profile(prefs: Partial<ProfileInput['preferences']>): Profile {
  return {
    ...persona, id: 'default', version: 'v', updatedAt: '2026-09-27T00:00:00.000Z',
    preferences: { ...persona.preferences, jobFunctions: [], targetTitles: [], employmentTypes: [], workModels: [], levels: [], countries: [], places: [], ...prefs },
  } as Profile;
}

// A tiny place dictionary: two Austins, and places around Austin, Texas.
const PLACES: Record<string, { lat: number; lon: number; names: string[] }> = {
  'gnis:1384879': { lat: 30.26715, lon: -97.74306, names: ['austin, tx', 'austin, texas'] },
  'gnis:639531': { lat: 43.66663, lon: -92.97464, names: ['austin, mn', 'austin, minnesota'] },
  'gnis:1366966': { lat: 30.50826, lon: -97.6789, names: ['round rock, tx'] },
  'gnis:1344166': { lat: 33.01984, lon: -96.69889, names: ['plano, texas', 'plano, tx'] },
  'gnis:amarillo': { lat: 35.222, lon: -101.8313, names: ['amarillo, tx'] },
  'gnis:rochester': { lat: 44.0121, lon: -92.4802, names: ['rochester, mn'] },
};
const miles = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const r = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
};
const places: FeedPlaces = {
  resolve(text) {
    const t = text.trim().toLowerCase();
    const hit = Object.entries(PLACES).find(([, p]) => p.names.includes(t));
    return { places: hit ? [{ placeId: hit[0] }] : [], notACity: /remote/.test(t) };
  },
  within(placeId, radius) {
    const c = PLACES[placeId];
    return new Set(c ? Object.entries(PLACES).filter(([, p]) => miles(c, p) <= radius).map(([id]) => id) : []);
  },
};

let n = 0;
function row(location: string, extra: Partial<CandidateRow> = {}): CandidateRow {
  return { id: ++n, title: 'Registered Nurse', company: 'Fixture Co', location, work_mode: 'onsite', remote: 0, employment_type: 'full_time', level: null, is_us: 1, sort_rec: 1, ...extra };
}
const locationChip = (m: ReturnType<typeof prefModel>, r: CandidateRow) => scoreRow(m, r).chips.find((c) => c.kind === 'location') ?? null;

test('two Austins: the chosen one and its radius decide, never the state or the name', () => {
  const mn = prefModel(profile({ places: [{ text: 'Austin, MN', placeId: 'gnis:639531', radiusMiles: 25 }] }), places);
  for (const loc of ['Austin, TX', 'Round Rock, TX', 'Plano, Texas', 'Amarillo, TX']) assert.equal(locationChip(mn, row(loc)), null, `${loc} is not near Austin, MN`);
  assert.deepEqual(locationChip(mn, row('Austin, Minnesota')), { kind: 'location', label: 'Within 25 mi of Austin', positive: true });
  assert.equal(locationChip(mn, row('Rochester, MN')), null, 'Rochester, MN is about 40 miles away, outside 25 miles');

  const tx = prefModel(profile({ places: [{ text: 'Austin, TX', placeId: 'gnis:1384879', radiusMiles: 25 }] }), places);
  assert.equal(locationChip(tx, row('Austin, TX'))?.positive, true);
  assert.equal(locationChip(tx, row('Round Rock, TX'))?.label, 'Within 25 mi of Austin');
  for (const loc of ['Plano, Texas', 'Amarillo, TX', 'Austin, MN']) assert.equal(locationChip(tx, row(loc)), null, `${loc} is outside 25 miles of Austin, TX`);
  // the place score follows the same rule
  assert.ok(scoreRow(tx, row('Round Rock, TX')).score > scoreRow(tx, row('Amarillo, TX')).score);
});

test('an old place saved as a bare name with no place data matches its name, never its whole guessed state', () => {
  const m = prefModel(profile({ places: [{ text: 'Austin', placeId: 'gnis:639531', radiusMiles: 25 }] }), null);
  assert.equal(locationChip(m, row('Plano, Texas')), null);
  assert.equal(locationChip(m, row('Harlingen, TX')), null);
  assert.equal(locationChip(m, row('Austin, TX'))?.label, 'In Austin');
  const typed = prefModel(profile({ places: [{ text: 'Austin, MN', placeId: null, radiusMiles: null }] }), null);
  assert.equal(locationChip(typed, row('Austin, TX')), null, 'a city with its state never matches the same name in another state');
  assert.equal(locationChip(typed, row('Austin, MN'))?.positive, true);
  const state = prefModel(profile({ places: [{ text: 'Texas', placeId: 'region:US-TX', radiusMiles: null }] }), places);
  assert.equal(locationChip(state, row('Amarillo, TX'))?.label, 'In Texas');
});

test('a remote job open in the US is a plus only for a person who wants the US', () => {
  const remote = { work_mode: 'remote', remote: 1, is_us: 1 } as const;
  const elsewhere = prefModel(profile({ countries: ['CA', 'DE'], workModels: ['remote'] }), places);
  const c = locationChip(elsewhere, row('Remote - US', remote));
  assert.equal(c?.positive, false);
  assert.doesNotMatch(c!.label, /open in the US$/);
  const withCity = prefModel(profile({ countries: ['CA', 'DE'], workModels: ['remote', 'onsite'], places: [{ text: 'Austin, TX', placeId: 'gnis:1384879', radiusMiles: 25 }] }), places);
  assert.equal(locationChip(withCity, row('Remote - US', remote))?.positive, false);
  const us = prefModel(profile({ countries: ['US'], workModels: ['remote'] }), places);
  assert.deepEqual(locationChip(us, row('Remote - US', remote)), { kind: 'location', label: 'Remote, open in the US', positive: true });
  const any = prefModel(profile({ workModels: ['remote'] }), places);
  assert.equal(locationChip(any, row('Remote - US', remote))?.positive, true, 'no countries chosen: the US is not excluded');
  assert.ok(scoreRow(us, row('Remote - US', remote)).score > scoreRow(elsewhere, row('Remote - US', remote)).score);
});
