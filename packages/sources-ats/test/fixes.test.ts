// Regression tests for the defects found by the independent evaluators (round 2). Nothing live: fake getters, fake
// clocks and in-process streams only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { HttpError } from '@jobleft/crawler';
import type { BoardRef } from '@jobleft/crawler';
import { workable } from '../src/adapters/workable.ts';
import { recruitee, mapRecruitee } from '../src/adapters/recruitee.ts';
import { personio } from '../src/adapters/personio.ts';
import { ashby, ashbyOverallPay, greenhouse, lever } from '../src/adapters/builtins.ts';
import { parseEuropeanPay } from '../src/pay-text.ts';
import { descriptionText, textField } from '../src/util.ts';
import { decodeEntitiesFull, ENTITY_COUNT, stripControls } from '../src/entities.ts';
import { BoundedPacer, politeFetch, resetRobotsProblems, robotsProblemFor } from '../src/polite-fetch.ts';
import { plainReason } from '../src/report.ts';
import { atsHost, normalRegion } from '../src/hosts.ts';
import { HERE } from './helpers.ts';

const board = (ats: string, b = 'acme', region?: string): BoardRef => ({ ats: ats as BoardRef['ats'], board: b, company: 'Acme', ...(region ? { region } : {}) });
const http = (body: unknown, seen: string[] = []) => ({ async getJson(url: string) { seen.push(url); return body; }, async getText(url: string) { seen.push(url); return String(body); } });

// ------------------------------------------------------------ European pay in text

test('European thousands-dot pay in a description is read as thousands, per year (EUR 45.000 - 55.000)', async () => {
  for (const [text, want] of [
    ['Salary: €45.000 – €55.000 brutto jährlich.', { min: 45000, max: 55000, currency: 'EUR', period: 'year' }],
    ['Gehalt 45.000 € bis 55.000 € pro Jahr', { min: 45000, max: 55000, currency: 'EUR', period: 'year' }],
    ["CHF 85'000 - 95'000 pro Jahr", { min: 85000, max: 95000, currency: 'CHF', period: 'year' }],
    ['€2.500,50 - €3.100 monatlich', { min: 2500.5, max: 3100, currency: 'EUR', period: 'month' }],
    ['Vergütung €14,50 - €16,00 pro Stunde', { min: 14.5, max: 16, currency: 'EUR', period: 'hour' }],
  ] as const) assert.deepEqual(parseEuropeanPay(text), want, text);
  // English style is left to the crawler; amounts without a currency, and small amounts with no period, are not read.
  for (const t of ['€45,000 – €55,000 per year', 'We raised $5 million', 'Vergütung: 2.900 - 3.300 EUR', '45.000 - 55.000 Mitarbeiter']) assert.equal(parseEuropeanPay(t), null, t);
  // Through a real adapter: the stored pay is 45000-55000, never an hourly 45-55.
  const jobs = await workable.fetchBoard(board('workable'), http({ name: 'Acme', jobs: [{
    shortcode: 'A1', title: 'Nurse', url: 'https://apply.workable.com/acme/j/A1/', description: '<p>Salary: €45.000 – €55.000 brutto jährlich.</p>', locations: [],
  }] }));
  assert.deepEqual(jobs[0].pay, { min: 45000, max: 55000, currency: 'EUR', period: 'year' });
  const p = await personio.fetchBoard(board('personio'), { ...http(''), async getText() {
    return '<workzag-jobs><position><id>7</id><name>Pflege</name><subcompany>Acme</subcompany><office>Berlin</office><createdAt>2026-09-01T10:00:00+00:00</createdAt>' +
      '<jobDescriptions><jobDescription><name>Ihr Profil</name><value><![CDATA[<p>Salary: €45.000 – €55.000 brutto jährlich.</p>]]></value></jobDescription></jobDescriptions></position></workzag-jobs>';
  } } as never);
  assert.deepEqual(p[0].pay, { min: 45000, max: 55000, currency: 'EUR', period: 'year' });
});

