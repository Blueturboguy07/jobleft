// The network layer, tested with a fake fetch: it must obey every crawling rule of the project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockedError, BudgetError, DeniedHostError, HostTrippedError, HttpClient, NotFoundError, Pacer, RobotsError, USER_AGENT } from '../src/http.ts';
import { parseRobots } from '../src/robots.ts';

interface Call { url: string; ua: string | null; t: number }
function fakeFetch(routes: Record<string, () => Response>, calls: Call[], clock: { t: number }): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, ua: headers.get('user-agent'), t: clock.t });
    const r = routes[url] ?? routes[new URL(url).pathname];
    if (!r) return new Response('not found', { status: 404 });
    return r();
  }) as typeof fetch;
}
const json = (o: unknown, status = 200) => () => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
function client(routes: Record<string, () => Response>, opts: { maxRequests?: number } = {}) {
  const calls: Call[] = [];
  const clock = { t: 0 };
  // Fake clock: sleep advances time instead of waiting, so the test proves the spacing without being slow.
  const pacer = new Pacer(1000, () => clock.t, async (ms) => { clock.t += ms; });
  const c = new HttpClient({ fetchImpl: fakeFetch(routes, calls, clock), pacer, retryDelayMs: 0, ...opts });
  return { c, calls, clock };
}

test('every request carries the neutral User-Agent and nothing personal', async () => {
  const { c, calls } = client({ '/robots.txt': () => new Response('User-agent: *\nDisallow: /embed/', { status: 200 }), '/v1/x': json({ ok: 1 }) });
  await c.getJson('https://boards-api.greenhouse.io/v1/x');
  assert.ok(calls.length >= 2);
  for (const call of calls) assert.equal(call.ua, USER_AGENT);
  assert.equal(USER_AGENT, 'jobleft/0.1.0 (+https://github.com/Blueturboguy07/jobleft; no personal data)');
});

test('pacer: two requests to one host are at least 1000 ms apart; a second host is not delayed', async () => {
  const { c, calls } = client({ '/robots.txt': () => new Response('', { status: 404 }), '/a': json({}), '/b': json({}) });
  await c.getJson('https://api.lever.co/a');
  await c.getJson('https://api.lever.co/b');
  const lever = calls.filter((x) => x.url.includes('api.lever.co')).map((x) => x.t);
  for (let i = 1; i < lever.length; i++) assert.ok(lever[i] - lever[i - 1] >= 1000, `gap ${lever[i] - lever[i - 1]}`);
  const before = calls.length;
  await c.getJson('https://api.ashbyhq.com/a');
  const ashby = calls.slice(before)[0];
  assert.ok(ashby.t - lever[lever.length - 1] < 1000, 'other host must not wait on lever');
});

test('pacer: Crawl-delay above 1s is honoured (Lever asks for 1s, a stricter host could ask for 5s)', async () => {
  const { c, calls } = client({ '/robots.txt': () => new Response('User-agent: *\nCrawl-delay: 5\n', { status: 200 }), '/a': json({}), '/b': json({}) });
  await c.getJson('https://slow.example.com/a');
  await c.getJson('https://slow.example.com/b');
  const ts = calls.filter((x) => !x.url.endsWith('robots.txt')).map((x) => x.t);
  assert.ok(ts[1] - ts[0] >= 5000);
});

test('403 and 429 stop the board at once: no retry, a BlockedError', async () => {
  for (const status of [403, 429]) {
    const { c, calls } = client({ '/robots.txt': () => new Response('', { status: 404 }), '/v': json({}, status) });
    await assert.rejects(c.getJson('https://api.lever.co/v'), BlockedError);
    assert.equal(calls.filter((x) => x.url.endsWith('/v')).length, 1, `status ${status} must not be retried`);
  }
});

