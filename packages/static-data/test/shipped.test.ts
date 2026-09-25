// Checks on the shipped datasets in dist/ (the real DOL, USGS and Natural Earth data). Skipped when dist/ is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DIST_DIR } from '../src/paths.ts';
import { loadH1bIndex } from '../src/h1b/index.ts';
import { loadPlaceIndex } from '../src/places/index.ts';
import { listDatasets } from '../src/datasets/list.ts';
import { tempDir } from './helpers.ts';

const haveH1b = existsSync(join(DIST_DIR, 'h1b-lca.json.gz'));
const havePlaces = existsSync(join(DIST_DIR, 'places.json.gz'));
const home = tempDir('jl-sd-shipped-');
const opts = { dataDir: join(home.dir, 'datasets') };
process.on('exit', () => home.done());

test('frequent filers: counts match the public files (O1)', { skip: !haveH1b }, () => {
  const idx = loadH1bIndex(opts);
  // Counted independently from the DOL files with openpyxl during the build review (FY2025 Q1 to FY2026 Q3).
  const expected: Record<string, number> = { Stripe: 513, NVIDIA: 4234, Airbnb: 382, Databricks: 810, 'Palantir Technologies': 292 };
  for (const [name, n] of Object.entries(expected)) {
    const r = idx.lookup(name);
    assert.equal(r.status, 'found', name);
    assert.equal(r.summary!.certifiedFilings, n, name);
    assert.equal(r.summary!.status, 'likely', name);
    assert.equal(r.summary!.dataThrough, '2026-06-30');
    assert.deepEqual(r.summary!.window, { from: '2024-10-01', to: '2026-06-30' });
    assert.match(r.summary!.source, /Department of Labor/);
    assert.match(r.summary!.note, /not a promise/);
  }
});

test('name variants give the same record (O4)', { skip: !haveH1b }, () => {
  const idx = loadH1bIndex(opts);
  const groups = [
    ['Stripe', 'Stripe, Inc.', 'STRIPE INC', 'stripe inc', 'Stripe LLC'],
    ['Ramp', 'Ramp Business Corporation'],
    ['Notion', 'Notion Labs, Inc.'],
    ['Meta', 'Meta Platforms, Inc.', 'Instagram', 'Facebook'],
    ['OpenAI', 'OpenAI OpCo'],
    ['Robinhood', 'Robinhood Markets, Inc.'],
  ];
  for (const g of groups) {
    const counts = g.map((n) => idx.lookup(n).summary?.certifiedFilings ?? null);
    assert.ok(counts[0] !== null && counts[0]! > 0, g[0]);
    assert.deepEqual(new Set(counts).size, 1, `${g.join(' / ')}: ${counts.join(', ')}`);
  }
  assert.ok(idx.lookup('Robinhood').summary!.certifiedFilings > 300);
  assert.ok(!idx.lookup('Robinhood').summary!.filerEntities.includes('Robinhood Group'));
});

test('look-alikes and unknown names are unknown, never "no" (O2, O5)', { skip: !haveH1b }, () => {
  const idx = loadH1bIndex(opts);
  for (const name of ['Baltimore Orioles', 'Silvus Technologies', 'Lamb Insurance Services', 'Kuros Biosciences', 'Rampart', 'Qxlorvane Widgets LLC']) {
    const r = idx.lookup(name);
    assert.equal(r.status, 'unknown', name);
    assert.doesNotMatch(JSON.stringify(r), /\bno h-?1b\b|does not sponsor|not a sponsor|"status":"no"/i);
  }
  assert.ok(!idx.lookup('Ramp').summary!.filerEntities.some((n) => /rampart/i.test(n)));
});

test('AWS names its filer entities and the total is their sum (O6)', { skip: !haveH1b }, () => {
  const idx = loadH1bIndex(opts);
  for (const name of ['Amazon Web Services', 'AWS']) {
    const s = idx.lookup(name).summary!;
    assert.ok(s.filerEntities.every((n) => /amazon web services/i.test(n)));
    assert.equal(s.entities.reduce((a, e) => a + e.certifiedFilings, 0), s.certifiedFilings);
  }
});

test('places: spellings join, same names stay apart (O13)', { skip: !havePlaces }, () => {
  const p = loadPlaceIndex(opts);
  const id = (t: string) => p.resolve(t).places.map((x) => x.placeId).join('|');
  const same = (list: string[]) => { const ids = list.map(id); assert.ok(ids[0] && ids.every((x) => x === ids[0]), `${list.join(' / ')}: ${ids.join(', ')}`); };
  same(['San Francisco, CA', 'San Francisco, California', 'san francisco, ca, USA', 'SF']);
  same(['New York, NY', 'New York City', 'NYC', 'New York, New York, United States']);
  same(['St. Louis, MO', 'Saint Louis, Missouri']);
  assert.notEqual(id('Portland, OR'), id('Portland, ME'));
  assert.notEqual(id('Columbus, OH'), id('Columbus, GA'));
  assert.equal(p.resolve('Portland').places.length, 0);
  assert.ok(p.resolve('Portland').ambiguous.length >= 2);
  assert.notEqual(id('Washington'), id('Washington, DC'));
});

test('places: several places, remote scope, unclear text, distance (O14)', { skip: !havePlaces }, () => {
  const p = loadPlaceIndex(opts);
  const multi = p.resolve('New York, NY; Austin, TX; Remote');
  assert.equal(multi.places.length, 2);
  assert.equal(multi.workModel, 'remote');
  assert.deepEqual(p.resolve('Remote - US').remoteScope?.regions, ['US']);
  assert.deepEqual(p.resolve('Remote (Canada)').remoteScope?.regions, ['CA']);
  assert.equal(p.resolve('Remote (Canada)').notACity, true);
  const georgia = p.resolve('Georgia');
  assert.equal(georgia.places.length, 0);
  assert.deepEqual(georgia.ambiguous.map((x) => x.placeId).sort(), ['country:GE', 'region:US-GA']);
  assert.equal(p.resolve('Tbilisi, Georgia').places[0]?.country, 'GE');
  const b = p.resolve('Building 7, Campus West');
  assert.equal(b.places.length, 0);
  assert.deepEqual(b.unresolved, ['Building 7, Campus West']);
  const austin = p.resolve('Austin, TX').places[0]!;
  const near = p.within(austin.placeId!, 25);
  assert.ok(near.has(p.resolve('Round Rock, TX').places[0]!.placeId!));
  assert.ok(!near.has(p.resolve('Houston, TX').places[0]!.placeId!));
  assert.ok(!near.has(p.resolve('Austin, MN').places[0]!.placeId!));
  assert.equal(p.within(p.resolve('Texas').places[0]!.placeId!, 25).size, 0);
});

test('every shipped dataset has a date, a licence and a source (O10)', { skip: !haveH1b || !havePlaces }, () => {
  const list = listDatasets(opts);
  for (const d of list.filter((x) => x.version !== 'live')) {
    assert.ok(d.licence.length > 0, d.id);
    assert.ok(d.dataThrough || d.updatedAt, d.id);
  }
  assert.ok(list.some((d) => d.id === 'h1b-lca' && d.dataThrough === '2026-06-30'));
  assert.ok(list.some((d) => d.id === 'places' && /GNIS/.test(d.attribution ?? '')));
});
