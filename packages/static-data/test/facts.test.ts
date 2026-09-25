// Company facts with recorded source answers (test/fixtures/facts) and a counting fake network (O10, O11, O12, O15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CompanyFacts, type PaidSearch } from '../src/facts/company-facts.ts';
import { loadH1bIndex } from '../src/h1b/index.ts';
import { loadAliasIndex } from '../src/aliases.ts';
import { FIXTURE_DIR, searchResults } from '../src/facts/mock-facts.ts';
import { DIST_DIR } from '../src/paths.ts';
import { tempDir } from './helpers.ts';

const have = existsSync(join(DIST_DIR, 'h1b-lca.json.gz'));
const home = tempDir('jl-sd-facts-');
process.on('exit', () => home.done());

function fakeNet(opts: { fail?: boolean } = {}) {
  const urls: string[] = [];
  const fetchText = async (u: string): Promise<string> => {
    urls.push(u);
    if (opts.fail) throw new Error('HTTP 503 from mock');
    const url = new URL(u);
    let m = /EntityData\/(Q\d+)\.json$/.exec(url.pathname);
    let file: string | null = null;
    if (m) file = `wikidata-${m[1]}.json`;
    m = /CIK(\d{10})\.json$/.exec(url.pathname);
    if (m) file = `sec-CIK${m[1]}.json`;
    m = /lei-records\/([A-Z0-9]{20})$/.exec(url.pathname);
    if (m) file = `gleif-${m[1]}.json`;
    if (url.pathname.endsWith('/lei-records')) file = `gleif-name-${(url.searchParams.get('filter[entity.legalName]') ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '-')}.json`;
    if (!file || !existsSync(join(FIXTURE_DIR, file))) return JSON.stringify({ data: [] });
    return readFileSync(join(FIXTURE_DIR, file), 'utf8');
  };
  return { urls, fetchText };
}

function paidSearch(scenario: 'empty' | 'other-company' | 'match') {
  const queries: string[] = [];
  let spent = 0;
  const paid: PaidSearch = {
    priceMicros: () => 5000,
    async search(q) { queries.push(q); spent += 5000; return searchResults(scenario, q); },
  };
  return { paid, queries, spent: () => spent };
}

function service(net: ReturnType<typeof fakeNet>, paid: PaidSearch | null, now = { t: Date.parse('2026-09-25T00:00:00Z') }) {
  const db = new DatabaseSync(':memory:');
  const facts = new CompanyFacts({ db, h1b: loadH1bIndex({ dataDir: join(home.dir, 'd') }), aliases: loadAliasIndex(), fetchText: net.fetchText, paid, now: () => now.t });
  return { facts, db, now };
}

