import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secondsLeft } from '../src/lib/format.ts';

test('the pairing countdown reads 5:00 at once, not 0:00, for a code valid 5 minutes (JL-extension-4)', () => {
  const now = Date.parse('2026-09-27T14:40:17.409Z');
  assert.equal(secondsLeft('2026-09-27T14:45:17.409Z', now), 300);
  assert.equal(secondsLeft('2026-09-27T14:45:17.000Z', now), 300, 'a fraction of a second rounds, it does not drop a whole second');
  assert.equal(secondsLeft('2026-09-27T14:40:00.000Z', now), 0, 'a passed time is 0, never negative');
  assert.equal(secondsLeft('not a date', now), 0);
});
