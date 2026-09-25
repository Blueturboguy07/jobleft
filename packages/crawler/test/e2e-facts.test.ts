// Outcomes O1, O2, O10, O12, O14 (facts): jobs arrive with what the board states, nothing is invented, text stays
// text, non-tech jobs at every level are kept and findable, posted dates are the employer's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobSchema, validate } from '@jobleft/contracts';
import { queryJobs } from '../src/contract.ts';
import { allJobs, crawlOnce, serveBoards, tempStore } from './helpers.ts';
import type { MockJob } from './helpers.ts';

test('O1: 40 jobs on three board types arrive with title, company, every place, pay, posted date, full description and their own link', async () => {
  const long = '<h2>About the role</h2><p>' + 'You will care for patients every day. '.repeat(400) + '</p><h3>Duties</h3><ul><li>Assess patients</li><li>Give medicine</li></ul><p>The end of the posting.</p>';
  const gh: MockJob[] = Array.from({ length: 14 }, (_, i) => ({
    id: 5000 + i, title: `Registered Nurse ${i}`, location: i === 0 ? ['Austin, TX', 'Dallas, TX', 'Houston, TX'] : `City${i}, TX`,
    description: i === 1 ? long : `<p>Nurse job ${i}.</p>`, postedAt: `2026-09-${String(1 + i).padStart(2, '0')}T15:30:00Z`,
    pay: i % 2 === 0 ? { min: 38, max: 52, period: 'hour' } : undefined, url: `https://careers.acme.example/jobs?gh_jid=${5000 + i}`,
  }));
  const lv: MockJob[] = Array.from({ length: 13 }, (_, i) => ({
    id: `lv-${i}`, title: `Store Manager ${i}`, location: i === 0 ? ['Denver, CO', 'Boulder, CO', 'Remote - US'] : 'Denver, CO',
    description: `<p>Run store ${i}.</p>`, postedAt: '2026-08-15T00:00:00Z', pay: { min: 60000 + i, max: 80000 + i, period: 'year' },
    workplaceType: 'OnSite', commitment: 'Full-time',
  }));
  const ab: MockJob[] = Array.from({ length: 13 }, (_, i) => ({
    id: `ab-${i}`, title: `Staff Accountant ${i}`, location: ['New York, NY', 'Remote - US'], description: `<p>Close the books ${i}.</p>`,
    postedAt: '2026-07-01T00:00:00Z', workplaceType: 'Hybrid', pay: { min: 5000, max: 6000, period: 'month' },
  }));
  const m = await serveBoards({ acme: { ats: 'greenhouse', jobs: gh }, beta: { ats: 'lever', jobs: lv }, gamma: { ats: 'ashby', jobs: ab } });
  const { store, cleanup } = tempStore();
  try {
    const out = await crawlOnce(store, m.boards);
    assert.equal(out.run.ok, 3);
    const page = allJobs(store);
    assert.equal(page.total, 40);
    for (const j of page.items) assert.ok(validate(JobSchema, j).ok, `${j.id} is a valid contract Job`);
    const byId = new Map(page.items.map((j) => [j.id, j]));
    // Greenhouse: three cities kept, hourly pay kept hourly, company from the board list, the job's own page (gh_jid kept).
    const n0 = byId.get('greenhouse:acme:5000')!;
    assert.deepEqual(n0.places.map((p) => p.text), ['Austin, TX', 'Dallas, TX', 'Houston, TX']);
    assert.deepEqual(n0.places.map((p) => [p.city, p.region, p.country]), [['Austin', 'TX', 'US'], ['Dallas', 'TX', 'US'], ['Houston', 'TX', 'US']]);
    assert.deepEqual([n0.pay?.min, n0.pay?.max, n0.pay?.period, n0.pay?.source], [38, 52, 'hour', 'board_field']);
    assert.equal(n0.company, 'acme Co');
    assert.equal(n0.url, 'https://careers.acme.example/jobs?gh_jid=5000');
    assert.equal(n0.postedAt, '2026-09-01T15:30:00.000Z');
    const n1 = byId.get('greenhouse:acme:5001')!;
    assert.equal(n1.pay, null, 'no pay stated, none shown');
    assert.ok(n1.description.length > 14_000, 'the long description is whole');
    assert.match(n1.description, /About the role\n/);
    assert.match(n1.description, /Duties\n+- Assess patients\n- Give medicine/);
    assert.match(n1.description, /The end of the posting\.$/);
    // Lever: every place, yearly pay, work model and employment type from the board's fields.
    const l0 = byId.get('lever:beta:lv-0')!;
    assert.deepEqual(l0.places.map((p) => p.text), ['Denver, CO', 'Boulder, CO', 'Remote - US']);
    assert.deepEqual([l0.pay?.min, l0.pay?.max, l0.pay?.period], [60000, 80000, 'year']);
    assert.equal(l0.workModel, 'onsite');
    assert.equal(l0.employmentType, 'full_time');
    assert.equal(l0.applyUrl, `${m.servers.beta!.origin}/jobs/beta/lv-0/apply`);
    // Ashby: a monthly figure stays monthly (never shown as yearly).
    const a0 = byId.get('ashby:gamma:ab-0')!;
    assert.deepEqual([a0.pay?.min, a0.pay?.max, a0.pay?.period, a0.pay?.annualMin], [5000, 6000, 'month', 60000]);
    assert.equal(a0.workModel, 'hybrid');
    for (const j of page.items) assert.equal(j.sources[0]!.url, j.url);
  } finally {
    cleanup();
    await m.close();
  }
});

