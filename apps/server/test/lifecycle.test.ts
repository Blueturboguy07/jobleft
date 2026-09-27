// Server O9, O11, O12: one server per data folder, a free port, clean stops, a server that follows its parent, and
// upgrades that keep data or refuse without touching it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { CLI, MAIN, childEnv, cleanup, raw, scratchHome, spawnServer, stopServer, waitExit } from './helpers.ts';

function hashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)) out[f] = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
  return out;
}

test('--help, --version and a wrong argument start nothing and touch no data folder; --home picks the folder', async () => {
  const home = scratchHome('args');
  const target = join(home, 'never-made');
  const env = childEnv({ JOBLEFT_HOME: target });
  const run = (args: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn(process.execPath, [MAIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (code) => resolve({ code, out }));
  });
  assert.deepEqual([(await run(['--help'])).code], [0]);
  assert.match((await run(['--version'])).out, /^jobleft server \d/);
  for (const bad of [['--bogus'], ['extra'], ['--port', 'abc'], ['--home', '']]) {
    const r = await run(bad);
    assert.equal(r.code, 1, bad.join(' '));
    assert.match(r.out, /usage:/);
    assert.ok(!r.out.includes('    at '), 'no stack trace');
  }
  assert.ok(!existsSync(target), 'no data folder was made');
  // --home wins over JOBLEFT_HOME.
  const chosen = join(home, 'chosen');
  const token = 'args-test-token-args-test-token-args-test-00';
  const c = spawn(process.execPath, [MAIN, '--home', chosen], { env: { ...env, JOBLEFT_LAUNCH_TOKEN: token, JOBLEFT_SECRET_STORE: 'memory', JOBLEFT_QUIET: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 100 && !existsSync(join(chosen, 'run', 'server.json')); i++) await new Promise((r) => setTimeout(r, 50));
  const port = JSON.parse(readFileSync(join(chosen, 'run', 'server.json'), 'utf8')).port as number;
  assert.equal((await raw(port, { path: '/api/v1/storage', headers: { 'x-jobleft-token': token } })).json.dataDir, chosen);
  assert.equal(await stopServer(c, port, token), 0);
  assert.ok(!existsSync(target), 'JOBLEFT_HOME was not used');
  cleanup(home);
});

test('a second server on the same data folder exits, and the first keeps working', async () => {
  const home = scratchHome('single');
  const a = spawnServer(home);
  const info = await a.ready;
  const b = spawnServer(home);
  b.ready.catch(() => { /* expected: it exits */ });
  const code = await waitExit(b.child, 10000);
  assert.equal(code, 3);
  const r = await raw(info.port, { path: '/api/v1/settings', headers: { 'x-jobleft-token': a.token } });
  assert.equal(r.status, 200);
  assert.equal(await stopServer(a.child, info.port, a.token), 0);
  assert.ok(!existsSync(join(home, 'run', 'server.json')), 'run file removed on a clean stop');
  assert.ok(!existsSync(join(home, 'run', 'server.lock')), 'lock removed on a clean stop');
  cleanup(home);
});

test('a lock left by a dead process, or by a reused pid, never blocks the next start', async () => {
  const home = scratchHome('stale');
  mkdirSync(join(home, 'run'), { recursive: true, mode: 0o700 });
  for (const holder of [{ pid: 999_999, procStart: Date.now() - 60_000 }, { pid: process.pid, procStart: 1_000 }]) {
    writeFileSync(join(home, 'run', 'server.lock'), JSON.stringify({ ...holder, lockedAt: new Date().toISOString(), nonce: 'old' }));
    const a = spawnServer(home);
    const info = await a.ready;
    assert.equal(await stopServer(a.child, info.port, a.token), 0);
  }
  cleanup(home);
});

test('a busy port is skipped', async () => {
  const home = scratchHome('port');
  const blocker = createServer();
  const busy = await new Promise<number>((r) => blocker.listen(0, '127.0.0.1', () => r((blocker.address() as { port: number }).port)));
  const a = spawnServer(home, { JOBLEFT_PORT: String(busy) });
  const info = await a.ready;
  assert.notEqual(info.port, busy);
  await stopServer(a.child, info.port, a.token);
  blocker.close();
  cleanup(home);
});

test('the server stops within 10 seconds after its parent is killed', async () => {
  const home = scratchHome('parent');
  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); // a parent that just lives (no /bin/sleep on Windows)
  const a = spawnServer(home, { JOBLEFT_PARENT_PID: String(parent.pid) });
  const info = await a.ready;
  const t0 = Date.now();
  parent.kill('SIGKILL');
  const code = await waitExit(a.child, 12000);
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 10000);
  const r = await raw(info.port, { path: '/api/v1/health' }).catch(() => null);
  assert.equal(r, null, 'the port is closed');
  cleanup(home);
});

