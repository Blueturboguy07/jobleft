// Outcomes O6, O7, O8 with the real pace (1 request per second per host): robots.txt, Crawl-delay, Retry-After, a
// failing host, the exact headers of every request, and hosts jobleft never contacts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoardList } from '../src/boardlist.ts';
import { checkUserAgent, ConfigError } from '../src/config.ts';
import { cfg, crawlOnce, jobsOf, startMockBoards, tempStore } from './helpers.ts';
import type { MockBoard, MockServer } from './helpers.ts';
import type { BoardRef } from '../src/types.ts';

function gaps(s: MockServer): number[] {
  const t = s.requests.map((r) => r.t);
  return t.slice(1).map((x, i) => x - t[i]!);
}

test('O6 + O7: at most one request per second per host, robots.txt obeyed, Crawl-delay and Retry-After honoured, a failing host asked less, one honest identity and nothing else', async () => {
  const gh = (p: string, extra: Partial<MockBoard> = {}): MockBoard => ({ ats: 'greenhouse', jobs: jobsOf(3, p), ...extra });
  const defs: Array<{ name: string; boards: Record<string, MockBoard>; robots?: { status: number; body: string } }> = [
    { name: 'busy', boards: { a1: gh('a1'), a2: gh('a2'), a3: gh('a3'), a4: gh('a4'), a5: gh('a5') } },
    { name: 'robots', boards: { open: gh('o'), secret: gh('s') }, robots: { status: 200, body: 'User-agent: *\nDisallow: /v1/boards/secret\n' } },
    { name: 'delay', boards: { d1: gh('d1'), d2: gh('d2') }, robots: { status: 200, body: 'User-agent: *\nCrawl-delay: 3\n' } },
    { name: 'toomany', boards: { t1: gh('t1', { mode: 'ratelimit429', retryAfter: 4 }), t2: gh('t2') } },
    { name: 'failing', boards: { f1: gh('f1', { mode: 'error500' }) } },
    { name: 'robots503', boards: { r1: gh('r1') }, robots: { status: 503, body: '' } },
  ];
  const servers: Record<string, MockServer> = {};
  const boards: BoardRef[] = [];
  for (const d of defs) {
    const m = await startMockBoards({ boards: d.boards, robots: d.robots ?? null });
    servers[d.name] = m;
    for (const token of Object.keys(d.boards)) boards.push({ ats: 'greenhouse', board: token, company: token, origin: m.origin });
  }
  const { store, cleanup } = tempStore();
  const second = tempStore();
  try {
    const out = await crawlOnce(store, boards, { pacerMs: 1000 });
    for (const [name, s] of Object.entries(servers)) {
      for (const g of gaps(s)) assert.ok(g >= 1000, `${name}: two requests ${g} ms apart`);
    }
    assert.equal(servers.robots!.requests.some((r) => r.path.startsWith('/v1/boards/secret')), false, 'no request to a disallowed path');
    for (const g of gaps(servers.delay!).slice(1)) assert.ok(g >= 3000, `Crawl-delay 3 s honoured (${g} ms)`);
    const tm = servers.toomany!.requests.filter((r) => r.path.startsWith('/v1'));
    const first429 = tm.findIndex((r) => r.status === 429);
    assert.ok(first429 >= 0);
    assert.ok(tm[first429 + 1]!.t - tm[first429]!.t >= 4000, 'nothing for the Retry-After time after a 429');
    assert.equal(servers.robots503!.requests.filter((r) => r.path.startsWith('/v1')).length, 0, 'an unreadable robots.txt means no crawl, not "all allowed"');
    const byBoard = new Map(out.report.boards.map((b) => [b.board, b]));
    assert.equal(byBoard.get('secret')!.status, 'robots');
    assert.equal(byBoard.get('r1')!.reasonCode, 'robots_unreadable');
    // The failing host: 3 tries in the first run, then one per run.
    const f1 = () => servers.failing!.requests.filter((r) => r.path.startsWith('/v1')).length;
    assert.equal(f1(), 3);
    await crawlOnce(store, boards.filter((b) => b.board === 'f1'), { pacerMs: 1000 });
    assert.equal(f1(), 4, 'a board that failed before is asked once, without retries');
    // A second, fresh install sends the same headers: nothing unique to an install, nothing personal, not a browser.
    await crawlOnce(second.store, boards.filter((b) => b.board === 'a1'), { pacerMs: 1000 });
    const all = Object.values(servers).flatMap((s) => s.requests);
    for (const r of all) {
      const names = Object.keys(r.headers).filter((h) => !['if-none-match', 'if-modified-since'].includes(h)).sort();
      assert.deepEqual(names, ['accept', 'accept-encoding', 'connection', 'host', 'user-agent'], `headers of ${r.path}`);
      assert.equal(r.headers['user-agent'], 'jobleft/0.1.2 (+https://github.com/Blueturboguy07/jobleft; no personal data)');
      assert.doesNotMatch(JSON.stringify(r), /jordan|testwell|mozilla|chrome|safari|cookie|referer/i);
    }
    const a1 = servers.busy!.requests.filter((r) => r.path.startsWith('/v1/boards/a1'));
    assert.equal(a1.length, 2);
    assert.deepEqual(a1[0]!.headers, a1[1]!.headers, 'two fresh installs send identical headers');
  } finally {
    cleanup();
    second.cleanup();
    for (const s of Object.values(servers)) await s.close();
  }
});

