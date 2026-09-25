import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BUNDLED_DIRECTORY_PATH, BoardDirectory, boardApiHost, forbiddenProvider, loadActiveDirectory, nameKey, parseDirectoryFile,
} from '../src/index.ts';

test('the shipped directory: over 3,000 boards, 3 providers, no duplicates, no blank names, no forbidden hosts, named sources', () => {
  const d = loadActiveDirectory({ env: {} });
  assert.equal(d.origin, 'bundled');
  assert.ok(d.entries.length >= 3000, `${d.entries.length} rows`);
  assert.equal(d.refused.length, 0);
  assert.ok(new Set(d.entries.map((e) => e.ats)).size >= 3);
  assert.equal(new Set(d.entries.map((e) => e.id)).size, d.entries.length);
  for (const e of d.entries) {
    assert.ok(e.company.trim(), e.id);
    assert.equal(forbiddenProvider(boardApiHost(e.ats, e.board, e.region)), null, e.id);
  }
  const raw = JSON.parse(readFileSync(BUNDLED_DIRECTORY_PATH, 'utf8')) as { sources: Array<{ id: string; licence: string; url: string }> };
  for (const s of raw.sources) {
    assert.ok(/^https:\/\//.test(s.url), s.id);
    assert.doesNotMatch(s.licence, /\bNC\b|non-?commercial/i, s.id);
  }
  for (const e of d.entries) assert.ok(raw.sources.some((s) => s.id === e.source), `source of ${e.id} is named`);
});

test('search: case, punctuation and legal suffixes do not matter', () => {
  const dir = new BoardDirectory([
    { ats: 'greenhouse', board: 'stripe', region: null, company: 'Stripe', source: 't' },
    { ats: 'ashby', board: 'stripeish', region: null, company: 'Stripeish Labs', source: 't' },
    { ats: 'lever', board: 'homedepot', region: null, company: 'The Home Depot', source: 't' },
    { ats: 'lever', board: 'cafe', region: null, company: 'Café Société, L.L.C.', source: 't' },
  ]);
  for (const q of ['stripe', 'STRIPE', 'Stripe, Inc.', 'stripe inc', ' Stripe  LLC ']) assert.equal(dir.search(q)[0]?.board, 'stripe', q);
  assert.equal(dir.search('home depot')[0]?.board, 'homedepot');
  assert.equal(dir.search('cafe societe')[0]?.board, 'cafe');
  assert.equal(nameKey('Stripe, Inc.'), 'stripe');
  assert.equal(dir.search('zzzz').length, 0);
});

test('the loader refuses bad rows with a reason', () => {
  const { entries, refused } = parseDirectoryFile({
    format: 'jobleft-board-directory/1', version: 't', generatedAt: '', notice: '', counts: {},
    sources: [{ id: 's', name: 's', url: 'https://x', licence: 'MIT', licenceUrl: null, rows: 5 }],
    rows: [
      { ats: 'greenhouse', slug: 'ok', name: 'OK', region: null, source: 's', lastVerified: null, status: 'unverified' },
      { ats: 'greenhouse', slug: 'OK', name: 'Dup', region: null, source: 's', lastVerified: null, status: 'unverified' },
      { ats: 'workday', slug: 'acme', name: 'Acme', region: null, source: 's', lastVerified: null, status: 'unverified' },
      { ats: 'lever', slug: 'blank', name: '  ', region: null, source: 's', lastVerified: null, status: 'unverified' },
      { ats: 'lever', slug: 'x', name: 'X', region: null, source: 'other', lastVerified: null, status: 'unverified' },
    ],
  });
  assert.equal(entries.length, 1);
  assert.equal(refused.length, 4);
});
