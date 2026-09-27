// Jobs added by link or by pasted text (External tab), from the black-box feed findings: links to this computer or
// the local network are never read (JL-feed-13), pages and texts that are not job postings are refused in plain
// words (JL-feed-12), the link keeps its scheme (JL-feed-13), the same posting is never stored twice (JL-feed-14),
// and a Greenhouse job link is read through the board's job API instead of failing on its redirect (JL-feed-15).
// A job added from pasted text: the text's own apply link is used; with none, the job has no apply link (the UI then
// shows "No apply link" instead of opening the reserved no-link address) (JL-tracker-12).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { greenhouseJob, startBoards, type Mock } from '../scripts/mocks.ts';
import { cleanup, scratchHome, startTest, type TestServer } from './helpers.ts';

let s: TestServer;
let boards: Mock;
let dir: string;

const LD = { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Pastry Chef', hiringOrganization: { '@type': 'Organization', name: 'Crumb & Co' }, description: '<p>Bake things.</p>', jobLocation: { '@type': 'Place', address: { addressLocality: 'Portland', addressRegion: 'OR', addressCountry: 'US' } } };
const PLAIN = `<html><head><title>Line Cook - Harbor Diner</title></head><body><h1>Line Cook</h1>
<p>Harbor Diner is hiring a line cook for our busy kitchen in Portland.</p>
<h2>Responsibilities</h2><ul><li>Prepare food on the line to our recipes</li><li>Keep the station clean and stocked</li></ul>
<h2>Qualifications</h2><ul><li>One year of kitchen experience</li><li>Food handler card</li></ul>
<p>Full-time, $20 to $24 per hour, with benefits. Apply on this page.</p></body></html>`;

async function waitCrawl(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const st = (await s.call('GET', '/api/v1/crawl/status')).json;
    if (!st.running && st.lastRun) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('crawl did not finish');
}

before(async () => {
  dir = scratchHome('extfix');
  const file = join(dir, 'boards.json');
  writeFileSync(file, JSON.stringify({
    greenhouse: {
      acme: [greenhouseJob(1, { board: 'acme', title: 'AI & Data Analyst', location: 'Washington, DC' })],
      otherco: [greenhouseJob(77, { board: 'otherco', title: 'Payroll Specialist', location: 'Austin, TX', content: '<p>Run payroll. You have 2+ years of payroll experience.</p>' })],
    },
    pages: {
      '/careers/pastry-chef': `<html><head><title>Careers</title><script type="application/ld+json">${JSON.stringify(LD)}</script></head><body>x</body></html>`,
      '/careers/line-cook': PLAIN,
      '/': '<html><head><title>Example Domain</title></head><body><h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.</p><p><a href="https://www.iana.org/domains/example">More information...</a></p></body></html>',
    },
  }));
  boards = await startBoards({ file });
  const map = { 'boards-api.greenhouse.io': boards.origin, 'jobs.example.com': boards.origin, 'www.example.com': boards.origin };
  s = await startTest('extfix', { env: { JOBLEFT_HOST_MAP: JSON.stringify(map) } });
  assert.equal((await s.call('POST', '/api/v1/boards', { ats: 'greenhouse', board: 'acme' })).status, 200);
  await s.call('POST', '/api/v1/crawl/run', {});
  await waitCrawl();
});

after(async () => { await s.stop(); await boards.close(); cleanup(s.home); cleanup(dir); });

const add = (body: Record<string, unknown>) => s.call('POST', '/api/v1/jobs/external', body);

test('JL-feed-13: a link to this computer or the local network is refused and never read', async () => {
  const sent = boards.log.length;
  for (const url of ['http://localhost:47862/', 'http://127.0.0.1:47862/api/v1/health', 'http://[::1]:47862/', 'http://192.168.1.20/jobs/1', 'http://intranet/jobs/1', `${boards.origin}/careers/line-cook`]) {
    const r = await add({ url });
    assert.equal(r.status, 422, `${url}: ${r.text}`);
    assert.equal(r.json.error.code, 'forbidden_source');
    assert.match(r.json.error.message, /this computer or your local network/);
  }
  assert.equal(boards.log.length, sent, 'nothing was sent');
});

test('JL-feed-12: a page or a text that is not a job posting is refused in plain words; a real posting page is added', async () => {
  const ex = await add({ url: 'https://www.example.com/' });
  assert.equal(ex.status, 422, ex.text);
  assert.match(ex.json.error.message, /does not look like a job posting/);
  const hi = await add({ text: 'hi' });
  assert.equal(hi.status, 400, hi.text);
  assert.match(hi.json.error.message, /too short to be a job posting/);
  const cook = await add({ url: 'https://jobs.example.com/careers/line-cook' });
  assert.equal(cook.status, 200, cook.text);
  assert.equal(cook.json.job.title, 'Line Cook - Harbor Diner');
  const external = (await s.call('GET', '/api/v1/tracker?view=external')).json.items.map((x: any) => x.job.title);
  assert.ok(!external.includes('Example Domain') && !external.includes('hi'), JSON.stringify(external));
});

test('JL-feed-13 and JL-feed-14: the link keeps its scheme, and the same posting added twice is one job', async () => {
  const a = await add({ url: 'http://jobs.example.com/careers/pastry-chef' });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.job.url, 'http://jobs.example.com/careers/pastry-chef', 'the link the person gave, not an https rewrite');
  const b = await add({ url: 'https://jobs.example.com/careers/pastry-chef?utm_source=mail' });
  assert.equal(b.status, 200, b.text);
  assert.equal(b.json.job.id, a.json.job.id);
  const titles = (await s.call('GET', '/api/v1/tracker?view=external')).json.items.map((x: any) => x.job.title);
  assert.equal(titles.filter((t: string) => t === 'Pastry Chef').length, 1);
});

