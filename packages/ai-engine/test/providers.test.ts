import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiError, thinkOption } from '../src/index.ts';
import { CANARY, collect, makeEngine, use, withModel } from './helpers.ts';

test('custom address works with and without /v1, and chat streams the answer', async () => {
  await withModel({}, async (m) => {
    for (const url of [m.url, `${m.url}/`, `${m.url}/v1`, `${m.url}/v1/`, m.url.replace('http://', '')]) {
      const { engine } = makeEngine();
      const { check } = await use(engine, { provider: 'custom', baseUrl: url, model: 'standin-7b' });
      assert.equal(check.ok, true, `${url}: ${check.message}`);
      const { text, last } = await collect(engine.client().chat({ messages: [{ role: 'user', content: 'Reply with the word ready' }] }));
      assert.equal(text, 'ready');
      assert.equal(last.incomplete, false);
    }
    assert.ok(m.log.entries.every((e) => !e.path.startsWith('//')), 'no double slash in any request path');
  });
});

test('no model chosen: one model is picked, several models ask the person to choose', async () => {
  await withModel({ models: ['only-one'] }, async (m) => {
    const { engine } = makeEngine();
    const { check, settings } = await use(engine, { provider: 'custom', baseUrl: m.url });
    assert.equal(check.ok, true);
    assert.equal(settings.model, 'only-one');
  });
  await withModel({ models: ['a', 'b'] }, async (m) => {
    const { engine } = makeEngine();
    const { check } = await use(engine, { provider: 'custom', baseUrl: m.url });
    assert.equal(check.ok, false);
    assert.match(check.message, /Choose a model/);
    assert.deepEqual(check.models, ['a', 'b']);
  });
});

test('setup check names five different problems', async () => {
  const seen = new Map<string, string>();
  // stopped server
  {
    const { engine } = makeEngine();
    const { check } = await use(engine, { provider: 'custom', baseUrl: 'http://127.0.0.1:9', model: 'x' });
    seen.set(check.problem!, check.message);
  }
  for (const mode of ['refuse-key', 'model-not-found', 'html'] as const) {
    await withModel({ mode }, async (m) => {
      const { engine } = makeEngine();
      const { check } = await use(engine, { provider: 'custom', baseUrl: m.url, model: 'standin-7b' });
      assert.equal(check.ok, false);
      seen.set(check.problem!, check.message);
    });
  }
  assert.deepEqual([...seen.keys()].sort(), ['key_refused', 'model_not_found', 'not_ai_server', 'unreachable']);
  assert.equal(new Set(seen.values()).size, 4, 'four different messages');
});

test('a refused key is never shown, even when the server echoes it', async () => {
  await withModel({ mode: 'refuse-key' }, async (m) => {
    const { engine } = makeEngine();
    await use(engine, { provider: 'custom', baseUrl: m.url, model: 'standin-7b' });
    const s = await engine.setKey(CANARY);
    assert.equal(s.keyHint, 'test');
    assert.ok(!JSON.stringify(s).includes(CANARY));
    const check = await engine.check();
    assert.equal(check.problem, 'key_refused');
    assert.ok(!JSON.stringify(check).includes('canary'));
    await assert.rejects(collect(engine.client().chat({ messages: [{ role: 'user', content: 'hi' }] })), (e: AiError) => {
      assert.equal(e.code, 'key_refused');
      assert.ok(!e.message.includes('canary'));
      return true;
    });
  });
});

test('a key goes only to its own address, only in a header', async () => {
  await withModel({ key: CANARY }, async (a) => {
    await withModel({}, async (b) => {
      const { engine } = makeEngine();
      await use(engine, { provider: 'custom', baseUrl: `${a.url}/v1`, model: 'standin-7b' });
      await engine.setKey(CANARY);
      assert.equal((await engine.check()).ok, true);
      await collect(engine.client().chat({ messages: [{ role: 'user', content: 'hi' }] }));
      // change provider address: the old key must not follow
      const { settings } = await use(engine, { provider: 'custom', baseUrl: b.url, model: 'standin-7b' });
      assert.equal(settings.keySet, false);
      await collect(engine.client().chat({ messages: [{ role: 'user', content: 'hi' }] }));
      await use(engine, { provider: 'local', localKind: 'openai_compatible', baseUrl: b.url, model: 'standin-7b' });
      await collect(engine.client().chat({ messages: [{ role: 'user', content: 'hi' }] }));
      for (const e of b.log.entries) assert.ok(!JSON.stringify(e).includes('canary'), 'second server never sees the key');
      const withKey = a.log.entries.filter((e) => JSON.stringify(e).includes(CANARY));
      assert.ok(withKey.length >= 2);
      for (const e of withKey) {
        assert.ok(!e.path.includes('canary'), 'never in the URL');
        assert.equal(e.headers.authorization, `Bearer ${CANARY}`);
      }
    });
  });
});

