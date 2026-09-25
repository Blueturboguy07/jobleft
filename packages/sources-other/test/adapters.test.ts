import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseRemoteOk } from '../src/feeds/remoteok.ts';
import { parseMusePage } from '../src/feeds/themuse.ts';
import { parseHnThread, pickHiringThread } from '../src/feeds/hn.ts';
import { GITHUB_LISTS, parseListings, parseSpeedyMarkdown } from '../src/feeds/github.ts';
import { parseRemotive } from '../src/feeds/remotive.ts';
import { parseUsajobsPage, parseUsajobsSecret } from '../src/feeds/usajobs.ts';
import { FeedError } from '../src/http.ts';
import { markdownHeaders, shapeDrift } from '../src/shape.ts';
import { FIX, NOW, fixture, fixtureText } from './helpers.ts';

const list = (id: string) => GITHUB_LISTS.find((l) => l.id === id)!;

test('fixtures fit the recorded shape of each real answer (no invented structure)', () => {
  const ro = fixture('remoteok/shape.json') as { paths: string[] };
  assert.deepEqual(shapeDrift(fixture('remoteok/api.json'), ro.paths), []);
  const hn = fixture('hn/shape.json') as { search: string[]; item: string[] };
  assert.deepEqual(shapeDrift(fixture('hn/search.json'), hn.search), []);
  assert.deepEqual(shapeDrift(fixture('hn/item.json'), hn.item), []);
  const gh = fixture('github/shape.json') as { listings: string[]; markdownHeaders: string[] };
  for (const f of ['simplify-listings', 'vanshb03-internships', 'vanshb03-newgrad']) assert.deepEqual(shapeDrift(fixture(`github/${f}.json`), gh.listings), [], f);
  for (const d of ['speedyapply-swe', 'speedyapply-ai']) {
    for (const f of readdirSync(join(FIX, 'github', d))) {
      for (const h of markdownHeaders(fixtureText(`github/${d}/${f}`))) assert.ok(gh.markdownHeaders.includes(h), `${d}/${f}: ${h}`);
    }
  }
  // The Muse fixture is the results list; the stand-in wraps it in the real page envelope.
  const muse = fixture('themuse/shape.json') as { paths: string[] };
  const page = { page: 0, page_count: 1, items_per_page: 20, took: 1, timed_out: false, total: 5, results: (fixture('themuse/jobs.json') as { results: unknown[] }).results, aggregations: {} };
  assert.deepEqual(shapeDrift(page, muse.paths), []);
});

test('Remote OK: postings, credit link, pay in USD per year, remote region as stated, mojibake repaired', () => {
  const r = parseRemoteOk(fixture('remoteok/api.json'), NOW);
  assert.equal(r.complete, true);
  assert.equal(r.postings!.length, 10);
  const nurse = r.postings!.find((p) => p.raw.externalId === '900001')!;
  assert.equal(nurse.sourceUrl, 'https://remoteOK.com/remote-jobs/remote-registered-nurse-telehealth-birchwood-health-900001');
  assert.equal(nurse.facts.pay, null, 'salary 0 means not stated');
  assert.deepEqual(nurse.facts.remoteScope?.regions, ['US']);
  assert.equal(nurse.facts.isUs, true);
  const be = r.postings!.find((p) => p.raw.externalId === '900002')!;
  assert.deepEqual([be.facts.pay?.min, be.facts.pay?.max, be.facts.pay?.currency, be.facts.pay?.period], [120000, 150000, 'USD', 'year']);
  const eu = r.postings!.find((p) => p.raw.externalId === '900003')!;
  assert.equal(eu.facts.isUs, false);
  const none = r.postings!.find((p) => p.raw.externalId === '900004')!;
  assert.equal(none.facts.remoteScope, null, 'empty location = region not stated');
  assert.equal(none.facts.isUs, null);
  const mx = r.postings!.find((p) => p.raw.externalId === '900005')!;
  assert.equal(mx.raw.title, 'Mecánico Automotriz Diagnóstico');
  assert.equal(nurse.facts.postedAt, '2026-09-24T00:00:07.000Z');
  assert.equal(r.postings!.find((p) => p.raw.externalId === '900006')!.raw.company, 'Granite Payments');
});

