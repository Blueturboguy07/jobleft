// Settings fixes from the black-box pass (jobleft-qa findings/settings.md, JL-settings-*): AI keys, the publik
// connection, backup and restore, delete-all, load shedding and job sources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAi, startPublik } from '../scripts/mocks.ts';
import { cleanup, startTest } from './helpers.ts';

test('JL-settings-6: a key typed for OpenAI while a custom address is saved is refused (409) and never sent there', async () => {
  const ai = await startAi();
  const s = await startTest('keybind');
  try {
    const set = await s.call('PUT', '/api/v1/ai/settings', { provider: 'custom', baseUrl: `${ai.origin}/v1`, model: 'mock-model' });
    assert.equal(set.status, 200, set.text);
    const k = await s.call('PUT', '/api/v1/ai/key', { key: 'sk-proj-QAOPENAI-9z8y7x6w5v4u3t2s', provider: 'own_key', vendor: 'openai' });
    assert.equal(k.status, 409, k.text);
    assert.equal(k.json.error.code, 'conflict');
    assert.ok(!k.text.includes('QAOPENAI'));
    const after = (await s.call('GET', '/api/v1/ai/settings')).json;
    assert.equal(after.provider, 'custom');
    assert.equal(after.keySet, false);
    await s.call('POST', '/api/v1/ai/check');
    assert.ok(ai.log.every((e) => !String(e.headers.authorization ?? '').includes('QAOPENAI')), 'the OpenAI key never reached the custom address');
    // The provider saved first, then its key: kept for OpenAI, never for the custom address.
    assert.equal((await s.call('PUT', '/api/v1/ai/settings', { provider: 'own_key', vendor: 'openai', model: 'gpt-x' })).status, 200);
    const ok = await s.call('PUT', '/api/v1/ai/key', { key: 'sk-proj-QAOPENAI-9z8y7x6w5v4u3t2s', provider: 'own_key', vendor: 'openai' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.keyHint, '3t2s');
    assert.equal((await s.call('PUT', '/api/v1/ai/settings', { provider: 'custom', baseUrl: `${ai.origin}/v1`, model: 'mock-model' })).json.settings.keySet, false);
  } finally { await s.stop(); await ai.close(); cleanup(s.home); }
});

test('JL-settings-9: Disconnect then Connect resumes the same publik install (same balance), not a new empty account', async () => {
  const pub = await startPublik({ balanceMicros: 240_000 });
  const s = await startTest('pubresume', { env: { JOBLEFT_PUBLIK_APP_TOKEN: 'stand-in-app-token', JOBLEFT_PUBLIK_BASE_URL: `${pub.origin}/api/v1` } });
  try {
    const mints = () => pub.log.filter((e) => e.path === '/api/v1/installs' && e.method === 'POST').map((e) => JSON.parse(e.body).install_id as string);
    assert.equal((await s.call('POST', '/api/v1/publik/connect', { disclosureAccepted: true, disclosureVersion: 1 })).json.state, 'connected');
    assert.equal((await s.call('POST', '/api/v1/publik/disconnect')).json.state, 'disconnected');
    assert.equal((await s.call('GET', '/api/v1/publik')).json.state, 'disconnected');
    const again = await s.call('POST', '/api/v1/publik/connect', { disclosureAccepted: true, disclosureVersion: 1 });
    assert.equal(again.json.state, 'connected');
    assert.equal(again.json.wallet.balanceMicros, 240_000);
    const ids = mints();
    assert.equal(ids.length, 2);
    assert.equal(ids[1], ids[0], 'the reconnect asks publik for the same install');
  } finally { await s.stop(); await pub.close(); cleanup(s.home); }
});
