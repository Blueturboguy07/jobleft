// Sign in with publik, end to end on the server process (the way the packaged app runs it): the publik module's gate
// (src/publik.ts) against the repo's publik stand-in, its screens served at "/" (http/publik-gate.ts), the API held
// until the sign-in, the usage count after it, and the builder's self-test line. The module's credential file is
// redirected into the scratch folder (HOME / XDG_CONFIG_HOME / LOCALAPPDATA), so this computer's own file is never read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { startMockPublikServer, STANDIN_APP_TOKEN } from '../../../packages/ai-engine/src/mock/publik-server.ts';
import { APP_VERSION } from '../src/version.ts';
import { MAIN, childEnv, cleanup, raw, scratchHome, spawnServer, stopServer, waitExit } from './helpers.ts';

/** The publik folder the module uses, redirected into `dir` on every system. */
function publikHome(dir: string): Record<string, string> {
  const fake = join(dir, 'fake-home');
  mkdirSync(fake, { recursive: true });
  return { HOME: fake, XDG_CONFIG_HOME: join(fake, '.config'), LOCALAPPDATA: join(fake, 'AppData', 'Local'), USERPROFILE: fake };
}
function credentialFile(dir: string): string {
  const fake = join(dir, 'fake-home');
  if (process.platform === 'darwin') return join(fake, 'Library', 'Application Support', 'publik', 'apps', 'jobleft.json');
  if (process.platform === 'win32') return join(fake, 'AppData', 'Local', 'publik', 'apps', 'jobleft.json');
  return join(fake, '.config', 'publik', 'apps', 'jobleft.json');
}

