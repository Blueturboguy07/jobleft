import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobSearchRequest } from '@jobleft/contracts';
import { parseQuery, TrackerStore, SynthGenerator } from '../src/index.ts';
import { CTX, NOW, freshStore, ids, job } from './helpers.ts';

const all = (store: ReturnType<typeof freshStore>, req: Omit<JobSearchRequest, 'limit' | 'cursor'>) => {
  const out: string[] = [];
  let r = store.search({ ...req, limit: 100 }, CTX);
  const total = r.total;
  for (;;) {
    out.push(...ids(r.items));
    if (!r.nextCursor) break;
    r = store.search({ ...req, limit: 100, cursor: r.nextCursor }, CTX);
  }
  return { ids: out, total };
};

test('query words: punctuation words keep their meaning; operators and quotes are plain words', () => {
  assert.deepEqual(parseQuery('C++').terms, ['cplusplus']);
  assert.deepEqual(parseQuery('C#').terms, ['csharp']);
  assert.deepEqual(parseQuery('C').terms, ['c']);
  assert.deepEqual(parseQuery('.NET developer').terms, ['dotnet', 'developer']);
  assert.deepEqual(parseQuery('Node.js').terms, ['nodejs']);
  assert.deepEqual(parseQuery('401(k)').terms, ['401k']);
  for (const q of ['"', '"unclosed', '*', 'a*', '(', ')', '[x]', '-', ' - ', 'AND', 'OR', 'NOT', 'NEAR', 'NEAR(a b)', 'a AND OR b', '{title}: x', 'x:y', '^', '"""']) {
    assert.doesNotThrow(() => parseQuery(q));
  }
});

test('word search: C++, C#, C, .NET, Node.js, 401(k) and accents find the right jobs, title words first', () => {
  const s = freshStore();
  s.upsertJobs([
    job({ id: 'cpp', title: 'Senior C++ Engineer', description: 'Low latency systems.' }),
    job({ id: 'cs', title: 'C# Developer', description: 'Build services on .NET.' }),
    job({ id: 'c', title: 'Embedded C Programmer', description: 'Firmware in C.' }),
    job({ id: 'node', title: 'Backend Engineer', description: 'We use Node.js and TypeScript. We offer a 401(k).' }),
    job({ id: 'sg', title: 'Analyste', company: 'Société Générale', description: 'Banque.' }),
    job({ id: 'desc', title: 'Platform Engineer', description: 'Some of our tools are written in C++.' }),
  ], { now: NOW });
  const q = (text: string) => ids(s.search({ sort: 'recommended', q: text }, CTX).items);
  assert.deepEqual(q('C++').slice(0, 2), ['cpp', 'desc']);
  assert.ok(!q('C++').includes('c'));
  assert.deepEqual(q('C#'), ['cs']);
  assert.ok(q('C').includes('c') && !q('C').includes('cpp'));
  assert.deepEqual(q('.NET'), ['cs']);
  assert.deepEqual(q('node.js'), ['node']);
  assert.deepEqual(q('401(k)'), ['node']);
  assert.deepEqual(q('Société Générale'), ['sg']);
  assert.deepEqual(q('societe generale'), ['sg']);
  for (const bad of ['"', 'AND', 'NOT', 'NEAR', '(', '-', '*', '"C++" OR "C#"', 'title:x']) {
    const r = s.search({ sort: 'recommended', q: bad }, CTX);
    assert.ok(r.total >= 0);
  }
  assert.equal(s.search({ sort: 'recommended', q: '' }, CTX).total, 6, 'an empty query is the normal list');
});