test('JL-feed-14 and JL-feed-15: a Greenhouse job link is the feed job when stored, else read through the board API', async () => {
  const sent = boards.log.length;
  const feed = await add({ url: 'https://boards.greenhouse.io/acme/jobs/1?gh_jid=1' });
  assert.equal(feed.status, 200, feed.text);
  assert.equal(feed.json.job.id, 'greenhouse:acme:1', 'the feed job, not a copy with the host as company');
  assert.equal(boards.log.length, sent, 'a stored job needs no request');
  const other = await add({ url: 'https://job-boards.greenhouse.io/otherco/jobs/77' });
  assert.equal(other.status, 200, other.text);
  assert.deepEqual([other.json.job.title, other.json.job.company], ['Payroll Specialist', 'otherco']);
  assert.equal(other.json.job.places[0].text, 'Austin, TX');
  assert.equal(other.json.job.url, 'https://job-boards.greenhouse.io/otherco/jobs/77');
  assert.ok(boards.log.some((e) => e.path === '/v1/boards/otherco/jobs/77'));
  const gone = await add({ url: 'https://boards.greenhouse.io/otherco/jobs/78' });
  assert.equal(gone.status, 404, gone.text);
  assert.match(gone.json.error.message, /not on the board/);
});

test('pasted text: the apply link the text states is the apply link; no link stays no link', async () => {
  const s = await startTest('ext');
  try {
    const a = await s.call('POST', '/api/v1/jobs/external', { text: 'Data Analyst\nQA Test Corp\nAustin, TX (Hybrid)\nFull-time. $80,000 - $95,000 per year.\nSee our site https://example.com/about for more.\nApply at https://example.com/careers/data-analyst.' });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.job.applyUrl, 'https://example.com/careers/data-analyst');
    assert.equal(new URL(a.json.job.url).hostname, 'jobleft.invalid', 'the text is not a page: its own address stays the no-link one');
    const b = await s.call('POST', '/api/v1/jobs/external', { text: 'Senior Data Analyst at Northwind Traders\nLocation: Remote (US)\nTo apply email jobs@northwind.example' });
    assert.equal(b.status, 200, b.text);
    assert.equal(b.json.job.applyUrl, null);
    assert.equal(new URL(b.json.job.url).hostname, 'jobleft.invalid');
    // Two postings that name one careers page stay two jobs.
    const c = await s.call('POST', '/api/v1/jobs/external', { text: 'Data Engineer\nApply at https://example.com/careers/data-analyst' });
    assert.notEqual(c.json.job.id, a.json.job.id);
    // A link the person types wins over the text.
    const d = await s.call('POST', '/api/v1/jobs/external', { text: 'ML Engineer\nApply at https://example.com/careers/ml', applyUrl: 'https://jobs.example.org/ml-1' });
    assert.equal(d.json.job.url, 'https://jobs.example.org/ml-1');
  } finally { await s.stop(); cleanup(s.home); }
});
