import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { StoreService } from '../src/service.ts';
import { serve } from '../src/serve.ts';
import { job, NOW } from './helpers.ts';

function call(port: number, method: string, path: string, opts: { token?: string; body?: unknown; host?: string; origin?: string; type?: string } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}` };
    if (opts.token) headers['x-jobleft-token'] = opts.token;
    if (opts.origin) headers.origin = opts.origin;
    if (data !== undefined) headers['content-type'] = opts.type ?? 'application/json';
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { let b: unknown = s; try { b = JSON.parse(s); } catch { /* text */ } resolve({ status: res.statusCode ?? 0, body: b }); });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

test('the loopback server: routes work with the token; foreign hosts, origins, missing tokens and form posts are refused', async () => {
  const home = mkdtempSync('/private/tmp/jobleft-serve-test-');
  const svc = new StoreService(home, { offline: true });
  svc.jobs.upsertJobs([job({ id: 's:1', title: 'Payroll Specialist' }), job({ id: 's:2', title: 'Nurse' })], { now: NOW });
  const srv = await serve(svc, { port: 0, token: 'test-token-123', download: false, quiet: true });
  const p = srv.port;
  const t = 'test-token-123';
  try {
    assert.equal((await call(p, 'GET', '/api/v1/health')).status, 200);
    assert.equal((await call(p, 'POST', '/api/v1/jobs/search', { body: { sort: 'recommended' } })).status, 401);
    assert.equal((await call(p, 'POST', '/api/v1/jobs/search', { token: 'wrong', body: { sort: 'recommended' } })).status, 401);
    assert.equal((await call(p, 'GET', '/api/v1/storage', { token: t, host: `127.0.0.1.evil.example:${p}` })).status, 403);
    assert.equal((await call(p, 'GET', '/api/v1/storage', { token: t, origin: 'https://evil.example' })).status, 403);
    assert.equal((await call(p, 'GET', '/api/v1/storage', { token: t, origin: 'null' })).status, 403);
    assert.equal((await call(p, 'POST', '/api/v1/jobs/search', { token: t, body: 'sort=recommended', type: 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await call(p, 'POST', '/api/v1/jobs/search', { token: t, body: { sort: 'sideways' } })).status, 400);
    const r = await call(p, 'POST', '/api/v1/jobs/search', { token: t, body: { sort: 'recommended', q: 'payroll' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 1);
    assert.equal(r.body.items[0].job.id, 's:1');
    const fit = await call(p, 'POST', '/api/v1/jobs/search', { token: t, body: { sort: 'top_matched' } });
    assert.equal(fit.status, 409);
    assert.equal(fit.body.error.code, 'needs_profile');
    const got = await call(p, 'GET', '/api/v1/jobs/s%3A1', { token: t });
    assert.equal(got.status, 200);
    assert.equal(got.body.job.title, 'Payroll Specialist');
    assert.equal((await call(p, 'GET', '/api/v1/jobs/nope', { token: t })).status, 404);
    const tr = await call(p, 'PATCH', '/api/v1/tracker/s%3A2', { token: t, body: { hidden: true } });
    assert.equal(tr.status, 200);
    assert.equal((await call(p, 'POST', '/api/v1/jobs/search', { token: t, body: { sort: 'most_recent' } })).body.total, 1);
    const f = await call(p, 'POST', '/api/v1/filters', { token: t, body: { name: 'Remote', filter: { workModels: ['remote'] }, sort: 'most_recent' } });
    assert.equal(f.status, 200);
    assert.equal((await call(p, 'GET', '/api/v1/filters', { token: t })).body.length, 1);
    assert.equal((await call(p, 'DELETE', `/api/v1/filters/${f.body.id}`, { token: t })).status, 200);
    const st = await call(p, 'GET', '/api/v1/index/status', { token: t });
    assert.equal(st.status, 200);
    assert.equal(st.body.state, 'model_missing');
    const list = await call(p, 'GET', '/api/v1/jobs?q=nurse&sort=recommended', { token: t });
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 0, 'the hidden job stays out of the simple list too');
    assert.equal((await call(p, 'GET', '/api/v1/jobs?token=abc', { token: t })).status, 401);
  } finally {
    await srv.close();
    rmSync(home, { recursive: true, force: true });
  }
});
