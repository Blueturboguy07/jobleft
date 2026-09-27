// JL-settings-6: a key typed on the "Your own key -> OpenAI" form while a custom address was the saved provider was
// saved for the custom address and sent to it as a Bearer. A key names the provider it was typed for; the engine
// keeps it only when that is the saved provider, and a key never reaches another address.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiError } from '../src/index.ts';
import { makeEngine, use, withModel } from './helpers.ts';

const OPENAI_KEY = 'sk-proj-QAOPENAI-9z8y7x6w5v4u3t2s';

test('a key typed for OpenAI is refused while a custom address is saved, and nothing reaches that address', async () => {
  await withModel({}, async (m) => {
    const { engine } = makeEngine();
    await use(engine, { provider: 'custom', baseUrl: `${m.url}/v1`, model: 'standin-7b' });
    await assert.rejects(engine.setKey(OPENAI_KEY, { provider: 'own_key', vendor: 'openai' }), (e: unknown) => {
      assert.ok(e instanceof AiError);
      assert.equal(e.code, 'conflict');
      assert.match(e.message, /OpenAI/);
      assert.match(e.message, /Nothing was saved/);
      assert.ok(!e.message.includes(OPENAI_KEY));
      return true;
    });
    const s = engine.settings();
    assert.equal(s.provider, 'custom');
    assert.equal(s.keySet, false, 'the custom address has no key');
    const before = m.log.entries.length;
    await engine.check();
    const sent = m.log.entries.slice(before);
    assert.ok(sent.length > 0, 'the check reached the custom address');
    assert.ok(sent.every((e) => !(e.headers.authorization ?? '').includes('QAOPENAI')), 'the OpenAI key never reached the custom address');
  });
});

test('a key typed for the saved provider is kept for it, and a key for another address of the same kind is refused', async () => {
  await withModel({}, async (m) => {
    const { engine } = makeEngine();
    await use(engine, { provider: 'custom', baseUrl: `${m.url}/v1`, model: 'standin-7b' });
    // The same provider named by the form: kept (the address may be written with or without /v1).
    const s = await engine.setKey('custom-key-abcd1234', { provider: 'custom', baseUrl: m.url });
    assert.equal(s.keySet, true);
    assert.equal(s.keyHint, '1234');
    // Another address of the same kind is another key slot: refused.
    await assert.rejects(engine.setKey('other-key-zzzz9999', { provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1' }), /Nothing was saved/);
    assert.equal(engine.settings().keyHint, '1234');
  });
});

test('own key: the key is kept for the vendor shown, only after that vendor is the saved provider', async () => {
  const { engine } = makeEngine();
  await use(engine, { provider: 'own_key', vendor: 'anthropic', model: 'claude-x' });
  await assert.rejects(engine.setKey(OPENAI_KEY, { provider: 'own_key', vendor: 'openai' }), /OpenAI/);
  assert.equal(engine.settings().keySet, false);
  await use(engine, { provider: 'own_key', vendor: 'openai', model: 'gpt-x' });
  const s = await engine.setKey(OPENAI_KEY, { provider: 'own_key', vendor: 'openai' });
  assert.equal(s.vendor, 'openai');
  assert.equal(s.keySet, true);
  assert.equal(s.keyHint, '3t2s');
  // Switching back to Anthropic shows no key: the OpenAI key stays with OpenAI.
  await use(engine, { provider: 'own_key', vendor: 'anthropic', model: 'claude-x' });
  assert.equal(engine.settings().keySet, false);
  // publik never takes a typed key.
  await assert.rejects(engine.setKey('x-key-12345678', { provider: 'publik' }), /publik connects without a key/);
});