// ------------------------------------------------------------ Retry-After and pace

/** A clock that only moves when the earliest sleeper wakes, so several callers can sleep at once. */
function virtualClock() {
  let now = 0;
  const timers: Array<{ at: number; wake: () => void }> = [];
  return {
    now: () => now,
    sleep: (ms: number) => new Promise<void>((wake) => { timers.push({ at: now + ms, wake }); }),
    async run(): Promise<void> {
      for (;;) {
        await new Promise((r) => setImmediate(r));
        const next = timers.sort((a, b) => a.at - b.at).shift();
        if (!next) return;
        now = Math.max(now, next.at);
        next.wake();
      }
    },
  };
}

test('after a 429 Retry-After, queued requests to the host leave at least 1 s apart (O7)', async () => {
  const clock = virtualClock();
  const sent: number[] = [];
  const base = (async () => { sent.push(clock.now()); return new Response('{}', { status: sent.length === 1 ? 429 : 200, headers: sent.length === 1 ? { 'retry-after': '5' } : {} }); }) as typeof fetch;
  const f = politeFetch({ fetchImpl: base, now: clock.now, sleep: clock.sleep });
  await Promise.all([f('https://api.gem.com/a'), clock.run()]);
  // Three boards queued at the same moment, as the crawler's pacer hands them over.
  await Promise.all([...['b', 'c', 'd'].map((x) => f(`https://api.gem.com/${x}`)), clock.run()]);
  assert.equal(sent.length, 4);
  assert.ok(sent[1] >= 5000, `first after Retry-After at ${sent[1]}`);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i] - sent[i - 1] >= 1000, `gap ${sent[i] - sent[i - 1]} ms between request ${i} and ${i + 1}: ${sent.join(', ')}`);
  // a different host is not held back
  const before = clock.now();
  await f('https://other.example.org/x');
  assert.equal(clock.now(), before);
});

test('a Crawl-delay that is short enough is slept and does not use up the request timeout', async () => {
  let clock = 0;
  const seenSignals: boolean[] = [];
  const base = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seenSignals.push(!!init?.signal?.aborted);
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nCrawl-delay: 30\n');
    return new Response('{"ok":true}');
  }) as typeof fetch;
  const f = politeFetch({ fetchImpl: base, now: () => clock, sleep: async (ms) => { clock += ms; } });
  await f('https://x.example.org/robots.txt');
  // The crawler builds the timeout signal BEFORE it calls fetch; 30 s of waiting would have run it out. Here it has.
  const expired = AbortSignal.timeout(1);
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(expired.aborted);
  const res = await f('https://x.example.org/feed', { signal: expired });
  assert.equal(res.status, 200);
  assert.ok(clock >= 30_000 && clock <= 30_200, `slept ${clock} ms`);
  assert.equal(seenSignals[1], false, 'the request went out with an already aborted signal');
});

test('a Crawl-delay longer than the wait cap fails at once with its true reason, never a multi-hour hold', async () => {
  let clock = 0;
  const base = (async (input: string | URL | Request) => String(input).endsWith('/robots.txt') ? new Response('User-agent: *\nCrawl-delay: 100000\n') : new Response('{}')) as typeof fetch;
  const f = politeFetch({ fetchImpl: base, now: () => clock, sleep: async (ms) => { clock += ms; } });
  await f('https://slow.example.org/robots.txt');
  await assert.rejects(f('https://slow.example.org/feed'), (e: Error) => {
    assert.equal(e.name, 'CrawlDelayError');
    assert.ok(e instanceof HttpError, 'an HttpError, so the crawler client does not retry it (each retry would wait the delay again)');
    assert.match(plainReason(`${e.name}: ${e.message}`) ?? '', /asks for 100000 seconds between requests.*longer than jobleft waits/);
    return true;
  });
  assert.equal(clock, 0, 'nothing was slept');
});

// ------------------------------------------------------------ body limit while streaming

