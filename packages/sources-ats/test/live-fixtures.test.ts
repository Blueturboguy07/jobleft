// The adapters on real payloads captured once from public boards on 2026-09-25 (test/fixtures/live/README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJob } from '@jobleft/crawler';
import type { BoardRef, RawJob } from '@jobleft/crawler';
import { gem, gemUrl } from '../src/adapters/gem.ts';
import { personio, personioUrl } from '../src/adapters/personio.ts';
import { recruitee, recruiteeUrl } from '../src/adapters/recruitee.ts';
import { teamtailor, teamtailorPageUrl } from '../src/adapters/teamtailor.ts';
import { workable, workableUrl } from '../src/adapters/workable.ts';
import { fakeHttp, fixture } from './helpers.ts';

function clean(jobs: RawJob[], board: BoardRef): void {
  for (const r of jobs) {
    assert.ok(!r.unreadable, `unreadable job on ${board.ats}`);
    const j = normalizeJob(board, r);
    assert.ok(j, `${board.ats} job ${r.externalId} did not normalise`);
    for (const bad of ['<p', '<li', '<br', '&amp;', '&lt;', '&gt;', '&#', 'CDATA', '<script', '<iframe']) {
      assert.ok(!j.description.includes(bad), `${board.ats} ${r.externalId} description contains ${bad}`);
      assert.ok(!j.title.includes(bad), `${board.ats} ${r.externalId} title contains ${bad}`);
    }
    assert.match(j.canonicalUrl, /^https:\/\//);
    assert.ok(j.description.length > 50, `${board.ats} ${r.externalId} description is empty`);
  }
}

test('Workable: huggingface widget payload maps every field', async () => {
  const board: BoardRef = { ats: 'workable', board: 'huggingface', company: 'Hugging Face (directory name)' };
  const http = fakeHttp({ [workableUrl('huggingface')]: fixture('live/workable-huggingface.json') });
  const jobs = await workable.fetchBoard(board, http);
  assert.deepEqual(http.calls, ['https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true']);
  assert.equal(jobs.length, 4);
  const byId = Object.fromEntries(jobs.map((j) => [j.externalId, j]));
  const a = byId.F4C096B22E;
  assert.equal(a.title, 'Low-level Senior Software Engineer, Xet Storage - EMEA Remote');
  assert.equal(a.company, 'Hugging Face'); // the account name the board reports
  assert.equal(a.location, 'France'); // the location is marked hidden: only its country is shown
  assert.deepEqual(a.countries, ['FR']);
  assert.equal(a.remote, true);
  assert.equal(a.workMode, 'remote');
  assert.equal(a.postedAt, '2026-07-30T12:00:00.000Z');
  assert.equal(a.url, 'https://apply.workable.com/j/F4C096B22E');
  assert.equal(a.applyUrl, 'https://apply.workable.com/j/F4C096B22E/apply');
  assert.equal(a.employmentType, 'full_time');
  assert.equal(a.department, 'Product');
  assert.equal(a.pay, null);
  assert.equal(byId['19A136F8E2'].location, 'New York, United States'); // not hidden: city, region, country
  assert.equal(byId.DB4D7C0EC8.location, 'France');
  clean(jobs, board);
});

test('Workable: one job listed once per location becomes one job with every place (live payload)', async () => {
  const board: BoardRef = { ats: 'workable', board: 'careers-ewingirrigation', company: 'Ewing Outdoor Supply' };
  const http = fakeHttp({ [workableUrl('careers-ewingirrigation')]: fixture('live/workable-careers-ewingirrigation.json') });
  const jobs = await workable.fetchBoard(board, http);
  assert.equal(jobs.length, 2); // 5 rows: 4 rows of one shortcode + 1 other job
  const mit = jobs.find((j) => j.externalId === '6177CE2ED4')!;
  assert.equal(mit.location, 'College Station, Texas, United States; Dallas, Texas, United States; San Antonio, Texas, United States; Austin, Texas, United States');
  assert.deepEqual(mit.countries, ['US']);
  assert.equal(mit.url, 'https://apply.workable.com/j/6177CE2ED4');
  clean(jobs, board);
});

test('Recruitee: bunq offers payload maps every field', async () => {
  const board: BoardRef = { ats: 'recruitee', board: 'bunq', company: 'bunq' };
  const http = fakeHttp({ [recruiteeUrl('bunq')]: fixture('live/recruitee-bunq.json') });
  const jobs = await recruitee.fetchBoard(board, http);
  assert.equal(jobs.length, 3);
  const a = jobs[0];
  assert.equal(a.externalId, '2755994');
  assert.equal(a.title, 'Support Experience Guide');
  assert.equal(a.company, 'bunq');
  assert.equal(a.location, 'İstanbul, Türkiye; Sofia, Sofia (stolitsa), Bulgaria');
  assert.deepEqual(a.countries, ['TR', 'BG']);
  assert.equal(a.workMode, 'hybrid');
  assert.equal(a.remote, false);
  assert.equal(a.postedAt, '2026-09-23T09:10:19.000Z');
  assert.equal(a.url, 'https://careers.bunq.com/o/support-experience-guide-3');
  assert.equal(a.applyUrl, 'https://careers.bunq.com/o/support-experience-guide-3/c/new');
  assert.equal(a.employmentType, 'full_time');
  assert.equal(a.department, 'Support & Operations');
  assert.equal(a.pay, null); // every salary field is null on this board
  clean(jobs, board);
});

test('Personio: the company\'s own XML feed maps every field', async () => {
  const board: BoardRef = { ats: 'personio', board: 'personio', company: 'Personio' };
  const http = fakeHttp({ [personioUrl('personio')]: fixture('live/personio-personio.xml') });
  const jobs = await personio.fetchBoard(board, http);
  assert.deepEqual(http.calls, ['https://personio.jobs.personio.de/xml']); // bodies present: no English fill request
  assert.equal(jobs.length, 1);
  const a = jobs[0];
  assert.equal(a.externalId, '1834171');
  assert.equal(a.title, 'Staff Software Engineer, Data Platform');
  assert.equal(a.company, 'Personio SE & Co. KG');
  assert.equal(a.location, 'Munich; Berlin');
  assert.equal(a.postedAt, '2024-11-13T14:10:41.000Z');
  assert.equal(a.url, 'https://personio.jobs.personio.de/job/1834171');
  assert.equal(a.employmentType, 'full_time');
  assert.equal(a.department, 'Product and Tech');
  const j = normalizeJob(board, a)!;
  assert.match(j.description, /^The Role: How you'll make an impact at Personio\n/);
  assert.match(j.description, /\n- You will conceptualize and own technical solutions end-to-end/);
  clean(jobs, board);
});

test('Teamtailor: the career site RSS feed maps every field', async () => {
  const board: BoardRef = { ats: 'teamtailor', board: 'career', company: 'Teamtailor' };
  const http = fakeHttp({ [teamtailorPageUrl('career', null, 0)]: fixture('live/teamtailor-career.rss') });
  const jobs = await teamtailor.fetchBoard(board, http);
  assert.deepEqual(http.calls, ['https://career.teamtailor.com/jobs.rss?offset=0&per_page=100']); // 3 < 100: one page
  assert.equal(jobs.length, 3);
  const a = jobs[0];
  assert.equal(a.externalId, '8021334');
  assert.equal(a.title, 'Account Executive - UK Enterprise');
  assert.equal(a.company, 'Teamtailor');
  assert.equal(a.location, 'London, United Kingdom');
  assert.deepEqual(a.countries, ['GB']);
  assert.equal(a.workMode, 'hybrid');
  assert.equal(a.postedAt, '2026-07-06T06:58:57.000Z');
  assert.equal(a.url, 'https://career.teamtailor.com/jobs/8021334-account-executive-uk-enterprise');
  assert.equal(a.department, 'Sales');
  clean(jobs, board);
});

test('Gem: the job_posts payload maps every field', async () => {
  const board: BoardRef = { ats: 'gem', board: 'gem', company: 'Gem' };
  const http = fakeHttp({ [gemUrl('gem')]: fixture('live/gem-gem.json') });
  const jobs = await gem.fetchBoard(board, http);
  assert.equal(jobs.length, 4);
  const a = jobs.find((j) => j.externalId === '4965519002')!;
  assert.equal(a.title, 'Software Engineer');
  assert.equal(a.location, 'San Francisco, United States');
  assert.equal(a.workMode, 'hybrid');
  assert.equal(a.postedAt, '2020-11-17T15:37:23.000Z');
  assert.equal(a.url, 'https://jobs.gem.com/gem/4965519002');
  assert.equal(a.employmentType, 'full_time');
  assert.equal(a.department, 'Engineering');
  clean(jobs, board);
});

test('double-escaped HTML and titles read as clean text, from JSON and from XML (O12)', async () => {
  const wBoard: BoardRef = { ats: 'workable', board: 'esc-demo', company: 'Esc Demo' };
  const w = await workable.fetchBoard(wBoard, fakeHttp({ [workableUrl('esc-demo')]: JSON.stringify({ name: 'Esc Demo', jobs: [{
    shortcode: 'E1', title: 'AT&amp;amp;T Field Tech', url: 'https://apply.workable.com/esc-demo/j/E1/',
    description: '&amp;lt;p&amp;gt;Fix lines &amp;amp;amp; poles.&amp;lt;/p&amp;gt;&amp;lt;ul&amp;gt;&amp;lt;li&amp;gt;Ladders&amp;lt;/li&amp;gt;&amp;lt;/ul&amp;gt;',
  }] }) }));
  const wj = normalizeJob(wBoard, w[0])!;
  assert.equal(wj.title, 'AT&T Field Tech');
  assert.equal(wj.description, 'Fix lines & poles.\n\n- Ladders');
  const tBoard: BoardRef = { ats: 'teamtailor', board: 'esc-demo', company: 'Esc Demo' };
  const rssText = '<rss><channel><title>Esc Demo</title><item><title>R&amp;amp;D Lead</title>' +
    '<description>&amp;lt;p&amp;gt;Caf&amp;amp;eacute; &amp;amp;amp; lab&amp;lt;/p&amp;gt;</description>' +
    '<link>https://esc-demo.teamtailor.com/jobs/77-lead</link></item></channel></rss>';
  const t = await teamtailor.fetchBoard(tBoard, fakeHttp({ [teamtailorPageUrl('esc-demo', null, 0)]: rssText }));
  const tj = normalizeJob(tBoard, t[0])!;
  assert.equal(tj.title, 'R&D Lead');
  assert.equal(tj.description, 'Café & lab');
  for (const bad of ['&amp;', '&lt;', '<p>', '&eacute;']) assert.ok(!tj.description.includes(bad) && !wj.description.includes(bad), bad);
});
