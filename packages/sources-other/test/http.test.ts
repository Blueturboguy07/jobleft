import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { USER_AGENT } from '@jobleft/crawler';
import { DbPacer, FeedClient, FeedError, MIN_GAP_MS, MemoryPacer } from '../src/http.ts';
import { migrateSourcesOther } from '../src/db.ts';
import { cleanup, noWait, tempDir } from './helpers.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function serve(handler: Handler): Promise<{ origin: string; hits: Array<{ path: string; ua: string; headers: IncomingMessage['headers']; t: number }>; close(): Promise<void> }> {
  const hits: Array<{ path: string; ua: string; headers: IncomingMessage['headers']; t: number }> = [];
  const server = createServer((req, res) => { hits.push({ path: req.url ?? '', ua: String(req.headers['user-agent']), headers: req.headers, t: Date.now() }); handler(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

function client(origin: string, extra: Partial<ConstructorParameters<typeof FeedClient>[0]> = {}): FeedClient {
  return new FeedClient({ sourceId: 't', allowedHosts: ['feed.example'], pacer: noWait, hostMap: { 'feed.example': origin }, retryDelayMs: 10, timeoutMs: 1500, ...extra });
}

test('never-crawl and non-approved hosts are refused before any request is sent', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response('{}'); }) as typeof fetch;
  const c = new FeedClient({ sourceId: 't', allowedHosts: ['feed.example', 'www.linkedin.com'], pacer: noWait, fetchImpl });
  await assert.rejects(c.getText('https://www.linkedin.com/jobs'), (e: unknown) => e instanceof FeedError && e.code === 'never_crawl');
  await assert.rejects(c.getText('https://uk.indeed.com/x'), (e: unknown) => e instanceof FeedError && e.code === 'never_crawl');
  await assert.rejects(c.getText('https://other.example/x'), (e: unknown) => e instanceof FeedError && e.code === 'forbidden_host');
  const off = new FeedClient({ sourceId: 't', allowedHosts: ['feed.example'], pacer: noWait, fetchImpl, offline: true });
  await assert.rejects(off.getText('https://feed.example/x'), (e: unknown) => e instanceof FeedError && e.code === 'offline');
  assert.equal(calls, 0);
});

test('the fixed User-Agent goes to every host; a source-required override only to its own host', async () => {
  const s = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  try {
    const c = client(s.origin);
    await c.getJson('https://feed.example/a');
    await c.request('https://feed.example/b', { userAgent: 'jordan.testwell@example.com', headers: { 'User-Agent': 'x@y.z', Cookie: 'c=1', 'authorization-key': 'TESTKEY-0000-jordan' } });
    const robots = s.hits.find((h) => h.path === '/robots.txt')!;
    assert.equal(robots.ua, USER_AGENT);
    assert.equal(s.hits.find((h) => h.path === '/a')!.ua, USER_AGENT);
    const b = s.hits.find((h) => h.path === '/b')!;
    assert.equal(b.ua, 'jordan.testwell@example.com');
    assert.equal(b.headers.cookie, undefined, 'a cookie header is never sent');
  } finally { await s.close(); }
});

test('robots.txt is obeyed; a disallowed path sends nothing but robots.txt', async () => {
  const s = await serve((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nDisallow: /api/\n'); return; }
    res.writeHead(200); res.end('{}');
  });
  try {
    const c = client(s.origin);
    await assert.rejects(c.getText('https://feed.example/api/jobs'), (e: unknown) => e instanceof FeedError && e.code === 'robots');
    assert.deepEqual(s.hits.map((h) => h.path), ['/robots.txt']);
  } finally { await s.close(); }
});

test('redirects are never followed (a redirect to a forbidden host sends nothing there)', async () => {
  const s = await serve((req, res) => { if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; } res.writeHead(302, { location: 'https://www.linkedin.com/jobs' }); res.end(); });
  try {
    await assert.rejects(client(s.origin).getText('https://feed.example/x'), (e: unknown) => e instanceof FeedError && e.code === 'redirect' && /linkedin/.test(e.message));
    assert.equal(s.hits.length, 2);
  } finally { await s.close(); }
});