test('an endless body stops at the size limit while it streams (memory stays at the limit)', async () => {
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024);
  const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled += chunk.byteLength; c.enqueue(chunk); } });
  const f = politeFetch({ fetchImpl: (async () => new Response(stream, { status: 200 })) as typeof fetch, maxBodyBytes: 1024 * 1024, minGapMs: 0 });
  await assert.rejects(f('https://big.example.org/x'), (e: unknown) => e instanceof HttpError && /body too large/.test(e.message));
  assert.ok(pulled <= 1024 * 1024 + 4 * 64 * 1024, `pulled ${pulled} bytes before it stopped`);
  // a normal body passes unchanged, with its headers
  const ok = await politeFetch({ fetchImpl: (async () => new Response('{"a":1}', { headers: { 'x-k': 'v' } })) as typeof fetch, minGapMs: 0 })('https://ok.example.org/x');
  assert.equal(await ok.text(), '{"a":1}');
  assert.equal(ok.headers.get('x-k'), 'v');
  // an empty 204 answer is fine
  const none = await politeFetch({ fetchImpl: (async () => new Response(null, { status: 204 })) as typeof fetch, minGapMs: 0 })('https://ok.example.org/y');
  assert.equal(none.status, 204);
});

// ------------------------------------------------------------ true reasons for robots.txt problems

test('a robots.txt that could not be read is reported as that, not as "disallows this feed"', async () => {
  resetRobotsProblems();
  const dead = politeFetch({ fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch, minGapMs: 0 });
  await assert.rejects(dead('http://127.0.0.1:47001/robots.txt'));
  const err = 'RobotsError: robots.txt: path is disallowed for http://127.0.0.1:47001/api/offers/';
  assert.match(plainReason(err) ?? '', /could not connect to 127\.0\.0\.1:47001 to read robots\.txt/);
  const five = politeFetch({ fetchImpl: (async () => new Response('oops', { status: 500 })) as typeof fetch, minGapMs: 0 });
  await five('http://127.0.0.1:47002/robots.txt');
  assert.match(robotsProblemFor('http://127.0.0.1:47002/x') ?? '', /robots\.txt could not be read \(HTTP 500\)/);
  assert.match(plainReason('RobotsError: robots.txt: path is disallowed for http://127.0.0.1:47002/x') ?? '', /HTTP 500/);
  // a real disallow keeps its own sentence
  assert.match(plainReason('RobotsError: robots.txt: path is disallowed for http://127.0.0.1:47003/x') ?? '', /robots\.txt disallows this feed/);
  resetRobotsProblems();
});

// ------------------------------------------------------------ Lever, Greenhouse, Ashby

test('Lever keeps every place of a job, joined with "; "', async () => {
  const jobs = await lever.fetchBoard(board('lever'), http([
    { id: '2193db3f-0000-4000-8000-000000000001', text: 'Engineer', hostedUrl: 'https://jobs.lever.co/acme/2193db3f-0000-4000-8000-000000000001', createdAt: 1_790_000_000_000,
      categories: { location: 'London', allLocations: ['London', 'Stockholm'], team: 'Eng' }, description: '<p>x</p>' },
    { id: '2193db3f-0000-4000-8000-000000000002', text: 'Designer', hostedUrl: 'https://jobs.lever.co/acme/2193db3f-0000-4000-8000-000000000002', createdAt: 1_790_000_000_000,
      categories: { location: 'Berlin' }, description: '<p>y</p>' },
  ]));
  assert.equal(jobs[0].location, 'London; Stockholm');
  assert.equal(jobs[1].location, 'Berlin');
});