test('every result obeys every filter; unknown facts fail unless asked; exclude wins', () => {
  const s = freshStore();
  s.upsertJobs([
    job({ id: 'pay-unknown', title: 'A' }),
    job({ id: 'pay-hourly', title: 'B', pay: { min: 45, max: 55, currency: 'USD', period: 'hour' } }),
    job({ id: 'pay-high', title: 'C', pay: { min: 150000, max: 180000, currency: 'USD', period: 'year' } }),
    job({ id: 'multi', title: 'D', places: ['Seattle, WA', 'Austin, TX'] }),
    job({ id: 'remote', title: 'E', workModel: 'remote', remoteScope: { regions: ['US'], text: 'Remote (US)' } }),
    job({ id: 'noposted', title: 'F', postedAt: null }),
    job({ id: 'old', title: 'G', postedAt: '2026-09-24T11:59:00Z' }),
    job({ id: 'new', title: 'H', postedAt: '2026-09-24T12:01:00Z', skills: ['Python'], company: 'Excluded Co' }),
  ], { now: NOW });
  const r = (filter: object) => all(s, { sort: 'recommended', filter }).ids.sort();
  assert.deepEqual(r({ minAnnualPayUsd: 90000 }), ['pay-high', 'pay-hourly']);
  assert.deepEqual(r({ minAnnualPayUsd: 90000, includeUnknown: ['pay'] }).includes('pay-unknown'), true);
  assert.deepEqual(r({ places: [{ text: 'Austin, TX', placeId: null, radiusMiles: null }] }), ['multi']);
  assert.deepEqual(r({ places: [{ text: 'Seattle', placeId: null, radiusMiles: null }] }), ['multi']);
  assert.deepEqual(r({ workModels: ['remote'] }), ['remote']);
  assert.deepEqual(r({ remoteRegions: ['US'] }), ['remote']);
  assert.deepEqual(r({ postedWithin: '24h' }), ['new']);
  assert.ok(!r({ postedWithin: '30d' }).includes('noposted'));
  assert.ok(r({ postedWithin: '30d', includeUnknown: ['postedAt'] }).includes('noposted'));
  assert.deepEqual(r({ skills: ['python'], excludedCompanies: ['Excluded Co'] }), []);
  assert.deepEqual(r({ skills: ['Python'] }), ['new']);
});

test('closed and hidden jobs never show or count, in any sort; tracked closed jobs move to the Closed view', () => {
  const s = freshStore();
  const t = new TrackerStore(s.db);
  const list = Array.from({ length: 50 }, (_, i) => job({ id: `b:${i}`, title: `Role ${i}`, ats: 'greenhouse', board: 'acme', externalId: String(1000 + i) }));
  s.refreshScope('greenhouse:acme', list, { now: NOW });
  t.patch('b:1', { liked: true, notes: [{ text: 'called the recruiter' }] }, NOW);
  t.patch('b:2', { status: 'applied' }, NOW);
  const remaining = list.slice(10);
  const res = s.refreshScope('greenhouse:acme', remaining, { now: NOW + 3600_000 });
  assert.equal(res.closed, 10);
  for (const sort of ['recommended', 'most_recent'] as const) {
    const r = all(s, { sort });
    assert.equal(r.total, 40);
    assert.equal(r.ids.length, 40);
    assert.ok(!r.ids.some((id) => ['b:0', 'b:1', 'b:2', 'b:9'].includes(id)));
  }
  const closed = t.list('closed');
  assert.deepEqual(closed.items.map((i) => i.job.id).sort(), ['b:1', 'b:2']);
  assert.equal(closed.items.find((i) => i.job.id === 'b:1')!.entry.notes[0]!.text, 'called the recruiter');
  assert.equal(closed.items.find((i) => i.job.id === 'b:2')!.entry.status, 'applied');
  // Not interested: gone from results until undone.
  t.patch('b:20', { hidden: true }, NOW);
  assert.ok(!all(s, { sort: 'most_recent' }).ids.includes('b:20'));
  s.refreshScope('greenhouse:acme', remaining, { now: NOW + 7200_000 });
  assert.ok(!all(s, { sort: 'most_recent' }).ids.includes('b:20'), 'a refresh does not bring a hidden job back');
  assert.equal(t.list('hidden').items.length, 1);
  t.patch('b:20', { hidden: false }, NOW);
  assert.ok(all(s, { sort: 'most_recent' }).ids.includes('b:20'));
  // An empty listing closes nothing; closing more than half of a board at once is held.
  const empty = s.refreshScope('greenhouse:acme', [], { now: NOW + 9000_000 });
  assert.equal(empty.closed, 0);
  const tooMany = s.refreshScope('greenhouse:acme', remaining.slice(0, 5), { now: NOW + 9500_000 });
  assert.equal(tooMany.closed, 0);
  assert.ok(tooMany.closeHeld);
  assert.equal(all(s, { sort: 'recommended' }).total, 40);
});