/** A listener that keeps every usage count it gets and answers like publik (204). */
async function usageListener(): Promise<{ url: string; seen: Array<{ headers: Record<string, unknown>; body: any }>; close(): Promise<void> }> {
  const seen: Array<{ headers: Record<string, unknown>; body: any }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { seen.push({ headers: req.headers, body: JSON.parse(body || '{}') }); res.statusCode = 204; res.end(); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/api/v1/telemetry`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('the gate holds the UI and the API until the person signed in, then the usage count goes out once', async () => {
  const pub = await startMockPublikServer({ balanceUsd: 0, log: null });
  const usage = await usageListener();
  const home = scratchHome('gate');
  const env = {
    ...publikHome(home),
    JOBLEFT_PUBLIK_ALLOW_LIVE: '1', PUBLIK_APP_TOKEN: STANDIN_APP_TOKEN, PUBLIK_ORIGIN: `http://127.0.0.1:${pub.port}`,
    JOBLEFT_PUBLIK_BASE_URL: pub.baseUrl, PUBLIK_TELEMETRY_URL: usage.url, DO_NOT_TRACK: '', PUBLIK_TELEMETRY: '',
  };
  const s = spawnServer(home, env);
  try {
    const { port } = await s.ready;
    const h = { 'x-jobleft-token': s.token, 'content-type': 'application/json' };
    // Health answers (the shell waits for it); the UI is the gate page; the API waits.
    const page = await raw(port, { path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.text, /Sign in with publik/);
    assert.match(page.text, /publik-gate\.js/);
    assert.equal((await raw(port, { path: '/publik-gate.js' })).status, 200);
    const held = await raw(port, { path: '/api/v1/publik', headers: h });
    assert.equal(held.status, 503, held.text);
    assert.equal(held.json.error.code, 'not_ready');
    assert.match(held.json.error.message, /Sign in with publik first/);
    assert.equal((await raw(port, { path: '/publik-gate' })).status, 401, 'the gate state needs the launch token');
    // The module made this computer's install and shows Sign in with publik.
    let state: any = null;
    for (let i = 0; i < 100 && state?.screen?.id !== 'sign_in'; i++) { await sleep(100); state = (await raw(port, { path: '/publik-gate', headers: h })).json; }
    assert.equal(state.pending, true);
    assert.equal(state.screen.id, 'sign_in');
    assert.equal(state.screen.title, 'Sign in with publik');
    assert.deepEqual(state.screen.buttons, [{ action: 'sign_in', label: 'Sign in with publik' }]);
    assert.ok(existsSync(credentialFile(home)), 'the credential file is in the redirected publik folder');
    assert.equal(usage.seen.length, 0, 'no usage count before the sign-in');
    // The person signs in in the browser: the gate sees it on its own (it reads the wallet every 3 s).
    await fetch(`http://127.0.0.1:${pub.port}/__admin/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    for (let i = 0; i < 100 && state?.screen?.id !== 'choose'; i++) { await sleep(100); state = (await raw(port, { path: '/publik-gate', headers: h })).json; }
    assert.equal(state.screen.id, 'choose', JSON.stringify(state));
    assert.equal(state.screen.title, 'Choose how to pay for AI', 'no plan and no balance');
    assert.ok(state.screen.buttons.some((b: { action: string }) => b.action === 'own_key'));
    // A press that is not one of the screen's buttons does nothing.
    const wrong = await raw(port, { method: 'POST', path: '/publik-gate', headers: h, body: JSON.stringify({ action: 'retry' }) });
    assert.equal(wrong.status, 200);
    assert.equal(wrong.json.pressed, false);
    assert.equal(wrong.json.pending, true);
    // "Use my own key": the gate passes, the UI is served, the API answers, one usage count went out with the key.
    const pressed = await raw(port, { method: 'POST', path: '/publik-gate', headers: h, body: JSON.stringify({ action: 'own_key' }) });
    assert.equal(pressed.json.pressed, true);
    for (let i = 0; i < 50 && state?.pending; i++) { await sleep(100); state = (await raw(port, { path: '/publik-gate', headers: h })).json; }
    assert.equal(state.pending, false);
    assert.equal(state.screen, null);
    const ui = await raw(port, { path: '/' });
    assert.equal(ui.status, 200);
    assert.doesNotMatch(ui.text, /publik-gate\.js/);
    assert.equal((await raw(port, { path: '/api/v1/publik', headers: h })).status, 200);
    const cred = JSON.parse(readFileSync(credentialFile(home), 'utf8'));
    assert.equal(cred.choice, 'own_key');
    assert.match(cred.key, /^pk_test_/);
    for (let i = 0; i < 50 && usage.seen.length === 0; i++) await sleep(100);
    assert.equal(usage.seen.length, 1, 'exactly one app_opened');
    assert.equal(usage.seen[0]!.body.event, 'app_opened');
    assert.equal(usage.seen[0]!.body.app, 'jobleft');
    assert.equal(usage.seen[0]!.body.app_version, APP_VERSION);
    assert.equal(usage.seen[0]!.headers.authorization, `Bearer ${cred.key}`, 'a signed-in computer is counted once');
    // The publik card: "use my own key" reads as disconnected; Connect = pay with the plan (no new install).
    assert.equal((await raw(port, { path: '/api/v1/publik', headers: h })).json.state, 'disconnected');
    const c = await raw(port, { method: 'POST', path: '/api/v1/publik/connect', headers: h, body: JSON.stringify({ disclosureAccepted: true, disclosureVersion: 1 }) });
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.state, 'connected');
    assert.equal(c.json.wallet.claimState, 'claimed');
    assert.equal(pub.state().keys, 1, 'one install for this computer');
    assert.equal(JSON.parse(readFileSync(credentialFile(home), 'utf8')).choice, 'publik');
    await stopServer(s.child, port, s.token);
  } finally {
    if (s.child.exitCode === null) { s.child.kill('SIGKILL'); await waitExit(s.child, 5000); }
    await pub.close();
    await usage.close();
    cleanup(home);
  }
});

test('a second start with the stored answer passes the gate with no click; a stored "publik" answer connects', async () => {
  const pub = await startMockPublikServer({ balanceUsd: 3, log: null });
  await fetch(`http://127.0.0.1:${pub.port}/__admin/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const home = scratchHome('gate2');
  const env = {
    ...publikHome(home),
    JOBLEFT_PUBLIK_ALLOW_LIVE: '1', PUBLIK_APP_TOKEN: STANDIN_APP_TOKEN, PUBLIK_ORIGIN: `http://127.0.0.1:${pub.port}`,
    JOBLEFT_PUBLIK_BASE_URL: pub.baseUrl, DO_NOT_TRACK: '1',
  };
  // First start: signed in already (claimed), the plan screen: Connect your plan.
  const a = spawnServer(home, env);
  try {
    const { port } = await a.ready;
    const h = { 'x-jobleft-token': a.token, 'content-type': 'application/json' };
    let state: any = null;
    for (let i = 0; i < 100 && state?.screen?.id !== 'choose'; i++) { await sleep(100); state = (await raw(port, { path: '/publik-gate', headers: h })).json; }
    assert.equal(state.screen.title, 'Connect your plan', JSON.stringify(state.screen));
    assert.match(state.screen.body, /Your balance: \$3\.00/);
    await raw(port, { method: 'POST', path: '/publik-gate', headers: h, body: JSON.stringify({ action: 'connect' }) });
    for (let i = 0; i < 50 && state?.pending; i++) { await sleep(100); state = (await raw(port, { path: '/publik-gate', headers: h })).json; }
    assert.equal(state.pending, false);
    const p = await raw(port, { path: '/api/v1/publik', headers: h });
    assert.equal(p.json.state, 'connected', 'Connect your plan = the publik plan pays for AI, with no other click');
    assert.equal(p.json.wallet.balanceMicros, 3_000_000);
    await stopServer(a.child, port, a.token);
  } finally { if (a.child.exitCode === null) { a.child.kill('SIGKILL'); await waitExit(a.child, 5000); } }
  // Second start: nothing to ask; the UI is there at once, still connected, still one install.
  const b = spawnServer(home, env);
  try {
    const { port } = await b.ready;
    const h = { 'x-jobleft-token': b.token, 'content-type': 'application/json' };
    let state: any = null;
    for (let i = 0; i < 100 && state?.pending !== false; i++) { await sleep(100); state = (await raw(port, { path: '/publik-gate', headers: h })).json; }
    assert.equal(state.pending, false);
    assert.doesNotMatch((await raw(port, { path: '/' })).text, /publik-gate\.js/);
    assert.equal((await raw(port, { path: '/api/v1/publik', headers: h })).json.state, 'connected');
    assert.equal(pub.state().keys, 1);
    await stopServer(b.child, port, b.token);
  } finally {
    if (b.child.exitCode === null) { b.child.kill('SIGKILL'); await waitExit(b.child, 5000); }
    await pub.close();
    cleanup(home);
  }
});

test('PUBLIK_SELF_TEST=1 prints the one line after a real GET /wallet and exits; a server from source has no gate', async () => {
  const pub = await startMockPublikServer({ balanceUsd: 0, log: null });
  const home = scratchHome('selftest');
  try {
    const run = (extra: Record<string, string>) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [MAIN], { env: childEnv({ ...publikHome(home), JOBLEFT_HOME: home, JOBLEFT_SECRET_STORE: 'memory', JOBLEFT_QUIET: '1', ...extra }), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout!.on('data', (d) => { out += d; });
      child.stderr!.on('data', (d) => { err += d; });
      child.on('exit', (code) => resolve({ code, out, err }));
    });
    const ok = await run({ PUBLIK_SELF_TEST: '1', PUBLIK_ORIGIN: `http://127.0.0.1:${pub.port}`, JOBLEFT_PUBLIK_APP_TOKEN: STANDIN_APP_TOKEN });
    assert.equal(ok.out, `publik self-test: ok jobleft ${APP_VERSION}\n`, ok.err);
    assert.equal(ok.code, 0);
    assert.ok(!existsSync(join(home, 'run')), 'the self-test touches no data folder');
    assert.equal(pub.state().keys, 1, 'POST /installs then GET /wallet, for real');
    const down = await run({ PUBLIK_SELF_TEST: '1', PUBLIK_ORIGIN: 'http://127.0.0.1:9', JOBLEFT_PUBLIK_APP_TOKEN: STANDIN_APP_TOKEN });
    assert.match(down.out, /^publik self-test: failed: publik is not reachable\. Check your connection\.\n$/);
    assert.equal(down.code, 1);
  } finally { await pub.close(); cleanup(home); }

  // No app token, no JOBLEFT_PUBLIK_ALLOW_LIVE (a server started from source): no gate, the UI and the API at once.
  const home2 = scratchHome('nogate');
  const s = spawnServer(home2, publikHome(home2));
  try {
    const { port } = await s.ready;
    assert.doesNotMatch((await raw(port, { path: '/' })).text, /publik-gate\.js/);
    assert.equal((await raw(port, { path: '/publik-gate', headers: { 'x-jobleft-token': s.token } })).status, 404);
    assert.equal((await raw(port, { path: '/api/v1/publik', headers: { 'x-jobleft-token': s.token } })).status, 200);
    await stopServer(s.child, port, s.token);
  } finally {
    if (s.child.exitCode === null) { s.child.kill('SIGKILL'); await waitExit(s.child, 5000); }
    cleanup(home2);
  }
});
