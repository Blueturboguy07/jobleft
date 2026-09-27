import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardError } from '../src/index.ts';
import type { PaidPageFetcher } from '../src/index.ts';
import { rig, row } from './helpers.ts';

const CONFIG = {
  boards: {
    'greenhouse:acme': { name: 'Acme Robotics', jobs: 4 },
    'greenhouse:emptyco': { name: 'Empty Co', jobs: 0 },
    'lever:beta': { jobs: 3, pageTitle: 'Beta Labs' },
    'lever:eu:euro': { jobs: 2, pageTitle: 'Euro GmbH' },
    'ashby:gamma': { jobs: 7, pageTitle: 'Gamma AI' },
    'lever:partnerco': { jobs: 1, pageTitle: 'Partner Co' },
  },
  pages: {
    '/embed.html': '<html><body><h1>Join Acme</h1><div id="grnhse_app"></div><script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script><footer><a href="https://jobs.lever.co/partnerco">Partner jobs</a></footer></body></html>',
    '/two.html': '<a href="https://boards.greenhouse.io/acme">US</a><a href="https://jobs.ashbyhq.com/gamma">Labs</a>',
    '/listing': '<html><script>var gh = "https://boards.greenhouse.io/embed/job_app?for=acme&token=1001"</script></html>',
    '/home.html': '<html><a href="/careers.html">Careers</a></html>',
    '/careers.html': '<iframe src="https://jobs.lever.co/beta"></iframe>',
    '/framed.html': '<h1>Work with us</h1><iframe src="/frame-inner.html"></iframe>',
    '/frame-inner.html': '<script src="https://jobs.ashbyhq.com/gamma/embed?version=2"></script>',
    '/nothing.html': '<html><h1>About us</h1><p>We make things.</p></html>',
    '/scriptonly.html': '<div id="grnhse_app"></div><script>loadBoard()</script>',
    '/to-workday.html': '<meta http-equiv="refresh" content="0; url=https://acme.wd5.myworkdayjobs.com/External">',
  },
  redirects: { '/go': 'https://jobs.ashbyhq.com/gamma', '/loop': '/loop2', '/loop2': '/loop' },
};

test('a board link: provider, the name the board reports, open jobs; adds nothing until add()', async () => {
  const r = await rig(CONFIG);
  try {
    const a = await r.service.resolve('https://job-boards.greenhouse.io/ACME/jobs/1001?gh_src=x');
    assert.equal(a.reason, null);
    assert.equal(a.candidates.length, 1);
    assert.deepEqual({ ...a.candidates[0] }, { boardId: 'greenhouse:acme', ats: 'greenhouse', board: 'acme', region: null, company: 'Acme Robotics', openJobs: 4, alreadyAdded: false });
    assert.equal(r.service.list({ view: 'user' }).total, 0, 'resolve adds nothing');
    const e = r.service.add({ ats: 'greenhouse', board: 'acme' });
    assert.equal(e.origin, 'user');
    assert.equal(e.company, 'Acme Robotics');
    assert.equal(e.state, 'live', 'the paste check counts as the first observed check');
    assert.equal(e.openJobs, 4);
    // The same board through four other shapes: one board, "already added", and add() refuses.
    for (const link of ['https://boards.greenhouse.io/acme', 'https://boards.greenhouse.io/embed/job_board?for=Acme', 'boards-api.greenhouse.io/v1/boards/acme/jobs', 'https://BOARDS.GREENHOUSE.IO/acme/?utm_campaign=x']) {
      const x = await r.service.resolve(link);
      assert.equal(x.candidates[0]?.boardId, 'greenhouse:acme', link);
      assert.equal(x.candidates[0]?.alreadyAdded, true, link);
    }
    assert.throws(() => r.service.add({ ats: 'greenhouse', board: 'ACME' }), (err: unknown) => err instanceof BoardError && err.code === 'conflict');
    assert.equal(r.service.list({ view: 'user' }).total, 1);
  } finally { await r.close(); }
});

test('Lever and Ashby names come from the board page; an EU Lever board is found on the EU host', async () => {
  const r = await rig(CONFIG);
  try {
    const l = await r.service.resolve('https://jobs.lever.co/beta/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b');
    assert.equal(l.candidates[0]?.company, 'Beta Labs');
    assert.equal(l.candidates[0]?.openJobs, 3);
    const eu = await r.service.resolve('https://jobs.lever.co/euro');
    assert.equal(eu.candidates[0]?.boardId, 'lever:eu:euro');
    assert.equal(eu.candidates[0]?.company, 'Euro GmbH');
    const g = await r.service.resolve('https://jobs.ashbyhq.com/gamma/embed?version=2');
    assert.equal(g.candidates[0]?.company, 'Gamma AI');
    assert.equal(g.candidates[0]?.openJobs, 7);
  } finally { await r.close(); }
});