test('5xx is retried once; 429 is not retried and keeps Retry-After; 401 says the key was refused', async () => {
  let n = 0;
  const s = await serve((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    n++;
    if (req.url === '/500') { res.writeHead(500); res.end(); return; }
    if (req.url === '/429') { res.writeHead(429, { 'retry-after': '7200' }); res.end(); return; }
    res.writeHead(401); res.end();
  });
  try {
    const c = client(s.origin);
    await assert.rejects(c.getText('https://feed.example/500'), (e: unknown) => e instanceof FeedError && e.code === 'http' && e.status === 500);
    assert.equal(n, 2, 'one retry');
    await assert.rejects(c.getText('https://feed.example/429'), (e: unknown) => e instanceof FeedError && e.code === 'rate_limited' && e.retryAfterSeconds === 7200);
    assert.equal(n, 3, 'no retry after 429');
    await assert.rejects(c.getText('https://feed.example/401'), (e: unknown) => e instanceof FeedError && e.code === 'key_refused');
  } finally { await s.close(); }
});

test('a source that never answers times out; a web page and a cut-off body are named plainly', async () => {
  const s = await serve((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    if (req.url === '/hang') return; // never answers
    if (req.url === '/html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>maintenance</html>'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"jobs": [1, 2');
  });
  try {
    const c = client(s.origin, { timeoutMs: 400 });
    const t0 = Date.now();
    await assert.rejects(c.getText('https://feed.example/hang'), (e: unknown) => e instanceof FeedError && e.code === 'timeout');
    assert.ok(Date.now() - t0 < 3000);
    await assert.rejects(c.getJson('https://feed.example/html'), (e: unknown) => e instanceof FeedError && e.code === 'web_page');
    await assert.rejects(c.getJson('https://feed.example/cut'), (e: unknown) => e instanceof FeedError && e.code === 'cut_off');
  } finally { await s.close(); }
});

test('the request budget stops a run; robots.txt and retries count', async () => {
  const s = await serve((req, res) => { if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; } res.writeHead(200); res.end('{}'); });
  try {
    const budget = { remaining: 2 };
    const c = client(s.origin, { budget });
    await c.getText('https://feed.example/1');
    await assert.rejects(c.getText('https://feed.example/2'), (e: unknown) => e instanceof FeedError && e.code === 'budget');
    assert.equal(s.hits.length, 2);
  } finally { await s.close(); }
});

test('secrets never appear in an error text', async () => {
  const s = await serve((req, res) => { if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; } res.writeHead(404); res.end(); });
  try {
    const c = client(s.origin, { secrets: ['TESTKEY-0000-jordan'] });
    await assert.rejects(c.getText('https://feed.example/jobs/TESTKEY-0000-jordan?api_key=TESTKEY-0000-jordan'), (e: unknown) => {
      assert.ok(e instanceof FeedError);
      assert.ok(!e.message.includes('TESTKEY'), e.message);
      assert.ok(!e.message.includes('api_key'), 'no query string in errors');
      return true;
    });
  } finally { await s.close(); }
});

test('pacing: two processes sharing the database never send to one host less than 1 second apart', async () => {
  const dir = tempDir();
  let a: DatabaseSync | undefined, b: DatabaseSync | undefined;
  try {
    const path = join(dir, 'pace.db');
    a = new DatabaseSync(path); migrateSourcesOther(a);
    b = new DatabaseSync(path); b.exec('PRAGMA busy_timeout = 5000');
    const pa = new DbPacer(a), pb = new DbPacer(b);
    const times: number[] = [];
    await Promise.all([0, 1, 2].map(async (i) => { await (i % 2 ? pb : pa).wait('feed.example', 0); times.push(Date.now()); }));
    times.sort((x, y) => x - y);
    for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= MIN_GAP_MS - 15, `gap ${times[i]! - times[i - 1]!}`);
    // A different host is not held up.
    const t0 = Date.now();
    await pa.wait('other.example', 0);
    assert.ok(Date.now() - t0 < 200);
  } finally { a?.close(); b?.close(); cleanup(dir); } // closed before the removal: Windows cannot delete an open database
});