test('Remote OK: a changed shape is an error, never rows with blank titles', () => {
  assert.throws(() => parseRemoteOk({ jobs: [] }, NOW), (e: unknown) => e instanceof FeedError && e.code === 'shape');
  const renamed = (fixture('remoteok/api.json') as Array<Record<string, unknown>>).map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`${k}_v2`, v])));
  assert.throws(() => parseRemoteOk(renamed, NOW), /data format changed/);
});

test('The Muse: level from the board field, remote without a region, link back to themuse.com', () => {
  const page = { page: 0, page_count: 1, items_per_page: 20, took: 1, timed_out: false, total: 5, results: (fixture('themuse/jobs.json') as { results: unknown[] }).results, aggregations: {} };
  const p = parseMusePage(page, NOW);
  assert.equal(p.pageCount, 1);
  const pm = p.postings[0]!;
  assert.equal(pm.facts.level, 'senior');
  assert.equal(pm.facts.workModel, 'remote');
  assert.deepEqual(pm.facts.remoteScope?.regions, []);
  assert.ok(pm.sourceUrl.startsWith('https://www.themuse.com/jobs/'));
  const intern = p.postings.find((x) => x.raw.title.includes('Intern'))!;
  assert.equal(intern.facts.level, 'intern');
  assert.equal(intern.facts.employmentType, 'internship');
  const span = p.postings.find((x) => x.raw.company === 'Pinecrest Software')!;
  assert.equal(span.facts.level, 'entry', 'Entry and Mid: the lowest named level');
});

test('HN: only the "Who is hiring?" thread, never "Who wants to be hired?"', () => {
  const t = pickHiringThread(fixture('hn/search.json'));
  assert.equal(t?.id, '99000001');
  assert.equal(t?.title, 'Ask HN: Who is hiring? (September 2026)');
  const wants = { hits: [{ author: 'whoishiring', title: 'Ask HN: Who wants to be hired? (September 2026)', objectID: '5', created_at_i: 1 }] };
  assert.equal(pickHiringThread(wants), null);
  const notByBot = { hits: [{ author: 'someone', title: 'Ask HN: Who is hiring? (September 2026)', objectID: '6', created_at_i: 1 }] };
  assert.equal(pickHiringThread(notByBot), null);
});

test('HN: header facts, pay as written, link to the comment, credit to the thread', () => {
  const t = pickHiringThread(fixture('hn/search.json'))!;
  const r = parseHnThread(fixture('hn/item.json'), t, NOW);
  assert.equal(r.postings!.length, 7);
  assert.equal(r.skipped, 1, 'the unstructured comment is skipped; the reply is not a top-level comment');
  const q = r.postings!.find((p) => p.raw.company === 'Quartzline')!;
  assert.equal(q.raw.title, 'Senior Platform Engineer');
  assert.equal(q.sourceUrl, 'https://news.ycombinator.com/item?id=99000101');
  assert.deepEqual(q.facts.remoteScope?.regions, ['US']);
  assert.deepEqual([q.facts.pay?.min, q.facts.pay?.max, q.facts.pay?.currency, q.facts.pay?.period], [150000, 190000, 'USD', 'year']);
  assert.equal(q.raw.applyUrl, 'https://jobs.lever.co/quartzline-example/7f1c2d3e-0000-4000-8000-000000000101');
  assert.equal(q.credit?.url, 'https://news.ycombinator.com/item?id=99000001');
  assert.equal(q.facts.postedAt, '2026-09-01T15:02:11.000Z', 'the comment time, not the fetch time');
  const onsite = r.postings!.find((p) => p.raw.company === 'Rivermark Bio')!;
  assert.equal(onsite.facts.workModel, 'onsite');
  assert.equal(onsite.facts.pay, null);
  const both = r.postings!.find((p) => p.raw.company === 'Umbra Security')!;
  assert.equal(both.facts.workModel, null, 'ONSITE or REMOTE is not one work model');
  assert.deepEqual(both.facts.remoteScope?.regions, ['US', 'CA']);
  const eur = r.postings!.find((p) => p.raw.company === 'Saltmarsh Games')!;
  assert.equal(eur.facts.pay?.currency, 'EUR');
  const tag = r.postings!.find((p) => p.raw.company === 'Tidewater Robotics')!;
  assert.equal(tag.facts.workModel, 'hybrid');
  const hourly = r.postings!.find((p) => p.raw.company === 'Vellum Health')!;
  assert.equal(hourly.facts.pay?.period, 'hour');
  assert.equal(hourly.facts.employmentType, 'part_time');
});

