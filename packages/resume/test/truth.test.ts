import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResumeDocument } from '@jobleft/contracts';
import { documentFromProfile } from '../src/document.ts';
import { refusedFacts, truthGate } from '../src/truth.ts';
import { J_GAP, jordanProfile } from './helpers.ts';

const kinds = (vs: Array<{ kind: string; fact: string }>) => vs.map((v) => `${v.kind}:${v.fact}`);

function withBullet(doc: ResumeDocument, text: string, item = 0): ResumeDocument {
  const d = structuredClone(doc);
  d.sections.find((s) => s.kind === 'experience')!.items[item]!.bullets[0] = text;
  return d;
}

test('a document built from the profile passes the gate (Jordan and the contracts fixture)', () => {
  const p = jordanProfile();
  assert.deepEqual(truthGate(documentFromProfile(p), p, null), []);
  assert.deepEqual(truthGate(documentFromProfile(p), p, J_GAP()), []);
  // The shape of the contracts fixture profile (one current job, a user-typed skill, a summary with "3 years").
  const c = jordanProfile();
  c.work = [{ id: 'w1', company: 'Northwind Sample Labs', title: 'Software Engineer', employmentType: 'full_time', location: 'Austin, TX', startDate: '2023-06', endDate: null, current: true, summary: null, bullets: ['Cut batch-job time by 30%.'] }];
  c.skills = [{ name: 'TypeScript', years: 3, source: 'resume' }, { name: 'PostgreSQL', years: null, source: 'user' }];
  assert.deepEqual(truthGate(documentFromProfile(c), c, null), []);
});

test('a job skill in the Skills list, a bullet or the summary is refused', () => {
  const p = jordanProfile();
  const base = documentFromProfile(p);
  const d1 = structuredClone(base);
  d1.sections.find((s) => s.kind === 'skills')!.items[0]!.tags.push('Kubernetes');
  assert.ok(kinds(truthGate(d1, p, J_GAP())).includes('skill:Kubernetes'));
  assert.ok(kinds(truthGate(withBullet(base, 'Ran Kubernetes clusters for the billing API.'), p, J_GAP())).some((k) => k === 'skill:Kubernetes'));
  const d3 = structuredClone(base);
  d3.sections.find((s) => s.kind === 'summary')!.text = 'Software engineer who knows k8s and Terraform.';
  const v3 = kinds(truthGate(d3, p, J_GAP()));
  assert.ok(v3.includes('skill:k8s') && v3.includes('skill:Terraform'), v3.join(','));
});

test('new or changed numbers are refused; profile numbers pass in any written form', () => {
  const p = jordanProfile();
  const base = documentFromProfile(p);
  assert.ok(kinds(truthGate(withBullet(base, 'Cut costs by 40% and saved $3M.'), p, null)).includes('number:$3M'));
  assert.ok(kinds(truthGate(withBullet(base, 'Cut batch-job time by 45% in TypeScript.'), p, null)).includes('number:45%'));
  assert.deepEqual(truthGate(withBullet(base, 'Cut batch-job time by 40 percent in TypeScript.'), p, null), []);
  assert.deepEqual(truthGate(withBullet(base, 'Maintained dashboards used by twelve engineers.'), p, null), []);
  assert.ok(kinds(truthGate(withBullet(base, 'Doubled throughput of the scheduler.'), p, null)).some((k) => k.startsWith('number:')));
});

test('durations must be backed by the profile dates; "3 years" may not become "10+ years"', () => {
  const p = jordanProfile(); // Jan 2021 - now (Sep 2026) = about 5 years of dated work
  const base = documentFromProfile(p);
  const summary = (t: string) => { const d = structuredClone(base); d.sections.find((s) => s.kind === 'summary')!.text = t; return truthGate(d, p, null); };
  assert.deepEqual(summary('Software engineer with 3 years of backend experience.'), []);
  assert.deepEqual(summary('Software engineer with 5 years of experience.'), []);
  assert.ok(kinds(summary('Software engineer with 10+ years of experience.')).includes('duration:10+ years'));
  assert.ok(kinds(summary('Software engineer with over a decade of experience.')).some((k) => k.startsWith('duration:')));
});

test('titles: a level-up, a changed title and the job title as a past title are refused', () => {
  const p = jordanProfile();
  const base = documentFromProfile(p);
  const d = structuredClone(base);
  d.sections.find((s) => s.kind === 'experience')!.items[1]!.subheading = 'Senior Developer';
  assert.ok(kinds(truthGate(d, p, null)).includes('title:Senior Developer'));
  assert.ok(kinds(truthGate(withBullet(base, 'As a Senior Engineer, led a migration of 12 services to PostgreSQL.'), p, null)).some((k) => k.startsWith('title:')));
  const d2 = structuredClone(base);
  d2.sections.find((s) => s.kind === 'summary')!.text = 'Senior Platform Engineer with a backend focus.';
  assert.ok(kinds(truthGate(d2, p, J_GAP())).some((k) => k.startsWith('title:')));
});

