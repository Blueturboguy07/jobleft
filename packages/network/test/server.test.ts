import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startDevServer, type DevServer } from '../src/dev/server.ts';
import { startMockAi, type MockAi } from '../src/dev/mock-ai.ts';
import { demoFixture } from '../src/dev/fixture.ts';
import { NOW, tempHome } from './helpers.ts';

process.env.JOBLEFT_NO_OS_NOTIFY = '1';

function raw(server: DevServer, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, method: opts.method ?? 'GET', path: opts.path, headers: { host: `127.0.0.1:${server.port}`, ...(opts.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => (/ECONNRESET|EPIPE/.test(String(e)) ? resolve({ status: 413, headers: {}, text: '' }) : reject(e)));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function withServer(fn: (s: DevServer, api: (m: string, p: string, b?: unknown, raw?: { type: string; data: string }) => Promise<{ status: number; body: any }>, mock: MockAi, publik: MockAi) => Promise<void>) {
  const h = tempHome();
  const mock = await startMockAi({ port: 0 });
  const publik = await startMockAi({ port: 0, publik: true, balanceUsd: 5, priceUsd: 0.01 });
  const server = await startDevServer({ home: h.dir, port: 0, osNotifications: false });
  const api = async (method: string, path: string, body?: unknown, rawBody?: { type: string; data: string }) => {
    const headers: Record<string, string> = { 'x-jobleft-token': server.token };
    let payload: string | undefined;
    if (rawBody) { headers['content-type'] = rawBody.type; payload = rawBody.data; }
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(`${server.origin}${path}`, { method, headers, body: payload });
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : null };
  };
  try { await fn(server, api, mock, publik); } finally {
    await server.close(); await mock.close(); await publik.close(); h.done();
  }
}

test('O11: foreign origins, forged hosts, missing or URL tokens and form posts are refused, and no CORS header is sent', async () => {
  await withServer(async (s, api) => {
    await api('POST', '/api/v1/network/import', undefined, { type: 'text/csv', data: demoFixture(NOW).text });
    const t = s.token;
    const cases: Array<[string, Parameters<typeof raw>[1], number, string]> = [
      ['no token', { path: '/api/v1/network/contacts' }, 401, 'unauthorized'],
      ['wrong token', { path: '/api/v1/network/contacts', headers: { 'x-jobleft-token': 'nope' } }, 401, 'unauthorized'],
      ['token in the query', { path: `/api/v1/network/contacts?token=${t}` }, 401, 'unauthorized'],
      ['token value in any query', { path: `/api/v1/network/contacts?q=${t}`, headers: { 'x-jobleft-token': t } }, 401, 'unauthorized'],
      ['foreign origin', { path: '/api/v1/network/contacts', headers: { 'x-jobleft-token': t, origin: 'https://evil.example' } }, 403, 'forbidden_origin'],
      ['null origin', { path: '/api/v1/network/contacts', headers: { 'x-jobleft-token': t, origin: 'null' } }, 403, 'forbidden_origin'],
      ['extension origin', { path: '/api/v1/network/contacts', headers: { 'x-jobleft-token': t, origin: 'chrome-extension://abcdefghijklmnop' } }, 403, 'forbidden_origin'],
      ['rebinding host', { path: '/api/v1/network/contacts', headers: { 'x-jobleft-token': t, host: `127.0.0.1.attacker.example:${s.port}` } }, 403, 'forbidden_host'],
      ['other host', { path: '/api/v1/network/contacts', headers: { 'x-jobleft-token': t, host: 'evil.example' } }, 403, 'forbidden_host'],
      ['form post', { method: 'POST', path: '/api/v1/network/plan', headers: { 'x-jobleft-token': t, 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b' }, 415, 'unsupported_media_type'],
      ['text/plain JSON', { method: 'PATCH', path: '/api/v1/network/contacts/x', headers: { 'x-jobleft-token': t, 'content-type': 'text/plain' }, body: '{}' }, 415, 'unsupported_media_type'],
      ['preflight', { method: 'OPTIONS', path: '/api/v1/network/contacts', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } }, 403, 'forbidden_origin'],
    ];
    for (const [name, opts, status, code] of cases) {
      const r = await raw(s, opts);
      assert.equal(r.status, status, name);
      assert.equal(JSON.parse(r.text).error.code, code, name);
      assert.equal(r.headers['access-control-allow-origin'], undefined, name);
      assert.doesNotMatch(r.text, /Quill|Avery|example\.com/, `${name}: no network row in an error`);
    }
    const ok = await raw(s, { path: '/api/v1/network/contacts?companyKey=stripe', headers: { 'x-jobleft-token': t, origin: `http://127.0.0.1:${s.port}` } });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.text).length, 4);
    assert.equal(ok.headers['access-control-allow-origin'], undefined);
    const health = await raw(s, { path: '/api/v1/health' });
    assert.equal(health.status, 200);
    assert.doesNotMatch(health.text, /\d{2,} people|private|tmp|Quill/);
    // A too-large upload is refused before anything is stored.
    const big = await raw(s, { method: 'POST', path: '/api/v1/network/import', headers: { 'x-jobleft-token': t, 'content-type': 'text/csv', 'content-length': String(11 * 1048576) }, body: 'x' });
    assert.equal(big.status, 413);
  });
});

test('O11: an error for a real contact does not echo its row', async () => {
  await withServer(async (s, api) => {
    await api('POST', '/api/v1/network/import', undefined, { type: 'text/csv', data: demoFixture(NOW).text });
    const list = (await api('GET', '/api/v1/network/contacts?q=Avery')).body;
    const r = await api('PATCH', `/api/v1/network/contacts/${list[0].id}`, { followUpOn: 'soon' });
    assert.equal(r.status, 400);
    assert.doesNotMatch(JSON.stringify(r.body), /Avery|Quill|Stripe/);
  });
});

test('O1 and O12 through the route: counts, reasons, blank email stays blank, not-a-connections file', async () => {
  await withServer(async (_s, api) => {
    const r = await api('POST', '/api/v1/network/import', undefined, { type: 'text/csv', data: demoFixture(NOW).text });
    assert.equal(r.status, 200);
    assert.equal(r.body.inFile, 31);
    assert.deepEqual(r.body.skipped.map((x: { line: number }) => x.line), [36, 37]);
    const blake = (await api('GET', '/api/v1/network/contacts?q=Ormond')).body[0];
    assert.equal(blake.email, null);
    const bad = await api('POST', '/api/v1/network/import', undefined, { type: 'text/plain', data: 'CONVERSATION ID,FROM\n1,a\n' });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.notAConnectionsFile, true);
    assert.equal((await api('GET', '/api/v1/network/contacts')).body.length, 31, 'nothing changed');
    const groups = (await api('GET', '/api/v1/network/companies')).body;
    assert.ok(groups.some((g: { kind: string; count: number }) => g.kind === 'unknown' && g.count === 2));
  });
});