test('an older data folder is upgraded with every item kept', async () => {
  const home = scratchHome('upgrade');
  execFileSync(process.execPath, [CLI, 'fixture', '--home', home, '--schema', '1'], { stdio: 'ignore' });
  const before = JSON.parse(execFileSync(process.execPath, [CLI, 'counts', '--home', home]).toString());
  const a = spawnServer(home);
  const info = await a.ready;
  const liked = await raw(info.port, { path: '/api/v1/tracker?view=applied', headers: { 'x-jobleft-token': a.token } });
  assert.equal(liked.json.items[0].entry.notes[0].text, 'Recruiter call went well. 面接 next week 🎉');
  const res = await raw(info.port, { path: '/api/v1/resumes', headers: { 'x-jobleft-token': a.token } });
  const file = readFileSync(join(home, 'files', 'resumes', 'res_0000000000000001.pdf'));
  assert.equal(res.json[0].file.sha256, createHash('sha256').update(file).digest('hex'));
  await stopServer(a.child, info.port, a.token);
  const after = JSON.parse(execFileSync(process.execPath, [CLI, 'counts', '--home', home]).toString());
  assert.deepEqual(after, before);
  cleanup(home);
});

test('a newer data folder is refused and left byte for byte as it was', async () => {
  const home = scratchHome('newer');
  execFileSync(process.execPath, [CLI, 'fixture', '--home', home, '--schema', 'future'], { stdio: 'ignore' });
  const before = hashes(join(home, 'data'));
  const a = spawnServer(home);
  await assert.rejects(a.ready, /newer jobleft/);
  assert.equal(a.child.exitCode, 2);
  assert.deepEqual(hashes(join(home, 'data')), before);
  cleanup(home);
});

test('a read-only data folder at start is refused and left as it was', { skip: process.platform === 'win32' && 'POSIX permissions only' }, async () => {
  const home = scratchHome('rostart');
  execFileSync(process.execPath, [CLI, 'fixture', '--home', home, '--schema', '1'], { stdio: 'ignore' });
  const before = hashes(join(home, 'data'));
  chmodSync(join(home, 'data'), 0o500);
  try {
    const a = spawnServer(home);
    await assert.rejects(a.ready, /read-only/);
    assert.equal(a.child.exitCode, 2);
    assert.deepEqual(hashes(join(home, 'data')), before);
  } finally {
    chmodSync(join(home, 'data'), 0o700);
    cleanup(home);
  }
});

test('a restore and a delete-all right after start leave a server that keeps answering (no stale timer)', async () => {
  const src = scratchHome('swap-src');
  execFileSync(process.execPath, [CLI, 'fixture', '--home', src, '--schema', '1'], { stdio: 'ignore' });
  const s0 = spawnServer(src);
  const i0 = await s0.ready;
  const backup = await raw(i0.port, { method: 'POST', path: '/api/v1/backup', headers: { 'x-jobleft-token': s0.token } });
  assert.equal(backup.status, 200);
  await stopServer(s0.child, i0.port, s0.token);
  cleanup(src);

  const home = scratchHome('swap');
  // The catch-up crawl timer fires 5 s after start; before the fix it read the database that the restore had closed.
  const a = spawnServer(home, { JOBLEFT_HOST_MAP: JSON.stringify({ 'boards-api.greenhouse.io': 'http://127.0.0.1:9' }) });
  const info = await a.ready;
  const h = { 'x-jobleft-token': a.token };
  const r = await raw(info.port, { method: 'POST', path: '/api/v1/restore', headers: { ...h, 'content-type': 'application/zip' }, body: backup.body });
  assert.equal(r.status, 200, r.text);
  await new Promise((res) => setTimeout(res, 6500));
  assert.equal(a.child.exitCode, null, 'the server is still running after the old catch-up timer time');
  const p = await raw(info.port, { path: '/api/v1/profile', headers: h });
  assert.equal(p.json.personal.lastName, 'Testwell');
  const d = await raw(info.port, { method: 'POST', path: '/api/v1/data/delete', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'delete everything' }) });
  assert.equal(d.status, 200, d.text);
  await new Promise((res) => setTimeout(res, 6000));
  assert.equal(a.child.exitCode, null, 'the server is still running after a delete-all');
  assert.equal((await raw(info.port, { path: '/api/v1/health' })).status, 200);
  assert.equal(await stopServer(a.child, info.port, a.token), 0);
  cleanup(home);
});

void createReadStream;
