import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { encryptedFileSecretStore, keychainSecretStore, WordPieceTokenizer } from '../src/index.ts';
import { startDevServer } from '../src/serve.ts';
import { CANARY, makeEngine, use, withModel } from './helpers.ts';

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...allFiles(p)); else out.push(p);
  }
  return out;
}

test('encrypted file store: round trip, no plain text on disk, mode 0600', async () => {
  const dir = mkdtempSync('/private/tmp/jl-secrets-');
  try {
    const s = encryptedFileSecretStore(join(dir, 'secrets'));
    assert.equal(await s.get('jobleft.ai.x.key'), null);
    await s.set('jobleft.ai.x.key', CANARY);
    await s.set('jobleft.ai.x.key', CANARY); // overwrite keeps one entry
    assert.equal(await s.get('jobleft.ai.x.key'), CANARY);
    for (const f of allFiles(dir)) {
      assert.ok(!readFileSync(f).includes(Buffer.from('canary')), `${f} has no plain key`);
      assert.equal(statSync(f).mode & 0o777, 0o600);
    }
    const enc = JSON.parse(readFileSync(join(dir, 'secrets', 'secrets.enc'), 'utf8'));
    assert.equal(Object.keys(enc.entries).length, 1);
    await s.delete('jobleft.ai.x.key');
    assert.equal(await s.get('jobleft.ai.x.key'), null);
    await assert.rejects(s.set('bad name with spaces', 'x'), /not allowed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('macOS Keychain store (only with JOBLEFT_TEST_KEYCHAIN=1)', { skip: process.platform !== 'darwin' || process.env.JOBLEFT_TEST_KEYCHAIN !== '1' }, async () => {
  const s = keychainSecretStore('jobleft-test-lane');
  const name = 'jobleft.test.probe.key';
  try {
    await s.set(name, `${CANARY} with spaces "and quotes"`);
    await s.set(name, CANARY);
    assert.equal(await s.get(name), CANARY);
  } finally {
    await s.delete(name);
  }
  assert.equal(await s.get(name), null);
});

test('dev server follows the local API security rules', async () => {
  await withModel({}, async (m) => {
    const { engine } = makeEngine();
    await use(engine, { provider: 'custom', baseUrl: m.url, model: 'standin-7b' });
    await engine.setKey(CANARY);
    const srv = await startDevServer(engine);
    const u = (p: string) => `${srv.origin}${p}`;
    const hdr = { 'x-jobleft-token': srv.token, 'content-type': 'application/json' };
    try {
      assert.equal((await fetch(u('/api/v1/health'))).status, 200);
      assert.equal((await fetch(u('/api/v1/ai/settings'))).status, 401, 'no token');
      assert.equal((await fetch(u('/api/v1/ai/settings'), { headers: { 'x-jobleft-token': 'guess' } })).status, 401, 'guessed token');
      assert.equal((await fetch(u(`/api/v1/ai/settings?token=${srv.token}`))).status, 401, 'token in the URL');
      assert.equal((await fetch(u('/api/v1/ai/settings'), { headers: { ...hdr, origin: 'http://127.0.0.1:1' } })).status, 403, 'foreign origin');
      assert.equal((await fetch(u('/api/v1/ai/settings'), { headers: { ...hdr, origin: 'null' } })).status, 403, 'null origin');
      const form = await fetch(u('/api/v1/ai/chat'), { method: 'POST', headers: { 'x-jobleft-token': srv.token, 'content-type': 'text/plain' }, body: '{"requestId":"a","messages":[{"role":"user","content":"hi"}]}' });
      assert.equal(form.status, 415, 'a plain form post starts nothing');
      const put = await fetch(u('/api/v1/ai/settings'), { method: 'PUT', headers: { 'x-jobleft-token': srv.token, 'content-type': 'application/x-www-form-urlencoded' }, body: 'provider=publik' });
      assert.equal(put.status, 415);
      const settings = (await (await fetch(u('/api/v1/ai/settings'), { headers: hdr })).json()) as { keyHint: string };
      assert.equal(settings.keyHint, 'test');
      assert.ok(!JSON.stringify(settings).includes(CANARY));
      const chat = await fetch(u('/api/v1/ai/chat'), { method: 'POST', headers: hdr, body: JSON.stringify({ requestId: 'r1', messages: [{ role: 'user', content: 'Reply with the word ready' }] }) });
      assert.equal(chat.headers.get('content-type')?.startsWith('text/event-stream'), true);
      const events = (await chat.text()).trim().split('\n\n').map((l) => JSON.parse(l.replace(/^data: /, '')));
      assert.equal(events[0].type, 'start');
      assert.equal(events.at(-1).type, 'done');
      assert.equal(events.filter((e: { type: string }) => e.type === 'delta').map((e: { text: string }) => e.text).join(''), 'ready');
      const bad = await fetch(u('/api/v1/ai/settings'), { method: 'PUT', headers: hdr, body: JSON.stringify({ provider: 'claude_subscription' }) });
      assert.equal(bad.status, 400);
      // Host check (DNS rebinding): a raw request with another Host header.
      const http = await import('node:http');
      const status = await new Promise<number>((resolve) => {
        const r = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/v1/ai/settings', headers: { host: `evil.example:${srv.port}`, 'x-jobleft-token': srv.token } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        r.end();
      });
      assert.equal(status, 403);
      for (const e of m.log.entries) assert.ok(!e.path.includes('canary'));
    } finally { await srv.close(); }
  });
});

test('WordPiece tokenizer follows BERT uncased rules', () => {
  const vocab = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'data', 'analyst', 'with', 'sql', 'and', 'tab', '##leau', ',', '.', 'cafe', '北'].join('\n');
  const t = new WordPieceTokenizer(vocab);
  assert.deepEqual(t.basic('Data Analyst, with SQL.'), ['data', 'analyst', ',', 'with', 'sql', '.']);
  assert.deepEqual(t.encode('Data analyst with SQL and Tableau'), [2, 4, 5, 6, 7, 8, 9, 10, 3]);
  assert.deepEqual(t.encode('Café 北京'), [2, 13, 14, 1, 3]);
  assert.equal(t.encode('word '.repeat(1000)).length, 512);
});