test('GitHub JSON lists: inactive rows are not listed, bad links are unreadable, sponsorship notes kept', () => {
  const r = parseListings(fixture('github/simplify-listings.json'), list('gh-simplify-internships'), NOW);
  assert.equal(r.postings!.length, 5);
  assert.equal(r.skipped, 2, 'one inactive, one hidden');
  assert.deepEqual(r.unreadableIds, ['00000000-0000-4000-8000-000000000008'], 'a javascript: link is never stored');
  const dns = r.postings!.find((p) => p.raw.company === 'Birchwood Health')!;
  assert.equal(dns.facts.statements.sponsorship, 'no');
  assert.equal(dns.facts.workModel, null, 'Denver and remote: not one work model');
  assert.deepEqual(dns.facts.remoteScope?.regions, ['US']);
  const cit = r.postings!.find((p) => p.raw.company === 'Dunmore Analytics')!;
  assert.equal(cit.facts.statements.usCitizenOnly, true);
  const acme = r.postings!.find((p) => p.raw.company === 'Acme Robotics')!;
  assert.equal(acme.sourceUrl, 'https://job-boards.greenhouse.io/acmerobotics-example/jobs/7700000001?utm_source=Simplify&ref=Simplify', 'the exact link, tracking kept');
  assert.equal(acme.facts.postedAt, new Date(1790100000 * 1000).toISOString());
  assert.throws(() => parseListings([{ company: 'x', role: 'y', link: 'https://a.example' }], list('gh-simplify-internships'), NOW), /data format changed/);
});

test('speedyapply markdown: columns by header, pay per hour, no invented posting date, changed header is an error', () => {
  const l = list('gh-speedyapply-swe');
  const r = parseSpeedyMarkdown(fixtureText('github/speedyapply-swe/README.md'), l, 'README.md', NOW);
  assert.equal(r.postings.length, 4);
  assert.equal(r.openTables, 0);
  const p = r.postings[0]!;
  assert.equal(p.raw.company, 'Orchard Bank');
  assert.equal(p.facts.pay?.period, 'hour');
  assert.equal(p.facts.pay?.min, 60);
  assert.equal(p.facts.postedAt, null, 'the list gives an age, not a date');
  assert.equal(p.sourceUrl, 'https://jobs.ashbyhq.com/orchard-example/a1a1a1a1-0000-4000-8000-000000000001');
  const more = r.postings.find((x) => x.raw.company === 'Pinecrest Software')!;
  assert.equal(more.facts.places[0]?.text, 'San Francisco, CA');
  const renamed = fixtureText('github/speedyapply-swe/README.md').replace(/\| Company \|/g, '| Employer |');
  assert.throws(() => parseSpeedyMarkdown(renamed, l, 'README.md', NOW), /data format changed/);
  const cut = fixtureText('github/speedyapply-swe/README.md').split('<!-- TABLE_END -->')[0]!;
  assert.equal(parseSpeedyMarkdown(cut, l, 'README.md', NOW).openTables, 1);
  const intl = parseSpeedyMarkdown(fixtureText('github/speedyapply-swe/INTERN_INTL.md'), l, 'INTERN_INTL.md', NOW);
  assert.equal(intl.postings[0]!.facts.pay?.currency, 'GBP');
  assert.equal(intl.postings[0]!.facts.isUs, false);
});