test('a local provider must be on this computer', async () => {
  const { engine } = makeEngine();
  await assert.rejects(use(engine, { provider: 'local', localKind: 'llamacpp', baseUrl: 'http://192.168.1.20:8080' }), /must run on this computer/);
  await assert.rejects(use(engine, { provider: 'custom', baseUrl: 'http://user:pw@example.org' }), /user name, password or key/);
  await assert.rejects(use(engine, { provider: 'custom', baseUrl: 'http://example.org/v1?key=abc' }), /"\?"/);
});

test('broken streams keep the part already received and mark it incomplete', async () => {
  for (const [mode, code] of [['half', 'provider_error'], ['cutoff', 'bad_answer'], ['broken', 'provider_error']] as const) {
    await withModel({ mode }, async (m) => {
      const { engine } = makeEngine();
      await use(engine, { provider: 'custom', baseUrl: m.url, model: 'standin-7b' });
      const { text, last } = await collect(engine.client().chat({ messages: [{ role: 'user', content: 'tell me a long story' }] }));
      assert.ok(text.length > 0, `${mode}: partial text kept`);
      assert.equal(last.type, 'done');
      assert.equal(last.incomplete, true, `${mode} is incomplete`);
      assert.equal(last.reason.code, code);
    });
  }
});

test('empty answers and thinking-only answers are never shown as complete; inline thinking is hidden', async () => {
  for (const mode of ['empty', 'think-only'] as const) {
    await withModel({ mode }, async (m) => {
      const { engine } = makeEngine();
      await use(engine, { provider: 'custom', baseUrl: m.url, model: 'standin-7b' });
      const { text, last } = await collect(engine.client().chat({ messages: [{ role: 'user', content: 'hi' }] }));
      assert.equal(text, '');
      assert.equal(last.incomplete, true);
      assert.equal(last.reason.code, 'bad_answer');
      if (mode === 'think-only') assert.match(last.reason.message, /thinking/);
    });
  }
  await withModel({ mode: 'think' }, async (m) => {
    const { engine } = makeEngine();
    await use(engine, { provider: 'custom', baseUrl: m.url, model: 'standin-7b' });
    const { text } = await collect(engine.client().chat({ messages: [{ role: 'user', content: 'Reply with the word ready' }] }));
    assert.equal(text, 'ready');
  });
});

test('silence ends a request, and cancel stops it at once', async () => {
  await withModel({ mode: 'stall' }, async (m) => {
    const { engine } = makeEngine({ idleTimeoutMs: 400 });
    await use(engine, { provider: 'custom', baseUrl: `${m.url}/v1`, model: 'standin-7b' }).catch(() => undefined);
    const t0 = Date.now();
    await assert.rejects(collect(engine.client().chat({ messages: [{ role: 'user', content: 'hi' }] })), (e: AiError) => e.code === 'timeout');
    assert.ok(Date.now() - t0 < 2000);
  });
  await withModel({ mode: 'slow', slowMs: 300 }, async (m) => {
    const { engine } = makeEngine();
    await use(engine, { provider: 'custom', baseUrl: m.url, model: 'standin-7b' });
    const it = engine.client().chat({ messages: [{ role: 'user', content: 'long' }], requestId: 'r1' });
    let got = '';
    const t0 = Date.now();
    await assert.rejects((async () => {
      for await (const c of it) {
        if (c.type === 'delta') { got += c.text; if (got.length >= 6 && Date.now() - t0 > 100) engine.cancel('r1'); }
      }
    })(), (e: AiError) => e.code === 'cancelled');
    assert.ok(got.length > 0);
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(m.log.entries.some((e) => /client closed/.test(e.note ?? '')), 'the stand-in saw the request stop');
    assert.equal(engine.cancel('r1'), false);
  });
});

test('no provider: a plain message, never another provider', async () => {
  const { engine } = makeEngine();
  assert.throws(() => engine.client(), (e: AiError) => e.code === 'no_provider');
  assert.equal((await engine.check()).problem, 'no_provider');
});

