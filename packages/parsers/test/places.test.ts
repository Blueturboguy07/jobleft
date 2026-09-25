import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUsLocation, parseLocationText, parsePlaces, placeFromAddress, placesFromText, usFromFacts } from '../src/index.ts';

const short = (text: string) => parsePlaces(text).map((p) => `${p.city ?? '-'}/${p.region ?? '-'}/${p.country ?? '-'}`);

test('places: city, state and country in the common formats', () => {
  const cases: Array<[string, string[]]> = [
    ['Austin, TX', ['Austin/TX/US']],
    ['San Francisco, CA, USA', ['San Francisco/CA/US']],
    ['New York, New York, United States', ['New York/NY/US']],
    ['Houston TX (19th St.)', ['Houston/TX/US']],
    ['135 W 26th Street, New York, NY 10001', ['New York/NY/US']],
    ['US-CA-San Francisco', ['San Francisco/CA/US']],
    ['Austin - TX', ['Austin/TX/US']],
    ['NYC', ['New York/NY/US']],
    ['San Francisco', ['San Francisco/CA/US']],
    ['Washington, D.C.', ['Washington/DC/US']],
    ['Richland, Washington', ['Richland/WA/US']],
    ['London, England, United Kingdom', ['London/-/GB']],
    ['Berlin, Berlin, Germany', ['Berlin/-/DE']],
    ['Bengaluru, Karnataka, India', ['Bengaluru/Karnataka/IN']],
    ['Toronto, ON, CA', ['Toronto/ON/CA']],
    ['Vancouver, British Columbia, Canada', ['Vancouver/BC/CA']],
    ['17th Floor, 5 Aldermanbury Square, London, EC2V 7HR', ['London/-/GB']],
    ['Guadalajara, JAL', ['Guadalajara/Jalisco/MX']],
  ];
  for (const [text, want] of cases) assert.deepEqual(short(text), want, text);
});

test('places: every place is kept (O7 angle 1)', () => {
  assert.deepEqual(short('New York, NY; San Francisco, CA; Austin, TX'), ['New York/NY/US', 'San Francisco/CA/US', 'Austin/TX/US']);
  assert.deepEqual(short('San Francisco, CA, Seattle WA, New York, NY'), ['San Francisco/CA/US', 'Seattle/WA/US', 'New York/NY/US']);
  assert.deepEqual(short('Paducah, KY or Los Angeles, CA'), ['Paducah/KY/US', 'Los Angeles/CA/US']);
  assert.deepEqual(short('SEA, SF, NYC, CHI'), ['Seattle/WA/US', 'San Francisco/CA/US', 'New York/NY/US', 'Chicago/IL/US']);
  assert.deepEqual(short('Maryland/Virginia'), ['-/MD/US', '-/VA/US']);
});

test('places: the stated state wins for Portland and Springfield (O7 angle 2)', () => {
  assert.deepEqual(short('Portland, ME'), ['Portland/ME/US']);
  assert.deepEqual(short('Portland, Maine'), ['Portland/ME/US']);
  assert.deepEqual(short('Portland, OR'), ['Portland/OR/US']);
  assert.deepEqual(short('Springfield, MO'), ['Springfield/MO/US']);
  assert.deepEqual(short('Springfield, IL'), ['Springfield/IL/US']);
  // A bare "Springfield" names no state; the posting's own words can.
  assert.deepEqual(short('Springfield'), ['Springfield/-/US']);
  assert.deepEqual(parsePlaces('Springfield', { context: 'Our clinic in Springfield, Missouri is growing.' }).map((p) => p.region), ['MO']);
});

test('places: "Multiple locations", "Various" and "Remote" are not places (O7 angle 4)', () => {
  for (const t of ['Multiple Locations', 'Various', 'Multiple Cities', 'N/A', 'Remote', 'TBD', 'Nowhere, XX', '']) assert.deepEqual(parsePlaces(t), [], t);
});

test('country: never the wrong country (O8)', () => {
  const us = (t: string) => { const r = parseLocationText(t); return usFromFacts(r.places, r.remoteRegions); };
  assert.equal(us('Paris, TX'), true);
  assert.equal(us('London, KY'), true);
  assert.equal(us('Tbilisi, Georgia'), false);
  assert.equal(us('Atlanta, Georgia'), true);
  assert.equal(us('Toronto, ON'), false);
  assert.equal(us('London, UK'), false);
  assert.equal(us('Bangalore, India'), false);
  assert.equal(us('Remote - Canada'), false);
  assert.equal(us('Remote (EMEA)'), false);
  assert.equal(us('Remote - US'), true);
  assert.equal(us('Remote'), null, 'plain Remote is unknown, never US');
  assert.equal(us(''), null);
  assert.equal(us('Perth, WA'), false, 'Perth is in Western Australia');
  assert.equal(us('Seattle, WA'), true);
  assert.equal(us('Vancouver, BC, CA'), false);
  assert.equal(us('Indianapolis, IN'), true);
  assert.equal(us('Berlin, DE'), false);
  assert.equal(us('Ontario - Remote'), false);
  assert.equal(parsePlaces('Tbilisi, Georgia')[0].country, 'GE');
  assert.equal(parsePlaces('Georgia', { context: 'Join our team in Tbilisi. Salary in GEL.' })[0].country, 'GE');
  assert.equal(parsePlaces('Georgia', { context: 'Join our team in Atlanta.' })[0].country, 'US');
  assert.equal(parsePlaces('Batumi, Georgia')[0].country, 'GE');
});

test('country: the spike API still answers the same questions', () => {
  assert.equal(isUsLocation('Austin, TX'), true);
  assert.equal(isUsLocation('Remote', ['US']), true);
  assert.equal(isUsLocation('Austin, TX', ['GB']), false);
  assert.equal(isUsLocation('Remote'), null);
});

test('places: board addresses and places named in pasted text', () => {
  assert.deepEqual(placeFromAddress({ city: 'Denver', region: 'CO', country: 'US' }), { text: 'Denver, CO, US', city: 'Denver', region: 'CO', country: 'US', placeId: null });
  assert.equal(placeFromAddress({ city: 'Toronto', region: 'Ontario', country: 'Canada' })?.region, 'ON');
  const pasted = placesFromText('Nurse Manager\nExample Health\nSt. Louis, MO\nFull-time\n\nAbout us: headquartered in Chicago, IL.');
  assert.deepEqual(pasted.places.map((p) => [p.city, p.region]), [['St. Louis', 'MO']]);
  const labeled = placesFromText('Our company is headquartered in Boston, MA.\nLocation: Tampa, FL');
  assert.deepEqual(labeled.places.map((p) => [p.city, p.region]), [['Tampa', 'FL']], 'a head-office line never replaces the work site');
});
