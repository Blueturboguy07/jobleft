// Settings fixes from the black-box pass (jobleft-qa findings/settings.md, JL-settings-*): AI keys, the publik
// connection, backup and restore, delete-all, load shedding and job sources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAi } from '../scripts/mocks.ts';
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
