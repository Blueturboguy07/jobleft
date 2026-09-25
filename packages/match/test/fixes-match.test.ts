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