test('Greenhouse: region "eu" is read from the EU host; a job with no first_published has no posted date', async () => {
  assert.equal(normalRegion('greenhouse', 'EU'), 'eu');
  assert.equal(atsHost('greenhouse', 'eu'), 'boards-api.eu.greenhouse.io');
  assert.equal(atsHost('greenhouse', null), 'boards-api.greenhouse.io');
  assert.equal(greenhouse.host?.(board('greenhouse', 'acme', 'eu')), 'boards-api.eu.greenhouse.io');
  const seen: string[] = [];
  const body = { jobs: [
    { id: 1, title: 'A', absolute_url: 'https://job-boards.eu.greenhouse.io/acme/jobs/1', updated_at: '2026-09-20T10:00:00-04:00', content: '<p>x</p>', location: { name: 'Berlin' } },
    { id: 2, title: 'B', absolute_url: 'https://job-boards.eu.greenhouse.io/acme/jobs/2', first_published: '2026-09-01T10:00:00-04:00', updated_at: '2026-09-20T10:00:00-04:00', content: '<p>x</p>', location: { name: 'Berlin' } },
  ] };
  const jobs = await greenhouse.fetchBoard(board('greenhouse', 'acme', 'eu'), http(body, seen));
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^https:\/\/boards-api\.eu\.greenhouse\.io\/v1\/boards\/acme\/jobs/);
  assert.equal(jobs[0].postedAt, null);
  assert.equal(jobs[1].postedAt, '2026-09-01T14:00:00.000Z');
  const us: string[] = [];
  await greenhouse.fetchBoard(board('greenhouse'), http(body, us));
  assert.match(us[0], /^https:\/\/boards-api\.greenhouse\.io\//);
});

test('Ashby: a job with several pay tiers gets the board\'s overall range, not the first tier', async () => {
  const comp = (min: number, max: number) => ({ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'EUR', minValue: min, maxValue: max });
  const compensation = {
    compensationTiers: [{ components: [comp(144500, 195500)] }, { components: [comp(127500, 172500)] }, { components: [comp(110000, 149500)] }],
    summaryComponents: [comp(110000, 195500)],
  };
  const jobs = await ashby.fetchBoard(board('ashby'), http({ jobs: [
    { id: 'j1', title: 'AE', jobUrl: 'https://jobs.ashbyhq.com/acme/j1', publishedAt: '2026-09-01T10:00:00Z', descriptionHtml: '<p>x</p>', compensation },
  ] }));
  assert.deepEqual(jobs[0].pay, { min: 110000, max: 195500, currency: 'EUR', period: 'year' });
  // without summaryComponents: the widest range over the tiers
  assert.deepEqual(ashbyOverallPay({ compensationTiers: compensation.compensationTiers }), { min: 110000, max: 195500, currency: 'EUR', period: 'year' });
  assert.equal(ashbyOverallPay({}), null);
});

// ------------------------------------------------------------ Recruitee pay

test('Recruitee pay: no period stays "not stated", decimals stay as stated', () => {
  const o = (id: number, salary: unknown) => mapRecruitee({ id, title: `T${id}`, careers_url: `https://acme.recruitee.com/o/t${id}`, description: '<p>x</p>', salary }, board('recruitee'));
  assert.deepEqual(o(1, { min: '25000', max: '28000', currency: 'GBP', period: null }).pay, { min: 25000, max: 28000, currency: 'GBP', period: null });
  assert.deepEqual(o(2, { min: '22.50', max: '19.5', currency: 'EUR', period: 'hour' }).pay, { min: 22.5, max: 19.5, currency: 'EUR', period: 'hour' });
  assert.equal(o(3, { min: '0', max: null, currency: 'EUR', period: 'hour' }).pay, null);
  assert.equal(o(4, { min: '10', max: '12', currency: '', period: 'hour' }).pay, null);
});

// ------------------------------------------------------------ text: entities, mixed markup, control characters

test('named HTML entities decode with the full HTML 4 table, exact case', () => {
  assert.ok(ENTITY_COUNT >= 252);
  assert.equal(decodeEntitiesFull('S&atilde;o Paulo, Portugu&ecirc;s, cr&egrave;me br&ucirc;lée, Gro&szlig;, &oacute;&iacute;&Eacute;&eacute; &euro;5 &amp; &lt;'), 'São Paulo, Português, crème brûlée, Groß, óíÉé €5 & <');
  assert.equal(decodeEntitiesFull('&notanentity; &#x1F600; &#65;'), '&notanentity; \u{1F600} A');
  const all = ['atilde', 'ucirc', 'ecirc', 'acirc', 'euro', 'ouml', 'Uuml', 'ntilde', 'ccedil', 'aring', 'oslash', 'aelig', 'iquest', 'laquo', 'raquo', 'ndash', 'mdash', 'hellip', 'rsquo', 'bull', 'trade', 'copy', 'reg', 'deg', 'plusmn', 'frac12'];
  for (const n of all) assert.ok(!/&[a-z]+;/i.test(descriptionText(`<p>a &${n}; b</p>`)), n);
});

