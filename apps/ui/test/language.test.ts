// The language chip and the "needs Dutch" rule on cards and in Web jobs (web search lane).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeCount, languageChip, needsDutch } from '../src/lib/filters.ts';

test('the language chip: Dutch required, written in Dutch, a plus, not needed; nothing for a silent English posting', () => {
  assert.deepEqual(languageChip({ posting: 'en', dutch: 'required', evidence: 'Fluency in Dutch.' }), { text: 'Dutch required', warn: true, tip: 'The posting says: "Fluency in Dutch."' });
  assert.equal(languageChip({ posting: 'nl', dutch: null })!.text, 'Written in Dutch');
  assert.equal(languageChip({ posting: 'nl', dutch: 'preferred', evidence: 'Engels is een pré' })!.warn, false);
  assert.equal(languageChip({ posting: 'en', dutch: 'preferred', evidence: 'Dutch is a plus.' })!.text, 'Dutch a plus');
  assert.equal(languageChip({ posting: 'en', dutch: 'not_required', evidence: 'No Dutch needed.' })!.text, 'No Dutch needed');
  assert.equal(languageChip({ posting: 'en', dutch: null }), null);
  assert.equal(languageChip(undefined), null);
  assert.ok(needsDutch({ posting: 'nl', dutch: null }));
  assert.ok(!needsDutch({ posting: 'nl', dutch: 'not_required' }));
  assert.ok(!needsDutch({ posting: 'en', dutch: 'preferred' }));
  assert.equal(activeCount({ minAnnualPayUsd: 50000, payCurrency: 'EUR', leaveOutDutch: true }), 2, 'the currency is part of the pay filter');
});

test('a posting with no date: when jobleft found it, worded as found', async () => {
  const { foundText } = await import('../src/lib/format.ts');
  const now = Date.parse('2026-10-12T18:00:00Z');
  assert.equal(foundText('2026-10-09T18:00:00Z', now), '3 days ago');
  assert.equal(foundText('2026-10-12T17:59:50Z', now), 'just now');
  assert.match(foundText('2026-03-01T12:00:00Z', now)!, /^on /);
  assert.equal(foundText(null, now), null);
});
