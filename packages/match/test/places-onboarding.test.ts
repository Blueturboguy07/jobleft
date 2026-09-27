// Location reasons (JL-onboarding-17, -18): a wanted place with a place id is measured from THAT place, so "Austin"
// picked as Austin, Minnesota never matches Austin, Texas; and a remote job whose scope leaves out every country the
// person wants is never shown as a plus.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Place, PlaceLookup } from '@jobleft/contracts';
import { distanceFromPlaceIndex } from '../src/index.ts';
import { job, profileOf, score, SWE } from './helpers.ts';

const ROWS: Array<Place & { lat: number; lon: number }> = [
  { text: 'Austin', city: 'Austin', region: 'TX', country: 'US', placeId: 'gnis:1384879', lat: 30.26715, lon: -97.74306 },
  { text: 'Austin', city: 'Austin', region: 'MN', country: 'US', placeId: 'gnis:639531', lat: 43.66663, lon: -92.97464 },
  { text: 'Round Rock', city: 'Round Rock', region: 'TX', country: 'US', placeId: 'gnis:1366966', lat: 30.50826, lon: -97.6789 },
  { text: 'Plano', city: 'Plano', region: 'TX', country: 'US', placeId: 'gnis:1344166', lat: 33.01984, lon: -96.69889 },
];
function miles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
}
// Like the shipped dictionary: "Austin" alone resolves to the big one (Texas) and lists the others as ambiguous.
const index = {
  resolve(text: string): PlaceLookup {
    const [city, region] = text.split(',').map((x) => x.trim().toLowerCase());
    const hits = ROWS.filter((r) => r.city!.toLowerCase() === city && (!region || r.region!.toLowerCase() === region));
    return { input: text, places: hits.slice(0, 1), ambiguous: region ? [] : hits.slice(1), notACity: false };
  },
  distanceMiles(a: Place, b: Place): number | null {
    const at = (p: Place) => (p.lat !== undefined && p.lon !== undefined ? p as { lat: number; lon: number } : ROWS.find((r) => r.placeId === p.placeId) ?? null);
    const x = at(a); const y = at(b);
    return x && y ? miles(x, y) : null;
  },
};

const onsite = (location: string) => job({ title: 'Software Engineer', location, description: 'Onsite role. Work in our office five days a week.' });
const placeOk = (r: ReturnType<typeof score>) => r.dealBreakers.find((c) => c.kind === 'location');
function wanting(place: { text: string; placeId: string | null; radiusMiles: number | null }) {
  return profileOf({ ...SWE, preferences: { ...(SWE.preferences as object), workModels: ['onsite'], places: [place] } });
}

test('the chosen Austin decides: Austin, MN never matches Austin or Plano, Texas', () => {
  const distanceMiles = distanceFromPlaceIndex(index);
  const mn = wanting({ text: 'Austin', placeId: 'gnis:639531', radiusMiles: 25 });
  for (const loc of ['Austin, TX', 'Plano, TX', 'Round Rock, TX']) {
    const r = score(mn, onsite(loc), { distanceMiles });
    assert.notEqual(placeOk(r)?.state, 'ok', `${loc} is not within 25 miles of Austin, MN`);
    assert.ok(!r.whyFit.some((c) => c.kind === 'location' && c.positive), `${loc} gets no positive place reason`);
  }
  const tx = wanting({ text: 'Austin', placeId: 'gnis:1384879', radiusMiles: 25 });
  const near = score(tx, onsite('Round Rock, TX'), { distanceMiles });
  assert.equal(placeOk(near)?.state, 'ok');
  assert.ok(near.whyFit.some((c) => c.kind === 'location' && c.positive));
  assert.notEqual(placeOk(score(tx, onsite('Plano, TX'), { distanceMiles }))?.state, 'ok', 'Plano is about 180 miles from Austin, TX');
});

test('a remote job open only outside the countries the person wants is a warning, not a plus', () => {
  const p = profileOf({ ...SWE, preferences: { ...(SWE.preferences as object), countries: ['CA', 'DE'], workModels: ['remote'], places: [] } });
  const r = score(p, job({ title: 'Software Engineer', location: 'Remote - US' }));
  const chip = r.whyFit.find((c) => c.kind === 'location');
  assert.equal(chip?.positive, false);
  const us = profileOf({ ...SWE, preferences: { ...(SWE.preferences as object), countries: ['US'], workModels: ['remote'], places: [] } });
  assert.equal(score(us, job({ title: 'Software Engineer', location: 'Remote - US' })).whyFit.find((c) => c.kind === 'location')?.positive, true);
});

// JL-v1-1: a person who wants only Austin, TX saw "In a place you want: San Francisco, CA" on a job listed as
// "San Francisco / New York City / Austin": the reason named the job's first city, not the one that matched.
test('the place reason names the place that matched, not the job\'s first city (JL-v1-1)', () => {
  const distanceMiles = distanceFromPlaceIndex(index);
  const tx = wanting({ text: 'Austin, TX', placeId: 'gnis:1384879', radiusMiles: 25 });
  // The places as the store holds them for "Hybrid - San Francisco, New York City, Austin" (Vercel 6188894004).
  const stored: Place[] = [
    { text: 'San Francisco', city: 'San Francisco', region: 'CA', country: 'US', placeId: null },
    { text: 'New York City', city: 'New York', region: 'NY', country: 'US', placeId: null },
    { text: 'Austin', city: 'Austin', region: 'TX', country: 'US', placeId: null },
  ];
  for (const j of [{ ...onsite('San Francisco, CA'), places: stored }, onsite(['San Francisco, CA', 'New York, NY', 'Austin, TX'] as unknown as string)]) {
    const r = score(tx, j, { distanceMiles });
    const where = j.places.map((p) => p.text).join(' / ');
    assert.equal(placeOk(r)?.state, 'ok', where);
    assert.equal(r.whyFit.find((c) => c.kind === 'location')?.label, 'In a place you want: Austin, TX', where);
    assert.match(placeOk(r)?.quote ?? '', /^Austin/, where);
  }
  // The radius still counts: a job in Round Rock and Plano is within 25 miles of Austin by Round Rock.
  const near = score(tx, onsite(['Plano, TX', 'Round Rock, TX'] as unknown as string), { distanceMiles });
  assert.equal(near.whyFit.find((c) => c.kind === 'location')?.label, 'In a place you want: Round Rock, TX');
  // A job in no wanted place that is fine only because it can also be done remotely names no city as wanted.
  const open = profileOf({ ...SWE, preferences: { ...(SWE.preferences as object), workModels: ['hybrid', 'remote'], places: [{ text: 'Austin, TX', placeId: 'gnis:1384879', radiusMiles: 25 }] } });
  const hybrid = job({ title: 'Software Engineer', location: ['Plano, TX', 'Remote - US'], workModel: 'hybrid', description: 'Hybrid role in Plano, or remote in the US.' });
  const chip = score(open, hybrid, { distanceMiles }).whyFit.find((c) => c.kind === 'location');
  assert.equal(chip?.label, 'Can be done remotely');
});