test('O2: nothing is invented: no pay, date or place stays empty; benefit money is never pay; text pay keeps its unit', async () => {
  const jobs: MockJob[] = [
    { id: 1, title: 'Cashier', description: '<p>Ring up sales.</p>' },
    { id: 2, title: 'Warehouse Associate', description: '<p>Pay: $18.50 - $22.00 per hour.</p><p>$2,000 sign-on bonus. 401(k) match up to $5,000.</p>' },
    { id: 3, title: 'Teller', description: '<p>We offer a $5,000 - $10,000 sign-on bonus and a 401(k) match up to $6,000.</p>' },
    { id: 4, title: 'Line Cook', description: '<p>Earn $45 per hour.</p>', location: 'Remote' },
    { id: 5, title: 'Bookkeeper', description: '<p>Salary range: $4,000 - $5,000 per month.</p>' },
  ];
  const m = await serveBoards({ plain: { ats: 'greenhouse', jobs } });
  const { store, cleanup } = tempStore();
  try {
    await crawlOnce(store, m.boards);
    const by = new Map(allJobs(store).items.map((j) => [j.externalId, j]));
    const c = by.get('1')!;
    assert.equal(c.pay, null);
    assert.equal(c.postedAt, null, 'a missing posted date is not the crawl date');
    assert.deepEqual(c.places, [], 'an empty place is not a default country');
    assert.equal(c.isUs, null);
    assert.equal(c.workModel, null, 'no work model stated, none shown');
    assert.equal(c.level, null);
    assert.deepEqual(c.levels, []);
    const w = by.get('2')!;
    assert.deepEqual([w.pay?.min, w.pay?.max, w.pay?.period, w.pay?.source], [18.5, 22, 'hour', 'description']);
    assert.match(w.evidence.pay?.text ?? '', /18\.50 - \$22\.00 per hour/);
    assert.equal(by.get('3')!.pay, null, 'a sign-on bonus range is not pay');
    // A single stated wage is pay with the same number and unit (min = max), never widened into a range.
    assert.deepEqual([by.get('4')!.pay?.min, by.get('4')!.pay?.max, by.get('4')!.pay?.period], [45, 45, 'hour']);
    assert.deepEqual(by.get('4')!.places.map((p) => [p.text, p.country]), [['Remote', null]], 'Remote names no country');
    assert.equal(by.get('4')!.workModel, 'remote');
    assert.deepEqual([by.get('5')!.pay?.min, by.get('5')!.pay?.max, by.get('5')!.pay?.period], [4000, 5000, 'month']);
  } finally {
    cleanup();
    await m.close();
  }
});

