// Web search through the person's own SearXNG: the address check, the searches sent, how results are sorted, and
// that no result page is opened. A loopback stand-in plays SearXNG.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { looksLikeJobList, looksLikeJobPage, normalizeSearxUrl, planQueries } from '../src/interim/websearch.ts';
import { cleanup, startTest } from './helpers.ts';

interface StandIn { origin: string; queries: URLSearchParams[]; close: () => Promise<void>; answer: (q: URLSearchParams) => { status?: number; body?: unknown } }

/** A SearXNG stand-in. `answer` gets the query and gives the status and JSON body. */
async function searx(answer: (q: URLSearchParams) => { status?: number; body?: unknown }): Promise<StandIn> {
  const queries: URLSearchParams[] = [];
  const me = {} as StandIn;
  me.answer = answer;
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname !== '/search') { res.writeHead(404).end(); return; }
    queries.push(u.searchParams);
    const a = me.answer(u.searchParams);
    res.writeHead(a.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(a.body ?? { results: [] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return Object.assign(me, { origin: `http://127.0.0.1:${port}`, queries, close: () => new Promise<void>((r) => server.close(() => r())) });
}

const R = (url: string, title: string, engines = ['duckduckgo']) => ({ url, title, content: `${title} snippet`, engines });

test('the SearXNG address: http(s) only, no password, "/search" and the trailing slash dropped, blank is off', () => {
  assert.equal(normalizeSearxUrl('http://127.0.0.1:8888/'), 'http://127.0.0.1:8888');
  assert.equal(normalizeSearxUrl('127.0.0.1:8888/search'), 'http://127.0.0.1:8888');
  assert.equal(normalizeSearxUrl('https://search.example.org/searx/'), 'https://search.example.org/searx');
  assert.equal(normalizeSearxUrl('  '), null);
  assert.equal(normalizeSearxUrl(null), null);
  assert.throws(() => normalizeSearxUrl('ftp://x'));
  assert.throws(() => normalizeSearxUrl('http://me:secret@127.0.0.1:8888'));
});

test('the searches: two grouped site searches for the systems jobleft reads, then two without a site', () => {
  const q = planQueries({ q: 'SOC analyst', place: ' Utrecht ' }).map((x) => x.q);
  assert.equal(q.length, 4);
  assert.equal(q[0], 'SOC analyst Utrecht (site:greenhouse.io OR site:lever.co OR site:jobs.ashbyhq.com OR site:apply.workable.com)');
  assert.ok(q[1]!.includes('site:recruitee.com OR site:teamtailor.com'));
  assert.ok(q.includes('SOC analyst Utrecht job OR careers'));
});

test('a job site\'s search page is a list, not one job', () => {
  assert.equal(looksLikeJobList('https://www.nationalevacaturebank.nl/vacatures/functie/security-analyst', '44 security analyst vacatures | 8 oktober 2026'), true);
  assert.equal(looksLikeJobList('https://www.cybersecurityjobsite.com/jobs/netherlands/soc-analyst/', 'SOC Analyst jobs in Netherlands - CyberSecurityJobsite.com'), true);
  assert.equal(looksLikeJobList('https://nl.jooble.org/vacatures-soc-analist', 'Vacatures - Soc analist (Dringend!) - Jooble'), true);
  assert.equal(looksLikeJobList('https://www.werkzoeken.nl/vacature/16002856-soc-analyst/', 'Vacature SOC Analyst | Amsterdam | Cyber Security District'), false);
  assert.equal(looksLikeJobList('https://securitytalent.nl/jobs-internships/junior-soc-analyst1', 'Job: Junior SOC Analyst - Security Talent'), false);
  assert.equal(looksLikeJobList('https://careers.verisure.com/nl/nl/job/r2026090547/Security-Analyst', 'Security Analyst in Amsterdam, North Holland, Netherlands'), false);
});

test('a page from a search without a site is kept only when it reads like a job page', () => {
  assert.equal(looksLikeJobPage('https://werken.example.nl/vacature/soc-analist', 'SOC-analist'), true);
  assert.equal(looksLikeJobPage('https://acme.com/careers/123', 'Security Analyst'), true);
  assert.equal(looksLikeJobPage('https://en.wikipedia.org/wiki/Security_operations_center', 'Security operations center - Wikipedia'), false);
  assert.equal(looksLikeJobPage('https://www.ncsc.nl/soc/wat-is-een-soc', 'Wat is een SOC? - NCSC'), false);
});

test('web search: the address is saved, checked, and the results are sorted without opening any page', async () => {
  const sx = await searx((p) => {
    const q = p.get('q') ?? '';
    if (q.includes('site:recruitee.com') && p.get('pageno') === '1') return { body: { results: [R('https://tesorion.recruitee.com/o/junior-soc-analyst', 'Junior SOC Analyst'), R('https://tesorion.recruitee.com/', 'Tesorion careers'), R('https://en.wikipedia.org/wiki/System_on_a_chip', 'System on a chip')] } };
    if (q.includes('site:greenhouse.io')) return { body: { results: [R('https://job-boards.greenhouse.io/acme/jobs/123', 'Security Engineer'), R('https://job-boards.greenhouse.io/acme/jobs/123?utm_source=x', 'Security Engineer', ['brave'])] } };
    if (q.endsWith('job OR careers')) return { body: { results: [
      R('https://www.linkedin.com/jobs/view/1', 'SOC Analyst - LinkedIn'),
      R('https://acme.wd3.myworkdayjobs.com/en-US/careers/job/1', 'SOC Analyst - Workday'),
      R('https://werken.example.nl/vacature/soc-analist', 'SOC-analist'),
      R('https://support.teamtailor.com/en/articles/1-create-a-job', 'Create a job - Teamtailor Support'),
      R('https://www.lever.co/blog/hiring', 'Hiring tips | Lever'),
      R('http://192.168.1.10/admin', 'router'),
    ], unresponsive_engines: [['google', 'CAPTCHA']] } };
    return { body: { results: [] } };
  });
  // The background reader reads the job pages found: every host goes to the stand-in, which knows none of them.
  const map = Object.fromEntries(['tesorion.recruitee.com', 'boards-api.greenhouse.io', 'job-boards.greenhouse.io', 'werken.example.nl'].map((h) => [h, sx.origin]));
  const s = await startTest('websearch', { env: { JOBLEFT_HOST_MAP: JSON.stringify(map) } });
  try {
    // Not set up yet: a plain answer, and nothing sent.
    const before = await s.call('POST', '/api/v1/websearch/jobs', { q: 'SOC analyst' });
    assert.equal(before.status, 503, before.text);
    assert.match(before.json.error.message, /Settings > Web search/);
    assert.equal(sx.queries.length, 0);

    const check = await s.call('POST', '/api/v1/websearch/check', { url: `${sx.origin}/search` });
    assert.equal(check.status, 200, check.text);
    assert.equal(check.json.ok, true, 'the test search finds greenhouse jobs in this stand-in');
    assert.deepEqual(check.json.siteEngines, ['brave', 'duckduckgo']);
    assert.equal(sx.queries.at(-1)!.get('format'), 'json');

    const settings = (await s.call('GET', '/api/v1/settings')).json;
    assert.deepEqual(settings.webSearch, { url: null });
    const saved = await s.call('PUT', '/api/v1/settings', { ...settings, webSearch: { url: `${sx.origin}/` } });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.webSearch.url, sx.origin);
    // A writer that leaves webSearch out (the shell's pause item) keeps it.
    const { webSearch: _w, ...rest } = saved.json;
    assert.equal((await s.call('PUT', '/api/v1/settings', rest)).json.webSearch.url, sx.origin);
    assert.equal((await s.call('PUT', '/api/v1/settings', { ...settings, webSearch: { url: 'ftp://nope' } })).status, 400);

    const n = sx.queries.length;
    const r = await s.call('POST', '/api/v1/websearch/jobs', { q: 'SOC analyst', place: 'Utrecht', timeRange: 'week' });
    assert.equal(r.status, 200, r.text);
    assert.equal(sx.queries.length - n, 4);
    assert.ok(sx.queries.slice(n).every((p) => p.get('time_range') === 'week' && p.get('format') === 'json'));
    const by = new Map(r.json.results.map((x: any) => [x.url, x]));
    const job: any = by.get('https://tesorion.recruitee.com/o/junior-soc-analyst');
    assert.equal(job.kind, 'board_job');
    assert.equal(job.boardId, 'recruitee:tesorion');
    assert.equal((by.get('https://tesorion.recruitee.com/') as any).kind, 'board');
    // The same job twice (a tracking parameter) is one result, with both engines.
    const gh = r.json.results.filter((x: any) => x.boardId === 'greenhouse:acme');
    assert.equal(gh.length, 1);
    assert.deepEqual(gh[0].engines.sort(), ['brave', 'duckduckgo']);
    assert.equal((by.get('https://www.linkedin.com/jobs/view/1') as any).kind, 'never');
    assert.equal((by.get('https://acme.wd3.myworkdayjobs.com/en-US/careers/job/1') as any).kind, 'never');
    assert.equal((by.get('https://werken.example.nl/vacature/soc-analist') as any).kind, 'page');
    assert.ok(!r.json.results.some((x: any) => x.url.includes('192.168.')), 'a local address is dropped');
    assert.ok(!r.json.results.some((x: any) => /support\.teamtailor|lever\.co\/blog/.test(x.url)), 'a hiring system\'s own pages are dropped');
    assert.ok(!r.json.results.some((x: any) => x.url.includes('wikipedia')), 'a result off the site a search asked for is dropped');
    assert.deepEqual(r.json.unresponsive, ['google']);
    const boards = new Map(r.json.boards.map((b: any) => [b.boardId, b]));
    assert.equal((boards.get('recruitee:tesorion') as any).results, 2);
    assert.equal((boards.get('recruitee:tesorion') as any).added, false);

    // The same search again is answered from the last 30 minutes: no engine is asked.
    const n2 = sx.queries.length;
    assert.equal((await s.call('POST', '/api/v1/websearch/jobs', { q: 'SOC analyst', place: 'Utrecht', timeRange: 'week' })).status, 200);
    assert.equal(sx.queries.length - n2, 1, 'only the search that found nothing is asked again');
    // "More results": the next page of the same searches.
    const more = await s.call('POST', '/api/v1/websearch/jobs', { q: 'SOC analyst', place: 'Utrecht', timeRange: 'week', page: 2 });
    assert.equal(more.status, 200, more.text);
    assert.ok(sx.queries.slice(-4).every((p) => p.get('pageno') === '2'));

    // A board in the list shows as added.
    assert.equal((await s.call('POST', '/api/v1/boards', { ats: 'recruitee', board: 'tesorion' })).status, 200);
    const again = await s.call('POST', '/api/v1/websearch/jobs', { q: 'SOC analyst' });
    assert.equal(again.json.boards.find((b: any) => b.boardId === 'recruitee:tesorion').added, true);
  } finally { await s.stop(); cleanup(s.home); await sx.close(); }
});

test('web search: SearXNG without JSON output, and an address where nothing answers, say what to do', async () => {
  const sx = await searx(() => ({ status: 403, body: {} }));
  const s = await startTest('websearch-off');
  try {
    const off = await s.call('POST', '/api/v1/websearch/check', { url: sx.origin });
    assert.equal(off.json.ok, false);
    assert.match(off.json.message, /settings\.yml/);
    const settings = (await s.call('GET', '/api/v1/settings')).json;
    await s.call('PUT', '/api/v1/settings', { ...settings, webSearch: { url: sx.origin } });
    const r = await s.call('POST', '/api/v1/websearch/jobs', { q: 'SOC analyst' });
    assert.equal(r.status, 422, r.text);
    assert.match(r.json.error.message, /json/);
    assert.equal(sx.queries.length, 2, 'it stops after the first refusal');
    await sx.close();
    const gone = await s.call('POST', '/api/v1/websearch/check', { url: sx.origin });
    assert.equal(gone.json.ok, false);
    assert.match(gone.json.message, /Nothing answered/);
  } finally { await s.stop(); cleanup(s.home); }
});

test('add by link: a Recruitee job is read from the board feed; a job the board no longer lists is called closed', async () => {
  const pages: string[] = [];
  const server: Server = createServer((req, res) => {
    pages.push(req.url ?? '');
    if (req.url === '/api/offers/') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ offers: [{
        id: 4242, slug: 'junior-soc-analyst', title: 'Junior SOC Analyst', careers_url: 'https://acme.recruitee.com/o/junior-soc-analyst',
        company_name: 'Acme Security', locations: [{ city: 'Utrecht', country: 'Netherlands', country_code: 'NL' }], description: '<p>Watch the alerts.</p>',
      }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const s = await startTest('websearch-recruitee', { env: { JOBLEFT_HOST_MAP: JSON.stringify({ 'acme.recruitee.com': origin }) } });
  try {
    const ok = await s.call('POST', '/api/v1/jobs/external', { url: 'https://acme.recruitee.com/o/junior-soc-analyst' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.job.title, 'Junior SOC Analyst');
    assert.equal(ok.json.job.company, 'Acme Security');
    assert.ok(!pages.includes('/o/junior-soc-analyst'), 'the job page itself is not read: the feed has the facts');
    const gone = await s.call('POST', '/api/v1/jobs/external', { url: 'https://acme.recruitee.com/o/senior-soc-analyst' });
    assert.equal(gone.status, 404, gone.text);
    assert.match(gone.json.error.message, /probably closed/);
  } finally { await s.stop(); cleanup(s.home); await new Promise((r) => server.close(r)); }
});

test('web search: the job pages found are read in the background into jobs of their own source, once each', async () => {
  const LD = { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'SOC-analist', datePosted: '2026-10-01', hiringOrganization: { name: 'Gemeente Voorbeeld' },
    jobLocation: { address: { addressLocality: 'Utrecht', addressCountry: 'NL' } }, description: '<p>Je bewaakt de meldingen.</p>' };
  const site: string[] = [];
  const pages: Server = createServer((req, res) => {
    site.push(req.url ?? '');
    if (req.url === '/api/offers/') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ offers: [{ id: 7, slug: 'junior-soc-analyst', title: 'Junior SOC Analyst', careers_url: 'https://acme.recruitee.com/o/junior-soc-analyst', company_name: 'Acme Security', locations: [{ city: 'Utrecht', country: 'Netherlands', country_code: 'NL' }], description: '<p>Watch the alerts.</p>' }] }));
    } else if (req.url === '/careers') {
      // A careers home page: it reads like a job (apply, benefits, experience) but carries no JobPosting record.
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head><title>Careers</title></head><body><p>${'Join us. We offer great benefits and salary. Apply today: requirements, experience, responsibilities, full-time and part-time roles. '.repeat(5)}</p></body></html>`);
    } else if (req.url === '/vacature/soc-analist') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head><title>SOC-analist</title><script type="application/ld+json">${JSON.stringify(LD)}</script></head><body>x</body></html>`);
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => pages.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;
  const sx = await searx((p) => {
    const q = p.get('q') ?? '';
    if (q.includes('site:recruitee.com')) return { body: { results: [R('https://acme.recruitee.com/o/junior-soc-analyst', 'Junior SOC Analyst')] } };
    if (q.includes('vacature OR vacancy')) return { body: { results: [R('https://werken.voorbeeld.nl/vacature/soc-analist', 'Vacature SOC-analist'), R('https://werken.voorbeeld.nl/careers', 'Careers at Voorbeeld')] } };
    return { body: { results: [] } };
  });
  const s = await startTest('webreader', { env: { JOBLEFT_HOST_MAP: JSON.stringify({ 'acme.recruitee.com': origin, 'werken.voorbeeld.nl': origin }) } });
  const read = async () => {
    for (let i = 0; i < 200; i++) {
      const st = (await s.call('GET', '/api/v1/websearch/reading')).json;
      if (!st.running && st.queued === 0) return st;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the reading did not finish');
  };
  try {
    const settings = (await s.call('GET', '/api/v1/settings')).json;
    await s.call('PUT', '/api/v1/settings', { ...settings, webSearch: { url: sx.origin } });
    const r = await s.call('POST', '/api/v1/websearch/jobs', { q: 'SOC analyst', place: 'Utrecht' });
    assert.equal(r.status, 200, r.text);
    const st = await read();
    assert.equal(st.jobs, 2);
    const web = await s.call('POST', '/api/v1/jobs/search', { filter: { sources: ['external:web'] }, sort: 'most_recent', limit: 20 });
    assert.deepEqual(web.json.items.map((x: any) => x.job.title).sort(), ['Junior SOC Analyst', 'SOC-analist']);
    const soc = web.json.items.find((x: any) => x.job.title === 'SOC-analist');
    assert.equal(soc.job.company, 'Gemeente Voorbeeld');
    // Recommended (no source asked for) does not list them.
    const rec = await s.call('POST', '/api/v1/jobs/search', { filter: {}, sort: 'most_recent', limit: 20 });
    assert.equal(rec.json.items.filter((x: any) => /SOC/.test(x.job.title)).length, 0);
    // The same results again: known, so nothing is read twice, and each result names its job.
    const n = site.length;
    const again = await s.call('POST', '/api/v1/websearch/jobs', { q: 'SOC analyst', place: 'Utrecht', page: 2 });
    assert.equal(again.status, 200, again.text);
    await read();
    assert.equal(site.length, n, 'no page was read again');

    // 30 days without being found again: a web job leaves the list, unless the person liked, applied to or added it.
    const liked = web.json.items.find((x: any) => x.job.title === 'Junior SOC Analyst');
    assert.equal((await s.call('PATCH', `/api/v1/tracker/${encodeURIComponent(liked.job.id)}`, { liked: true })).status, 200);
    const db = new DatabaseSync(join(s.home, 'data', 'jobleft.db'));
    db.exec("PRAGMA busy_timeout = 5000; UPDATE jobs SET last_seen = '2026-01-01T00:00:00.000Z' WHERE ats = 'external' AND board = 'web'");
    db.close();
    sx.answer = () => ({ body: { results: [] } });
    await s.call('POST', '/api/v1/websearch/jobs', { q: 'something else' });
    const left = await s.call('POST', '/api/v1/jobs/search', { filter: { sources: ['external:web'] }, sort: 'most_recent', limit: 20 });
    assert.deepEqual(left.json.items.map((x: any) => x.job.title), ['Junior SOC Analyst']);
  } finally { await s.stop(); cleanup(s.home); await sx.close(); await new Promise((r) => pages.close(r)); }
});