test('two blocked responses in a row trip the host: later boards on it are skipped without a request', async () => {
  const { c, calls } = client({ '/robots.txt': () => new Response('', { status: 404 }), '/v': json({}, 429) });
  await assert.rejects(c.getJson('https://api.lever.co/v'), BlockedError);
  await assert.rejects(c.getJson('https://api.lever.co/v'), BlockedError);
  const n = calls.length;
  await assert.rejects(c.getJson('https://api.lever.co/v'), HostTrippedError);
  assert.equal(calls.length, n);
});

test('a 5xx is retried up to 2 times, then fails; a 404 is not retried', async () => {
  const { c, calls } = client({ '/robots.txt': () => new Response('', { status: 404 }), '/v': json({}, 503), '/nf': json({}, 404) });
  await assert.rejects(c.getJson('https://api.lever.co/v'));
  assert.equal(calls.filter((x) => x.url.endsWith('/v')).length, 3);
  await assert.rejects(c.getJson('https://api.lever.co/nf'), NotFoundError);
  assert.equal(calls.filter((x) => x.url.endsWith('/nf')).length, 1);
});

test('robots.txt: a disallowed path is never requested', async () => {
  const { c, calls } = client({ '/robots.txt': () => new Response('User-agent: *\nDisallow: /embed/\n', { status: 200 }), '/embed/x': json({}) });
  await assert.rejects(c.getJson('https://boards-api.greenhouse.io/embed/x'), RobotsError);
  assert.equal(calls.some((x) => x.url.endsWith('/embed/x')), false);
});

test('robots.txt: a server error while reading it means "assume disallowed"; a 404/401 means no rules', async () => {
  const bad = client({ '/robots.txt': () => new Response('', { status: 503 }), '/a': json({}) });
  await assert.rejects(bad.c.getJson('https://x.example.com/a'), RobotsError);
  const none = client({ '/robots.txt': () => new Response('Unauthorized', { status: 401 }), '/a': json({ ok: true }) });
  assert.deepEqual(await none.c.getJson('https://api.ashbyhq.com/a'), { ok: true });
});

test('never-crawl list: LinkedIn, Indeed, Glassdoor, SmartRecruiters and Workday are refused before any request', async () => {
  const { c, calls } = client({});
  for (const u of ['https://www.linkedin.com/jobs', 'https://www.indeed.com/x', 'https://www.glassdoor.com/x', 'https://api.smartrecruiters.com/v1/companies/x/postings', 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/x/jobs']) {
    await assert.rejects(c.getJson(u), DeniedHostError, u);
  }
  assert.equal(calls.length, 0);
});

test('request budget: the client refuses to send more than the configured total', async () => {
  const { c } = client({ '/robots.txt': () => new Response('', { status: 404 }), '/a': json({}) }, { maxRequests: 2 });
  await c.getJson('https://api.lever.co/a'); // robots + 1
  await assert.rejects(c.getJson('https://api.lever.co/a'), BudgetError);
});

test('redirects are not followed (a redirect could skip the pacer, robots and deny-list)', async () => {
  const { c, calls } = client({ '/robots.txt': () => new Response('', { status: 404 }), '/r': () => new Response('', { status: 302, headers: { location: 'https://www.linkedin.com/' } }) });
  await assert.rejects(c.getJson('https://api.lever.co/r'));
  assert.equal(calls.some((x) => x.url.includes('linkedin')), false);
});

test('robots parser: product token group beats *, longest match wins, Allow wins a tie, wildcards and $ work', () => {
  const r = parseRobots(`User-agent: *\nDisallow: /\nUser-agent: jobleft-build\nDisallow: /private\nAllow: /private/open$\nDisallow: /*.json$\nCrawl-delay: 2`, 'jobleft-build');
  assert.equal(r.allows('/jobs'), true);
  assert.equal(r.allows('/private/x'), false);
  assert.equal(r.allows('/private/open'), true);
  assert.equal(r.allows('/a/b.json'), false);
  assert.equal(r.crawlDelayMs, 2000);
  const star = parseRobots('User-agent: *\nDisallow: /embed/\n', 'jobleft-build');
  assert.equal(star.allows('/embed/x'), false);
  assert.equal(star.allows('/v1/boards/x/jobs?content=true'), true);
});
