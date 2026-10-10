// First-run board choice: country lists come first for the places they cover; everyone else gets the same set as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_BY_COUNTRY, countriesFor, seedBoards } from '../src/core/seed.ts';
import { cleanup, PERSONA, startTest } from './helpers.ts';
import { boardIdOf } from '../src/interim/boards.ts';

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

// The real setup order: "Looking for" is saved first (the first seed), the place only two steps later.
const nlIds = SEED_BY_COUNTRY.NL!.map((b) => boardIdOf(b.ats, b.board, b.region ?? null));
const lookingFor = (p: typeof PERSONA) => ({ ...p, preferences: { ...p.preferences, jobFunctions: ['Cyber Security'], targetTitles: [], countries: [], places: [] } });
const withPlace = (p: typeof PERSONA, countries: string[]) => ({ ...p, preferences: { ...p.preferences, jobFunctions: ['Cyber Security'], targetTitles: [], countries, places: [] } });
const followed = async (s: Awaited<ReturnType<typeof startTest>>): Promise<string[]> => {
  const ids: string[] = [];
  let cursor: string | null = '0';
  while (cursor !== null) {
    const page: { items: Array<{ id: string }>; nextCursor: string | null } = (await s.call('GET', `/api/v1/boards?view=followed&limit=100&cursor=${cursor}`)).json;
    ids.push(...page.items.map((b) => b.id));
    cursor = page.nextCursor;
  }
  return ids;
};

test('setup order: choosing the Netherlands after "Looking for" swaps the US starting boards for the Dutch ones', async () => {
  const s = await startTest('seed-nl', { env: { JOBLEFT_BOARD_DIRECTORY: 'none' } });
  try {
    assert.equal((await s.call('PUT', '/api/v1/profile', lookingFor(PERSONA))).status, 200);
    const first = await followed(s);
    assert.ok(first.includes('greenhouse:stripe'), 'the first save seeds the usual set');
    assert.equal((await s.call('PUT', '/api/v1/profile', withPlace(PERSONA, ['NL']))).status, 200);
    const after = await followed(s);
    assert.deepEqual([...after].sort(), [...nlIds].sort());
    // A later save changes nothing (the place step is looked at once).
    assert.equal((await s.call('PUT', '/api/v1/profile', withPlace(PERSONA, ['NL', 'US']))).status, 200);
    assert.deepEqual([...(await followed(s))].sort(), [...nlIds].sort());
  } finally { await s.stop(); cleanup(s.home); }
});

test('setup order: a person in the US keeps the usual set, and boards the person changed are never touched', async () => {
  const us = await startTest('seed-us', { env: { JOBLEFT_BOARD_DIRECTORY: 'none' } });
  try {
    await us.call('PUT', '/api/v1/profile', lookingFor(PERSONA));
    const first = await followed(us);
    await us.call('PUT', '/api/v1/profile', withPlace(PERSONA, ['US']));
    assert.deepEqual(await followed(us), first);
  } finally { await us.stop(); cleanup(us.home); }
  const changed = await startTest('seed-changed', { env: { JOBLEFT_BOARD_DIRECTORY: 'none' } });
  try {
    await changed.call('PUT', '/api/v1/profile', lookingFor(PERSONA));
    assert.equal((await changed.call('PATCH', '/api/v1/boards/greenhouse:stripe', { followed: false })).status, 200);
    const mine = await followed(changed);
    await changed.call('PUT', '/api/v1/profile', withPlace(PERSONA, ['NL']));
    assert.deepEqual(await followed(changed), mine, 'the person changed their boards, so jobleft leaves them alone');
  } finally { await changed.stop(); cleanup(changed.home); }
});