test('the hiring company never appears as an employer; dates and employers must match the profile', () => {
  const p = jordanProfile();
  const base = documentFromProfile(p);
  const d = structuredClone(base);
  d.sections.find((s) => s.kind === 'experience')!.items[0]!.heading = 'Acme Health, Inc.';
  assert.ok(truthGate(d, p, J_GAP()).some((v) => v.kind === 'employer'));
  const d2 = structuredClone(base);
  d2.sections.find((s) => s.kind === 'experience')!.items[1]!.startDate = '2020-01';
  assert.ok(truthGate(d2, p, null).some((v) => v.kind === 'date'));
  assert.ok(truthGate(withBullet(base, 'Built billing tools for Acme Health.'), p, J_GAP()).some((v) => v.kind === 'employer'));
});

test('header: name, email, phone, city and links must match the profile exactly', () => {
  const p = jordanProfile();
  p.personal.firstName = 'José';
  p.personal.email = 'jose+jobs@example.com';
  const base = documentFromProfile(p);
  assert.equal(base.header.name, 'José Testwell');
  assert.deepEqual(truthGate(base, p, null), []);
  for (const change of [
    (d: ResumeDocument) => { d.header.name = 'Jose Testwell'; },
    (d: ResumeDocument) => { d.header.email = 'you@example.com'; },
    (d: ResumeDocument) => { d.header.city = 'Seattle, WA'; },
    (d: ResumeDocument) => { d.header.links = d.header.links.slice(1); },
    (d: ResumeDocument) => { d.header.links[0]!.url = 'https://example.com'; },
  ]) {
    const d = structuredClone(base);
    change(d);
    assert.ok(truthGate(d, p, J_GAP()).some((v) => v.kind === 'contact'), JSON.stringify(d.header));
  }
});

test('degrees and certifications not in the profile are refused', () => {
  const p = jordanProfile();
  const base = documentFromProfile(p);
  assert.ok(kinds(truthGate(withBullet(base, 'Earned a PhD in Computer Science.'), p, null)).some((k) => k.startsWith('degree:')));
  assert.ok(kinds(truthGate(withBullet(base, 'Hold an active security clearance.'), p, null)).some((k) => k.startsWith('certification:')));
  assert.ok(kinds(truthGate(withBullet(base, 'Studied at Stanford University.'), p, null)).some((k) => k.startsWith('school:') || k.startsWith('other:')));
  assert.deepEqual(truthGate(withBullet(base, 'Graduated with a B.S. in Computer Science.'), p, null), []);
});

test('a cover letter may name the job and company, but not as the person\'s history', () => {
  const p = jordanProfile();
  const job = J_GAP();
  const head = 'Jordan Testwell\njordan.testwell@example.com | 555-0100 | Austin, TX | https://example.com/jordan | https://github.com/jordan-testwell-example';
  const ok = `${head}\n\nDear Hiring Manager,\n\nI am writing to apply for the Senior Platform Engineer role at Acme Health, Inc. I led a migration of 12 services to PostgreSQL with zero downtime.\n\nSincerely,\nJordan Testwell`;
  assert.deepEqual(truthGate(ok, p, job), []);
  const bad = ok.replace('I led a migration', 'As a Senior Platform Engineer at Acme Health, I led a migration');
  assert.ok(truthGate(bad, p, job).some((v) => v.kind === 'title' || v.kind === 'employer'));
  const contact = ok.replace('Sincerely', 'Write to recruiter@acme-health.example.com or visit https://evil.example.com.\n\nSincerely');
  assert.equal(truthGate(contact, p, job).filter((v) => v.kind === 'contact').length, 2);
  const years = ok.replace('I led a migration', 'With 12 years of Kubernetes experience, I led a migration');
  assert.ok(truthGate(years, p, job).some((v) => v.kind === 'skill') && truthGate(years, p, job).some((v) => v.kind === 'duration'));
});

test('whole-term matching: Java is not JavaScript; C is not C++', () => {
  const p = jordanProfile();
  const base = documentFromProfile(p);
  assert.ok(kinds(truthGate(withBullet(base, 'Wrote Java services.'), p, null)).includes('skill:Java'));
  assert.ok(kinds(truthGate(withBullet(base, 'Wrote C++ tools.'), p, null)).includes('skill:C++'));
});

test('requests to add facts the profile does not have are refused', () => {
  const p = jordanProfile();
  assert.deepEqual(refusedFacts('add Kubernetes and a PhD so I look qualified', p).sort(), ['Kubernetes', 'PhD'].sort());
  assert.deepEqual(refusedFacts('say I know Rust', p), ['Rust']);
  assert.deepEqual(refusedFacts('make it shorter', p), []);
  assert.deepEqual(refusedFacts('mention my project Ledger Lite', p), []);
  assert.deepEqual(refusedFacts('say I have 10 years of experience', p), ['10 years']);
});