test('dedupe: one posting through three links shows once; same title at one company in other cities or ids stays separate', () => {
  const s = freshStore();
  const desc = 'Build the billing platform. Five years of experience.';
  const base = { title: 'Billing Engineer', company: 'Stripe', description: desc, places: ['Seattle, WA'] };
  s.upsertJobs([
    { ...base, url: 'https://boards.greenhouse.io/stripe/jobs/5550001' },
    { ...base, url: 'https://boards.greenhouse.io/stripe/jobs/5550001?utm_source=newsletter&utm_medium=email' },
    { ...base, url: 'https://stripe.com/jobs/listing/billing-engineer/5550001?gh_jid=5550001' },
    { ...base, company: 'Stripe, Inc.', url: 'https://jobfeed.example.org/p/abc', sources: [{ sourceId: 'feed:example', name: 'Example feed', url: 'https://jobfeed.example.org/p/abc' }] },
    { ...base, places: ['Denver, CO'], url: 'https://boards.greenhouse.io/stripe/jobs/5550002' },
    { ...base, places: ['New York, NY'], url: 'https://boards.greenhouse.io/stripe/jobs/5550003' },
    { ...base, url: 'https://stripe.com/jobs/listing/billing-engineer/7770001?gh_jid=7770001' },
  ], { now: NOW });
  const r = all(s, { sort: 'recommended', q: 'billing engineer' });
  assert.equal(r.total, 4);
  assert.equal(new Set(r.ids).size, 4);
  for (let i = 0; i < 3; i++) s.upsertJobs([{ ...base, url: 'https://boards.greenhouse.io/stripe/jobs/5550001' }], { now: NOW + i });
  assert.equal(all(s, { sort: 'recommended' }).total, 4, 'refreshing adds no copies');
});

test('paging: the total equals the jobs reached; no repeats or skips while new jobs arrive', () => {
  const s = freshStore();
  const g = new SynthGenerator({ seed: 3, now: NOW });
  s.upsertJobs(Array.from({ length: 1500 }, (_, i) => g.job(i)), { now: NOW });
  for (const req of [{ sort: 'recommended' as const }, { sort: 'most_recent' as const }, { sort: 'recommended' as const, q: 'engineer' }]) {
    const seen = new Set<string>();
    let r = s.search({ ...req, limit: 37 }, CTX);
    const start = r.total;
    let before = new Set<string>();
    // Everything that matched at the start:
    before = new Set(all(s, req).ids);
    let added = false;
    for (;;) {
      for (const it of r.items) { assert.ok(!seen.has(it.job.id), `repeat ${it.job.id}`); seen.add(it.job.id); }
      if (!added) { s.upsertJobs(Array.from({ length: 200 }, (_, i) => g.job(5000 + i + seen.size * 1000)), { now: NOW }); added = true; }
      if (!r.nextCursor) break;
      r = s.search({ ...req, limit: 37, cursor: r.nextCursor }, CTX);
    }
    for (const id of before) assert.ok(seen.has(id), `skipped ${id}`);
    assert.equal(seen.size, start);
  }
});

test('facts are kept as stated: hourly pay, no work model, no posted date', () => {
  const s = freshStore();
  s.upsertJobs([job({ id: 'h', title: 'Barista', pay: { min: 18, max: 22, currency: 'USD', period: 'hour' }, postedAt: null, places: ['Portland, OR', 'Salem, OR'] })], { now: NOW });
  const j = s.get('h')!;
  assert.equal(j.pay!.period, 'hour');
  assert.equal(j.pay!.min, 18);
  assert.equal(j.pay!.annualMin, 18 * 2080);
  assert.equal(j.workModel, null);
  assert.equal(j.postedAt, null);
  assert.equal(j.employmentType, null);
  assert.deepEqual(j.places.map((p) => p.text), ['Portland, OR', 'Salem, OR']);
  const item = s.search({ sort: 'most_recent', filter: {} }, CTX).items[0]!;
  assert.equal(item.job.postedAt, null);
  assert.equal(item.job.workModel, null);
});

test('same query, same order; Most Recent is by posted date, unknown last', () => {
  const s = freshStore();
  const g = new SynthGenerator({ seed: 9, now: NOW });
  s.upsertJobs(Array.from({ length: 800 }, (_, i) => g.job(i)), { now: NOW });
  const a = ids(s.search({ sort: 'recommended', q: 'manager', limit: 50 }, CTX).items);
  const b = ids(s.search({ sort: 'recommended', q: 'manager', limit: 50 }, CTX).items);
  assert.deepEqual(a, b);
  const r = all(s, { sort: 'most_recent' });
  let prev = Infinity;
  let sawUnknown = false;
  for (const id of r.ids) {
    const p = s.get(id)!.postedAt;
    if (p === null) { sawUnknown = true; continue; }
    assert.ok(!sawUnknown, 'a dated job after an undated one');
    const t = Date.parse(p);
    assert.ok(t <= prev);
    prev = t;
  }
});

test('Top Matched without a profile says so and shows no list', () => {
  const s = freshStore();
  s.upsertJobs([job()], { now: NOW });
  assert.throws(() => s.search({ sort: 'top_matched' }, CTX), (e: Error & { code?: string }) => e.code === 'needs_profile');
  assert.throws(() => s.search({ sort: 'top_matched' }, { ...CTX, fitUnavailable: 'not_ready' }), (e: Error & { code?: string }) => e.code === 'not_ready');
});
