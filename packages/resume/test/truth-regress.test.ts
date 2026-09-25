// Regression tests for gate leaks found by evaluators: look-alike employers, near-miss tools, a letter body with no
// blank line after the header, hyphenated names, template titles read as employers, units like "2TB", "TS/SCI".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFromProfile } from '../src/document.ts';
import { builtinSkillDictionary, jobTerms } from '../src/gaps.ts';
import { jobFromText } from '../src/cli/store.ts';
import { buildProfileFacts, checkLetter, checkText, truthGate } from '../src/truth.ts';
import { J_GAP, jordanProfile } from './helpers.ts';

const k = (vs: Array<{ kind: string; fact: string }>) => vs.map((v) => `${v.kind}:${v.fact}`);

test('a look-alike employer is refused; a short form of your own employer is fine', () => {
  const p = jordanProfile();
  p.work[1]!.company = 'Contoso Labs';
  p.skills.push({ name: 'Fabrikam Ltd', years: null, source: 'user' }); // "ltd" is now one of your words
  const pf = buildProfileFacts(p);
  for (const s of ['Migrated 14 cron scripts to Airflow at Contoso Ltd', 'Software Engineer at Contoso Ltd', 'Worked with Contoso Inc on billing']) {
    assert.ok(k(checkText(s, 'x', pf, null, 'resume')).some((x) => x.startsWith('employer:Contoso')), s);
  }
  assert.deepEqual(k(checkText('Worked at Contoso on billing.', 'x', pf, null, 'resume')), []);
  assert.deepEqual(k(checkText('Worked at Contoso Labs on billing.', 'x', pf, null, 'resume')), []);
});

test('a bullet naming another of your employers is refused under the wrong job', () => {
  const p = jordanProfile();
  const d = documentFromProfile(p);
  d.sections.find((s) => s.kind === 'experience')!.items[0]!.bullets[0] = 'Led a migration of 12 services at Contoso Example Corp.';
  assert.ok(k(truthGate(d, p, null)).includes('employer:Contoso Example Corp'));
});

test('a longer tool name than the profile holds is another tool', () => {
  const p = jordanProfile();
  p.skills.push({ name: 'Tableau', years: null, source: 'resume' });
  const pf = buildProfileFacts(p);
  assert.ok(k(checkText('Shipped services using Docker Compose.', 'x', pf, null, 'resume')).includes('skill:Docker Compose'));
  assert.ok(k(checkText('Built dashboards in Tableau Prep.', 'x', pf, null, 'resume')).includes('skill:Tableau Prep'));
  assert.ok(k(checkText('Ran Docker Swarm clusters.', 'x', pf, null, 'resume')).includes('skill:Docker Swarm'));
  assert.deepEqual(k(checkText('Shipped services using Docker and Tableau.', 'x', pf, null, 'resume')), []);
  // A Skills list is held to the same rule.
  const d = documentFromProfile(p);
  d.sections.find((s) => s.kind === 'skills')!.items[0]!.tags.push('Docker Compose');
  assert.ok(k(truthGate(d, p, null)).includes('skill:Docker Compose'));
  // With Docker Compose in the profile it passes.
  p.skills.push({ name: 'Docker Compose', years: null, source: 'user' });
  assert.deepEqual(k(checkText('Shipped services using Docker Compose.', 'x', buildProfileFacts(p), null, 'resume')), []);
});

const HEADER = 'Jordan Testwell\njordan.testwell@example.com | 555-0100 | Austin, TX | https://example.com/jordan | https://github.com/jordan-testwell-example';

test('a letter body with no blank line after the header is still checked', () => {
  const p = jordanProfile();
  const text = `${HEADER}\nDear Hiring Manager,\nI write to apply. I also hold a PhD from Stanford and know Kubernetes.\nSincerely,\nJordan Testwell`;
  const got = k(checkLetter(text, p, J_GAP()));
  assert.ok(got.includes('skill:Kubernetes') && got.includes('degree:PhD'), got.join(','));
  // An extra line inside the contact block that is not a contact detail is checked too.
  const t2 = `${HEADER}\nFormer staff at Stanford University\n\nDear Hiring Manager,\n\nThank you.\n\nSincerely,\nJordan Testwell`;
  assert.ok(checkLetter(t2, p, J_GAP()).length > 0);
  // A clean letter with no blank lines at all passes.
  assert.deepEqual(k(checkLetter(`${HEADER}\nDear Hiring Manager,\nThank you for your time.\nSincerely,\nJordan Testwell`, p, J_GAP())), []);
});

test('a hyphenated or accented surname passes in the header and the sign-off', () => {
  for (const last of ['Test-well', 'Álvarez-Testwell', 'Łukasz-Testwell']) {
    const p = jordanProfile();
    p.personal.lastName = last;
    const text = `${HEADER}\n\nDear Hiring Manager,\n\nThank you.\n\nSincerely,\nJordan Testwell`.replace(/Jordan Testwell/g, `Jordan ${last}`);
    assert.deepEqual(k(checkLetter(text, p, J_GAP())), [], last);
  }
});

test('template lead words do not make an employer out of a title; units stay with their number', () => {
  const p = jordanProfile();
  p.work[0]!.title = 'Systems Engineer';
  p.work[1]!.title = 'Analytics Intern';
  p.work[1]!.bullets.push('Wrote Spark jobs over 2TB of claims data.');
  const pf = buildProfileFacts(p);
  for (const s of ['As Systems Engineer at Northwind Sample Labs, I cut batch-job time by 40%.', 'As Analytics Intern at Contoso Example Corp, I wrote Python scripts.', 'I wrote Spark jobs over 2TB of claims data.']) {
    assert.deepEqual(k(checkText(s, 'x', pf, null, 'letter')), [], s);
  }
  assert.deepEqual(truthGate(documentFromProfile(p), p, null), []);
  assert.ok(k(checkText('Wrote Spark jobs over 3TB of claims data.', 'x', pf, null, 'resume')).some((x) => x.startsWith('number:')));
  assert.ok(k(checkText('Wrote Spark jobs over 2PB of claims data.', 'x', pf, null, 'resume')).some((x) => x.startsWith('number:')));
});

test('"TS/SCI" in a posting is a clearance, not TypeScript', () => {
  const job = jobFromText({ title: 'Analyst', company: 'Globex', text: 'Requirements: Active TS/SCI security clearance. Python and SQL.', city: null });
  const terms = jobTerms(job, builtinSkillDictionary()).map((t) => t.term);
  assert.ok(!terms.includes('TypeScript'), terms.join(','));
  assert.ok(terms.includes('Security clearance'));
});
