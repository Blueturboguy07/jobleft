// First-run board choice: country lists come first for the places they cover; everyone else gets the same set as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_BY_COUNTRY, countriesFor, seedBoards } from '../src/core/seed.ts';

const env = { JOBLEFT_BOARD_DIRECTORY: 'none' } as NodeJS.ProcessEnv;
const ids = (list: Array<{ ats: string; board: string }>) => list.map((b) => `${b.ats}:${b.board}`);
const nl = ids(SEED_BY_COUNTRY.NL!);
const security = { jobFunctions: ['Cyber Security'], targetTitles: ['SOC Analyst'] };

test('seed: a person in the Netherlands gets the Dutch boards and no US starter boards', () => {
  const out = ids(seedBoards({ ...security, countries: ['NL'], places: [] }, env));
  assert.deepEqual(out, nl);
  assert.equal(out.includes('greenhouse:stripe'), false);
  assert.equal(out.includes('greenhouse:cityoffortworth'), false);
});

test('seed: a Dutch city named in words counts as the Netherlands', () => {
  const out = ids(seedBoards({ ...security, countries: [], places: [{ text: 'Utrecht', placeId: null, radiusMiles: 25 }] }, env));
  assert.deepEqual(out, nl);
  assert.deepEqual(countriesFor({ countries: [], places: [{ text: 'Den Haag', placeId: null, radiusMiles: null }] }), { codes: ['NL'], onlyListed: true });
});

test('seed: the Netherlands plus another place gets the Dutch boards first, then the usual set', () => {
  const out = ids(seedBoards({ ...security, countries: ['NL', 'US'], places: [] }, env));
  assert.deepEqual(out.slice(0, nl.length), nl);
  assert.ok(out.includes('greenhouse:stripe'), 'the usual software boards follow');
});

test('seed: a person in the US, or with no place, gets exactly the set they got before', () => {
  const before = ids(seedBoards(security, env));
  assert.deepEqual(ids(seedBoards({ ...security, countries: ['US'], places: [] }, env)), before);
  assert.deepEqual(ids(seedBoards({ ...security, countries: [], places: [{ text: 'Austin, TX', placeId: null, radiusMiles: 25 }] }, env)), before);
  assert.equal(before.some((id) => id === 'recruitee:tesorion'), false);
});

test('seed: every country board is a well-formed board on a supported provider, listed once', () => {
  assert.equal(new Set(nl).size, nl.length);
  for (const b of SEED_BY_COUNTRY.NL!) {
    assert.ok(['greenhouse', 'lever', 'ashby', 'recruitee', 'personio', 'workable'].includes(b.ats), b.board);
    assert.match(b.board, /^[a-z0-9][a-z0-9._-]{0,99}$/);
  }
});
