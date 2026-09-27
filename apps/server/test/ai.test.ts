// Chat through the ONE chosen provider (a loopback OpenAI-compatible stand-in), saved conversations, plain errors
// when the provider is down or the app is offline, and the publik balance card against a loopback stand-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAi, startPublik } from '../scripts/mocks.ts';
import { cleanup, startTest } from './helpers.ts';

function events(text: string): any[] {
  return text.split('\n\n').map((l) => l.trim()).filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
}

test('chat streams from the chosen local server, and the conversation is saved on the laptop', async () => {
  const ai = await startAi();
  const s = await startTest('ai');
  try {
    const set = await s.call('PUT', '/api/v1/ai/settings', { provider: 'local', localKind: 'openai_compatible', baseUrl: `${ai.origin}/v1`, model: 'mock-model' });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.json.check.ok, true, JSON.stringify(set.json.check));
    assert.deepEqual(set.json.check.models, ['mock-model']);
    const r = await s.call('POST', '/api/v1/ai/chat', { requestId: 'req-1', messages: [{ role: 'user', content: 'Hello from Jordan Testwell' }] });
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-type']), /text\/event-stream/);
    const ev = events(r.text);
    assert.equal(ev[0].type, 'start');
    assert.equal(ev.at(-1).type, 'done');
    assert.equal(ev.at(-1).incomplete, false);
    const text = ev.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    assert.equal(text, 'This answer comes from the local mock model.');
    const chatId = ev.at(-1).chatId;
    const thread = (await s.call('GET', `/api/v1/ai/chats/${chatId}`)).json;
    assert.deepEqual(thread.messages.map((m: any) => m.role), ['user', 'assistant']);
    assert.equal(thread.messages[1].content, text);
    // The key: saved in the secret store, only the last 4 characters come back.
    const k = await s.call('PUT', '/api/v1/ai/key', { key: 'sk-test-MARKER123-wxyz' });
    assert.equal(k.json.keySet, true);
    assert.equal(k.json.keyHint, 'wxyz');
    assert.ok(!JSON.stringify((await s.call('GET', '/api/v1/ai/settings')).json).includes('MARKER123'));
    // Only the chosen host was contacted.
    assert.ok(ai.log.every((e) => e.path.startsWith('/v1/')));
    // A credentials-in-URL address is refused.
    assert.equal((await s.call('PUT', '/api/v1/ai/settings', { provider: 'custom', baseUrl: 'https://user:pass@example.com/v1', model: 'x' })).status, 400);
    // A local provider must be on this computer.
    assert.equal((await s.call('PUT', '/api/v1/ai/settings', { provider: 'local', baseUrl: 'https://example.com/v1', model: 'x' })).status, 400);
  } finally { await s.stop(); await ai.close(); cleanup(s.home); }
});

