import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interimCompanyKey, isPlaceholderCompany, keysForCompany } from '../src/company.ts';
import { readTitle } from '../src/titles.ts';
import { rankContacts } from '../src/rank.ts';
import { demoFixture, fileText } from '../src/dev/fixture.ts';
import { contact, job, memoryService, NOW } from './helpers.ts';

test('company key: harmless variants join, different companies never do', () => {
  const k = interimCompanyKey;
  assert.equal(k('Stripe, Inc.'), 'stripe');
  assert.equal(k('stripe'), 'stripe');
  assert.equal(k('STRIPE INC'), 'stripe');
  assert.equal(k('Stripe LLC'), 'stripe');
  assert.equal(k('Acme L.L.C.'), 'acme');
  assert.equal(k('The Home Depot'), 'homedepot');
  assert.equal(k('Bain & Co.'), 'bain');
  assert.equal(k('Société Générale'), 'societegenerale');
  assert.notEqual(k('Stripe Partners Ltd'), 'stripe');
  assert.notEqual(k('Apple Leisure Group'), 'apple');
  assert.notEqual(k('Metaview'), k('Meta'));
  assert.notEqual(k('Blockchain Labs'), k('Block'));
  assert.equal(k('Inc.'), 'inc', 'a suffix alone is kept');
});

test('placeholders and blanks have no key; a trailing short form is matched both ways', () => {
  for (const p of ['Self-employed', 'Freelance', 'Stealth Startup', 'N/A', '-', 'Confidential', 'Open to work']) {
    assert.equal(isPlaceholderCompany(p), true, p);
    assert.deepEqual(keysForCompany(p, interimCompanyKey), { key: null, rawKey: null });
  }
  assert.deepEqual(keysForCompany(null, interimCompanyKey), { key: null, rawKey: null });
  assert.deepEqual(keysForCompany('Amazon Web Services (AWS)', interimCompanyKey), { key: 'amazonwebservices', rawKey: 'amazonwebservicesaws' });
  assert.deepEqual(keysForCompany('Google (via Randstad)', interimCompanyKey).key, 'googleviarandstad');
  assert.equal(isPlaceholderCompany('Stripe'), false);
});

test('O4: Stripe job shows 4, Apple job shows 2, unknown shows nothing, list equals count', () => {
  const s = memoryService();
  s.import(demoFixture(NOW).text);
  const stripe = interimCompanyKey('Stripe');
  assert.equal(s.countFor(stripe), 4);
  assert.equal(s.list({ companyKey: stripe }).length, 4);
  assert.deepEqual(new Set(s.list({ companyKey: stripe }).map((c) => c.company)), new Set(['Stripe, Inc.', 'stripe']));
  assert.equal(s.countFor(interimCompanyKey('Apple')), 2);
  assert.equal(s.list({ companyKey: 'apple' }).length, 2);
  assert.equal(s.countFor(interimCompanyKey('Figma')), null);
  assert.deepEqual(s.list({ companyKey: 'figma' }), []);
  assert.equal(s.countFor(''), null, 'a blank job company matches no one');
  assert.deepEqual(s.list({ companyKey: '' }), []);
  assert.equal(s.countFor('meta'), 1);
  assert.equal(s.countFor('block'), 1);
  assert.equal(s.countFor('amazonwebservices'), 2);
  assert.equal(s.countFor('amazonwebservicesaws'), 1);
  assert.equal(s.list({ noCompany: true }).length, 4, '2 blank + Self-employed + Stealth Startup');
  const counts = s.countsFor(['stripe', 'apple', 'figma', '']);
  assert.deepEqual([...counts.values()], [4, 2, null, null]);
  const e = s.explain('stripe', 'Stripe');
  assert.equal(e.count, 4);
  assert.deepEqual(e.notCounted.map((x) => x.name), ['Stripe Partners Ltd']);
  const apple = s.explain('apple', 'Apple');
  assert.deepEqual(apple.notCounted.map((x) => x.name), ['Apple Leisure Group']);
});