test('the directory name is used when the board does not report one; never the link text', async () => {
  const r = await rig({ boards: { 'lever:quiet': { jobs: 2 } } }, { directory: [row('lever', 'quiet', 'Quiet Company')] });
  try {
    const a = await r.service.resolve('https://jobs.lever.co/quiet');
    assert.equal(a.candidates[0]?.company, 'Quiet Company');
  } finally { await r.close(); }
});

test('employer pages: script embed, footer partner ignored, two boards, gh_jid link, redirect, careers hop', async () => {
  const r = await rig(CONFIG);
  try {
    const e = await r.service.resolve('https://careers.mock.example/embed.html');
    assert.deepEqual(e.candidates.map((c) => c.boardId), ['greenhouse:acme']);
    const two = await r.service.resolve('https://careers.mock.example/two.html');
    assert.deepEqual(new Set(two.candidates.map((c) => c.boardId)), new Set(['greenhouse:acme', 'ashby:gamma']));
    const jid = await r.service.resolve('https://careers.mock.example/listing?gh_jid=1001');
    assert.deepEqual(jid.candidates.map((c) => c.boardId), ['greenhouse:acme']);
    const go = await r.service.resolve('https://careers.mock.example/go');
    assert.deepEqual(go.candidates.map((c) => c.boardId), ['ashby:gamma']);
    const hop = await r.service.resolve('https://careers.mock.example/home.html');
    assert.deepEqual(hop.candidates.map((c) => c.boardId), ['lever:beta']);
    const framed = await r.service.resolve('https://careers.mock.example/framed.html');
    assert.deepEqual(framed.candidates.map((c) => c.boardId), ['ashby:gamma']);
  } finally { await r.close(); }
});

test('"cannot" answers: plain words, a reason, nothing added, no request to forbidden hosts', async () => {
  const r = await rig(CONFIG);
  try {
    const cases: Array<[string, string]> = [
      ['hello there', 'not_a_link'],
      ['https://www.linkedin.com/jobs/view/12345', 'forbidden_host'],
      ['https://acme.wd5.myworkdayjobs.com/en-US/External/job/1', 'forbidden_host'],
      ['https://acme.bamboohr.com/careers', 'unsupported_provider'],
      ['https://careers.mock.example/missing.html', 'broken_link'],
      ['https://careers.mock.example/nothing.html', 'no_board_found'],
      ['https://careers.mock.example/scriptonly.html', 'no_board_found'],
      ['https://careers.mock.example/to-workday.html', 'forbidden_host'],
      ['https://careers.mock.example/loop', 'broken_link'],
      ['https://boards.greenhouse.io/nosuchboard', 'no_board_found'],
      ['https://job-boards.eu.greenhouse.io/acme', 'unsupported_provider'],
    ];
    for (const [link, reason] of cases) {
      const a = await r.service.resolve(link);
      assert.equal(a.candidates.length, 0, link);
      assert.equal(a.reason, reason, `${link}: ${a.message}`);
      assert.ok(a.message.length > 20 && !/Error:|at \w+ \(/.test(a.message), `plain message for ${link}: ${a.message}`);
    }
    assert.equal(r.service.list({}).total, 0);
    assert.ok(r.sent.every((u) => new URL(u).hostname === '127.0.0.1'), 'every request went to a mock host');
    assert.ok(!r.sent.some((u) => /linkedin|myworkdayjobs|bamboohr/i.test(u)), 'no request named a forbidden or unsupported host');
  } finally { await r.close(); }
});

test('offline: no request, the link is kept as pending', async () => {
  const r = await rig(CONFIG, { offline: true });
  try {
    const a = await r.service.resolve('https://boards.greenhouse.io/acme');
    assert.equal(a.reason, 'offline');
    assert.equal(r.mock.log.length, 0);
    assert.deepEqual(r.service.listPending().map((p) => p.url), ['https://boards.greenhouse.io/acme']);
  } finally { await r.close(); }
});

test('a real network failure on a provider link says offline, keeps the link, adds nothing (never "robots.txt")', async () => {
  // Every connect fails the way a dead network fails. The crawler reads an unreachable robots.txt as "disallow all";
  // that must not reach the person as a robots.txt block.
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ETIMEDOUT']) {
    const fetchImpl = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) }); }) as typeof fetch;
    const r = await rig(CONFIG, { fetchImpl });
    try {
      const links = ['https://boards.greenhouse.io/acme', 'https://jobs.lever.co/beta', 'https://jobs.ashbyhq.com/gamma'];
      for (const link of links) {
        const a = await r.service.resolve(link);
        assert.equal(a.candidates.length, 0, `${code} ${link}: nothing offered`);
        assert.equal(a.reason, 'offline', `${code} ${link}: ${a.message}`);
        assert.doesNotMatch(a.message, /robots/i, `${code} ${link}`);
        assert.match(a.message, /pending links/, `${code} ${link}`);
      }
      assert.deepEqual(r.service.listPending().map((p) => p.url).sort(), links.sort(), `${code}: every link is kept`);
      assert.equal(r.service.list({}).total, 0, 'nothing was added');
    } finally { await r.close(); }
  }
});

