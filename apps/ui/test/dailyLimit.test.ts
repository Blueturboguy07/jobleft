// JL-network-19: the balance card names publik's daily limit before and after it is reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PublikWallet } from '@jobleft/contracts';
import { dailyLimitReached, dailyLimitText } from '../src/lib/dailyLimit.ts';

const base: PublikWallet = {
  claimState: 'anonymous', balanceMicros: 104_205, starterRemainingMicros: 104_205, plan: 'none',
  week: { usedMicros: 145_795, budgetMicros: null, resetsAt: null }, topUpUrl: 'https://publikhq.com/claim/x', claimUrl: null, addCreditUrl: null,
  updatedAt: '2026-09-27T15:00:00.000Z',
};
const now = Date.parse('2026-09-27T15:00:00.000Z');

test('JL-network-19: the limit and what is left today are shown before it is reached', () => {
  const t = dailyLimitText({ ...base, daily: { capMicros: 250_000, usedMicros: 145_795, resetsAt: '2026-09-28T00:00:00.000Z', reachedAt: null } }, now)!;
  assert.match(t.summary, /up to \$0\.25 a day on AI steps, even when more balance is left\. Used today: \$0\.14 \(\$0\.10 left today\)\./);
  assert.match(t.summary, /\(midnight UTC\)\.$/);
  assert.equal(t.reached, null);
});

test('JL-network-19: after a refusal the card says so until the limit starts again; no amount is invented', () => {
  const w: PublikWallet = { ...base, daily: { capMicros: null, usedMicros: null, resetsAt: '2026-09-28T00:00:00.000Z', reachedAt: '2026-09-27T14:59:00.000Z' } };
  const t = dailyLimitText(w, now)!;
  assert.match(t.summary, /publik has not told jobleft the amount/);
  assert.doesNotMatch(t.summary, /\$/);
  assert.match(t.reached!, /publik refused an AI step because it would go over this limit\. Nothing was charged for it\./);
  assert.equal(dailyLimitReached(w, now), true);
  assert.equal(dailyLimitReached(w, Date.parse('2026-09-28T00:00:01.000Z')), false, 'gone once the limit starts again');
  assert.equal(dailyLimitText(base, now), null, 'an older wallet without the field shows nothing');
});

test('JL-v2-5: a $0.00 balance on an unlinked computer says linking gives $0.05 once; a linked one says add money; never "credits"', async () => {
  const { zeroBalanceText } = await import('../src/lib/dailyLimit.ts');
  const fresh = zeroBalanceText({ ...base, balanceMicros: 0, starterRemainingMicros: null, claimState: 'anonymous', week: { usedMicros: 0, budgetMicros: null, resetsAt: null } })!;
  assert.match(fresh, /Link this computer to your publik account for \$0\.05 of free use, once/);
  assert.match(fresh, /\$0\.00/);
  const spent = zeroBalanceText({ ...base, balanceMicros: 0, starterRemainingMicros: 0, claimState: 'claimed' })!;
  assert.doesNotMatch(spent, /\$0\.05/);
  assert.match(spent, /add money at publik/);
  assert.match(spent, /\$0\.00/);
  for (const t of [fresh, spent]) assert.doesNotMatch(t, /credit/i);
  assert.equal(zeroBalanceText(base), null, 'no line while money is left');
});
