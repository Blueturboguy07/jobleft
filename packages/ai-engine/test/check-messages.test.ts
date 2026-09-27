// Plain setup-check messages from the Settings findings: a wrong Google key (JL-settings-11) and an https address to
// a plain-http Ollama (JL-settings-4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHttpFailure } from '../src/classify.ts';
import { makeEngine, use, withModel } from './helpers.ts';

test('a wrong Google key (HTTP 400 API_KEY_INVALID) says the key was refused, like the other vendors', () => {
  const raw = JSON.stringify([{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }]);
  const e = classifyHttpFailure(400, 'application/json', raw, { label: 'Google', model: 'gemini-1.5-flash', keySet: true });
  assert.equal(e.code, 'key_refused');
  assert.equal(e.message, 'Google refused the saved key. Check the key and save it again.');
  // Another 400 stays a plain request error.
  assert.equal(classifyHttpFailure(400, 'application/json', '{"error":{"message":"bad temperature"}}', { label: 'Google', model: 'x', keySet: true }).code, 'provider_error');
});

test('an https address to a plain-http Ollama gets the http address, not "Ollama is not running"', async () => {
  await withModel({}, async (m) => {
    const { engine } = makeEngine();
    const https = m.url.replace(/^http:/, 'https:');
    const { check } = await use(engine, { provider: 'local', localKind: 'ollama', baseUrl: https, model: 'standin-7b' });
    assert.equal(check.ok, false);
    assert.match(check.message, /Nothing answered over https/);
    assert.ok(check.message.includes(`use ${new URL(m.url).origin}`), check.message);
    // The plain http address works.
    const ok = await use(engine, { provider: 'local', localKind: 'ollama', baseUrl: m.url, model: 'standin-7b' });
    assert.equal(ok.check.ok, true, ok.check.message);
  });
});