test('facts name their source, link and date; H-1B facts come from the filings (O10)', { skip: !have }, async () => {
  const net = fakeNet();
  const { facts } = service(net, null);
  const c = await facts.refresh(facts.note('NVIDIA'), { allowPaid: false });
  assert.equal(c.facts.founded?.value, 1993);
  assert.equal(c.facts.headquarters?.value, 'Santa Clara, CA');
  assert.equal(c.facts.headquarters?.source.name, 'SEC EDGAR');
  assert.equal(c.facts.stage?.value, 'public');
  assert.ok(c.facts.leaders?.value.some((l) => l.name === 'Jensen Huang' && l.title === 'Chief Executive Officer'));
  for (const f of Object.values(c.facts)) {
    assert.ok(f!.source.name && /^https:\/\//.test(f!.source.url ?? ''), JSON.stringify(f));
    assert.equal(f!.source.retrievedAt, '2026-09-25T00:00:00.000Z');
  }
  assert.equal(c.facts.totalFundingUsd, undefined);
  assert.equal(c.facts.investors, undefined);
  assert.equal(c.h1b?.certifiedFilings, 4234);
});

test('a fictional company gets no facts at all (O11)', { skip: !have }, async () => {
  const net = fakeNet();
  const s = paidSearch('empty');
  const { facts } = service(net, s.paid);
  const c = await facts.refresh(facts.note('Qxlorvane Widgets LLC'), { allowPaid: true, maxPriceMicros: 100_000 });
  assert.deepEqual(c.facts, {});
  assert.equal(c.h1b, null);
  assert.equal(net.urls.length, 0);
});

test('search results about a different company with a similar name are never used (O11)', { skip: !have }, async () => {
  const s = paidSearch('other-company');
  const { facts } = service(fakeNet(), s.paid);
  const c = await facts.refresh(facts.note('Notion'), { allowPaid: true, maxPriceMicros: 100_000 });
  assert.equal(c.facts.totalFundingUsd, undefined);
  assert.equal(c.facts.stage, undefined);
  assert.equal(c.facts.news, undefined);
  assert.match(c.paidLookup?.note ?? '', /left out/);
  assert.equal(c.paidLookup?.lastCostText, '$0.01 from your balance');
});

test('kept facts are reused per company; expiry and failures behave (O12)', { skip: !have }, async () => {
  const net = fakeNet();
  const { facts, now } = service(net, null);
  const key = facts.note('Stripe');
  await Promise.all([facts.refresh(key, { allowPaid: false }), facts.refresh(key, { allowPaid: false }), facts.refresh(key, { allowPaid: false })]);
  const first = net.urls.length;
  assert.ok(first > 0);
  await facts.refresh(key, { allowPaid: false });
  await facts.refresh(key, { allowPaid: false });
  assert.equal(net.urls.length, first, 'no new requests while the facts are fresh');
  now.t += 31 * 24 * 3600 * 1000;
  await facts.refresh(key, { allowPaid: false });
  assert.ok(net.urls.length > first, 'new requests after expiry (labels of people stay cached)');
  assert.ok(net.urls.slice(first).some((u) => /Q7624104/.test(u)), 'the company item is read again');
  const kept = facts.get(key).facts;
  assert.ok(kept.founded);
  // A failed refresh keeps the old facts.
  const failing = fakeNet({ fail: true });
  const db2 = new DatabaseSync(':memory:');
  const f2 = new CompanyFacts({ db: db2, h1b: loadH1bIndex({ dataDir: join(home.dir, 'd') }), aliases: loadAliasIndex(), fetchText: net.fetchText, paid: null, now: () => now.t });
  await f2.refresh(f2.note('Stripe'), { allowPaid: false });
  const good = f2.get('stripe').facts;
  f2.expireAll();
  const f3 = new CompanyFacts({ db: db2, h1b: loadH1bIndex({ dataDir: join(home.dir, 'd') }), aliases: loadAliasIndex(), fetchText: failing.fetchText, paid: null, now: () => now.t });
  const after = await f3.refresh('stripe', { allowPaid: false });
  assert.deepEqual(after.facts, good);
  assert.match(after.factsStatus.lastError ?? '', /failed/);
});

test('paid lookups run only with consent and within the cap; cost is in dollars from the balance (O12)', { skip: !have }, async () => {
  const s = paidSearch('match');
  const { facts } = service(fakeNet(), s.paid);
  const key = facts.note('Stripe');
  await facts.refresh(key, { allowPaid: false });
  assert.equal(s.queries.length, 0);
  const capped = await facts.refresh(key, { allowPaid: true, maxPriceMicros: 1000 });
  assert.equal(s.queries.length, 0);
  assert.match(capped.paidLookup?.note ?? '', /over your limit/);
  await facts.refresh(key, { allowPaid: true, maxPriceMicros: 100_000, force: true });
  assert.equal(s.queries.length, 2);
  for (const q of s.queries) assert.doesNotMatch(q, /jordan|testwell|@/i);
  const c = facts.get(key);
  assert.doesNotMatch(JSON.stringify(c), /credit/i);
  assert.match(c.paidLookup?.lastCostText ?? '', /^\$0\.01 from your balance$/);
});
