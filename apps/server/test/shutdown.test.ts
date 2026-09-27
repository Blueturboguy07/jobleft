// The shutdown route (the desktop shell's clean quit on every platform; Windows has no SIGTERM): one POST with the
// launch token closes the server, the caller's onStop runs once, the port is free again, and a stranger gets nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { memorySecrets, newLaunchToken, startServer } from '../src/index.ts';
import { cleanup, raw, scratchHome } from './helpers.ts';

const portOpen = (port: number) => new Promise<boolean>((resolve) => {
  const s = connect({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

test('POST /api/v1/shutdown closes the server once, frees the port and removes run/server.json; no token = no shutdown', async () => {
  const home = scratchHome('shutdown');
  const token = newLaunchToken();
  const stops: string[] = [];
  const server = await startServer({ home, launchToken: token, secrets: memorySecrets(), dev: false, env: { JOBLEFT_AUTO_CRAWL: '0' }, onStop: (why) => stops.push(why) });
  const port = server.port;
  assert.ok(existsSync(join(home, 'run/server.json')));
  // A stranger (no token, wrong token, a browser page's origin) gets a refusal and the server stays up.
  const strangers: Record<string, string>[] = [{}, { 'x-jobleft-token': 'wrong' }, { origin: 'https://evil.example', 'x-jobleft-token': token }];
  for (const headers of strangers) {
    const r = await raw(port, { method: 'POST', path: '/api/v1/shutdown', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
    assert.ok(r.status === 401 || r.status === 403, `stranger got ${r.status}`);
  }
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await portOpen(port), true, 'still serving after the refusals');
  assert.deepEqual(stops, []);
  const ok = await raw(port, { method: 'POST', path: '/api/v1/shutdown', headers: { 'x-jobleft-token': token, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true });
  // A second call in the same instant must not run a second close.
  await raw(port, { method: 'POST', path: '/api/v1/shutdown', headers: { 'x-jobleft-token': token, 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
  const t0 = Date.now();
  while (await portOpen(port)) { if (Date.now() - t0 > 8000) assert.fail('port still open 8 s after shutdown'); await new Promise((r) => setTimeout(r, 100)); }
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(stops, ['shutdown route']);
  assert.ok(!existsSync(join(home, 'run/server.json')), 'run/server.json removed');
  cleanup(home);
});