test('titles: seniority traps', () => {
  const lvl = (t: string) => readTitle(t).seniority;
  assert.equal(lvl('Senior Recruiting Coordinator'), 'senior');
  assert.ok(readTitle('Senior Recruiting Coordinator').recruiter);
  assert.equal(lvl('Executive Assistant to the CEO'), null);
  assert.equal(lvl('Account Executive'), null);
  assert.equal(lvl('Executive Recruiter'), null);
  assert.equal(lvl('Chief of Staff to the CEO'), 'lead');
  assert.equal(lvl('Talent Partner'), null);
  assert.equal(lvl('HR Business Partner'), null);
  assert.equal(lvl('Partner'), 'exec');
  assert.equal(lvl('Product Owner'), null);
  assert.equal(lvl('Lead Generation Specialist'), null);
  assert.equal(lvl('Chief Executive Officer'), 'exec');
  assert.equal(lvl('CEO'), 'exec');
  assert.equal(lvl('Founder & CEO'), 'founder');
  assert.equal(lvl('Vice President, Engineering'), 'vp');
  assert.equal(lvl('Senior Vice President'), 'vp');
  assert.equal(lvl('AVP, Risk'), 'senior');
  assert.equal(lvl('Director of Engineering'), 'director');
  assert.equal(lvl('Head of Talent'), 'director');
  assert.equal(lvl('Product Management Intern'), 'intern');
  assert.equal(lvl('Staff Software Engineer'), 'lead');
  assert.equal(lvl('Software Engineer II'), null);
  assert.equal(readTitle('Strategic Sourcing Manager').recruiter, null);
  assert.ok(readTitle('Talent Acquisition Partner').recruiter);
  assert.ok(readTitle('Technical Sourcer').recruiter);
  assert.ok(readTitle('Solutions Engineer').fields.has('sales'));
  assert.ok(!readTitle('Solutions Engineer').fields.has('engineering'));
});

test('O5: ranking is stable, reasons are true, and an email changes only that person', () => {
  const rows = (email: string) => fileText([
    `Avery,Quill,https://www.linkedin.com/in/aq,avery@example.com,"Stripe, Inc.",Technical Recruiter,16 Aug 2026`,
    `Blake,Ormond,https://www.linkedin.com/in/bo,,"Stripe, Inc.","Engineering Manager, Payments",17 Jul 2024`,
    `Casey,Brandt,https://www.linkedin.com/in/cb,${email},"Stripe, Inc.",Software Engineer II,14 Mar 2015`,
    `Devon,Marsh,https://www.linkedin.com/in/dm,,stripe,Senior Recruiting Coordinator,17 Jul 2024`,
  ]);
  const s = memoryService();
  s.import(rows(''));
  const j = job('Backend Engineer', 'Stripe', 'Engineering');
  const first = s.rank('stripe', j);
  assert.deepEqual(s.rank('stripe', j), first, 'same data, same order');
  const byId = new Map(s.list().map((c) => [c.id, c]));
  for (const r of first) {
    const c = byId.get(r.contactId)!;
    for (const reason of r.reasons) {
      if (reason.code === 'email_on_file') assert.ok(c.email);
      if (reason.code === 'recruiter') assert.match(c.position!, /Recruit/);
      if (reason.code === 'connected_recently') assert.equal(c.connectedOn, '2026-08-16');
      if (reason.code === 'connected_long_ago') assert.equal(c.connectedOn, '2015-03-14');
      assert.doesNotMatch(reason.text, /school|same team|hiring manager for/i);
    }
  }
  const casey = first.find((r) => byId.get(r.contactId)!.firstName === 'Casey')!;
  assert.ok(!casey.reasons.some((x) => x.code === 'email_on_file'));
  assert.ok(!casey.reasons.some((x) => x.code === 'connected_recently'));
  const devon = first.find((r) => byId.get(r.contactId)!.firstName === 'Devon')!;
  assert.ok(devon.reasons.some((x) => x.code === 'seniority_senior'));
  assert.ok(!devon.reasons.some((x) => /exec/.test(x.code)));

  s.import(rows('casey@example.com'));
  const after = s.rank('stripe', j);
  for (const r of after) {
    const before = first.find((x) => x.contactId === r.contactId)!;
    if (byId.get(r.contactId)!.firstName === 'Casey') {
      assert.ok(r.reasons.some((x) => x.code === 'email_on_file'));
      assert.equal(r.score, before.score + 5);
    } else {
      assert.deepEqual(r.reasons, before.reasons);
    }
  }
});

test('rankContacts (pure): ties break by name and id, not by input order', () => {
  const a = contact({ id: 'c_b', firstName: 'Al', lastName: 'Zed' });
  const b = contact({ id: 'c_a', firstName: 'Al', lastName: 'Aye' });
  const ctx = { companyKey: 'stripe', job: null, now: NOW };
  const one = rankContacts([a, b], ctx).map((r) => r.contactId);
  const two = rankContacts([b, a], ctx).map((r) => r.contactId);
  assert.deepEqual(one, two);
  assert.deepEqual(one, ['c_a', 'c_b']);
  assert.deepEqual(rankContacts([contact({ id: 'x', firstName: 'A', lastName: 'B', companyKey: 'apple' })], ctx), []);
});

test('a future or unknown Connected On gives no recency reason', () => {
  const r = rankContacts([
    contact({ id: 'c1', firstName: 'A', lastName: 'B', connectedOn: '2030-01-01' }),
    contact({ id: 'c2', firstName: 'C', lastName: 'D', connectedOn: null }),
  ], { companyKey: 'stripe', job: null, now: NOW });
  for (const x of r) assert.ok(!x.reasons.some((y) => y.code === 'connected_recently' || y.code === 'connected_years'));
});
