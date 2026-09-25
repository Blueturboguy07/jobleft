import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h1bTagFor, passesH1bFilter } from '../src/h1b/tag.ts';
import { parseRobots } from '../src/net/polite-fetch.ts';
import { checkProposed, moneyIn } from '../src/facts/enrich.ts';
import { normalizeTitle } from '../src/h1b/role-family.ts';
import { excelDate } from '../src/h1b/xlsx.ts';

test('the post wins over history, and tag and filter agree (O3, O8)', () => {
  const likely = { status: 'likely' as const };
  const none = { sponsorship: null, clearanceRequired: null, usCitizenOnly: null };
  const cases: Array<[Parameters<typeof h1bTagFor>[0], string | null, boolean]> = [
    [{ ...none, sponsorship: 'no' }, 'post_says_no', false],
    [{ ...none, usCitizenOnly: true }, 'post_says_no', false],
    [{ ...none, clearanceRequired: true }, 'post_says_no', false],
    [{ ...none, sponsorship: 'yes' }, 'post_says_yes', true],
    [none, 'likely_by_history', true],
  ];
  for (const [st, tag, pass] of cases) {
    const r = h1bTagFor(st, likely);
    assert.equal(r.tag, tag);
    assert.equal(passesH1bFilter(r.tag), pass);
  }
  assert.notEqual(h1bTagFor({ ...none, clearanceRequired: true }, likely).label, h1bTagFor({ ...none, sponsorship: 'no' }, likely).label);
  assert.equal(h1bTagFor(none, null).tag, null);
  assert.equal(h1bTagFor(none, { status: 'some_history' }).tag, null);
});

test('robots.txt groups: blank lines do not split a group (RFC 9309)', () => {
  const census = 'User-agent: *\n\nUser-agent: RavenCrawler\nDisallow: /\n\nUser-agent: Googlebot\nCrawl-delay: 30\n';
  assert.equal(parseRobots(census).allows('/geo/file.zip'), false);
  const open = 'User-agent: *\nDisallow:\n';
  assert.equal(parseRobots(open).allows('/anything'), true);
  const wd = 'User-agent: *\nDisallow: /w/\nDisallow: /wiki/Special:EntityData/\nAllow: /wiki/Special:EntityData/*.\n';
  assert.equal(parseRobots(wd).allows('/wiki/Special:EntityData/Q42.json'), true);
  assert.equal(parseRobots(wd).allows('/w/api.php?action=wbsearchentities'), false);
});

test('proposed facts need a matching quote and the same company (O11)', () => {
  const results = [{ title: 'Acme raises money', url: 'https://news.example.com/a', snippet: 'Acme (acme.com), based in Austin, raised $40M in a Series B round.' }];
  const target = { name: 'Acme', keys: ['acme'], websiteHost: 'acme.com', hqCity: 'Austin' };
  const q = 'Acme (acme.com), based in Austin, raised $40M in a Series B round.';
  assert.equal(checkProposed({ field: 'totalFundingUsd', value: 40_000_000, url: results[0]!.url, quote: q }, results, target), null);
  assert.match(checkProposed({ field: 'totalFundingUsd', value: 400_000_000, url: results[0]!.url, quote: q }, results, target)!, /amount/);
  assert.match(checkProposed({ field: 'totalFundingUsd', value: 40_000_000, url: 'https://elsewhere.example/x', quote: q }, results, target)!, /link/);
  assert.match(checkProposed({ field: 'investors', value: ['Sequoia'], url: results[0]!.url, quote: q }, results, target)!, /not in the quote/);
  assert.match(checkProposed({ field: 'totalFundingUsd', value: 40_000_000, url: results[0]!.url, quote: q }, results, { ...target, websiteHost: 'other.com', hqCity: 'Graz' })!, /same company/);
  assert.deepEqual(moneyIn('raised $1.2 billion and $40M and 3 million dollars'), [1.2e9, 4e7, 3e6]);
});

test('titles and dates normalize', () => {
  assert.equal(normalizeTitle('Senior Software Engineer II, Payments (Remote)'), 'software engineer');
  assert.equal(excelDate('45931'), '2025-10-01');
  assert.equal(excelDate('2025-10-01 00:00:00'), '2025-10-01');
  assert.equal(excelDate(''), null);
});
