import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanPage } from '../src/index.ts';

const PAGE = new URL('https://careers.acme.example/jobs');
const ids = (html: string, url = PAGE) => scanPage(html, url).boards.map((b) => b.id);

test('a board behind a plain link, a frame, a script embed, an Apply button or a form', () => {
  assert.deepEqual(ids('<a href="https://boards.greenhouse.io/acme">Open roles</a>'), ['greenhouse:acme']);
  assert.deepEqual(ids('<iframe src="https://job-boards.greenhouse.io/embed/job_board?for=acme"></iframe>'), ['greenhouse:acme']);
  assert.deepEqual(ids('<div id="grnhse_app"></div><script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>'), ['greenhouse:acme']);
  assert.deepEqual(ids('<a class="btn" href="https://jobs.lever.co/acme/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b/apply">Apply now</a>'), ['lever:acme']);
  assert.deepEqual(ids('<form action="https://jobs.ashbyhq.com/acme/2b5c8e4a-1111-4222-8333-944455556666/application"></form>'), ['ashby:acme']);
  assert.deepEqual(ids('<script src="https://jobs.ashbyhq.com/acme/embed?version=2"></script>'), ['ashby:acme']);
});

test('inline embed configs and escaped JSON addresses', () => {
  assert.deepEqual(ids('<script>window.leverJobsOptions = {accountName: "acme", includeCss: true};</script>'), ['lever:acme']);
  assert.deepEqual(ids('<script>Grnhse.Settings = { boardToken: "acme" };</script>'), ['greenhouse:acme']);
  assert.deepEqual(ids('<script>window.__cfg = {"jobs":"https:\\/\\/jobs.ashbyhq.com\\/acme"}</script>'), ['ashby:acme']);
  assert.deepEqual(ids('<script>var o = { organizationHostedJobsPageName: "acme" };</script>'), ['ashby:acme']);
});

test('redirects: meta refresh and script location', () => {
  assert.deepEqual(ids('<meta http-equiv="refresh" content="0; url=https://jobs.lever.co/acme">'), ['lever:acme']);
  assert.deepEqual(ids('<script>window.location.href = "https://boards.greenhouse.io/acme";</script>'), ['greenhouse:acme']);
  const s = scanPage('<meta http-equiv="refresh" content="0;url=/careers/open">', PAGE);
  assert.equal(s.boards.length, 0);
  assert.equal(s.redirect, 'https://careers.acme.example/careers/open');
});

test("a partner's board in the footer never beats the employer's own embed", () => {
  const html = `<main><iframe src="https://boards.greenhouse.io/embed/job_board?for=acme"></iframe></main>
    <footer><a href="https://jobs.lever.co/partnerco">Our partner is hiring</a></footer>`;
  assert.deepEqual(ids(html), ['greenhouse:acme']);
  // Only a footer link: it is kept (the person chooses), never silently dropped.
  assert.deepEqual(ids('<footer><a href="https://jobs.lever.co/partnerco">Partner jobs</a></footer>'), ['lever:partnerco']);
});

test('two boards on one page are both offered; comments and provider home links are ignored', () => {
  const html = `<a href="https://boards.greenhouse.io/acme">US roles</a> <a href="https://jobs.lever.co/acme-eu">EU roles</a>
    <!-- <a href="https://jobs.ashbyhq.com/oldboard">old</a> --> <a href="https://www.greenhouse.io/">Powered by Greenhouse</a>`;
  assert.deepEqual(new Set(ids(html)), new Set(['greenhouse:acme', 'lever:acme-eu']));
});

test('a page with no board gives hints, careers links and no guess', () => {
  const s = scanPage('<div id="grnhse_app"></div><a href="/careers">Careers</a><a href="https://news.example/x">News</a>', new URL('https://www.acme.example/'));
  assert.equal(s.boards.length, 0);
  assert.deepEqual(s.providerHints, ['greenhouse']);
  assert.deepEqual(s.careersLinks, ['https://www.acme.example/careers']);
  const w = scanPage('<script src="https://acme.wd5.myworkdayjobs.com/embed.js"></script>', PAGE);
  assert.equal(w.forbiddenTarget, 'Workday');
});

test('hostile pages: 4 MB of unclosed tags scan quickly and find nothing false', () => {
  const junk = '<nav><footer><aside><script><div class="footer"><a href="x'.repeat(40_000) + 'x'.repeat(2_000_000);
  const t0 = performance.now();
  const s = scanPage(junk, PAGE);
  assert.ok(performance.now() - t0 < 3000, `took ${Math.round(performance.now() - t0)} ms`);
  assert.equal(s.boards.length, 0);
  const many = Array.from({ length: 5000 }, (_, i) => `<a href="https://jobs.lever.co/co${i}">x</a>`).join('');
  const t1 = performance.now();
  assert.equal(scanPage(many, PAGE).boards.length, 5000);
  assert.ok(performance.now() - t1 < 3000);
});