test('O10: markup never survives as markup; a non-web apply link is dropped; the text stays readable', async () => {
  const evil = '<p>Great job.</p><script>alert(1)</script><img src="http://127.0.0.1:9/logger.png" onerror="alert(2)"><a href="javascript:alert(3)">Apply here</a><iframe src="http://x.example"></iframe>';
  const m = await serveBoards({
    evilgh: { ats: 'greenhouse', jobs: [{ id: 1, title: 'Barista', description: evil }, { id: 2, title: 'Host', url: 'javascript:alert(4)' }] },
    evillv: { ats: 'lever', jobs: [{ id: 'x', title: 'Baker', description: evil, applyUrl: 'file:///etc/passwd' }] },
  });
  const { store, cleanup } = tempStore();
  try {
    const out = await crawlOnce(store, m.boards);
    const page = allJobs(store);
    assert.equal(page.total, 2, 'the posting with no web link at all is not stored');
    const gh = out.report.boards.find((b) => b.board === 'evilgh')!;
    assert.equal(gh.stats.skipped, 1);
    assert.match(gh.reason ?? '', /no web \(http or https\) link/);
    for (const j of page.items) {
      assert.doesNotMatch(j.description, /<script|<img|onerror|javascript:|<iframe|logger\.png/i);
      assert.match(j.description, /Great job\./);
      assert.match(j.description, /Apply here/);
      assert.match(j.url, /^https?:\/\//);
    }
    const baker = page.items.find((j) => j.title === 'Baker')!;
    assert.equal(baker.applyUrl, null, 'file: apply link is not kept');
  } finally {
    cleanup();
    await m.close();
  }
});

test('O12 + O14: nurses, forklift drivers, accountants and electricians at every level are kept and found; posted dates are the board dates', async () => {
  const titles = [
    'Registered Nurse - Night Shift', 'Forklift Operator', 'Staff Accountant', 'Journeyman Electrician', 'Retail Sales Associate',
    'Middle School Math Teacher', 'Line Cook', 'Truck Driver CDL-A', 'Dental Hygienist', 'Bank Teller', 'Nursing Intern',
    'Senior Bank Teller', 'Director of Nursing', 'VP of Finance', 'Chief Operating Officer', 'Electrician Apprentice',
  ];
  const jobs: MockJob[] = titles.map((t, i) => ({ id: 900 + i, title: t, location: 'Tulsa, OK', description: `<p>${t} wanted.</p>`, postedAt: i === 0 ? '2026-09-24T00:00:00Z' : i === 1 ? '2026-08-26T00:00:00Z' : '2026-03-09T00:00:00Z', pay: i % 3 === 0 ? { min: 20 + i, max: 30 + i, period: 'hour' } : undefined }));
  const m = await serveBoards({ mixed: { ats: 'greenhouse', jobs } });
  const { store, cleanup } = tempStore();
  try {
    await crawlOnce(store, m.boards);
    assert.equal(allJobs(store).total, titles.length);
    const find = (q: string) => queryJobs(store.db, { q, status: 'open' }).items.map((j) => j.title);
    assert.ok(find('registered nurse').includes('Registered Nurse - Night Shift'));
    assert.deepEqual(find('forklift'), ['Forklift Operator']);
    assert.deepEqual(find('staff accountant'), ['Staff Accountant']);
    assert.deepEqual(find('electrician').sort(), ['Electrician Apprentice', 'Journeyman Electrician']);
    const levels = new Set(allJobs(store).items.map((j) => j.level));
    for (const l of ['intern', 'senior', 'director', 'vp', 'exec']) assert.ok(levels.has(l as never), `level ${l} kept`);
    const posted = new Map(allJobs(store).items.map((j) => [j.title, j.postedAt]));
    assert.equal(posted.get('Registered Nurse - Night Shift'), '2026-09-24T00:00:00.000Z');
    assert.equal(posted.get('Forklift Operator'), '2026-08-26T00:00:00.000Z');
    assert.equal(posted.get('Staff Accountant'), '2026-03-09T00:00:00.000Z');
  } finally {
    cleanup();
    await m.close();
  }
});