test('a robots.txt that says no is still a robots block; a link kept while the network was down clears when it works again', async () => {
  const r = await rig({ ...CONFIG, robots: { 'boards-api.greenhouse.io': 'User-agent: *\nDisallow: /' } });
  try {
    const a = await r.service.resolve('https://boards.greenhouse.io/acme');
    assert.equal(a.reason, 'blocked_by_robots');
    assert.deepEqual(r.service.listPending(), []);
  } finally { await r.close(); }
  // The network is down for the first attempts only; the shared client must not stay stuck on "robots.txt unreadable".
  let failing = true;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => failing
    ? Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }))
    : fetch(input, init)) as typeof fetch;
  const r2 = await rig(CONFIG, { fetchImpl });
  try {
    const down = await r2.service.resolve('https://boards.greenhouse.io/acme');
    assert.equal(down.reason, 'offline');
    assert.equal(r2.service.listPending().length, 1);
    failing = false;
    const up = await r2.service.resolve('https://boards.greenhouse.io/acme');
    assert.equal(up.candidates.length, 1, up.message);
    assert.equal(up.candidates[0]!.openJobs, 4);
    assert.deepEqual(r2.service.listPending(), [], 'the kept link is cleared once the link works');
  } finally { await r2.close(); }
});

test('paid lookup: offered with a dollar price, never used unless accepted, used once when accepted', async () => {
  let calls = 0;
  const paid: PaidPageFetcher = {
    enabled: true,
    prices: () => ({ page: 2000, jsPage: 4000 }),
    fetchPage: async (url) => { calls++; return { url, html: '<a href="https://jobs.lever.co/beta">Jobs</a>', costMicros: 4000 }; },
  };
  const r = await rig(CONFIG, { paid });
  try {
    const offer = await r.service.resolve('https://careers.mock.example/scriptonly.html');
    assert.equal(offer.reason, 'no_board_found');
    assert.deepEqual(offer.paidLookup, { priceMicros: 4000 });
    assert.match(offer.message, /\$0\.004/);
    assert.doesNotMatch(offer.message, /credit/i);
    assert.equal(calls, 0);
    const used = await r.service.resolve('https://careers.mock.example/scriptonly.html', { acceptPaidLookup: true });
    assert.equal(calls, 1);
    assert.equal(used.candidates[0]?.boardId, 'lever:beta');
    assert.match(used.message, /\$0\.004 from your balance/);
  } finally { await r.close(); }
});

// JL-settings-12: the app server keeps the person's boards in its own table; its answer decides "already added".
test('a host app that keeps its own board list decides "already added" (isAdded)', async () => {
  const mine = new Set(['greenhouse:acme']);
  const r = await rig(CONFIG, { isAdded: (id) => mine.has(id) });
  try {
    const a = await r.service.resolve('https://boards.greenhouse.io/acme');
    assert.equal(a.candidates[0]?.alreadyAdded, true);
    assert.match(a.message, /already in your boards/);
    const b = await r.service.resolve('https://jobs.ashbyhq.com/gamma');
    assert.equal(b.candidates[0]?.alreadyAdded, false);
    mine.add('ashby:gamma');
    assert.equal((await r.service.resolve('https://jobs.ashbyhq.com/gamma')).candidates[0]?.alreadyAdded, true, 'a cached answer is read again');
  } finally { await r.close(); }
});
