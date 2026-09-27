// The extension talks to ONE app: the port the person typed with the pairing code (JL-extension-2, 3, 12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ExtensionStatusSchema } from '@jobleft/contracts';
import { AppError, createAppClient, parsePort, type Pairing } from '../src/appclient.ts';

const TOKEN = 'T'.repeat(43);
const INFO = { extensionId: 'abcdefghijklmnopabcdefghijklmnop', extensionVersion: '0.1.0', protocolVersion: 1, browser: 'Chrome test' };
const HEALTH = { app: 'jobleft', version: '0.1.2', apiVersion: 1, extensionProtocol: 1 };
const STATUS = { paired: true, appVersion: '0.1.2', protocolVersion: 1, profileComplete: true, missingProfileFields: [] };

type Seen = { port: number; path: string; method: string; token: string | null; body: string | null };

/** Fake apps on 127.0.0.1: port -> handler. A port with no handler refuses the connection. */
function world(apps: Record<number, (path: string, method: string, token: string | null) => { status: number; json: unknown }>) {
  const seen: Seen[] = [];
  let pairing: Pairing | null = null;
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = headers['x-jobleft-pairing'] ?? null;
    seen.push({ port: Number(u.port), path: u.pathname, method: init?.method ?? 'GET', token, body: typeof init?.body === 'string' ? init.body : null });
    const app = apps[Number(u.port)];
    if (!app) throw new TypeError('fetch failed');
    const r = app(u.pathname, init?.method ?? 'GET', token);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = createAppClient({ fetch: fetchFake, getPairing: async () => pairing, setPairing: async (p) => { pairing = p; } });
  return { client, seen, get pairing() { return pairing; }, set pairing(p: Pairing | null) { pairing = p; } };
}

/** A jobleft app that accepts one code and one token. */
function realApp() {
  return (path: string, method: string, token: string | null) => {
    if (path === '/api/v1/health') return { status: 200, json: HEALTH };
    if (path === '/api/v1/extension/pair' && method === 'POST') return { status: 200, json: { pairingToken: TOKEN, appVersion: '0.1.2', protocolVersion: 1 } };
    if (token !== TOKEN) return { status: 401, json: { error: { code: 'unauthorized', message: 'not paired' } } };
    return { status: 200, json: STATUS };
  };
}

/** Another program that answers like jobleft but knows no code and no token. */
function stranger() {
  return (path: string) => path === '/api/v1/health' ? { status: 200, json: HEALTH } : { status: 401, json: { error: { code: 'unauthorized', message: 'no' } } };
}

test('pairing sends the code to the typed port only, never to another jobleft on a lower port (JL-extension-2)', async () => {
  const w = world({ 47821: stranger(), 47829: realApp() });
  const r = await w.client.pair('123353', '47829', INFO);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /^Paired with jobleft 0\.1\.2/);
  assert.deepEqual([...new Set(w.seen.map((s) => s.port))], [47829], 'no request of any kind to another port');
  assert.ok(!w.seen.some((s) => s.body?.includes('123353') && s.port !== 47829));
  assert.deepEqual(w.pairing, { token: TOKEN, port: 47829, appVersion: '0.1.2' }, 'the pairing remembers the port');
});

test('an app outside 47821-47830 can pair (JL-extension-3), and the manifest lets the extension reach any 127.0.0.1 port only', async () => {
  const w = world({ 47867: realApp() });
  const r = await w.client.pair('111111', '47867', INFO);
  assert.equal(r.ok, true, r.message);
  assert.equal(w.pairing?.port, 47867);
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as { content_security_policy: { extension_pages: string } };
  const connect = /connect-src ([^;]+)/.exec(manifest.content_security_policy.extension_pages)?.[1]?.trim();
  assert.equal(connect, 'http://127.0.0.1:*', 'the extension pages may connect to 127.0.0.1 (any port) and nowhere else');
});

test('a wrong or missing port sends the code nowhere', async () => {
  const w = world({ 47821: stranger() });
  for (const port of ['', 'abc', '0', '70000', '4782a']) {
    const r = await w.client.pair('123456', port, INFO);
    assert.equal(r.ok, false);
    assert.match(r.message, /port/);
  }
  assert.equal(w.seen.length, 0);
  const r = await w.client.pair('123456', '47830', INFO);
  assert.equal(r.ok, false);
  assert.match(r.message, /No jobleft app answers on port 47830/);
  assert.ok(!w.seen.some((s) => s.path === '/api/v1/extension/pair'), 'no code sent to a port where no jobleft answers');
  assert.deepEqual(w.seen.map((s) => s.port), [47830]);
  assert.equal(parsePort(' 47829 '), 47829);
  assert.equal(parsePort('65536'), null);
});

test('when the paired port stops answering: "not running", and the token goes nowhere else (JL-extension-12)', async () => {
  const w = world({ 47821: stranger() });
  w.pairing = { token: TOKEN, port: 47829, appVersion: '0.1.2' };
  await assert.rejects(w.client.call('/api/v1/extension/check', 'POST', {}, ExtensionStatusSchema), (e: unknown) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'not_running');
    assert.match(e.message, /does not answer on port 47829/);
    return true;
  });
  assert.deepEqual(w.seen.map((s) => s.port), [47829], 'one request, to the paired port');
  assert.ok(!w.seen.some((s) => s.port !== 47829 && s.token !== null), 'the token never reaches another port');
  assert.equal(w.pairing?.port, 47829, 'the pairing is kept for when the app comes back');
});

test('a paired call goes to the paired port; a 401 there drops the pairing without trying other ports', async () => {
  const w = world({ 47821: stranger(), 47829: realApp() });
  w.pairing = { token: TOKEN, port: 47829, appVersion: '0.1.2' };
  const s = await w.client.call<{ paired: boolean }>('/api/v1/extension/check', 'POST', {}, ExtensionStatusSchema);
  assert.equal(s.paired, true);
  w.pairing = { token: 'U'.repeat(43), port: 47829, appVersion: '0.1.2' };
  await assert.rejects(w.client.call('/api/v1/extension/check', 'POST', {}, ExtensionStatusSchema), (e: unknown) => e instanceof AppError && e.code === 'unpaired');
  assert.equal(w.pairing, null);
  assert.deepEqual([...new Set(w.seen.map((s) => s.port))], [47829]);
});

test('unpair tells the paired port only, and forgets the token even when the app is closed', async () => {
  const w = world({ 47821: stranger() });
  w.pairing = { token: TOKEN, port: 47829, appVersion: '0.1.2' };
  await w.client.unpair();
  assert.equal(w.pairing, null);
  assert.deepEqual(w.seen.map((s) => [s.port, s.method]), [[47829, 'DELETE']]);
});