test('a provider that is down gives a plain error quickly, and nothing goes anywhere else', async () => {
  const s = await startTest('aidown');
  try {
    await s.call('PUT', '/api/v1/ai/settings', { provider: 'local', localKind: 'openai_compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' });
    const t0 = Date.now();
    const r = await s.call('POST', '/api/v1/ai/chat', { requestId: 'req-2', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(Date.now() - t0 < 10_000);
    const ev = events(r.text);
    assert.equal(ev.at(-1).type, 'error');
    assert.match(ev.at(-1).error.message, /could not be reached|Nothing answers at/);
    const none = await startTest('ainone');
    try {
      const n = await none.call('POST', '/api/v1/ai/chat', { requestId: 'req-3', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(n.status, 409);
      assert.equal(n.json.error.code, 'needs_provider');
    } finally { await none.stop(); cleanup(none.home); }
  } finally { await s.stop(); cleanup(s.home); }
});

test('offline mode refuses AI and publik at once', async () => {
  const s = await startTest('aioff', { offline: true, env: { JOBLEFT_PUBLIK_APP_TOKEN: 'stand-in-app-token', JOBLEFT_PUBLIK_BASE_URL: 'https://publik.example.org/api/v1' } });
  try {
    // A model server on this computer is allowed in offline mode (nothing leaves the laptop); a server elsewhere is not.
    await s.call('PUT', '/api/v1/ai/settings', { provider: 'custom', baseUrl: 'https://ai.example.org/v1', model: 'm' });
    const r = await s.call('POST', '/api/v1/ai/chat', { requestId: 'req-4', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.json.error.code, 'offline');
    const p = await s.call('POST', '/api/v1/publik/connect', { disclosureAccepted: true, disclosureVersion: 1 });
    assert.equal(p.status, 503, p.text);
    assert.ok(['offline', 'not_ready'].includes(p.json.error.code), p.text);
  } finally { await s.stop(); cleanup(s.home); }
});

test('publik: no app token gives a plain message; with the stand-in the balance card works and a 402 names the balance', async () => {
  const plain = await startTest('pubnone');
  try {
    const r = await plain.call('POST', '/api/v1/publik/connect', { disclosureAccepted: true, disclosureVersion: 1 });
    assert.equal(r.status, 503);
    assert.match(r.json.error.message, /not available in this build/);
    assert.equal((await plain.call('GET', '/api/v1/publik')).json.state, 'disconnected');
  } finally { await plain.stop(); cleanup(plain.home); }

  // A token from the environment is never used with a non-loopback publik address (nothing can reach publikhq.com).
  const guarded = await startTest('pubguard', { offline: true, env: { JOBLEFT_PUBLIK_APP_TOKEN: 'stand-in-app-token' } });
  try {
    const r = await guarded.call('POST', '/api/v1/publik/connect', { disclosureAccepted: true, disclosureVersion: 1 });
    assert.equal(r.status, 503);
    assert.match(r.json.error.message, /not available in this build/);
  } finally { await guarded.stop(); cleanup(guarded.home); }

  const pub = await startPublik({ balanceMicros: 1_500_000 });
  const s = await startTest('pub', { env: { JOBLEFT_PUBLIK_APP_TOKEN: 'stand-in-app-token', JOBLEFT_PUBLIK_BASE_URL: `${pub.origin}/api/v1` } });
  try {
    const c = await s.call('POST', '/api/v1/publik/connect', { disclosureAccepted: true, disclosureVersion: 1 });
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.state, 'connected');
    assert.equal(c.json.wallet.balanceMicros, 1_500_000);
    assert.ok(!JSON.stringify(c.json).includes('pk_test_'), 'the key never comes back');
    await s.call('PUT', '/api/v1/ai/settings', { provider: 'publik' });
    pub.setBalance(0);
    const r = await s.call('POST', '/api/v1/ai/chat', { requestId: 'req-5', messages: [{ role: 'user', content: 'hi' }] });
    const ev = events(r.text);
    assert.equal(ev.at(-1).type, 'error');
    assert.equal(ev.at(-1).error.code, 'insufficient_balance');
    assert.match(ev.at(-1).error.message, /balance/);
    assert.doesNotMatch(ev.at(-1).error.message, /credit/i);
    assert.equal(ev.at(-1).error.link.url, 'https://publikhq.com/claim/stand-in');
    const d = await s.call('POST', '/api/v1/publik/disconnect');
    assert.equal(d.json.state, 'disconnected');
    assert.ok(pub.log.some((e) => e.path === '/api/v1/installs/revoke'));
    // Nothing identifying went to publik: no data-folder path, no persona.
    for (const e of pub.log) assert.ok(!e.body.includes(s.home) && !e.body.includes('Testwell'));
  } finally { await s.stop(); await pub.close(); cleanup(s.home); }
});

test('publik: the balance after a chat is the balance after the charge, never the temporary hold (JL-tracker-14)', async () => {
  const pub = await startPublik({ balanceMicros: 218_951, holdMicros: 105_132, priceMicros: 3_014, walletDelayMs: 300 });
  const s = await startTest('pubhold', { env: { JOBLEFT_PUBLIK_APP_TOKEN: 'stand-in-app-token', JOBLEFT_PUBLIK_BASE_URL: `${pub.origin}/api/v1` } });
  try {
    assert.equal((await s.call('POST', '/api/v1/publik/connect', { disclosureAccepted: true, disclosureVersion: 1 })).json.wallet.balanceMicros, 218_951);
    await s.call('PUT', '/api/v1/ai/settings', { provider: 'publik' });
    for (let i = 1; i <= 2; i++) {
      const r = await s.call('POST', '/api/v1/ai/chat', { requestId: `req-hold-${i}`, messages: [{ role: 'user', content: 'Summarize this posting in two lines.' }] });
      assert.equal(events(r.text).at(-1).type, 'done', r.text);
      // Read at once after "done", as the balance chip does.
      const w = (await s.call('GET', '/api/v1/publik')).json.wallet;
      assert.equal(w.balanceMicros, 218_951 - i * 3_014, 'the chip reads the settled balance');
      assert.equal(w.balanceMicros, pub.balance());
    }
  } finally { await s.stop(); await pub.close(); cleanup(s.home); }
});
