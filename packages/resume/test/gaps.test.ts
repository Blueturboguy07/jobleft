import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobFromText } from '../src/cli/store.ts';
import { documentFromProfile } from '../src/document.ts';
import { builtinSkillDictionary, keywordGaps } from '../src/gaps.ts';
import { applyChanges, draftTailoring } from '../src/tailor.ts';
import { truthGate } from '../src/truth.ts';
import { jordanProfile } from './helpers.ts';

// Ten known terms: 4 on the base resume, 3 only in the profile, 3 nowhere (resume O6).
const TEXT = `Platform Developer
We use TypeScript, React, Python and SQL every day.
You will also work with Docker, AWS and Linux.
Nice to have: Kubernetes, Terraform and Go.`;

function setup() {
  const p = jordanProfile();
  p.skills = ['TypeScript', 'React', 'Python', 'SQL', 'Docker', 'AWS', 'Linux'].map((name) => ({ name, years: null, source: 'resume' as const }));
  const doc = documentFromProfile(p);
  const sk = doc.sections.find((s) => s.kind === 'skills')!.items[0]!;
  sk.tags = ['TypeScript', 'React', 'Python', 'SQL'];
  // Keep Docker, AWS and Linux out of every other line of this resume too.
  for (const s of doc.sections) for (const it of s.items) it.bullets = it.bullets.filter((b) => !/Docker|AWS|Linux/.test(b));
  for (const w of p.work) w.bullets = w.bullets.filter((b) => !/Docker|AWS|Linux/.test(b));
  const job = jobFromText({ title: 'Platform Developer', company: 'Globex Sample Co', text: TEXT });
  return { p, doc, job };
}

test('each term lands in the right group, twice the same', () => {
  const { p, doc, job } = setup();
  const g = keywordGaps(job, doc, p, builtinSkillDictionary(), 'r1');
  const by = (s: string) => g.terms.filter((t) => t.status === s).map((t) => t.term).sort();
  assert.equal(g.requirementsFound, true);
  assert.deepEqual(by('covered'), ['Python', 'React', 'SQL', 'TypeScript']);
  assert.deepEqual(by('in_profile_not_resume'), ['AWS', 'Docker', 'Linux']);
  assert.deepEqual(by('not_in_profile'), ['Go', 'Kubernetes', 'Terraform']);
  assert.deepEqual(keywordGaps(job, doc, p, builtinSkillDictionary(), 'r1'), g);
});

test('Java is not covered by JavaScript; k8s covers Kubernetes', () => {
  const p = jordanProfile();
  p.skills.push({ name: 'k8s', years: null, source: 'user' });
  const doc = documentFromProfile(p);
  const job = jobFromText({ title: 'Engineer', company: 'Globex Sample Co', text: 'We need Java and Kubernetes experience for this backend role.' });
  const g = keywordGaps(job, doc, p, builtinSkillDictionary(), 'r1');
  assert.equal(g.terms.find((t) => t.term === 'Java')!.status, 'not_in_profile');
  const k = g.terms.find((t) => t.term === 'Kubernetes')!;
  assert.equal(k.status, 'covered');
  assert.equal(k.matchedAs, 'k8s');
});

test('a posting with no readable requirements says so (never "no gaps")', () => {
  const p = jordanProfile();
  const job = jobFromText({ title: 'Role', company: 'Globex Sample Co', text: '' });
  const g = keywordGaps(job, documentFromProfile(p), p, builtinSkillDictionary(), 'r1');
  assert.equal(g.requirementsFound, false);
  assert.deepEqual(g.terms, []);
});

test('tailoring can add only the profile-only terms; the result passes the gate', async () => {
  const { p, doc, job } = setup();
  const d = await draftTailoring({ profile: p, job, base: doc, resumeId: 'r1', skills: builtinSkillDictionary(), ai: null });
  const adds = d.proposal.changes.filter((c) => c.field === 'skills.add').map((c) => c.after).sort();
  assert.deepEqual(adds, ['AWS', 'Docker', 'Linux']);
  assert.deepEqual(d.proposal.gaps.filter((g) => ['Kubernetes', 'Terraform', 'Go'].includes(g)).sort(), ['Go', 'Kubernetes', 'Terraform']);
  const out = applyChanges(doc, d.ops, d.proposal.changes.map((c) => c.id));
  assert.deepEqual(truthGate(out, p, job), []);
  const tags = out.sections.find((s) => s.kind === 'skills')!.items[0]!.tags;
  for (const t of ['Kubernetes', 'Terraform', 'Go']) assert.ok(!tags.includes(t));
  // Each term appears once: no stuffing.
  assert.equal(new Set(tags).size, tags.length);
});