test('Remotive (built, not crawled): posted date from the source, pay only when written, regions as stated', () => {
  const r = parseRemotive(fixture('remotive/remote-jobs.json'), NOW);
  assert.equal(r.postings!.length, 5);
  const us = r.postings![0]!;
  assert.equal(us.facts.postedAt, '2026-09-23T10:00:00.000Z');
  assert.deepEqual(us.facts.remoteScope?.regions, ['US']);
  const eu = r.postings![1]!;
  assert.equal(eu.facts.pay?.currency, 'EUR');
  assert.equal(eu.facts.isUs, false);
  const hourly = r.postings![2]!;
  assert.equal(hourly.facts.pay?.period, 'hour');
  assert.equal(hourly.facts.pay?.min, 30);
  assert.equal(r.postings![3]!.facts.remoteScope, null);
  assert.equal(r.postings![4]!.facts.pay, null, '"competitive" is not pay');
});

test('USAJOBS (built, not crawled): grade line, hourly pay, bi-weekly gives no pay, expired jobs are not listed', () => {
  const p = parseUsajobsPage(fixture('usajobs/search.json'), NOW);
  assert.equal(p.expired, 1);
  assert.equal(p.postings.length, 3);
  const pa = p.postings[0]!;
  assert.deepEqual([pa.facts.pay?.min, pa.facts.pay?.max, pa.facts.pay?.period], [61111, 79431, 'year']);
  assert.match(pa.raw.descriptionHtml, /Pay grade: GS-09 to GS-11/);
  assert.equal(pa.facts.level, null, 'a GS grade is never turned into a level');
  const ph = p.postings[1]!;
  assert.equal(ph.facts.pay?.period, 'hour');
  assert.equal(ph.facts.pay?.min, 18.5);
  const bw = p.postings[2]!;
  assert.equal(bw.facts.pay, null);
  assert.match(bw.raw.descriptionHtml, /Bi-weekly/);
  assert.equal(bw.facts.workModel, 'remote');
  assert.deepEqual(bw.facts.remoteScope?.regions, ['US']);
  assert.deepEqual(parseUsajobsSecret('jordan.testwell@example.com TESTKEY-0000-jordan'), { email: 'jordan.testwell@example.com', key: 'TESTKEY-0000-jordan' });
  assert.deepEqual(parseUsajobsSecret('TESTKEY-0000-jordan jordan.testwell@example.com'), { email: 'jordan.testwell@example.com', key: 'TESTKEY-0000-jordan' });
  assert.equal(parseUsajobsSecret('TESTKEY-0000-jordan'), null);
});

test('a field renamed in every posting is a format change: readable jobs are kept, nothing may close', () => {
  const data = (fixture('remoteok/api.json') as Array<Record<string, unknown>>).map((o) => {
    if (!('salary_min' in o)) return o;
    const { salary_min, salary_max, ...rest } = o;
    return { ...rest, salaryMin: salary_min, salaryMax: salary_max };
  });
  const r = parseRemoteOk(data, NOW);
  assert.equal(r.postings!.length, 10, 'the jobs are still read');
  assert.equal(r.complete, false, 'so nothing is closed by this answer');
  assert.match(r.problem ?? '', /no posting has the fields "salary_min", "salary_max"/);
  const lists = (fixture('github/vanshb03-newgrad.json') as Array<Record<string, unknown>>).map(({ date_posted, ...o }) => ({ ...o, posted: date_posted }));
  assert.match(parseListings(lists, list('gh-vanshb03-newgrad'), NOW).problem ?? '', /"date_posted"/);
  const noLoc = fixtureText('github/speedyapply-swe/README.md').replace(/\| Location \|/g, '| Where |');
  assert.equal(parseSpeedyMarkdown(noLoc, list('gh-speedyapply-swe'), 'README.md', NOW).missingColumns.length, 1);
});