test('O8 end to end: the mock logs one contact\'s facts only; a remote provider needs one confirmation; publik cost is in dollars', async () => {
  await withServer(async (_s, api, mock, publik) => {
    await api('POST', '/api/v1/network/import', undefined, { type: 'text/csv', data: demoFixture(NOW).text });
    const job = (await api('POST', '/api/v1/network-dev/jobs', { title: 'Backend Engineer', company: 'Stripe', liked: true })).body;
    const devon = (await api('GET', '/api/v1/network/contacts?q=Devon')).body[0];
    // No provider: a plain 409 that offers the template, and the template works.
    const none = await api('POST', `/api/v1/network/contacts/${devon.id}/draft`, { variant: 'short', jobId: job.id });
    assert.equal(none.status, 409);
    assert.equal(none.body.error.code, 'needs_provider');
    const tpl = await api('POST', `/api/v1/network/contacts/${devon.id}/draft`, { variant: 'short', jobId: job.id, template: true });
    assert.equal(tpl.body.ready, true);
    // Local provider: no confirmation needed.
    await api('PUT', '/api/v1/network-dev/ai', { provider: 'local', baseUrl: mock.origin });
    const d = await api('POST', `/api/v1/network/contacts/${devon.id}/draft`, { variant: 'short', jobId: job.id });
    assert.equal(d.status, 200);
    assert.equal(d.body.ready, true, JSON.stringify(d.body.warnings));
    assert.match(d.body.text, /^Hi Devon,/);
    const logged = JSON.stringify(mock.log.map((x) => x.body));
    for (const must of ['Devon', 'Marsh', 'Senior Recruiting Coordinator']) assert.ok(logged.includes(must));
    for (const never of ['Avery', 'Quill', 'Blake', 'devon.marsh@example.com', '@example.com', 'linkedin.com/in']) assert.ok(!logged.includes(never), never);
    // Bad output: warnings, not ready.
    mock.setMode('bad');
    const b = await api('POST', `/api/v1/network/contacts/${devon.id}/draft`, { variant: 'short', jobId: job.id });
    assert.equal(b.body.ready, false);
    assert.ok(b.body.warnings.some((w: string) => /Greets "Taylor"/.test(w)));
    // Remote (publik stand-in): confirmation first, then drafts with a cost in micros.
    await api('PUT', '/api/v1/network-dev/ai', { provider: 'publik', baseUrl: `${publik.origin}/api/v1` });
    const pre = await api('POST', `/api/v1/network/contacts/${devon.id}/draft/preview`, { variant: 'short', jobId: job.id });
    assert.equal(pre.body.needsConfirmation, true);
    assert.equal(pre.body.destination.remote, true);
    assert.deepEqual(Object.keys(pre.body.sends.contact).sort(), ['company', 'firstName', 'lastName', 'title']);
    const before = publik.log.length;
    const ask = await api('POST', `/api/v1/network/contacts/${devon.id}/draft`, { variant: 'short', jobId: job.id });
    assert.equal(ask.status, 409);
    assert.equal(ask.body.error.details.needsConfirmation, true);
    assert.equal(publik.log.length, before, 'nothing was sent before the confirmation');
    const paid = await api('POST', `/api/v1/network/contacts/${devon.id}/draft`, { variant: 'short', jobId: job.id, confirmRemote: true });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.costMicros, 10000);
    const ai = (await api('GET', '/api/v1/network-dev/ai')).body;
    assert.equal(ai.wallet.balance, '$4.99');
    assert.doesNotMatch(JSON.stringify(ai), /credit/i);
    // The second remote draft needs no new confirmation.
    assert.equal((await api('POST', `/api/v1/network/contacts/${devon.id}/draft`, { variant: 'long' })).status, 200);
    // Out of money: one plain message with one link.
    await fetch(`${publik.origin}/__admin/balance`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"usd":0}' });
    const broke = await api('POST', `/api/v1/network/contacts/${devon.id}/draft`, { variant: 'short' });
    assert.equal(broke.status, 402);
    assert.match(broke.body.error.message, /balance ran out/);
    assert.ok(broke.body.error.link.url.startsWith('http://127.0.0.1'));
  });
});

test('the dev server writes no network data outside the database, and delete-all through the route clears it', async () => {
  await withServer(async (s, api) => {
    await api('POST', '/api/v1/network/import', undefined, { type: 'text/csv', data: demoFixture(NOW).text });
    const r = await api('DELETE', '/api/v1/network');
    assert.deepEqual(r.body, { ok: true, deleted: 31 });
    const feed = (await api('POST', '/api/v1/network-dev/jobs', { title: 'Backend Engineer', company: 'Stripe' })).body;
    assert.equal((await api('GET', `/api/v1/network-dev/jobs/${encodeURIComponent(feed.id)}`)).body.networkCount, null);
    const home = join(s.service.db.location()!, '..', '..');
    const hits: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (readFileSync(p).includes(Buffer.from('Quill'))) hits.push(p); } };
    walk(home);
    assert.deepEqual(hits, []);
    assert.ok(existsSync(join(home, 'logs', 'network-dev.log')));
  });
});
