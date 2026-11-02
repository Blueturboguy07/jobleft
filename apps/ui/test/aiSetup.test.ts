// publik first: before AI is set up, the chip, the setup checklist and the AI notes all ask for one thing, "Connect
// publik" (no key needed). One press connects and opens the publikhq.com claim page; until the computer is linked, the
// chip and the card say "Finish linking on publikhq.com", and only then is AI set up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AiSettings, PublikConnection, PublikWallet } from '@jobleft/contracts';
import { CONNECT_PLACE, CONNECT_ROUTE, OTHER_PROVIDERS_ROUTE, PUBLIK_FIRST, aiChecklistStep, chipState, linkUrl, needsLink, needsPublikConnect, publikStage } from '../src/lib/aiSetup.ts';

const settings = (provider: AiSettings['provider']): AiSettings => ({ provider, updatedAt: provider ? '2026-11-01T18:00:00.000Z' : null } as unknown as AiSettings);
const CLAIM = 'https://publikhq.com/claim/ABCD-EFGH';
const wallet = (w: Partial<PublikWallet> = {}): PublikWallet => ({
  claimState: 'anonymous', balanceMicros: 0, starterRemainingMicros: null, plan: 'none',
  week: { usedMicros: 0, budgetMicros: null, resetsAt: null },
  topUpUrl: CLAIM, claimUrl: CLAIM, addCreditUrl: 'https://publikhq.com/dashboard/api/add',
  updatedAt: '2026-11-01T18:00:00.000Z',
  daily: { capMicros: null, usedMicros: null, resetsAt: '2026-11-02T00:00:00.000Z', reachedAt: null },
  ...w,
});
const conn = (w: PublikWallet | null): PublikConnection => ({ state: 'connected', wallet: w, disclosureVersion: 1 } as PublikConnection);
const justConnected = conn(wallet());
const linked = conn(wallet({ claimState: 'claimed', balanceMicros: 50_000, claimUrl: null, topUpUrl: 'https://publikhq.com/dashboard/api/add' }));
const disconnected: PublikConnection = { state: 'disconnected', wallet: null, disclosureVersion: null } as PublikConnection;

test('first launch (no provider): the chip is the "Connect publik" button and opens the connect panel', () => {
  const c = chipState(settings(null), undefined);
  assert.deepEqual(c, { text: 'Connect publik', on: false, to: CONNECT_ROUTE, kind: 'connect' });
  assert.equal(CONNECT_ROUTE, 'settings/balance');
  assert.equal(CONNECT_PLACE, 'Settings > Balance', 'messages name the place where the button is');
  assert.ok(!/not set up/i.test(c.text), 'never the old "AI: not set up" pill');
});

test('first launch: the checklist step names publik, says no key is needed and opens the connect panel', () => {
  const step = aiChecklistStep(settings(null), undefined);
  assert.equal(step.done, false);
  assert.match(step.text, /publik/);
  assert.match(step.text, /no key/i);
  assert.equal(step.to, CONNECT_ROUTE);
});

test('just connected at $0.00 and not linked: "Finish linking on publikhq.com", AI is not set up yet', () => {
  assert.equal(publikStage(settings('publik'), justConnected), 'linking');
  assert.equal(needsLink(justConnected.wallet), true);
  assert.deepEqual(chipState(settings('publik'), justConnected), { text: 'Finish linking on publikhq.com', on: false, to: CONNECT_ROUTE, kind: 'link' });
  const step = aiChecklistStep(settings('publik'), justConnected);
  assert.equal(step.done, false, 'the checklist is done only after the link');
  assert.equal(step.text, PUBLIK_FIRST.link);
  assert.equal(linkUrl(justConnected), CLAIM, 'the button opens the claim page again');
  assert.equal(needsPublikConnect(settings('publik'), justConnected), false, 'connected: no second connect');
});

