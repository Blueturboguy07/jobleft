// publik first: before AI is set up, the chip, the setup checklist and the AI notes all ask for one thing, "Connect
// publik" (no key needed), and open the existing connect step (Settings > Balance).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AiSettings, PublikConnection, PublikWallet } from '@jobleft/contracts';
import { CONNECT_ROUTE, OTHER_PROVIDERS_ROUTE, PUBLIK_FIRST, aiChecklistStep, chipState, needsPublikConnect } from '../src/lib/aiSetup.ts';

const settings = (provider: AiSettings['provider']): AiSettings => ({ provider, updatedAt: provider ? '2026-11-01T18:00:00.000Z' : null } as unknown as AiSettings);
const wallet: PublikWallet = {
  claimState: 'anonymous', balanceMicros: 50_000, starterRemainingMicros: null, plan: 'none',
  week: { usedMicros: 0, budgetMicros: null, resetsAt: null },
  topUpUrl: 'https://publikhq.com/claim/ABCD-EFGH', claimUrl: 'https://publikhq.com/claim/ABCD-EFGH', addCreditUrl: 'https://publikhq.com/dashboard/api/add',
  updatedAt: '2026-11-01T18:00:00.000Z',
  daily: { capMicros: null, usedMicros: null, resetsAt: '2026-11-02T00:00:00.000Z', reachedAt: null },
};
const connected: PublikConnection = { state: 'connected', wallet, disclosureVersion: 1 };
const disconnected: PublikConnection = { state: 'disconnected', wallet: null, disclosureVersion: null };

test('first launch (no provider): the chip is the "Connect publik" button and opens the connect step', () => {
  const c = chipState(settings(null), undefined);
  assert.deepEqual(c, { text: 'Connect publik', on: false, to: CONNECT_ROUTE, connect: true });
  assert.equal(CONNECT_ROUTE, 'settings/balance', 'the existing connect step: disclosure, "I have read this", connect');
  assert.ok(!/not set up/i.test(c.text), 'never the old "AI: not set up" pill');
});

test('first launch: the checklist step names publik, says no key is needed and opens the connect step', () => {
  const step = aiChecklistStep(settings(null), undefined);
  assert.equal(step.done, false);
  assert.match(step.text, /publik/);
  assert.match(step.text, /no key/i);
  assert.equal(step.to, CONNECT_ROUTE);
});

test('the publik-first card shows until AI is ready, and the copy says publik API with no key', () => {
  assert.equal(needsPublikConnect(settings(null), undefined), true, 'no provider yet');
  assert.equal(needsPublikConnect(settings('publik'), disconnected), true, 'publik chosen, this computer not connected');
  assert.equal(needsPublikConnect(settings('publik'), undefined), false, 'publik chosen, the connection is still loading');
  assert.equal(needsPublikConnect(settings('publik'), connected), false, 'connected');
  assert.equal(needsPublikConnect(settings('own_key'), undefined), false, 'a person who chose their own key is not asked again');
  assert.equal(needsPublikConnect(settings('local'), undefined), false);
  assert.equal(needsPublikConnect(undefined, undefined), false, 'nothing read yet: no flash of the card');
  assert.match(PUBLIK_FIRST.title, /^AI runs on publik API$/);
  assert.match(PUBLIK_FIRST.body, /^No key needed\./);
  assert.equal(PUBLIK_FIRST.button, 'Connect publik');
  assert.equal(OTHER_PROVIDERS_ROUTE, 'settings/ai', 'own key and local model stay one click away');
  for (const t of Object.values(PUBLIK_FIRST)) assert.ok(!/credits?\b|upgrade|subscri|premium/i.test(t), `no credits or upsell words: ${t}`);
  assert.ok(!/Publik/.test(Object.values(PUBLIK_FIRST).join(' ')), 'the brand is lowercase publik');
});

test('publik chosen but not connected: the chip asks to connect, never shows a balance', () => {
  assert.deepEqual(chipState(settings('publik'), disconnected), { text: 'Connect publik', on: false, to: CONNECT_ROUTE, connect: true });
  assert.equal(chipState(settings('publik'), undefined).text, 'Balance: …', 'still loading');
  assert.equal(chipState(settings('publik'), undefined, { publikError: true }).text, 'Balance: not available');
});

test('connected: the chip shows the balance, and the checklist step is done', () => {
  assert.deepEqual(chipState(settings('publik'), connected), { text: 'Balance: $0.05', on: true, to: CONNECT_ROUTE, connect: false });
  assert.equal(aiChecklistStep(settings('publik'), connected).done, true);
  assert.equal(aiChecklistStep(settings('publik'), disconnected).done, false, 'publik chosen but not connected is not done');
  assert.equal(aiChecklistStep(settings('own_key'), undefined).done, true, 'another provider also completes the step');
});

test('other providers keep their chip text, and a failed check never shows a green dot (JL-settings-3)', () => {
  assert.deepEqual(chipState(settings('local'), undefined), { text: 'AI: model on this computer', on: true, to: OTHER_PROVIDERS_ROUTE, connect: false });
  assert.equal(chipState(settings('local'), undefined, { compact: true }).text, 'AI on this computer');
  assert.equal(chipState(settings('custom'), undefined).text, 'AI: your server');
  assert.equal(chipState(settings('own_key'), undefined).text, 'AI: your own key');
  assert.deepEqual(chipState(settings('own_key'), undefined, { checkFailed: true }), { text: 'AI: not answering', on: false, to: OTHER_PROVIDERS_ROUTE, connect: false });
});
