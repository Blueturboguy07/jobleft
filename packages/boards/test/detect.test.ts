import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardId, detectBoardFromUrl, parseLink } from '../src/index.ts';

// [link, expected board id, expected job id or null]
const BOARD_LINKS: Array<[string, string, string | null]> = [
  ['https://boards.greenhouse.io/acme', 'greenhouse:acme', null],
  ['https://boards.greenhouse.io/acme/', 'greenhouse:acme', null],
  ['https://BOARDS.greenhouse.io/Acme?utm_source=linkedin&utm_medium=x', 'greenhouse:acme', null],
  ['https://job-boards.greenhouse.io/acme/jobs/4455667', 'greenhouse:acme', '4455667'],
  ['https://job-boards.greenhouse.io/acme/jobs/4455667?gh_src=abc#apply', 'greenhouse:acme', '4455667'],
  ['https://boards.greenhouse.io/acme?gh_jid=123', 'greenhouse:acme', '123'],
  ['https://job-boards.eu.greenhouse.io/acme', 'greenhouse:eu:acme', null],
  ['https://boards.greenhouse.io/embed/job_board?for=acme&b=https%3A%2F%2Facme.com', 'greenhouse:acme', null],
  ['https://boards.greenhouse.io/embed/job_board/js?for=Acme', 'greenhouse:acme', null],
  ['https://boards.greenhouse.io/embed/job_app?for=acme&token=998877', 'greenhouse:acme', '998877'],
  ['https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true', 'greenhouse:acme', null],
  ['boards.greenhouse.io/acme', 'greenhouse:acme', null],
  ['<https://jobs.lever.co/acme>', 'lever:acme', null],
  ['https://jobs.lever.co/acme/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b', 'lever:acme', '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'],
  ['https://jobs.lever.co/ACME/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b/apply?lever-source=LinkedIn', 'lever:acme', '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'],
  ['https://jobs.eu.lever.co/acme', 'lever:eu:acme', null],
  ['https://api.lever.co/v0/postings/acme?mode=json', 'lever:acme', null],
  ['https://jobs.ashbyhq.com/acme', 'ashby:acme', null],
  ['https://jobs.ashbyhq.com/Acme/2b5c8e4a-1111-4222-8333-944455556666', 'ashby:acme', '2b5c8e4a-1111-4222-8333-944455556666'],
  ['https://jobs.ashbyhq.com/acme/2b5c8e4a-1111-4222-8333-944455556666/application?utm_source=x', 'ashby:acme', '2b5c8e4a-1111-4222-8333-944455556666'],
  ['https://jobs.ashbyhq.com/acme/embed?version=2', 'ashby:acme', null],
  ['https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true', 'ashby:acme', null],
  ['https://apply.workable.com/acme/', 'workable:acme', null],
  ['https://apply.workable.com/acme/j/AB12CD34EF/', 'workable:acme', 'AB12CD34EF'],
  ['https://acme.recruitee.com/o/senior-baker', 'recruitee:acme', 'senior-baker'],
  ['https://acme.jobs.personio.de/job/12345?language=en', 'personio:acme', '12345'],
];

test('every board and job link shape names the right board (case, tracking, slash, region)', () => {
  for (const [link, id, job] of BOARD_LINKS) {
    const d = detectBoardFromUrl(link);
    assert.equal(d.kind, 'board', `${link} -> ${d.kind}`);
    if (d.kind !== 'board') continue;
    assert.equal(boardId(d.found.ats, d.found.board, d.found.region), id, link);
    assert.equal(d.found.jobId, job, `job id of ${link}`);
  }
});

test('forbidden hosts are recognised before anything else', () => {
  const cases: Array<[string, string]> = [
    ['https://www.linkedin.com/jobs/view/123456/', 'LinkedIn'],
    ['https://lnkd.in/abc', 'LinkedIn'],
    ['https://www.indeed.com/viewjob?jk=abc', 'Indeed'],
    ['https://uk.indeed.com/viewjob?jk=abc', 'Indeed'],
    ['https://www.glassdoor.co.uk/job-listing/x', 'Glassdoor'],
    ['https://jobs.smartrecruiters.com/Acme/123', 'SmartRecruiters'],
    ['https://acme.wd5.myworkdayjobs.com/en-US/External/job/X', 'Workday'],
    ['https://careers-acme.icims.com/jobs/1234/job', 'iCIMS'],
    ['https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/1', 'Oracle'],
    ['https://recruiting.ultipro.com/ACM1000/JobBoard/abc', 'UKG'],
    ['https://acme.taleo.net/careersection/2/jobdetail.ftl?job=1', 'Taleo'],
  ];
  for (const [link, provider] of cases) {
    const d = detectBoardFromUrl(link);
    assert.equal(d.kind, 'forbidden', link);
    if (d.kind === 'forbidden') assert.equal(d.provider, provider, link);
  }
});

test('unsupported providers, job sites and provider home pages never become a board', () => {
  assert.equal(detectBoardFromUrl('https://acme.bamboohr.com/careers/12').kind, 'unsupported');
  assert.equal(detectBoardFromUrl('https://jobs.jobvite.com/acme/job/o1').kind, 'unsupported');
  assert.equal(detectBoardFromUrl('https://www.ziprecruiter.com/c/Acme/Job/x').kind, 'job_site');
  assert.equal(detectBoardFromUrl('https://www.greenhouse.io/careers').kind, 'provider_home');
  assert.equal(detectBoardFromUrl('https://boards.greenhouse.io/').kind, 'provider_home');
  assert.equal(detectBoardFromUrl('https://boards.greenhouse.io/embed/job_board').kind, 'provider_home');
  assert.equal(detectBoardFromUrl('https://www.lever.co/').kind, 'provider_home');
  assert.equal(detectBoardFromUrl('https://app.ashbyhq.com/signin').kind, 'provider_home');
});

test('plain text, other schemes and credentials are not links', () => {
  for (const t of ['acme careers', 'hello', '', '   ', 'javascript:alert(1)', 'mailto:jordan.testwell@example.com', 'ftp://acme.com/jobs', 'https://user:pw@acme.com/jobs']) {
    assert.equal(detectBoardFromUrl(t).kind, 'not_a_link', JSON.stringify(t));
  }
  assert.equal(parseLink('careers.acme.com/jobs')?.href, 'https://careers.acme.com/jobs');
  assert.equal(parseLink('localhost:8080/page.html')?.href, 'http://localhost:8080/page.html');
});

test('employer pages are pages to read, with gh_jid and ashby_jid hints', () => {
  const d = detectBoardFromUrl('https://www.acme.com/careers/listing?gh_jid=4567890');
  assert.equal(d.kind, 'page');
  if (d.kind === 'page') assert.equal(d.hints.ghJid, '4567890');
  const a = detectBoardFromUrl('https://acme.com/jobs?ashby_jid=2b5c8e4a-1111-4222-8333-944455556666');
  assert.equal(a.kind, 'page');
  if (a.kind === 'page') assert.equal(a.hints.ashbyJid, '2b5c8e4a-1111-4222-8333-944455556666');
});