test('O8: forbidden hosts get no request, in board entries, links and redirects; the reason is said plainly', async () => {
  const list = parseBoardList(JSON.stringify([
    { url: 'https://www.linkedin.com/jobs/view/4000' }, { url: 'https://lnkd.in/abc' }, { url: 'https://www.indeed.com/viewjob?jk=1' },
    { url: 'https://www.glassdoor.com/job-listing/x' }, { url: 'https://jobs.smartrecruiters.com/Acme/1' },
    { url: 'https://acme.wd5.myworkdayjobs.com/en-US/External' }, { url: 'https://careers-acme.icims.com/jobs/1/job' },
    { url: 'https://acme.taleo.net/careersection/2/jobdetail.ftl' }, { url: 'https://recruiting.ultipro.com/ACM/JobBoard/1' },
    { url: 'https://bit.ly/3xyz' }, { ats: 'workday', board: 'acme' }, { ats: 'linkedin', board: 'acme' },
    { url: 'https://boards.greenhouse.io/acme/jobs/123' }, { url: 'https://jobs.lever.co/beta/abc' }, { url: 'https://jobs.ashbyhq.com/gamma' },
  ]));
  assert.deepEqual(list.boards.map((b) => `${b.ats}:${b.board}`), ['greenhouse:acme', 'lever:beta', 'ashby:gamma']);
  assert.equal(list.skipped.length, 12);
  for (const s of list.skipped) assert.match(s.reason, /never contacts|are off until the owner|not a Greenhouse, Lever or Ashby|nothing was sent/);
  const m = await startMockBoards({ boards: { moved: { ats: 'greenhouse', jobs: jobsOf(2, 'x'), mode: 'redirect', redirectTo: 'https://www.linkedin.com/jobs/view/1' } } });
  const { store, cleanup } = tempStore();
  try {
    const out = await crawlOnce(store, [{ ats: 'greenhouse', board: 'moved', company: 'Moved', origin: m.origin }], { config: cfg() });
    const r = out.report.boards[0]!;
    assert.equal(r.reasonCode, 'redirect');
    assert.match(r.reason ?? '', /linkedin\.com.*never contacts LinkedIn/);
    assert.equal(out.requests, 2, 'robots.txt and the board, nothing more');
  } finally {
    cleanup();
    await m.close();
  }
  for (const bad of ['Mozilla/5.0 (Macintosh) jobleft/0.1', 'jobleft/0.1 (contact: jordan.testwell@gmail.com)', 'curl/8.0', 'jobleft/0.1 Chrome/120']) {
    assert.throws(() => checkUserAgent(bad), ConfigError, bad);
  }
});
