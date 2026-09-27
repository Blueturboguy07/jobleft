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

const letterFor = (body: string) => `Jordan Testwell\njordan.testwell@example.com | 555-0100 | Austin, TX | https://example.com/jordan | https://github.com/jordan-testwell-example\n\nDear Hiring Manager,\n\n${body}\n\nSincerely,\nJordan Testwell`;

test('a letter may name the hiring company and the job\'s own title, even when they are tool names (JL-resume-16)', () => {
  const p = jordanProfile();
  const cases: Array<[string, string]> = [
    ['Software Engineer - Data Infrastructure', 'Figma'], ['Senior Software Engineer - Distributed Data Systems', 'Databricks'],
    ['Backend Engineer, Developer & End-user Experience Platform', 'Stripe'], ['Staff Software Engineer, Risk Data Engineering', 'Stripe'],
    ['Site Reliability Engineer', 'GitLab'], ['Software Engineer, Hostmap', 'Datadog'],
  ];
  for (const [title, company] of cases) {
    const job = jobFromText({ title, company, text: 'Data warehousing, Spark and Kubernetes. You will mentor engineers.', city: null });
    const text = letterFor(`I am writing to apply for the ${title} role at ${company}.\n\nI am a software engineer with 3 years of backend experience building APIs and data pipelines.\n\nThank you for considering my application. I would welcome the chance to talk about how I can help ${company}.`);
    assert.deepEqual(k(checkLetter(text, p, job)), [], `${company}: ${title}`);
  }
  // A sentence that also says who the person is may still name the company it is written to.
  const figma = jobFromText({ title: 'Software Engineer - Data Infrastructure', company: 'Figma', text: 'Spark.', city: null });
  assert.deepEqual(k(checkLetter(letterFor('As a software engineer with 3 years of backend experience, I would love to help Figma.'), p, figma)), []);
  // The company as a place the person worked, or the job's skills claimed as the person's own, are still refused.
  for (const bad of ['I worked at Figma for two years.', 'As a Software Engineer at Figma, I built a billing API.', 'At Figma, I built a billing API.', 'During my time at Figma I built a billing API.']) {
    assert.ok(k(checkLetter(letterFor(bad), p, figma)).some((x) => /Figma/.test(x)), bad);
  }
  const risk = jobFromText({ title: 'Staff Software Engineer, Risk Data Engineering', company: 'Stripe', text: 'Data engineering.', city: null });
  assert.ok(k(checkLetter(letterFor('I have deep Data Engineering experience.'), p, risk)).includes('skill:Data Engineering'));
});

test('a letter\'s claims about the person are flagged by their words: mentoring, results, a job skill in another form, a number said another way (JL-resume-22)', () => {
  const p = jordanProfile();
  const job = jobFromText({ title: 'Staff Software Engineer, Risk Data Engineering', company: 'Stripe', text: 'Lead technical outcomes and mentor engineers. Data warehousing, Spark, Python.', city: null });
  const claims: Array<[string, string]> = [
    ['I am well-prepared to lead technical outcomes for a team of talented engineers, providing mentorship and guidance as outlined in the responsibilities.', 'other:mentorship'],
    ['At Northwind Sample Labs I led migrations to PostgreSQL with zero downtime, demonstrating my ability to maintain data warehouses and pipelines.', 'skill:data warehouses'],
    ['I rewrote the scheduler in TypeScript at 40% faster batch-job times.', 'number:40% faster'],
    ['I wrote Python scripts to automate manual tasks, enhancing efficiency and reducing errors.', 'other:efficiency'],
  ];
  for (const [sentence, want] of claims) assert.ok(k(checkLetter(letterFor(sentence), p, job)).includes(want), `${want} in: ${k(checkLetter(letterFor(sentence), p, job)).join(', ')}`);
  // The profile's own claims, in its own words or a close form, pass.
  for (const ok of ['I cut batch-job time by 40% by rewriting the scheduler in TypeScript.', 'I led a migration of 12 services to PostgreSQL with zero downtime.', 'I wrote Python scripts that saved 10 hours of manual work each week.', 'I reduced batch-job time by 40%.']) {
    assert.deepEqual(k(checkLetter(letterFor(ok), p, job)), [], ok);
  }
});
