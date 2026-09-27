// Regression tests for two evaluator findings: a site general manager read as an executive, and bare one-per-line
// language names ("- Rust", "- C") dropped from a posting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelOfTitle } from '../src/job.ts';
import { job, profileOf, score } from './helpers.ts';

const RETAIL = profileOf({
  work: [
    { company: 'Contoso Outfitters', title: 'Store Manager', startDate: '2021-05', endDate: 'present', bullets: ['Own store P&L of $6M.', 'Hire, train and coach a team of 30.', 'Run inventory control.'] },
    { company: 'Contoso Outfitters', title: 'Assistant Store Manager', startDate: '2018-01', endDate: '2021-04', bullets: ['Led inventory counts and scheduling.'] },
    { company: 'Fabrikam Goods', title: 'Sales Associate', startDate: '2016-05', endDate: '2017-12', bullets: ['Retail sales floor.'] },
  ],
  skills: ['P&L', 'Hiring', 'Inventory management', 'Retail'],
});
const GM_POSTING = 'We run specialty retail stores.\n\nRequirements\n- 4+ years of retail store management experience\n- P&L responsibility\n- Hire, train and coach a team\n- Inventory management';

test('a general manager of one store, restaurant or hotel is a manager, not an executive', () => {
  assert.equal(levelOfTitle('General Manager, Specialty Retail'), 'manager');
  assert.equal(levelOfTitle('Restaurant General Manager'), 'manager');
  assert.equal(levelOfTitle('Hotel General Manager'), 'manager');
  assert.equal(levelOfTitle('General Manager', 'food'), 'manager');
  // Company-wide and multi-site general managers stay above that.
  assert.notEqual(levelOfTitle('Regional General Manager'), 'manager');
  assert.equal(levelOfTitle('General Manager'), 'exec');
  assert.equal(levelOfTitle('VP and General Manager, Cloud'), 'exec');
});

test('a ten-year store manager is Strong or Good for a store general manager role, with no seniority blocker', () => {
  for (const title of ['General Manager, Specialty Retail', 'Restaurant General Manager']) {
    const r = score(RETAIL, job({ title, company: 'Northwind Retail', location: 'Austin, TX', description: GM_POSTING }));
    assert.ok(r.percent >= 70, `${title}: ${r.percent}`);
    assert.ok(['strong', 'good'].includes(r.band), `${title}: ${r.band}`);
    assert.ok(!r.blockers.some((b) => b.kind === 'level'), `${title}: ${JSON.stringify(r.blockers)}`);
  }
});

const SKILLS_ONLY = profileOf({
  work: [{ company: 'Northwind', title: 'Software Engineer', startDate: '2020-01', endDate: 'present', bullets: ['Built services.'] }],
  skills: ['JavaScript', 'Kubernetes'],
});
const swJob = (lines: string) => job({ title: 'Software Engineer', company: 'Woodgrove', location: 'Austin, TX', description: `We build storage.\n\nRequirements\n${lines}` });

test('bare one-per-line language names are read: Java, C and Rust missing, k8s met, Skills 25%', () => {
  const r = score(SKILLS_ONLY, swJob('- Java\n- k8s\n- C\n- Rust'));
  assert.deepEqual([...r.skills.missing].sort(), ['C', 'Java', 'Rust']);
  assert.ok(r.skills.matched.includes('Kubernetes'));
  assert.equal(r.subScores.skills.percent, 25);
});

test('a single bare language requirement is missing, not "not enough information"', () => {
  for (const [line, name] of [['- Rust', 'Rust'], ['- C', 'C'], ['- Go', 'Go'], ['- Ruby', 'Ruby'], ['- Swift', 'Swift'], ['- Experience with Rust', 'Rust'], ['- Rust experience', 'Rust']]) {
    const r = score(SKILLS_ONLY, swJob(line));
    assert.deepEqual(r.skills.missing, [name], line);
  }
});

test('a hyphen inside a word still blocks a language name ("C-suite", "go-to")', () => {
  const r = score(SKILLS_ONLY, swJob('- Present to the C-suite\n- Be the go-to engineer for Java and Kubernetes'));
  assert.ok(!r.skills.missing.includes('C') && !r.skills.missing.includes('Go'), JSON.stringify(r.skills));
});

