import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { USER_AGENT } from '@jobleft/crawler';
import { SqlitePacer, createBoardHttp } from '../src/index.ts';
import { startMockHosts } from '../scripts/mock-hosts.ts';

test('two clients with separate pacers on one database still space requests to a host', async () => {
  const mock = await startMockHosts({ boards: { 'greenhouse:acme': { name: 'Acme', jobs: 1 } } });
  const dir = mkdtempSync(join('/private/tmp', 'jl-boards-pacer-'));
  const db = join(dir, 'p.db');
  const p1 = new SqlitePacer(db, 300), p2 = new SqlitePacer(db, 300);
  try {
    const a = createBoardHttp({ pacer: p1, hostMap: mock.hostMap });
    const b = createBoardHttp({ pacer: p2, hostMap: mock.hostMap });
    const url = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true';
    await Promise.all([...Array(4)].flatMap(() => [a.getJson(url), b.getJson(url)]));
    const times = mock.log.filter((e) => e.host === 'boards-api.greenhouse.io').map((e) => e.at).sort((x, y) => x - y);
    for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= 250, `gap ${times[i]! - times[i - 1]!} ms`);
    for (const e of mock.log) assert.equal(e.headers['user-agent'], USER_AGENT);
  } finally { p1.close(); p2.close(); await mock.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a host that answers 429 with Retry-After gets no request before that time; robots.txt blocks a path', async () => {
  const mock = await startMockHosts({
    boards: { 'greenhouse:busy': { name: 'Busy', jobs: 1, script: ['429:2', 'ok'] } },
    robots: { 'careers.mock.example': 'User-agent: *\nDisallow: /private' },
    pages: { '/private/jobs.html': '<a href="https://boards.greenhouse.io/x">x</a>' },
  });
  const dir = mkdtempSync(join('/private/tmp', 'jl-boards-pacer-'));
  const pacer = new SqlitePacer(join(dir, 'p.db'), 100);
  try {
    const http = createBoardHttp({ pacer, hostMap: mock.hostMap });
    await assert.rejects(http.getJson('https://boards-api.greenhouse.io/v1/boards/busy/jobs'));
    const http2 = createBoardHttp({ pacer, hostMap: mock.hostMap }); // a new client: same shared schedule
    await http2.getJson('https://boards-api.greenhouse.io/v1/boards/busy/jobs');
    const t = mock.log.filter((e) => e.path.startsWith('/v1/boards/busy')).map((e) => e.at);
    assert.equal(t.length, 2);
    assert.ok(t[1]! - t[0]! >= 1900, `waited ${t[1]! - t[0]!} ms after Retry-After: 2`);
    await assert.rejects(http.getText('https://careers.mock.example/private/jobs.html'), /robots/);
    assert.equal(mock.log.filter((e) => e.path.startsWith('/private')).length, 0, 'the blocked path got no request');
  } finally { pacer.close(); await mock.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a reply larger than the cap is refused without reading it all', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); // no content-length: a stream
    let n = 0;
    const tick = () => { if (n++ > 400 || res.destroyed) { res.end(); return; } res.write('x'.repeat(64 * 1024), tick); };
    tick();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { BusyPacer } = await import('../src/index.ts');
  try {
    const port = (server.address() as import('node:net').AddressInfo).port;
    const http = createBoardHttp({ pacer: new BusyPacer(0), maxBodyBytes: 1024 * 1024, retries: 0 });
    await assert.rejects(http.getText(`http://127.0.0.1:${port}/big.html`, 'text/html'));
  } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});

test('robots.txt is read once for several clients sharing one database, and its rules still apply', async () => {
  const mock = await startMockHosts({
    boards: { 'greenhouse:acme': { name: 'Acme', jobs: 1 } },
    robots: { 'boards-api.greenhouse.io': 'User-agent: *\nDisallow: /v1/boards/secret' },
  });
  const dir = mkdtempSync(join('/private/tmp', 'jl-boards-pacer-'));
  const pacer = new SqlitePacer(join(dir, 'p.db'), 50);
  try {
    for (let i = 0; i < 3; i++) {
      const http = createBoardHttp({ pacer, hostMap: mock.hostMap });
      await http.getJson('https://boards-api.greenhouse.io/v1/boards/acme/jobs');
      await assert.rejects(http.getJson('https://boards-api.greenhouse.io/v1/boards/secret/jobs'), /robots/);
    }
    assert.equal(mock.log.filter((e) => e.path === '/robots.txt').length, 1);
    assert.equal(mock.log.filter((e) => e.path.includes('secret')).length, 0);
  } finally { pacer.close(); await mock.close(); rmSync(dir, { recursive: true, force: true }); }
});
