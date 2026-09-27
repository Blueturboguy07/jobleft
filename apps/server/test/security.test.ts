// Server O1, O2, O14: only the app can use the server; a web page never reaches the data; no hidden doors.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_API, buildPath, type RouteSpec } from '@jobleft/contracts';
import { connect } from 'node:net';
import { cleanup, raw, startTest, type TestServer } from './helpers.ts';

let s: TestServer;
before(async () => { s = await startTest('sec'); });
after(async () => { await s.stop(); cleanup(s.home); });

const ROUTES = Object.entries(LOCAL_API) as Array<[string, RouteSpec]>;
function samplePath(r: RouteSpec): string {
  return buildPath(r.path, Object.fromEntries((r.path.match(/:([A-Za-z]+)/g) ?? []).map((p) => [p.slice(1), 'x'])));
}

test('health answers without a token and reveals no data', async () => {
  const r = await raw(s.port, { path: '/api/v1/health' });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['apiVersion', 'app', 'extensionProtocol', 'version']);
  assert.ok(!r.text.includes(s.home));
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('every route except health and pair refuses a missing or wrong token, and changes nothing', async () => {
  for (const [name, r] of ROUTES) {
    if (r.auth === 'none') continue;
    for (const token of [undefined, 'wrong-token-wrong-token-wrong-token-wrong1']) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token) headers[r.auth === 'pairing' ? 'x-jobleft-pairing' : 'x-jobleft-token'] = token;
      const res = await raw(s.port, { method: r.method, path: samplePath(r), headers, body: r.method === 'GET' || r.method === 'DELETE' ? undefined : '{}' });
      assert.ok([401, 403, 404].includes(res.status), `${name} answered ${res.status}`);
      if (r.devOnly) continue;
      assert.equal(res.json?.error?.code, r.auth === 'pairing' ? (res.status === 403 ? 'forbidden_origin' : 'unauthorized') : 'unauthorized', `${name}: ${res.text}`);
    }
  }
});

test('the token is refused in a URL query string', async () => {
  const r = await raw(s.port, { path: `/api/v1/settings?token=${s.token}` });
  assert.equal(r.status, 400);
  const r2 = await raw(s.port, { path: `/api/v1/jobs?q=${s.token}`, headers: { 'x-jobleft-token': s.token } });
  assert.equal(r2.status, 400);
});

test('a foreign Host is refused even with the right token (DNS rebinding)', async () => {
  for (const host of [`attacker.example:${s.port}`, `127.0.0.1.attacker.example:${s.port}`, `localhost.attacker.example:${s.port}`, '127.0.0.1', `127.0.0.1:${s.port + 1}`, `[::1]:${s.port}`, `0.0.0.0:${s.port}`]) {
    const r = await raw(s.port, { path: '/api/v1/settings', host, headers: { 'x-jobleft-token': s.token } });
    assert.equal(r.status, 403, host);
    assert.equal(r.json.error.code, 'forbidden_host');
  }
  const ok = await raw(s.port, { path: '/api/v1/settings', host: `localhost:${s.port}`, headers: { 'x-jobleft-token': s.token } });
  assert.equal(ok.status, 200);
});

/** One raw HTTP/1.1 exchange over a socket, for requests that node:http cannot send (two Host lines, "//x" targets). */
function rawSocket(port: number, text: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1');
    let buf = '';
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.on('close', () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0), text: buf }));
    sock.on('error', reject);
    sock.write(text);
  });
}

