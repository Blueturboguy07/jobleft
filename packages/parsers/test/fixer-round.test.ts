// Regressions for the evaluator round: board-stated countries, US exclusion, state-limited remote, open-ended pay,
// preferred-only years and board pay boilerplate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts, fromAshby, fromLever, parsePay, parseStatements, parseYearsRequired, payFromBoard } from '../src/index.ts';

const US_CITIES: Array<[string, string, string]> = [
  ['Birmingham', 'Alabama', 'AL'], ['Sudbury', 'Massachusetts', 'MA'], ['Halifax', 'Massachusetts', 'MA'], ['Perth', 'New Jersey', 'NJ'],
  ['London', 'Ohio', 'OH'], ['Manchester', 'New Hampshire', 'NH'], ['Rome', 'Georgia', 'GA'], ['Guelph', 'Illinois', 'IL'],
  ['Vaughan', 'Mississippi', 'MS'], ['Brampton', 'Michigan', 'MI'], ['Barrie', 'Illinois', 'IL'],
];

test('a bare city with a structured US address is the US city, priced in USD', () => {
  for (const [city, state, code] of US_CITIES) {
    const f = extractFacts(fromAshby({
      title: 'Behavior Therapist', location: city, descriptionPlain: 'Pay $24 - $26 per hour',
      address: { postalAddress: { addressLocality: city, addressRegion: state, addressCountry: 'United States' } },
    }));
    assert.equal(f.places.length, 1, city);
    const p = f.places[0];
    // Guelph, Vaughan, Brampton and Barrie are not in the US gazetteer: the address still sets the country.
    assert.deepEqual([p.city, p.country], [city, 'US'], city);
    assert.equal(p.region, code, city);
    assert.equal(f.isUs, true, city);
    assert.equal(f.pay?.currency, 'USD', city);
  }
});

test('a bare city with a board country of US is read in the US; a foreign address keeps its country', () => {
  const f = extractFacts(fromLever({ text: 'Therapist', categories: { location: 'Sudbury' }, country: 'US', descriptionPlain: 'Pay $24 - $26 per hour' }));
  assert.deepEqual([f.places[0].city, f.places[0].region, f.places[0].country, f.isUs, f.pay?.currency], ['Sudbury', 'MA', 'US', true, 'USD']);
  const ca = extractFacts(fromAshby({ title: 'x', location: 'Sudbury', descriptionPlain: 'x', address: { postalAddress: { addressLocality: 'Sudbury', addressRegion: 'Ontario', addressCountry: 'Canada' } } }));
  assert.deepEqual([ca.places[0].country, ca.isUs], ['CA', false]);
  // A city with its state written stays as written.
  const tx = extractFacts({ title: 'x', location: 'Paris, TX', countries: ['US'], description: 'x' });
  assert.deepEqual([tx.places[0].region, tx.places[0].country], ['TX', 'US']);
});

test('a remote job not open to people in the US is not a US job and not worldwide', () => {
  const f = extractFacts(fromAshby({
    title: 'Account Executive - Dental - International', location: 'Remote (Global)', workplaceType: 'Remote', isRemote: true,
    descriptionPlain: 'Fully remote. Internationally located candidates only (not in US, CA, UK, NZ, or AU).',
    address: { postalAddress: { addressLocality: 'San Francisco', addressRegion: 'California', addressCountry: 'United States' } },
  }));
  assert.equal(f.isUs, false);
  assert.deepEqual(f.places, [], 'the office address of a remote-global job is not its place');
  assert.ok(f.remoteScope && !f.remoteScope.regions.includes('WORLDWIDE'));
  assert.match(f.remoteScope!.text, /not in US, CA, UK, NZ, or AU/);
  // Turning people outside the US away is the opposite.
  const us = extractFacts({ title: 'x', location: 'Remote (Global)', workplaceType: 'remote', description: 'Candidates outside the US will not be considered.' });
  assert.notEqual(us.isUs, false);
  const lever = extractFacts(fromLever({ text: 'x', categories: { location: 'Remote (Global)' }, workplaceType: 'remote', descriptionPlain: 'Fully remote. Internationally located candidates only (not in US, CA, UK, NZ, or AU).' }));
  assert.equal(lever.isUs, false);
});

test('a remote limit to state codes in the text is kept', () => {
  const f = extractFacts({ title: 'x', location: 'Remote', workplaceType: 'remote', description: 'Fully remote, open to residents of CA, NY, TX, WA and FL only.' });
  assert.ok(f.remoteScope);
  assert.deepEqual(f.remoteScope!.regions, ['US']);
  assert.match(f.remoteScope!.text, /CA, NY, TX, WA and FL/);
  assert.equal(f.isUs, true);
});

test('open-ended pay has no maximum', () => {
  const a = parsePay('Targeted starting salary range: $19.00/hr+', { country: 'US' })!.pay;
  assert.deepEqual([a.min, a.max, a.period], [19, null, 'hour']);
  const b = parsePay('年俸: 2,800,000円〜', { country: 'JP' })!.pay;
  assert.deepEqual([b.min, b.max, b.currency], [2800000, null, 'JPY']);
  const c = parsePay('年俸: 2,800,000円〜3,500,000円', { country: 'JP' })!.pay;
  assert.deepEqual([c.min, c.max], [2800000, 3500000]);
  const d = parsePay('Pay: $75,000 + bonus', { country: 'US' })!.pay;
  assert.deepEqual([d.min, d.max], [75000, 75000], 'a plus before another word is not "or more"');
});

test('preferred-only years are not required years', () => {
  for (const t of ['Preferred: 7 years of experience in software.', 'We prefer one year of prior serving experience.', 'Five years of medical practice experience preferred', 'Prefer one year prior bussing experience']) {
    assert.equal(parseYearsRequired(t), null, t);
  }
  assert.equal(parseYearsRequired('Requires 2 years of experience; 7 years preferred.')?.min, 2);
});

test('board pay evidence holds the figures when the board text is boilerplate', () => {
  const r = payFromBoard([{ min: 20, max: 24, currency: 'USD', period: 'hour', text: 'Minimum and maximum wage or salary for the position.' }], { text: '' })!;
  assert.match(r.evidence.text, /20/);
  assert.match(r.evidence.text, /24/);
  const kept = payFromBoard([{ min: 20, max: 24, currency: 'USD', period: 'hour', text: '$20 - $24 an hour' }], { text: '' })!;
  assert.equal(kept.evidence.text, '$20 - $24 an hour');
});

test('statements: "work authorization that does not now or in the future require sponsorship" is no sponsorship (JL-tracker-3)', () => {
  const said = parseStatements('Applicants for employment in the US must have work authorization that does not now or in the future require sponsorship of a visa for employment authorization in the United States.');
  assert.equal(said.sponsorship, 'no');
  assert.match(said.evidence.sponsorship?.text ?? '', /does not now or in the future require sponsorship/);
  assert.equal(parseStatements('Candidates must not now or in the future require employer sponsorship.').sponsorship, 'no');
  // An application question is not a statement.
  assert.equal(parseStatements('Will you now or in the future require sponsorship for employment visa status?').sponsorship, null);
});