test('a description is plain text whatever mix of live and escaped HTML the posting uses, and has no terminal controls', () => {
  const hostile = '<p>Real text A.</p>&lt;script src="http://127.0.0.1:47998/s.js"&gt;&lt;/script&gt;<p>Real text B.</p>&lt;b&gt;bold&lt;/b&gt;';
  const t = descriptionText(hostile);
  assert.ok(!/[<>]/.test(t), t);
  assert.match(t, /Real text A\.\s+Real text B\.\s+bold/);
  const twice = descriptionText('&amp;lt;p&amp;gt;Escaped twice&amp;lt;/p&amp;gt;');
  assert.equal(twice, 'Escaped twice');
  const esc = descriptionText('Plain.\u001b[2J\u001b]52;c;cHduZWQ=\u0007 and&#27; nul\u0000 done');
  assert.ok(!/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.test(esc), JSON.stringify(esc));
  assert.equal(textField('\u001b]0;PWNED\u0007Charge Nurse \u001b[31mRED'), ']0;PWNED' + 'Charge Nurse [31mRED');
  assert.equal(stripControls('a\u0000b\u009bc‮d\te\nf'), 'abcd\te\nf');
  // The crawler's own htmlToText, which runs later on the stored description, gives back the same text.
  return import('@jobleft/parsers').then(({ htmlToText }) => {
    return import('../src/util.ts').then(({ cleanDescription }) => {
      const src = '<p>R&amp;D &atilde; 5 &lt; 6</p><ul><li>one</li><li>two</li></ul>';
      const once = descriptionText(src);
      assert.equal(htmlToText(cleanDescription(src)), once);
      assert.match(once, /R&D ã 5 < 6/);
    });
  });
});

test('every family stores clean text: entities, mixed markup and controls, through the adapters', async () => {
  const description = '<p>ICU nursing in S&atilde;o Paulo.</p>&lt;script&gt;alert(1)&lt;/script&gt;<p>Plain.\u001b[2J\u0007</p>';
  const jobs = await recruitee.fetchBoard(board('recruitee'), http({ offers: [
    { id: 960001, title: '\u001b]0;PWNED\u0007Nurse', careers_url: 'https://acme.recruitee.com/o/n', description },
  ] }));
  assert.equal(jobs[0].title, ']0;PWNEDNurse');
  const text = descriptionText(jobs[0].descriptionHtml);
  assert.match(text, /ICU nursing in São Paulo\./);
  assert.ok(!/[<>]|&[a-z]+;|[\u0000-\u0008\u001B]/.test(text), JSON.stringify(text));
});

// ------------------------------------------------------------ CLI: detect --json with several links

test('detect --json A B answers both links; detect --json A answers one', async () => {
  const run = promisify(execFile);
  const cli = join(HERE, '..', 'src', 'cli.ts');
  const two = JSON.parse((await run(process.execPath, [cli, 'detect', '--json', 'https://acme.recruitee.com/', 'https://jobs.lever.co/acme'], { encoding: 'utf8' })).stdout) as Array<{ input: string }>;
  assert.deepEqual(two.map((r) => r.input), ['https://acme.recruitee.com/', 'https://jobs.lever.co/acme']);
  const one = JSON.parse((await run(process.execPath, [cli, 'detect', 'https://acme.recruitee.com/', '--json'], { encoding: 'utf8' })).stdout) as unknown[];
  assert.equal(one.length, 1);
  const first = JSON.parse((await run(process.execPath, [cli, 'detect', '--json', 'https://acme.recruitee.com/'], { encoding: 'utf8' })).stdout) as unknown[];
  assert.equal(first.length, 1);
});

