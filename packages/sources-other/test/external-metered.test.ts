import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { jobFromText, jobFromUrl } from '../src/external.ts';
import { METERED_PRICES_MICROS, MeteredFetchError, createMeteredFetchClient } from '../src/metered.ts';
import { FeedError } from '../src/http.ts';
import type { FeedHttp } from '../src/types.ts';

const page = (body: string): FeedHttp => ({ async getText() { return body; }, async getJson() { return JSON.parse(body); } });

test('jobFromUrl reads JSON-LD JobPosting facts and keeps unknowns unknown', async () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, {
      '@type': 'JobPosting', title: 'Registered Nurse', hiringOrganization: { '@type': 'Organization', name: 'Birchwood Health' },
      description: '<p>Night shifts.</p>', datePosted: '2026-09-20', jobLocation: { address: { addressLocality: 'Austin', addressRegion: 'TX', addressCountry: 'US' } },
      baseSalary: { currency: 'USD', value: { minValue: 38.5, maxValue: 52, unitText: 'HOUR' } }, employmentType: 'FULL_TIME',
    }],
  })}</script></head><body>...</body></html>`;
  const d = await jobFromUrl('https://careers.birchwood.example/jobs/1', page(html));
  assert.equal(d.sourceId, 'external:url');
  assert.equal(d.raw.title, 'Registered Nurse');
  assert.equal(d.raw.company, 'Birchwood Health');
  assert.deepEqual(d.raw.pay, { min: 38.5, max: 52, currency: 'USD', period: 'hour' });
  assert.equal(d.raw.location, 'Austin, TX, US');
  assert.equal(d.raw.postedAt, '2026-09-20T00:00:00.000Z');
  assert.equal(d.raw.employmentType, 'full_time');
  assert.deepEqual(d.warnings, []);
});

test('jobFromUrl refuses never-crawl hosts before any request, and says when a page is not a job', async () => {
  let calls = 0;
  const http: FeedHttp = { async getText() { calls++; return ''; }, async getJson() { calls++; return {}; } };
  await assert.rejects(jobFromUrl('https://www.linkedin.com/jobs/view/1', http), (e: unknown) => e instanceof FeedError && e.code === 'never_crawl');
  await assert.rejects(jobFromUrl('javascript:alert(1)', http), (e: unknown) => e instanceof FeedError);
  assert.equal(calls, 0);
  await assert.rejects(jobFromUrl('https://news.example/article', page('<html><title>Weather</title><body>Sunny today.</body></html>')), /does not look like a job posting/);
});

test('jobFromText keeps the text as text and states what it could not find', () => {
  const d = jobFromText('Senior Nurse\nLocation: Austin, TX\n<script>alert(1)</script> Responsibilities: care', null);
  assert.equal(d.raw.title, 'Senior Nurse');
  assert.equal(d.raw.company, '');
  assert.ok(d.warnings.some((w) => /employer/.test(w)));
  assert.ok(d.warnings.some((w) => /apply link/.test(w)));
  assert.ok(d.raw.descriptionHtml.includes('&lt;script&gt;'), 'pasted markup is escaped, so it stays text');
  assert.equal(d.raw.location, 'Austin, TX');
});

test('metered client: off means no request at all, and the price is stated in dollars (never "credits")', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response('{}'); }) as typeof fetch;
  const m = createMeteredFetchClient({ enabled: () => false, baseUrl: 'http://127.0.0.1:1/api/v1', key: async () => 'k', fetchImpl });
  assert.equal(m.enabled, false);
  await assert.rejects(m.fetchPage('https://example.com', { js: false, maxPriceMicros: 1_000_000 }), (e: unknown) => {
    assert.ok(e instanceof MeteredFetchError && e.code === 'off');
    assert.match(e.message, /\$2\.00 per 1,000/);
    assert.ok(!/credit/i.test(e.message));
    return true;
  });
  await assert.rejects(m.search('nurse jobs', { maxPriceMicros: 1_000_000 }), (e: unknown) => e instanceof MeteredFetchError && e.code === 'off');
  assert.equal(calls, 0);
  assert.deepEqual(m.prices(), { ...METERED_PRICES_MICROS });
});

test('metered client: price cap, never-crawl hosts and a low balance are refused plainly', async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/v1/search') { res.writeHead(402, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'insufficient_balance', message: 'low', link: 'https://publikhq.example/top-up' } })); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: JSON.parse(body).url, html: '<html>ok</html>', cost_micros: 2000 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  try {
    const m = createMeteredFetchClient({ enabled: () => true, baseUrl: base, key: async () => 'publik-test-key' });
    await assert.rejects(m.fetchPage('https://example.com', { js: true, maxPriceMicros: 3000 }), (e: unknown) => e instanceof MeteredFetchError && e.code === 'price_cap');
    await assert.rejects(m.fetchPage('https://www.glassdoor.com/job', { js: false, maxPriceMicros: 5000 }), (e: unknown) => e instanceof MeteredFetchError && e.code === 'forbidden_source');
    assert.deepEqual(hits, []);
    const ok = await m.fetchPage('https://example.com/job', { js: false, maxPriceMicros: 5000 });
    assert.equal(ok.costMicros, 2000);
    await assert.rejects(m.search('nurse', { maxPriceMicros: 10_000 }), (e: unknown) => {
      assert.ok(e instanceof MeteredFetchError && e.code === 'insufficient_balance');
      assert.match(e.message, /balance/);
      assert.ok(!/credit/i.test(e.message));
      assert.equal(e.link, 'https://publikhq.example/top-up');
      return true;
    });
    const none = createMeteredFetchClient({ enabled: () => true, baseUrl: base, key: async () => null });
    await assert.rejects(none.fetchPage('https://example.com', { js: false, maxPriceMicros: 5000 }), (e: unknown) => e instanceof MeteredFetchError && e.code === 'no_key');
  } finally { server.closeAllConnections(); server.close(); }
});