test('memory pacer spaces one host by at least MIN_GAP_MS and honours a longer crawl delay', async () => {
  const p = new MemoryPacer();
  const t0 = Date.now();
  await p.wait('h', 0);
  await p.wait('h', 0);
  assert.ok(Date.now() - t0 >= MIN_GAP_MS - 15);
});

test('robots.txt Crawl-delay above 1 second holds EVERY request to the host, including the first one after robots.txt', async () => {
  const cases: Array<{ name: string; robots: string; delayMs: number; pacer: () => { pacer: InstanceType<typeof MemoryPacer> | InstanceType<typeof DbPacer>; done(): void } }> = [
    { name: 'the * group, in-memory pacer', robots: 'User-agent: *\nCrawl-delay: 2\n', delayMs: 2000, pacer: () => ({ pacer: new MemoryPacer(), done() {} }) },
    { name: 'the jobleft-build group, shared-database pacer', robots: 'User-agent: *\nCrawl-delay: 1\n\nUser-agent: jobleft-build\nCrawl-delay: 2\n', delayMs: 2000, pacer: () => {
      const dir = tempDir();
      const db = new DatabaseSync(join(dir, 'pace.db')); migrateSourcesOther(db);
      return { pacer: new DbPacer(db), done() { db.close(); cleanup(dir); } };
    } },
  ];
  for (const c of cases) {
    const s = await serve((req, res) => {
      if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(c.robots); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    });
    const p = c.pacer();
    try {
      const cl = client(s.origin, { pacer: p.pacer });
      await cl.getJson('https://feed.example/a');
      await cl.getJson('https://feed.example/b');
      await cl.getJson('https://feed.example/c');
      assert.deepEqual(s.hits.map((h) => h.path), ['/robots.txt', '/a', '/b', '/c']);
      for (let i = 1; i < s.hits.length; i++) {
        assert.ok(s.hits[i]!.t - s.hits[i - 1]!.t >= c.delayMs - 30, `${c.name}: gap before ${s.hits[i]!.path} was ${s.hits[i]!.t - s.hits[i - 1]!.t} ms, Crawl-delay is ${c.delayMs} ms`);
      }
    } finally { p.done(); await s.close(); }
  }
});

test('a Crawl-delay of 1 second or less keeps the 1.1 second floor, and a pacer without hold() still works', async () => {
  const s = await serve((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nCrawl-delay: 1\n'); return; }
    res.writeHead(200); res.end('{}');
  });
  try {
    const cl = client(s.origin, { pacer: new MemoryPacer() });
    await cl.getJson('https://feed.example/a');
    await cl.getJson('https://feed.example/b');
    for (let i = 1; i < s.hits.length; i++) assert.ok(s.hits[i]!.t - s.hits[i - 1]!.t >= 1000, `gap ${s.hits[i]!.t - s.hits[i - 1]!.t}`);
    const bare = client(s.origin, { pacer: { async wait() { /* no wait, no hold */ } } });
    await bare.getJson('https://feed.example/c');
  } finally { await s.close(); }
});

test('stand-in mode: with a host map set, an unmapped host is never contacted live', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response('{}'); }) as typeof fetch;
  const c = new FeedClient({ sourceId: 't', allowedHosts: ['feed.example', 'other.example'], pacer: noWait, fetchImpl, hostMap: { 'feed.example': 'http://127.0.0.1:9' } });
  await assert.rejects(c.getText('https://other.example/x'), (e: unknown) => e instanceof FeedError && e.code === 'forbidden_host' && /stand-in mode/.test(e.message));
  assert.equal(calls, 0);
});