test('an escaped Greenhouse body decodes every entity with the full table (no "EUR", no raw &atilde;)', async () => {
  const content = '&lt;p&gt;S&amp;atilde;o Paulo &amp;euro;5 &amp;amp; &amp;ndash; caf&amp;eacute; &amp;#99999999999999999999; &amp;#x;&lt;/p&gt;';
  const jobs = await greenhouse.fetchBoard(board('greenhouse'), http({ jobs: [{ id: 9, title: 'X', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/9', content, location: { name: 'Sao Paulo' } }] }));
  assert.equal(descriptionText(jobs[0].descriptionHtml).replace(/&#x;/, '').replace(/\s+/g, ' ').trim(), 'São Paulo €5 & – café');
});

test('a Latin-1 feed (Content-Type charset or XML declaration) is read as UTF-8 text, not as replacement characters', async () => {
  const latin1 = Uint8Array.from([...'<?xml version="1.0" encoding="ISO-8859-1"?><t>Caf'].map((c) => c.charCodeAt(0)).concat([0xe9], [...' Z'].map((c) => c.charCodeAt(0)), [0xfc], [...'rich</t>'].map((c) => c.charCodeAt(0))));
  const f = politeFetch({ fetchImpl: (async () => new Response(latin1, { headers: { 'content-type': 'application/xml' } })) as typeof fetch, minGapMs: 0, marginMs: 0 });
  assert.equal(await (await f('https://a.example.org/x')).text(), '<?xml version="1.0" encoding="ISO-8859-1"?><t>Café Zürich</t>');
  const f2 = politeFetch({ fetchImpl: (async () => new Response(Uint8Array.from([0x47, 0x72, 0xfc, 0xdf, 0x65]), { headers: { 'content-type': 'application/rss+xml; charset=iso-8859-1' } })) as typeof fetch, minGapMs: 0, marginMs: 0 });
  assert.equal(await (await f2('https://b.example.org/x')).text(), 'Grüße');
  const f3 = politeFetch({ fetchImpl: (async () => new Response('Zürich', { headers: { 'content-type': 'text/plain; charset=utf-8' } })) as typeof fetch, minGapMs: 0, marginMs: 0 });
  assert.equal(await (await f3('https://c.example.org/x')).text(), 'Zürich');
});

test('the crawler pacer never reserves an absurd Crawl-delay for the next request to a host', async () => {
  const slept: number[] = [];
  let clock = 0;
  const pacer = new BoundedPacer(1000, 60_000, () => clock, async (ms) => { slept.push(ms); clock += ms; });
  await pacer.wait('slow.example.org');
  await pacer.wait('slow.example.org', 100_000_000); // robots.txt says Crawl-delay: 100000
  await pacer.wait('slow.example.org', 100_000_000);
  // The crawler pacer measures each gap from the last request with the caller's own delay, plus its 100 ms margin; the
  // absurd delay is cut to 60 s, so each of the two later requests waits 60.1 s, never 27 hours.
  assert.deepEqual(slept, [60_100, 60_100]);
});

test('a broken or cut-off answer gets a plain sentence, not "terminated"', () => {
  assert.match(plainReason('TypeError: terminated') ?? '', /stopped in the middle or its compression was broken/);
});

test('a CDATA marker inside a JSON description keeps its words', () => {
  assert.equal(descriptionText('<![CDATA[<p>Lead sales in <em>São Paulo</em>.</p>]]>'), 'Lead sales in São Paulo.');
  assert.equal(descriptionText('<p>A</p><![CDATA[B &amp; C]]><p>D</p>'), 'A\n\nB & C\n\nD'.replace(/\n\n/g, '\n'));
  assert.equal(descriptionText('text <![CDATA[ unterminated'), 'text  unterminated'.replace('  ', ' '));
});