// JL-feed-23 (black-box feed finding): "Why this score" quoted a 450-character description paragraph as the job's
// "title" when the stored level came from the posting text.
test('a level stated in the posting text is quoted as the posting\'s words, short, never as the title', () => {
  const para = "The Payments organization owns some of Stripe's most critical payment flows, from the checkout page to the settlement of funds with banks and card networks, across dozens of countries and local payment methods. The team partners closely with product, engineering, risk and finance to measure and grow payment acceptance, and it needs an analyst with 3+ years of experience in SQL and data analysis.";
  const base = job({ title: 'Data Analyst, Payments', description: `${para}\n\nWhat you need\n- SQL` });
  const j = { ...base, level: 'mid' as const, evidence: { ...base.evidence, level: { source: 'description' as const, text: para } } };
  const r = score(profileOf({ skills: ['SQL'] }), j);
  const texts = r.subScores.experienceLevel.reasons.map((x) => x.text).join(' | ');
  assert.ok(!texts.includes('title "The Payments organization'), texts);
  const m = /the posting says "([^"]*)"/.exec(texts);
  assert.ok(m, texts);
  assert.ok(m[1]!.length <= 160, `quote of ${m[1]!.length} characters`);
  const t = { ...base, level: 'senior' as const, title: 'Senior Data Analyst, Payments', evidence: { ...base.evidence, level: { source: 'title' as const, text: 'Senior Data Analyst, Payments' } } };
  const rt = score(profileOf({ skills: ['SQL'] }), t).subScores.experienceLevel.reasons.map((x) => x.text).join(' | ');
  assert.ok(!/the posting says/.test(rt), rt);
});

// JL-v2-1 / JL-v2-2: the card and the "Years of experience" filter showed the job's yearsRequired ("5+ years" from
// "Forbes' Cloud 100 (five years running!)"), while "Why this score" read its own figure ("4+ years"). One value now.
test('Why this score reads the same years as the card and the filter (JL-v2-1, JL-v2-2)', () => {
  const pm = profileOf({
    work: [{ company: 'Northwind', title: 'Product Manager', startDate: '2019-01', endDate: 'present', bullets: ['Owned the data platform roadmap.'] }],
    skills: ['Product management'],
  });
  const attentive = job({
    title: 'Senior Product Manager, Data Platform',
    description: "Attentive is proud to be included in Deloitte's Fast 500 (four years running!), Forbes' Cloud 100 (five years running!), and Inc.'s Best Workplaces!\n\nWhat you'll accomplish\n- 4+ years of product management experience building complex B2B or SaaS platforms.",
  });
  assert.deepEqual(attentive.yearsRequired, { min: 4, max: null });
  const a = score(pm, attentive);
  assert.equal(a.jobFacts.years.value, '4+ years');
  assert.match(a.jobFacts.years.quote ?? '', /4\+ years of product management experience/);

  // A sub-requirement never lowers the figure, in the score as on the card.
  const manager = job({ title: 'Manager of Data Science', description: 'Requirements\n- 7+ years of experience in data science, analytics, or related fields, including 2+ years of people management experience' });
  assert.deepEqual(manager.yearsRequired, { min: 7, max: null });
  assert.equal(score(pm, manager).jobFacts.years.value, '7+ years');

  // A job read by the crawler: the score takes its stored figure, even where this lane's own reading differs.
  const stored = { ...job({ title: 'Data Analyst', description: 'Requirements\n- 3+ years of experience in analytics\n- 2 years of SQL' }), yearsRequired: { min: 5, max: null }, evidence: { years: { source: 'description' as const, text: '3+ years of experience in analytics' } } };
  assert.equal(score(pm, stored).jobFacts.years.value, '5+ years');
  // A job whose posting states no years the card can show states none in the score either.
  const none = { ...job({ title: 'Reliability Engineer', description: 'Requirements\n- Minimum of five years of professional involvement in reliability validation or hardware testing.' }), yearsRequired: null, evidence: {} };
  const n = score(pm, none);
  assert.equal(n.jobFacts.years.value, null);
  assert.ok(!n.mustHaves.some((m) => m.kind === 'years'), JSON.stringify(n.mustHaves));
});
