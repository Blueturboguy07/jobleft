import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeUrl, dedupHash, dedupeBatch, normalizeCompany, normalizeTitle, partitionNew } from '../src/normalize.ts';

test('canonicalizeUrl: lowercases host, forces https, strips tracking, sorts params, drops fragment and trailing slash', () => {
  const a = canonicalizeUrl('HTTP://Boards.Greenhouse.io:443/acme/jobs/123/?utm_source=x&b=2&a=1#apply');
  assert.equal(a, 'https://boards.greenhouse.io/acme/jobs/123?a=1&b=2');
  assert.equal(canonicalizeUrl('https://boards.greenhouse.io/acme/jobs/123?a=1&b=2&utm_campaign=z&ref=q'), a);
});

test('canonicalizeUrl: unwraps aggregator redirect wrappers (Internship Machine spine)', () => {
  const real = 'https://jobs.lever.co/acme/abc-123';
  const wrapped = 'https://click.appcast.io/track?url=' + encodeURIComponent(real + '?lever-source=simplify');
  assert.equal(canonicalizeUrl(wrapped), 'https://jobs.lever.co/acme/abc-123');
});

test('canonicalizeUrl: rejects empty and non-http input', () => {
  assert.equal(canonicalizeUrl(''), '');
  assert.equal(canonicalizeUrl('mailto:a@b.c'), '');
  assert.equal(canonicalizeUrl('not a url'), '');
});

test('DEVIATION: gh_jid is kept by default, because on company-hosted careers pages it is the only job identity', () => {
  const p1 = 'https://careers.acme.com/open-roles?gh_jid=4001&utm_source=li';
  const p2 = 'https://careers.acme.com/open-roles?gh_jid=4002&utm_source=li';
  assert.notEqual(canonicalizeUrl(p1), canonicalizeUrl(p2));
  // Python behaviour (strip gh_jid) collapses two different jobs into one URL. This is the bug the default avoids.
  assert.equal(canonicalizeUrl(p1, { stripGhJid: true }), canonicalizeUrl(p2, { stripGhJid: true }));
});

test('normalizeCompany: legal suffixes and punctuation do not split a company', () => {
  assert.equal(normalizeCompany('Stripe, Inc.'), 'stripe');
  assert.equal(normalizeCompany('The Home Depot'), 'homedepot');
  assert.equal(normalizeCompany('Redwood Credit Union'), 'redwoodcreditunion');
});

test('normalizeTitle: drops parentheticals, years and seasons; keeps intern by default (deviation)', () => {
  assert.equal(normalizeTitle('Registered Nurse (Night Shift) 2027'), 'registered nurse');
  assert.equal(normalizeTitle('Software Engineer Intern - Summer 2027'), 'software engineer intern');
  assert.equal(normalizeTitle('Software Engineer Intern - Summer 2027', { stripInternTerms: true }), 'software engineer');
  assert.notEqual(dedupHash('Acme', 'Engineer'), dedupHash('Acme', 'Engineer Intern'));
  // Python behaviour, switchable: with the intern words stripped the two roles collapse.
  assert.equal(dedupHash('Acme', 'Engineer Intern', { stripInternTerms: true }), dedupHash('Acme', 'Engineer'));
});

test('dedupHash: same role on two URLs collides, different company or title does not', () => {
  assert.equal(dedupHash('Acme Inc.', 'Cashier (Part-Time)'), dedupHash('ACME', 'Cashier'));
  assert.notEqual(dedupHash('Acme', 'Cashier'), dedupHash('Acme', 'Store Manager'));
  assert.notEqual(dedupHash('Acme', 'Cashier'), dedupHash('Beta', 'Cashier'));
});

const item = (url: string, hash: string, trust = 1) => ({ canonicalUrl: url, dedupHash: hash, sourceTrust: trust, tag: url + '|' + trust });

test('dedupeBatch: collapses a repeated canonical URL, keeps first slot and stable order', () => {
  const out = dedupeBatch([item('u1', 'h1'), item('u2', 'h2'), item('u1', 'h1'), item('u3', 'h3')]);
  assert.deepEqual(out.map((o) => o.canonicalUrl), ['u1', 'u2', 'u3']);
});

test('dedupeBatch: on a collision the higher-trust source replaces the lower one in the same slot', () => {
  const out = dedupeBatch([item('u1', 'h1', 1), item('u2', 'h2', 1), item('u1', 'h1', 5)]);
  assert.deepEqual(out.map((o) => o.tag), ['u1|5', 'u2|1']);
});

test('dedupeBatch: same role hash with different URLs is KEPT by default (multi-city postings), collapsed with byHash', () => {
  const rows = [item('u-nyc', 'same'), item('u-sf', 'same')];
  assert.equal(dedupeBatch(rows).length, 2);
  assert.equal(dedupeBatch(rows, { byHash: true }).length, 1);
});

test('partitionNew: a job is a duplicate when its URL or its role hash was already stored; accepted jobs extend the seen sets', () => {
  const seenUrls = new Set(['u-old']);
  const seenHashes = new Set(['h-old']);
  const { fresh, duplicates } = partitionNew(
    [item('u-old', 'h1'), item('u2', 'h-old'), item('u3', 'h3'), item('u3', 'h4'), item('u5', 'h3')], seenUrls, seenHashes);
  assert.deepEqual(fresh.map((f) => f.canonicalUrl), ['u3']);
  assert.equal(duplicates.length, 4);
  assert.ok(seenUrls.has('u3') && seenHashes.has('h3'));
});
