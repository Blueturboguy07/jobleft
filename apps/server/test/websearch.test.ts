// Web search through the person's own SearXNG: the address check, the searches sent, how results are sorted, and
// that no result page is opened. A loopback stand-in plays SearXNG.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { alternativesOf, dutchTitle, looksLikeJobList, looksLikeJobPage, normalizeSearxUrl, planQueries, searchLinks } from '../src/interim/websearch.ts';
import { startScriptedModel } from '../../../packages/assistant/src/mock/scripted-model.ts';
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

test('the searches: the open web, the job words, Dutch words for a Dutch place, and the big job sites left out', () => {
  const nl = planQueries({ q: 'SOC analyst', place: ' Utrecht ' }, 'NL').map((x) => x.q);
  assert.equal(nl.length, 3);
  assert.equal(nl[0], 'SOC analyst vacature Utrecht -site:linkedin.com -site:indeed.com -site:glassdoor.com -site:glassdoor.nl');
  assert.equal(nl[1], 'SOC analist vacature Utrecht -site:linkedin.com -site:indeed.com -site:glassdoor.com -site:glassdoor.nl', 'the Dutch spelling');
  assert.ok(planQueries({ q: 'SOC engineer', place: 'Utrecht' }, 'NL').some((x) => x.q.startsWith('SOC engineer werken bij Utrecht')), 'no Dutch spelling: "werken bij"');
  assert.equal(dutchTitle('Junior Security Analyst'), 'Junior security analist');
  assert.equal(dutchTitle('DevOps Engineer'), null);
  assert.ok(nl.every((q) => !q.includes('site:recruitee.com')), 'no job board searches');
  const us = planQueries({ q: 'SOC Analyst, Security Analyst', place: 'Austin' }, 'US').map((x) => x.q);
  assert.equal(us[0], '("SOC Analyst" OR "Security Analyst") job Austin -site:linkedin.com -site:indeed.com -site:glassdoor.com -site:glassdoor.nl');
  assert.deepEqual(alternativesOf('SOC Analyst, Security Analyst; Junior SOC Analyst, Extra'), ['SOC Analyst', 'Security Analyst', 'Junior SOC Analyst']);
  const links = searchLinks({ q: 'SOC Analyst, Security Analyst', place: 'Utrecht' }, 'NL');
  assert.deepEqual(links.map((l) => l.name), ['LinkedIn', 'Indeed', 'Glassdoor', 'Google job search', 'Werken voor Nederland']);
  assert.equal(links[0]!.url, 'https://www.linkedin.com/jobs/search/?keywords=SOC%20Analyst&location=Utrecht');
  assert.equal(links[1]!.url, 'https://nl.indeed.com/jobs?q=SOC%20Analyst&l=Utrecht');
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
    if (q.includes('site:greenhouse.io')) return { body: { results: [R('https://job-boards.greenhouse.io/acme/jobs/123', 'Security Engineer')] } };
    if (q.includes(' vacature ') && p.get('pageno') === '1') return { body: { results: [
      R('https://www.werkenvoornederland.nl/vacatures/soc-analist-kvk-1', 'Vacature: Cybersecurity SOC analist, KVK'),
      R('https://www.werkenvoornederland.nl/vacatures/soc-analist-kvk-1?utm_source=x', 'Vacature: Cybersecurity SOC analist, KVK', ['brave']),
      R('https://tesorion.recruitee.com/o/junior-soc-analyst', 'Junior SOC Analyst'),
      R('https://www.nationalevacaturebank.nl/vacatures/functie/security-analyst', '44 security analyst vacatures'),
    ] } };
    if (q.includes(' job ')) return { body: { results: [
      R('https://www.linkedin.com/jobs/view/1', 'SOC Analyst - LinkedIn'),
      R('https://acme.wd3.myworkdayjobs.com/en-US/careers/job/1', 'SOC Analyst - Workday'),
      R('https://werken.example.nl/vacature/soc-analist', 'SOC-analist'),
      R('https://support.teamtailor.com/en/articles/1-create-a-job', 'Create a job - Teamtailor Support'),
      R('http://192.168.1.10/admin', 'router'),
    ], unresponsive_engines: [['google', 'CAPTCHA']] } };
    return { body: { results: [] } };
  });
  // The background reader reads the pages found: every host goes to the stand-in, which knows none of them.
  const map = Object.fromEntries(['www.werkenvoornederland.nl', 'werken.example.nl', 'tesorion.recruitee.com'].map((h) => [h, sx.origin]));
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
    assert.equal(r.json.country, 'NL', 'Utrecht is in the Netherlands');
    // Three searches, and the second page of the one whose first page was full (5 results).
    assert.deepEqual(sx.queries.slice(n).map((p) => p.get('pageno')), ['1', '1', '1', '2']);
    assert.ok(sx.queries.at(-1)!.get('q')!.includes(' job '));
    assert.ok(sx.queries.slice(n).every((p) => p.get('time_range') === 'week' && /-site:linkedin\.com/.test(p.get('q') ?? '')));
    const by = new Map(r.json.results.map((x: any) => [x.url, x]));
    // The same page twice (a tracking parameter) is one result, with both engines.
    const kvk = r.json.results.filter((x: any) => x.url.startsWith('https://www.werkenvoornederland.nl/vacatures/soc-analist-kvk-1'));
    assert.equal(kvk.length, 1);
    assert.deepEqual(kvk[0].engines.sort(), ['brave', 'duckduckgo']);
    assert.equal(kvk[0].kind, 'page');
    assert.equal((by.get('https://www.nationalevacaturebank.nl/vacatures/functie/security-analyst') as any).kind, 'list');
    assert.equal((by.get('https://www.linkedin.com/jobs/view/1') as any).kind, 'never');
    assert.equal((by.get('https://acme.wd3.myworkdayjobs.com/en-US/careers/job/1') as any).kind, 'never');
    assert.ok(!r.json.results.some((x: any) => x.url.includes('recruitee.com')), 'job boards are left out');
    assert.equal(r.json.boardResults, 1);
    assert.ok(!r.json.results.some((x: any) => x.url.includes('192.168.')), 'a local address is dropped');
    assert.ok(!r.json.results.some((x: any) => /support\.teamtailor/.test(x.url)), 'a hiring system\'s own pages are dropped');
    assert.deepEqual(r.json.unresponsive, ['google']);
    assert.equal(r.json.searchLinks[0].name, 'LinkedIn');

    // The outcomes: each result's reading, in the country asked for.
    const o = await s.call('POST', '/api/v1/websearch/outcomes', { urls: [kvk[0].url, 'https://nowhere.example/x'], country: 'NL' });
    assert.equal(o.status, 200, o.text);
    assert.equal(o.json[1].state, 'unread');

    // The same search again is answered from the last 30 minutes: every page had results, so none is asked again.
    const n2 = sx.queries.length;
    assert.equal((await s.call('POST', '/api/v1/websearch/jobs', { q: 'SOC analyst', place: 'Utrecht', timeRange: 'week' })).status, 200);
    assert.deepEqual(sx.queries.slice(n2).map((p) => p.get('pageno')), []);
    // "More results": the engines' pages 3 (and 4 for a full page 3).
    const n3 = sx.queries.length;
    const more = await s.call('POST', '/api/v1/websearch/jobs', { q: 'SOC analyst', place: 'Utrecht', timeRange: 'week', page: 2 });
    assert.equal(more.status, 200, more.text);
    assert.deepEqual(sx.queries.slice(n3).map((p) => p.get('pageno')), ['3', '3', '3', '4']);
    // A Dutch name for the country counts too.
    assert.equal((await s.call('POST', '/api/v1/websearch/jobs', { q: 'SOC analyst', place: 'Nederland' })).json.country, 'NL');
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
    if (req.url === '/vacature/singapore') {
      const sg = { ...LD, title: 'SOC Analyst (Singapore office)', jobLocation: { address: { addressLocality: 'Singapore', addressCountry: 'SG' } } };
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head><script type="application/ld+json">${JSON.stringify(sg)}</script></head><body>x</body></html>`);
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
    if (q.includes(' vacature ')) return { body: { results: [R('https://werken.voorbeeld.nl/vacature/soc-analist', 'Vacature SOC-analist'), R('https://werken.voorbeeld.nl/careers', 'SOC careers at Voorbeeld'), R('https://werken.voorbeeld.nl/vacature/singapore', 'SOC Analyst Singapore'), R('https://en.wikipedia.org/wiki/History', 'History - Wikipedia')] } };
    return { body: { results: [] } };
  });
  const s = await startTest('webreader', { env: { JOBLEFT_HOST_MAP: JSON.stringify({ 'werken.voorbeeld.nl': origin }) } });
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
    assert.deepEqual(web.json.items.map((x: any) => x.job.title).sort(), ['SOC Analyst (Singapore office)', 'SOC-analist']);
    // Each result says what came of it, and whether the job is in the country asked for.
    const out = (await s.call('POST', '/api/v1/websearch/outcomes', { urls: r.json.results.map((x: any) => x.url), country: 'NL' })).json;
    const of = (u: string) => out.find((x: any) => x.url === u);
    assert.equal(of('https://werken.voorbeeld.nl/vacature/soc-analist').state, 'job');
    assert.equal(of('https://werken.voorbeeld.nl/vacature/soc-analist').inPlace, true, JSON.stringify(of('https://werken.voorbeeld.nl/vacature/soc-analist')));
    assert.equal(of('https://werken.voorbeeld.nl/vacature/singapore').inPlace, false, 'Singapore is not in the Netherlands');
    assert.equal(of('https://werken.voorbeeld.nl/careers').state, 'not_job');
    assert.ok(!r.json.results.some((x: any) => x.url.includes('wikipedia')), 'a page that names no searched word is left out');
    assert.equal(r.json.unrelatedResults, 1);
    // The cards in the country asked for leave the Singapore job out.
    const nl = await s.call('POST', '/api/v1/jobs/search', { filter: { sources: ['external:web'], countries: ['NL'], includeUnknown: ['place'] }, sort: 'most_recent', limit: 20 });
    assert.deepEqual(nl.json.items.map((x: any) => x.job.title), ['SOC-analist']);
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
    const liked = web.json.items.find((x: any) => x.job.title === 'SOC-analist');
    assert.equal((await s.call('PATCH', `/api/v1/tracker/${encodeURIComponent(liked.job.id)}`, { liked: true })).status, 200);
    const db = new DatabaseSync(join(s.home, 'data', 'jobleft.db'));
    db.exec("PRAGMA busy_timeout = 5000; UPDATE jobs SET last_seen = '2026-01-01T00:00:00.000Z' WHERE ats = 'external' AND board = 'web'");
    db.close();
    sx.answer = () => ({ body: { results: [] } });
    await s.call('POST', '/api/v1/websearch/jobs', { q: 'something else' });
    const left = await s.call('POST', '/api/v1/jobs/search', { filter: { sources: ['external:web'] }, sort: 'most_recent', limit: 20 });
    assert.deepEqual(left.json.items.map((x: any) => x.job.title), ['SOC-analist']);
  } finally { await s.stop(); cleanup(s.home); await sx.close(); await new Promise((r) => pages.close(r)); }
});

test('the assistant searches the web: the chat stream carries the live steps, and the jobs it read have ids', async () => {
  const LD = { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'SOC Analyst Traineeship', datePosted: '2026-10-01', hiringOrganization: { name: 'Gemeente Voorbeeld' },
    jobLocation: { address: { addressLocality: 'Utrecht', addressCountry: 'NL' } }, description: '<p>Als SOC analyst trainee bewaak je de meldingen.</p>' };
  const pages: Server = createServer((req, res) => {
    if (req.url === '/vacature/soc-trainee') res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head><script type="application/ld+json">${JSON.stringify(LD)}</script></head><body>x</body></html>`);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => pages.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;
  const sx = await searx((p) => (p.get('q') ?? '').includes(' vacature ')
    ? { body: { results: [R('https://werken.voorbeeld.nl/vacature/soc-trainee', 'SOC Analyst Traineeship')] } }
    : { body: { results: [] } });
  const model = await startScriptedModel({ script: (ctx) => {
    if (!ctx.tools.includes('web_search')) return { text: 'No web search here.' };
    if (ctx.afterTool) { const r = JSON.parse(ctx.lastToolResult); return { text: `Found: ${r.jobs.map((j: any) => `${j.title} (${j.id})`).join(', ')}.` }; }
    return { toolCalls: [{ name: 'web_search', arguments: { query: 'SOC analyst', place: 'Utrecht' } }] };
  } });
  const s = await startTest('webassist', { env: { JOBLEFT_HOST_MAP: JSON.stringify({ 'werken.voorbeeld.nl': origin }) } });
  try {
    const settings = (await s.call('GET', '/api/v1/settings')).json;
    await s.call('PUT', '/api/v1/settings', { ...settings, webSearch: { url: sx.origin } });
    assert.equal((await s.call('PUT', '/api/v1/ai/settings', { provider: 'local', localKind: 'openai_compatible', baseUrl: model.url, model: 'scripted-model' })).status, 200);
    const r = await s.call('POST', '/api/v1/ai/chat', { requestId: 'req-web-1', messages: [{ role: 'user', content: 'Find SOC analyst traineeships in Utrecht.' }] });
    const ev = r.text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    const tools = ev.filter((e: any) => e.type === 'tool');
    assert.equal(tools[0].label, 'Searching the web for jobs: SOC analyst, Utrecht');
    const end = tools.at(-1);
    assert.equal(end.state, 'done', JSON.stringify(end));
    assert.ok(end.steps.some((x: string) => x.startsWith('Asking your search engine: SOC analyst vacature Utrecht')), JSON.stringify(end.steps));
    assert.ok(end.steps.includes('werken.voorbeeld.nl: a new job'), JSON.stringify(end.steps));
    assert.equal(end.sources[0].url, 'https://werken.voorbeeld.nl/vacature/soc-trainee');
    assert.match(end.summary, /^1 job found · 1 page read/);
    const text = ev.filter((e: any) => e.type === 'delta').map((e: any) => e.text).join('');
    assert.match(text, /SOC Analyst Traineeship \(external:web:/);
    // The job is a web job: it is in Web jobs too.
    const web = await s.call('POST', '/api/v1/jobs/search', { filter: { sources: ['external:web'] }, sort: 'most_recent', limit: 5 });
    assert.equal(web.json.items[0].job.title, 'SOC Analyst Traineeship');
  } finally { await s.stop(); cleanup(s.home); await sx.close(); await model.close(); await new Promise((r) => pages.close(r)); }
});

