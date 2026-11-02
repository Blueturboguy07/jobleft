// The balance screen keeps reading the balance on its own only while a connected computer is still unlinked, the
// window is visible and the watch window (3 minutes from the screen or the link click) has not passed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PublikConnection, PublikWallet } from '@jobleft/contracts';
import { WATCH_EVERY_MS, WATCH_MS, watchingBalance } from '../src/lib/publikWatch.ts';

const wallet = (claimState: PublikWallet['claimState']): PublikWallet => ({
  claimState, balanceMicros: 0, starterRemainingMicros: null, plan: 'none',
  week: { usedMicros: 0, budgetMicros: null, resetsAt: null },
  topUpUrl: 'https://publikhq.com/claim/ABCD-EFGH', claimUrl: 'https://publikhq.com/claim/ABCD-EFGH', addCreditUrl: 'https://publikhq.com/dashboard/api/add',
  updatedAt: '2026-11-01T18:00:00.000Z',
  daily: { capMicros: null, usedMicros: null, resetsAt: '2026-11-02T00:00:00.000Z', reachedAt: null },
});
const connected = (claimState: PublikWallet['claimState']): PublikConnection => ({ state: 'connected', wallet: wallet(claimState), disclosureVersion: 1 });

test('the screen watches an unlinked connection for 3 minutes, every 5 s, while visible', () => {
  const now = Date.parse('2026-11-01T18:00:10.000Z');
  const until = now + WATCH_MS;
  assert.equal(WATCH_EVERY_MS, 5000, 'the local service reads publik at most once per 5 s: asking sooner is wasted');
  assert.equal(watchingBalance(connected('anonymous'), until, now), true);
  assert.equal(watchingBalance(connected('anonymous'), until, now, false), false, 'not while the window is hidden');
  assert.equal(watchingBalance(connected('anonymous'), until, until), false, 'the watch ends after 3 minutes');
  assert.equal(watchingBalance(connected('anonymous'), until, until - 1), true);
  assert.equal(watchingBalance(connected('claimed'), until, now), false, 'a linked computer needs no watch');
  assert.equal(watchingBalance({ state: 'disconnected', wallet: null, disclosureVersion: null }, until, now), false);
  assert.equal(watchingBalance({ state: 'connecting', wallet: null, disclosureVersion: null }, until, now), false);
  assert.equal(watchingBalance(undefined, until, now), false, 'nothing read yet');
});
