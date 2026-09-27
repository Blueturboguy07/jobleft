import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { openBoardsApp } from '../src/app.ts';
import { startDevServer } from '../src/server.ts';
import { startMockHosts } from '../scripts/mock-hosts.ts';
import { tmpdir } from 'node:os';
// Scratch folders: /private/tmp on macOS (short paths, no symlink games), the system temp folder elsewhere (Windows).
const TMP = process.platform === 'darwin' ? '/private/tmp' : tmpdir();

function call(port: number, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    const req = request({ host: '127.0.0.1', port, method, path, headers: {
      ...(opts.token ? { 'x-jobleft-token': opts.token } : {}),
      ...(data !== undefined && typeof opts.body !== 'string' ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    } }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => { text += c.toString(); });
      res.on('end', () => { let json: any = null; try { json = JSON.parse(text); } catch { /* ndjson */ } resolve({ status: res.statusCode ?? 0, json, text }); });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

test('the development server keeps the local API rules and serves the board routes', async () => {
  const mock = await startMockHosts({ boards: { 'greenhouse:acme': { name: 'Acme', jobs: 2 } } });
  const home = mkdtempSync(join(TMP, 'jl-srv-'));
  const app = openBoardsApp({ env: { JOBLEFT_HOME: home, JOBLEFT_HOST_MAP: JSON.stringify(mock.hostMap), JOBLEFT_BOARD_DIRECTORY: 'none' } });
  const srv = await startDevServer(app, { token: 't0ken' });
  const p = srv.port;
  try {
    assert.equal((await call(p, 'GET', '/api/v1/boards')).status, 401);
    assert.equal((await call(p, 'GET', '/api/v1/boards?token=t0ken')).status, 401);
    assert.equal((await call(p, 'GET', '/api/v1/boards', { token: 't0ken', headers: { host: 'evil.example' } })).status, 403);
    assert.equal((await call(p, 'GET', '/api/v1/boards', { token: 't0ken', headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call(p, 'POST', '/api/v1/boards/resolve', { token: 't0ken', body: 'url=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
    assert.equal((await call(p, 'POST', '/api/v1/boards/resolve', { token: 't0ken', body: { nope: 1 } })).status, 400);
    const r = await call(p, 'POST', '/api/v1/boards/resolve', { token: 't0ken', body: { url: 'https://boards.greenhouse.io/acme' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.candidates[0].company, 'Acme');
    assert.equal((await call(p, 'GET', '/api/v1/boards', { token: 't0ken' })).json.total, 0, 'resolve added nothing');
    assert.equal((await call(p, 'POST', '/api/v1/boards', { token: 't0ken', body: { ats: 'greenhouse', board: 'acme' } })).status, 200);
    const again = await call(p, 'POST', '/api/v1/boards', { token: 't0ken', body: { ats: 'greenhouse', board: 'ACME' } });
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, 'conflict');
    const missing = await call(p, 'POST', '/api/v1/boards', { token: 't0ken', body: { ats: 'greenhouse', board: 'nosuchboard' } });
    assert.equal(missing.status, 404);
    assert.equal((await call(p, 'PATCH', '/api/v1/boards/greenhouse:acme', { token: 't0ken', body: { followed: false } })).json.followed, false);
    assert.equal((await call(p, 'PATCH', '/api/v1/boards/greenhouse:nope', { token: 't0ken', body: { hidden: true } })).status, 404);
    assert.equal((await call(p, 'POST', '/api/v1/crawl/run', { token: 't0ken', body: {} })).json.started, true);
    for (let i = 0; i < 50 && (await call(p, 'GET', '/api/v1/crawl/status', { token: 't0ken' })).json.running; i++) await new Promise((res) => setTimeout(res, 100));
    const rep = await call(p, 'GET', '/api/v1/crawl/report', { token: 't0ken' });
    assert.equal(rep.json.boards[0].status, 'ok');
    const exp = await call(p, 'GET', '/api/v1/boards/export', { token: 't0ken' });
    assert.equal(exp.text.trim().split('\n').length, 1);
    assert.equal((await call(p, 'GET', '/api/v1/jobs', { token: 't0ken' })).status, 404, 'only board routes are served here');
  } finally { await srv.close(); app.close(); await mock.close(); rmSync(home, { recursive: true, force: true }); }
});