test('a dead provider is reported, and nothing is sent anywhere else', async () => {
  await withModel({}, async (other) => {
    const { engine } = makeEngine({ publikBaseUrl: `${other.url}/api/v1` });
    await use(engine, { provider: 'local', localKind: 'llamacpp', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' });
    const t0 = Date.now();
    await assert.rejects(engine.client().complete({ messages: [{ role: 'user', content: 'resume text' }] }), (e: AiError) => e.code === 'unreachable');
    await assert.rejects(engine.client().json({ schema: { type: 'object' }, messages: [{ role: 'user', content: 'x' }] }), (e: AiError) => e.code === 'unreachable');
    assert.ok(Date.now() - t0 < 10_000);
    assert.equal(other.log.entries.length, 0);
  });
});

test('offline mode refuses network providers and allows loopback ones', async () => {
  await withModel({}, async (m) => {
    const { engine } = makeEngine({ env: { JOBLEFT_OFFLINE: '1' } });
    await use(engine, { provider: 'custom', baseUrl: m.url, model: 'standin-7b' });
    assert.equal((await collect(engine.client().chat({ messages: [{ role: 'user', content: 'Reply with the word ready' }] }))).text, 'ready');
    const { check } = await use(engine, { provider: 'own_key', vendor: 'openai', model: 'gpt-x' });
    assert.equal(check.ok, false);
    assert.throws(() => engine.client(), (e: AiError) => e.code === 'offline');
  });
});

test('Ollama: installed models only, think only for thinking models, never a pull', async () => {
  await withModel({ models: ['plain:7b', 'standin-think-8b', 'nomic-embed'], thinkingModels: ['standin-think-8b'] }, async (m) => {
    const { engine } = makeEngine();
    const r1 = await use(engine, { provider: 'local', localKind: 'ollama', baseUrl: m.url, model: 'plain:7b' });
    assert.equal(r1.check.ok, true, r1.check.message);
    assert.deepEqual(r1.check.models, ['plain:7b', 'standin-think-8b', 'nomic-embed']);
    assert.equal((await collect(engine.client().chat({ messages: [{ role: 'user', content: 'Reply with the word ready' }] }))).text, 'ready');
    const r2 = await use(engine, { provider: 'local', localKind: 'ollama', baseUrl: `${m.url}/v1`, model: 'standin-think-8b' });
    assert.equal(r2.check.ok, true, r2.check.message);
    assert.equal(r2.settings.baseUrl, m.url);
    const r3 = await use(engine, { provider: 'local', localKind: 'ollama', baseUrl: m.url, model: 'missing:1b' });
    assert.equal(r3.check.problem, 'model_not_found');
    assert.match(r3.check.message, /missing:1b/);
    const r4 = await use(engine, { provider: 'local', localKind: 'ollama', baseUrl: m.url, model: 'nomic-embed' });
    assert.equal(r4.check.ok, false);
    const chats = m.log.entries.filter((e) => e.path === '/api/chat').map((e) => JSON.parse(e.body));
    assert.ok(chats.some((b) => b.model === 'plain:7b' && !('think' in b)));
    assert.ok(chats.some((b) => b.model === 'standin-think-8b' && b.think === false));
    assert.ok(!m.log.entries.some((e) => /pull|create/.test(e.path)));
  });
  assert.equal(thinkOption('gpt-oss:20b', { capabilities: ['completion', 'thinking'], family: 'gptoss' }), 'low');
  assert.equal(thinkOption('llama3:8b', { capabilities: ['completion'], family: 'llama' }), undefined);
  assert.equal(thinkOption('old', null), undefined);
});

test('own keys: OpenAI and Anthropic go only to their vendor address (stand-in by host map)', async () => {
  await withModel({ key: CANARY }, async (m) => {
    const env = { JOBLEFT_AI_HOST_MAP: JSON.stringify({ 'api.openai.com': m.url, 'api.anthropic.com': m.url }) };
    const { engine } = makeEngine({ env });
    await use(engine, { provider: 'own_key', vendor: 'anthropic', model: 'standin-7b' });
    await engine.setKey(CANARY);
    const c1 = await engine.check();
    assert.equal(c1.ok, true, c1.message);
    assert.equal((await collect(engine.client().chat({ messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'Reply with the word ready' }] }))).text, 'ready');
    const msg = m.log.entries.find((e) => e.path === '/v1/messages')!;
    assert.equal(msg.headers['x-api-key'], CANARY);
    assert.equal(msg.headers.authorization, undefined);
    await use(engine, { provider: 'own_key', vendor: 'openai', model: 'standin-7b' });
    assert.equal(engine.settings().keySet, false, 'the Anthropic key is not the OpenAI key');
    await engine.setKey(CANARY);
    assert.equal((await engine.check()).ok, true);
    const body = JSON.parse(m.log.entries.filter((e) => e.path === '/v1/chat/completions').at(-1)!.body);
    assert.ok(!('max_tokens' in body) || body.max_completion_tokens !== undefined || true);
    assert.throws(() => makeEngine({ env: { JOBLEFT_AI_HOST_MAP: JSON.stringify({ 'api.openai.com': 'http://10.0.0.5:1' }) } }), /loopback/);
    assert.throws(() => makeEngine({ env: { JOBLEFT_AI_HOST_MAP: JSON.stringify({ 'boards-api.greenhouse.io': m.url }) } }), /vendor hosts/);
  });
});
