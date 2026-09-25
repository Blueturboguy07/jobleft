import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageKey } from '../src/pagekey.ts';
import { isNeverHost, supportFromUrl } from '../src/support.ts';

test('pageKey: tracking parameters are dropped, job ids are kept', () => {
  assert.equal(pageKey('https://boards.greenhouse.io/acme/jobs/123?gh_src=abc&utm_source=x'), 'greenhouse:123');
  assert.equal(pageKey('https://acme.example/careers?gh_jid=123'), 'greenhouse:123');
  assert.equal(pageKey('https://job-boards.greenhouse.io/acme/jobs/123'), 'greenhouse:123');
  assert.equal(pageKey('https://jobs.lever.co/acme/0f8a6b4c-1234-4a5b-9c8d-0123456789ab/apply?lever-source=x'),
    'lever:0f8a6b4c-1234-4a5b-9c8d-0123456789ab');
  assert.equal(pageKey('https://careers.acme.example/job?id=1&utm_campaign=z'), 'careers.acme.example/job?id=1');
  assert.notEqual(pageKey('https://careers.acme.example/job?id=1'), pageKey('https://careers.acme.example/job?id=2'));
  assert.equal(pageKey('https://careers.acme.example/jobs/42/apply/'), pageKey('https://careers.acme.example/jobs/42'));
  assert.equal(pageKey('https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Engineer_JR-1234/apply'), 'workday:acme:JR-1234');
});

test('never hosts: LinkedIn, Indeed, Glassdoor with country domains and subdomains', () => {
  for (const h of ['www.linkedin.com', 'uk.linkedin.com', 'linkedin.com', 'www.indeed.com', 'uk.indeed.com', 'indeed.co.uk', 'de.indeed.com',
    'www.glassdoor.com', 'glassdoor.co.uk', 'www.glassdoor.de', 'lnkd.in', 'media.licdn.com']) {
    assert.ok(isNeverHost(h), h);
  }
  for (const h of ['boards.greenhouse.io', 'jobs.lever.co', '127.0.0.1', 'example.com', 'linkedinsider.example']) assert.ok(!isNeverHost(h), h);
  assert.equal(supportFromUrl('https://www.linkedin.com/jobs/view/1').level, 'never');
  assert.equal(supportFromUrl('https://boards.greenhouse.io/acme/jobs/1').level, 'supported');
  assert.equal(supportFromUrl('https://acme.wd1.myworkdayjobs.com/x').level, 'partial');
  assert.equal(supportFromUrl('http://127.0.0.1:8000/form.html').level, 'not_supported');
  assert.equal(supportFromUrl('chrome://extensions').level, 'not_a_page');
});