test('a request with two Host lines, or a target that is not a plain path, is refused', async () => {
  const two = await rawSocket(s.port, `GET /api/v1/settings HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nHost: attacker.example\r\nx-jobleft-token: ${s.token}\r\nConnection: close\r\n\r\n`);
  assert.equal(two.status, 400, two.text);
  assert.ok(!two.text.includes('"crawl"'), 'no settings in the answer');
  for (const target of ['//etc/passwd', '//attacker.example/api/v1/settings', `http://attacker.example/api/v1/settings`, `http://127.0.0.1:${s.port}/api/v1/settings`]) {
    const r = await rawSocket(s.port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nx-jobleft-token: ${s.token}\r\nConnection: close\r\n\r\n`);
    assert.ok(r.status === 404 || r.status === 400, `${target} -> ${r.status}`);
    assert.ok(!r.text.includes('root:') && !r.text.includes('"crawl"'), target);
  }
});

test('foreign and null Origins are refused, with no CORS header echoed', async () => {
  for (const origin of ['http://127.0.0.1:8099', 'null', 'http://attacker.example', `http://127.0.0.1:${s.port}.attacker.example`, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
    const r = await raw(s.port, { path: '/api/v1/settings', headers: { 'x-jobleft-token': s.token, origin } });
    assert.equal(r.status, 403, origin);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    const w = await raw(s.port, { method: 'PUT', path: '/api/v1/settings', headers: { 'x-jobleft-token': s.token, origin, 'content-type': 'application/json' }, body: JSON.stringify({ crawl: { intervalHours: 99, catchUpOnLaunch: false, runInTray: false }, notifications: { reminders: false, alerts: false } }) });
    assert.equal(w.status, 403);
  }
  const settings = await s.call('GET', '/api/v1/settings');
  assert.equal(settings.json.crawl.intervalHours, 6, 'nothing changed');
  const own = await raw(s.port, { path: '/api/v1/settings', headers: { 'x-jobleft-token': s.token, origin: `http://127.0.0.1:${s.port}` } });
  assert.equal(own.status, 200);
});

test('cross-site image or script loads (no Origin, Sec-Fetch-Site cross-site) are refused', async () => {
  const r = await raw(s.port, { path: '/api/v1/profile', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image' } });
  assert.equal(r.status, 403);
});

test('a plain cross-site form post (text/plain, urlencoded, multipart) is refused before any work', async () => {
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const r = await raw(s.port, { method: 'PUT', path: '/api/v1/profile', headers: { 'x-jobleft-token': s.token, 'content-type': ct }, body: '{}' });
    assert.equal(r.status, 415, ct);
    assert.equal(r.json.error.code, 'unsupported_media_type');
  }
});

test('preflight is refused for web pages and never allows "*"', async () => {
  const r = await raw(s.port, { method: 'OPTIONS', path: '/api/v1/profile', headers: { origin: 'http://attacker.example', 'access-control-request-method': 'PUT' } });
  assert.equal(r.status, 403);
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('bodies over the limit answer 413 and store nothing', async () => {
  const big = JSON.stringify({ name: 'x'.repeat(1_100_000), filter: {}, sort: 'recommended' });
  const r = await s.call('POST', '/api/v1/filters', undefined, { 'content-type': 'application/json' });
  assert.equal(r.status, 400);
  const r2 = await raw(s.port, { method: 'POST', path: '/api/v1/filters', headers: { 'x-jobleft-token': s.token, 'content-type': 'application/json' }, body: big });
  assert.equal(r2.status, 413);
  assert.equal((await s.call('GET', '/api/v1/filters')).json.length, 0);
});

test('invalid bodies answer 400 with issue paths and no personal text, and store nothing', async () => {
  const cases: Array<[string, string, unknown]> = [
    ['PUT', '/api/v1/profile', { personal: 'Jordan Testwell' }],
    ['POST', '/api/v1/filters', { name: 42, filter: {}, sort: 'recommended' }],
    ['POST', '/api/v1/filters', { filter: {}, sort: 'recommended' }],
    ['PATCH', '/api/v1/tracker/greenhouse:x:1', { status: 'hired' }],
    ['PUT', '/api/v1/settings', { crawl: { intervalHours: 0 } }],
  ];
  for (const [m, p, b] of cases) {
    const r = await s.call(m, p, b);
    assert.equal(r.status, 400, `${m} ${p}`);
    assert.equal(r.json.error.code, 'bad_request');
    assert.ok(!r.text.includes('Jordan'), 'no body text echoed');
    assert.ok(Array.isArray(r.json.error.details.issues));
  }
  const bad = await raw(s.port, { method: 'PUT', path: '/api/v1/profile', headers: { 'x-jobleft-token': s.token, 'content-type': 'application/json' }, body: '{"personal": "Jordan Testwell"' });
  assert.equal(bad.status, 400);
  assert.ok(!bad.text.includes('Jordan'));
  assert.equal((await s.call('GET', '/api/v1/profile')).json.personal.firstName, null);
  // Text is stored character for character or refused: bytes that are not UTF-8 (Latin-1 "é") and a lone surrogate
  // are refused, never saved as a replacement character.
  const h = { 'x-jobleft-token': s.token, 'content-type': 'application/json' };
  for (const body of [Buffer.from('{"name":"Caf\xe9","filter":{},"sort":"recommended"}', 'latin1'), '{"name":"bad \\ud800 x","filter":{},"sort":"recommended"}', '{"name":"ok","filter":{"\\udfff":1},"sort":"recommended"}']) {
    const r = await raw(s.port, { method: 'POST', path: '/api/v1/filters', headers: h, body });
    assert.equal(r.status, 400, String(body));
    assert.equal(r.json.error.code, 'bad_request');
  }
  const pair = await raw(s.port, { method: 'POST', path: '/api/v1/filters', headers: h, body: '{"name":"ok \\ud83c\\udfaf","filter":{},"sort":"recommended"}' });
  assert.equal(pair.status, 200, 'a surrogate PAIR (an emoji) is fine');
  assert.equal(pair.json.name, 'ok 🎯');
  assert.deepEqual((await s.call('GET', '/api/v1/filters')).json.map((f: { name: string }) => f.name), ['ok 🎯']);
  await s.call('DELETE', `/api/v1/filters/${pair.json.id}`);
});

test('undocumented and traversal paths answer not found; no file outside the UI folder is served', async () => {
  for (const p of ['/api/v1/admin', '/api/v1/debug', '/api/mcp', '/api/v1/files/..%2f..%2fetc%2fpasswd', '/api/v1/../../etc/passwd', '/api/health', '/api/v1/dev/clock',
    '/..%2f..%2f..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2f..%2fpackage.json', '/.git/config', '/dashboard', '/api/auth/session']) {
    const r = await raw(s.port, { path: p, headers: { 'x-jobleft-token': s.token } });
    assert.ok(!r.text.includes('root:'), p);
    assert.ok(!r.text.includes('"name": "@jobleft/server"'), p);
    assert.ok(r.status === 404 || r.status === 400 || r.status === 405, `${p} -> ${r.status}`);
  }
  // Outside /api/ only real UI files answer: no fallback page for admin, debug or tool paths.
  for (const p of ['/admin', '/debug', '/developer', '/_next/', '/%252e%252e/etc/passwd', '/files/resumes', '/data/jobleft.db', '/logs/server.log', '/run/server.json']) {
    const r = await raw(s.port, { path: p });
    assert.equal(r.status, 404, `${p} -> ${r.status}`);
  }
  assert.equal((await raw(s.port, { path: '/' })).status, 200, 'the UI itself still loads');
});

test('the dev clock route is hidden without dev mode', async () => {
  const t = await startTest('secdev', { dev: false });
  try {
    const r = await t.call('POST', '/api/v1/dev/clock', { offset: '72h' });
    assert.equal(r.status, 404);
  } finally { await t.stop(); cleanup(t.home); }
});

test('an error never shows a stack trace or the account path', async () => {
  const r = await s.call('GET', '/api/v1/jobs/' + encodeURIComponent('greenhouse:nope:1'));
  assert.equal(r.status, 404);
  assert.ok(!/\/Users\/|at .*\.ts:\d+/.test(r.text));
});

test('at the default log level, refused requests leave every file in the data folder byte for byte as it was', async () => {
  const { createHash } = await import('node:crypto');
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const t = await startTest('secquiet', { env: { JOBLEFT_LOG_LEVEL: 'info' } });
  // One hash per file, so a difference names the file. SQLite's -shm file is left out: it is the WAL's shared index,
  // which readers touch too (read marks), so it is not a record of any write.
  const hashAll = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const n of readdirSync(d).sort()) {
        const p = join(d, n);
        if (p.startsWith(join(t.home, 'run')) || n.endsWith('-shm')) continue;
        if (statSync(p).isDirectory()) walk(p); else out[p.slice(t.home.length)] = createHash('sha256').update(readFileSync(p)).digest('hex');
      }
    };
    walk(dir);
    return out;
  };
  try {
    await t.call('PUT', '/api/v1/profile', { ...(await import('./helpers.ts')).PERSONA });
    const before = hashAll(t.home);
    for (const [, r] of ROUTES) {
      const path = samplePath(r);
      await raw(t.port, { method: r.method, path, headers: { 'content-type': 'text/plain' }, body: r.method === 'GET' || r.method === 'DELETE' ? undefined : 'x' });
      await raw(t.port, { method: r.method, path, headers: { origin: 'http://127.0.0.1:8099', 'x-jobleft-token': t.token } });
      await raw(t.port, { method: r.method, path, host: 'attacker.example', headers: { 'x-jobleft-token': t.token } });
    }
    assert.deepEqual(hashAll(t.home), before);
  } finally { await t.stop(); cleanup(t.home); }
});