test('Widen with AI: the provider\'s titles join the searches and the relevance check; without a provider it says so', async () => {
  const { cleanTitles } = await import('../src/interim/widen.ts');
  assert.deepEqual(cleanTitles(['security analist', '1. SOC medewerker', 'SOC analyst', 'Visit https://x.example', 'a very long title that goes on and on and on'], ['SOC analyst']), ['security analist', 'SOC medewerker']);
  const asked: string[] = [];
  const sx = await searx((p) => { asked.push(p.get('q') ?? ''); return { body: { results: [] } }; });
  let modelCalls = 0;
  const model = await startScriptedModel({ script: () => { modelCalls++; return { text: '{"titles": ["security analist", "SOC medewerker", "Utrecht"]}' }; } });
  const s = await startTest('webwiden');
  try {
    const settings = (await s.call('GET', '/api/v1/settings')).json;
    await s.call('PUT', '/api/v1/settings', { ...settings, webSearch: { url: sx.origin } });
    // No provider yet: the search runs with the words given and says why it was not widened.
    const plain = await s.call('POST', '/api/v1/websearch/jobs', { q: 'SOC analyst', place: 'Netherlands', widen: true });
    assert.equal(plain.status, 200, plain.text);
    assert.match(plain.json.widenProblem, /no AI provider/);
    assert.equal(plain.json.widenedWith, undefined);
    assert.equal((await s.call('PUT', '/api/v1/ai/settings', { provider: 'local', localKind: 'openai_compatible', baseUrl: model.url, model: 'scripted-model' })).status, 200);
    asked.length = 0;
    const calls = modelCalls;
    const r = await s.call('POST', '/api/v1/websearch/jobs', { q: 'SOC analyst', place: 'Netherlands', widen: true, timeRange: 'week' });
    assert.equal(r.status, 200, r.text);
    assert.equal(modelCalls - calls, 1, 'one AI call');
    assert.deepEqual(r.json.widenedWith, ['security analist', 'SOC medewerker'], 'a place is not a title');
    // The person's own searches stay as they are; the AI's titles get one more search of their own.
    assert.ok(asked[0]!.startsWith('SOC analyst vacature Netherlands'), asked[0]);
    assert.equal(asked.length, 4);
    assert.ok(asked[3]!.startsWith('("security analist" OR "SOC medewerker") vacature Netherlands'), asked[3]);
    // The same search again: the titles are remembered, no AI call.
    await s.call('POST', '/api/v1/websearch/jobs', { q: 'SOC analyst', place: 'Netherlands', widen: true, timeRange: 'week' });
    assert.equal(modelCalls - calls, 1);
  } finally { await s.stop(); cleanup(s.home); await sx.close(); await model.close(); }
});