test('linked on publikhq.com: the chip shows the balance and the checklist step is done', () => {
  assert.equal(publikStage(settings('publik'), linked), 'ready');
  assert.deepEqual(chipState(settings('publik'), linked), { text: 'Balance: $0.05', on: true, to: CONNECT_ROUTE, kind: 'status' });
  assert.equal(aiChecklistStep(settings('publik'), linked).done, true);
  assert.equal(linkUrl(linked), null, 'nothing left to link');
});

test('an unlinked computer that still has money to spend can run AI (no link wall in front of it)', () => {
  const funded = conn(wallet({ balanceMicros: 4_370_000 }));
  assert.equal(publikStage(settings('publik'), funded), 'ready');
  assert.equal(chipState(settings('publik'), funded).text, 'Balance: $4.37');
  assert.equal(linkUrl(funded), CLAIM, 'linking stays possible from the balance page');
});

test('connected but the balance did not load: a plain "Could not load your publik balance · Try again", never "Connect publik"', () => {
  const noWallet = conn(null);
  assert.equal(publikStage(settings('publik'), noWallet), 'wallet_error');
  assert.deepEqual(chipState(settings('publik'), noWallet), { text: 'Could not load your publik balance · Try again', on: false, to: CONNECT_ROUTE, kind: 'retry' });
  assert.equal(chipState(settings('publik'), undefined, { publikError: true }).kind, 'retry', 'the connection itself could not be read');
  assert.equal(aiChecklistStep(settings('publik'), noWallet).done, false);
  assert.equal(chipState(settings('publik'), undefined).text, 'Balance: …', 'still loading');
});

test('publik chosen but not connected: the chip asks to connect, never shows a balance', () => {
  assert.deepEqual(chipState(settings('publik'), disconnected), { text: 'Connect publik', on: false, to: CONNECT_ROUTE, kind: 'connect' });
  assert.equal(needsPublikConnect(settings('publik'), disconnected), true);
  assert.equal(needsPublikConnect(settings('publik'), undefined), false, 'publik chosen, the connection is still loading');
  assert.equal(needsPublikConnect(undefined, undefined), false, 'nothing read yet: no flash of the card');
  assert.equal(aiChecklistStep(settings('publik'), disconnected).done, false);
});

test('other providers keep their chip text and complete the step; a failed check never shows a green dot (JL-settings-3)', () => {
  assert.deepEqual(chipState(settings('local'), undefined), { text: 'AI: model on this computer', on: true, to: OTHER_PROVIDERS_ROUTE, kind: 'status' });
  assert.equal(chipState(settings('local'), undefined, { compact: true }).text, 'AI on this computer');
  assert.equal(chipState(settings('custom'), undefined).text, 'AI: your server');
  assert.equal(chipState(settings('own_key'), undefined).text, 'AI: your own key');
  assert.deepEqual(chipState(settings('own_key'), undefined, { checkFailed: true }), { text: 'AI: not answering', on: false, to: OTHER_PROVIDERS_ROUTE, kind: 'status' });
  assert.equal(aiChecklistStep(settings('own_key'), undefined).done, true);
  assert.equal(needsPublikConnect(settings('own_key'), undefined), false, 'a person who chose their own key is not asked again');
});

test('the publik copy: publik API, no key, lowercase publik, no credits or upsell words', () => {
  assert.match(PUBLIK_FIRST.title, /^AI runs on publik API$/);
  assert.match(PUBLIK_FIRST.body, /^No key needed\./);
  assert.equal(PUBLIK_FIRST.button, 'Connect publik');
  assert.match(PUBLIK_FIRST.setupLine, /publik API\. No key needed/);
  assert.equal(OTHER_PROVIDERS_ROUTE, 'settings/ai', 'own key and local model stay one click away');
  for (const t of Object.values(PUBLIK_FIRST)) assert.ok(!/credits?\b|upgrade|subscri|premium/i.test(t), `no credits or upsell words: ${t}`);
  assert.ok(!/Publik/.test(Object.values(PUBLIK_FIRST).join(' ')), 'the brand is lowercase publik');
});
