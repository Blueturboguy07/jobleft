import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, detectAts } from '../src/detect.ts';
import { notCrawledReason } from '../src/source-list.ts';

type Want = [string, string, string | null, string | null, string | null];
// [url, ats, board, region, jobId]
const CASES: Want[] = [
  ['https://boards.greenhouse.io/acme', 'greenhouse', 'acme', null, null],
  ['https://job-boards.greenhouse.io/Acme/jobs/4012345?utm_source=x', 'greenhouse', 'acme', null, '4012345'],
  ['https://job-boards.eu.greenhouse.io/acme/jobs/4012345', 'greenhouse', 'acme', 'eu', '4012345'],
  ['https://boards.greenhouse.io/embed/job_board?for=acme', 'greenhouse', 'acme', null, null],
  ['https://boards.greenhouse.io/embed/job_app?for=acme&token=555', 'greenhouse', 'acme', null, '555'],
  ['https://careers.acme.com/jobs?gh_jid=4012345&gh_src=abc', 'greenhouse', null, null, '4012345'],
  ['https://jobs.lever.co/acme/0a1b2c3d-1111-2222-3333-444455556666/apply', 'lever', 'acme', null, '0a1b2c3d-1111-2222-3333-444455556666'],
  ['https://jobs.eu.lever.co/acme/', 'lever', 'acme', 'eu', null],
  ['https://jobs.ashbyhq.com/Acme/0a1b2c3d-1111-2222-3333-444455556666', 'ashby', 'acme', null, '0a1b2c3d-1111-2222-3333-444455556666'],
  ['https://apply.workable.com/acme/', 'workable', 'acme', null, null],
  ['HTTPS://APPLY.WORKABLE.COM/acme/j/AB12CD34EF/?utm_medium=x', 'workable', 'acme', null, 'AB12CD34EF'],
  ['https://apply.workable.com/j/AB12CD34EF', 'workable', null, null, 'AB12CD34EF'],
  ['https://www.workable.com/api/accounts/acme?details=true', 'workable', 'acme', null, null],
  ['https://acme.workable.com/jobs/123456', 'workable', 'acme', null, '123456'],
  ['https://acme.recruitee.com/', 'recruitee', 'acme', null, null],
  ['https://acme.recruitee.com/o/warehouse-lead/c/new', 'recruitee', 'acme', null, 'warehouse-lead'],
  ['https://acme.jobs.personio.de/job/1834171?language=en', 'personio', 'acme', null, '1834171'],
  ['https://acme.jobs.personio.com/', 'personio', 'acme', 'com', null],
  ['https://acme.teamtailor.com/jobs/8021334-account-executive', 'teamtailor', 'acme', null, '8021334'],
  ['https://acme-1700147786.na.teamtailor.com/jobs', 'teamtailor', 'acme-1700147786', 'na', null],
  ['https://jobs.gem.com/acme/4965519002', 'gem', 'acme', null, '4965519002'],
  ['https://api.gem.com/job_board/v0/acme/job_posts/', 'gem', 'acme', null, null],
  ['https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Engineer_R12345', 'workday', 'acme', 'wd5', 'R12345'],
  ['https://careers-acme.icims.com/jobs/12345/engineer/job', 'icims', 'acme', null, '12345'],
  ['https://jobs.smartrecruiters.com/Acme/744000012345678-engineer', 'smartrecruiters', 'acme', null, '744000012345678'],
  ['https://acme.taleo.net/careersection/2/jobdetail.ftl?job=12345', 'taleo', 'acme', null, '12345'],
  ['https://recruiting.ultipro.com/ACM1000/JobBoard/abc/OpportunityDetail?opportunityId=xyz', 'ukg', 'acm1000', null, 'xyz'],
  ['https://acme.bamboohr.com/careers/42', 'bamboohr', 'acme', null, '42'],
  ['https://acme.breezy.hr/p/0a1b2c3d4e5f-engineer', 'breezy', 'acme', null, '0a1b2c3d4e5f'],
  ['https://acme.applytojob.com/apply/AbC123/Engineer', 'jazzhr', 'acme', null, 'AbC123'],
  ['https://ats.rippling.com/acme/jobs/0a1b2c3d', 'rippling', 'acme', null, '0a1b2c3d'],
];

test('recognises board and job links of every family (case, tracking and trailing slash ignored)', () => {
  for (const [url, ats, board, region, jobId] of CASES) {
    const d = detectAts(url);
    assert.ok(d, `no detection for ${url}`);
    assert.deepEqual({ ats: d.ats, board: d.board, region: d.region, jobId: d.jobId }, { ats, board, region, jobId }, url);
  }
});

test('the same board through different link shapes gives the same board id', () => {
  const shapes = ['https://apply.workable.com/acme', 'https://apply.workable.com/ACME/', 'apply.workable.com/acme/j/X1?ref=abc#top'];
  assert.deepEqual(new Set(shapes.map((s) => `${detectAts(s)?.ats}:${detectAts(s)?.board}`)), new Set(['workable:acme']));
});

test('crawlable is true only for crawled families', () => {
  assert.equal(detectAts('https://acme.recruitee.com')!.crawlable, true);
  assert.equal(detectAts('https://jobs.gem.com/acme')!.crawlable, true);
  for (const u of ['https://acme.bamboohr.com/careers', 'https://acme.wd1.myworkdayjobs.com/x', 'https://jobs.smartrecruiters.com/Acme']) {
    assert.equal(detectAts(u)!.crawlable, false, u);
  }
});

test('product pages of an ATS are not boards; odd input gives null', () => {
  for (const u of ['https://www.recruitee.com/', 'https://support.recruitee.com/x', 'https://www.teamtailor.com/en', 'https://example.com/jobs',
    'not a link', '', 'javascript:alert(1)', 'mailto:jobs@example.com', 'ftp://acme.recruitee.com']) {
    const d = detectAts(u);
    assert.ok(d === null || d.board === null, `${u} -> ${JSON.stringify(d)}`);
  }
});

test('classifyUrl gives a plain message for every kind of link (O3, O15)', () => {
  const c = (u: string) => classifyUrl(u, notCrawledReason);
  assert.equal(c('https://acme.recruitee.com/o/x').verdict, 'crawlable');
  assert.equal(c('https://apply.workable.com/j/AB12').verdict, 'job_link_without_board');
  for (const u of ['https://www.linkedin.com/jobs/view/123', 'https://www.indeed.com/viewjob?jk=1', 'https://www.glassdoor.com/job-listing/x',
    'https://jobs.smartrecruiters.com/Acme/1', 'https://acme.wd1.myworkdayjobs.com/External', 'https://careers-acme.icims.com/jobs/1/x/job',
    'https://acme.taleo.net/careersection/2/jobdetail.ftl', 'https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/1',
    'https://recruiting.ultipro.com/ACM1000/JobBoard/abc']) {
    const r = c(u);
    assert.equal(r.verdict, 'never', u);
    assert.match(r.message, /does not support .*Nothing was sent/, u);
  }
  const b = c('https://acme.bamboohr.com/careers');
  assert.equal(b.verdict, 'not_crawled');
  assert.match(b.message, /does not crawl BambooHR: no documented public feed.*Nothing was sent\.$/);
  assert.equal(c('https://example.com/careers').verdict, 'unknown');
  assert.equal(c('hello world').verdict, 'invalid');
  assert.equal(c('javascript:alert(1)').verdict, 'invalid');
});
