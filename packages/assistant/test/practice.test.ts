// JL-network-12: practice questions state only what the posting says ("preferred" stays preferred) and never assume
// a fact about the person; a skill the posting never names is never claimed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Job, MatchResult, Profile } from '@jobleft/contracts';
import { planQuestions } from '../src/index.ts';
import { postingNames } from '../src/practice.ts';

const job = (o: Partial<Job> & { description: string }): Job => ({
  id: 'greenhouse:stripe:1', title: 'Staff Data Analyst', company: 'Stripe', companyKey: 'stripe', skills: [], yearsRequired: null,
  ...o,
} as unknown as Job);

const profile = (o: Partial<Profile> = {}): Profile => ({ education: [], work: [], skills: [{ name: 'SQL', years: 3, source: 'user' }], certifications: [], ...o } as unknown as Profile);

const match = (o: Partial<MatchResult>): MatchResult => ({
  skills: { matched: [], missing: [], required: [], preferred: [] }, skillDetail: [], mustHaves: [], experienceYearsUsed: null, ...o,
} as unknown as MatchResult);

test('JL-network-12: a preferred degree stays "prefers", and a degree the profile lacks is a gap, never "your Master\'s degree"', () => {
  const j = job({ description: 'Preferred qualifications\n- Master\'s degree in a quantitative field\nSQL every day.', yearsRequired: { min: 10, max: null } });
  const m = match({
    skills: { matched: ['SQL'], missing: [], required: ['SQL'], preferred: [] },
    skillDetail: [{ name: 'SQL', importance: 'required', state: 'met', quote: 'SQL every day', heldFrom: null, via: null }],
    mustHaves: [
      { kind: 'degree', requirement: "Master's degree", importance: 'preferred', state: 'info', quote: "Master's degree in a quantitative field", message: 'x' },
      { kind: 'years', requirement: '10+ years of experience', importance: 'required', state: 'info', quote: '10+ years', message: 'x' },
    ],
    experienceYearsUsed: null,
  });
  const qs = planQuestions(j, m, profile());
  const deg = qs.find((q) => q.target === "Master's degree")!;
  assert.ok(deg, 'the degree question is there');
  assert.doesNotMatch(deg.text, /requires/);
  assert.doesNotMatch(deg.text, /your Master's degree/);
  assert.match(deg.text, /prefers Master's degree, and your profile does not show it\. It is a plus, not a must-have\./);
  assert.equal(deg.gap, true);
  const years = qs.find((q) => q.target === '10+ years of experience')!;
  assert.equal(years.gap, true, 'no work history: the years are not covered');
  assert.match(years.text, /your profile does not show that much yet/);
  assert.doesNotMatch(years.text, /covers this/);
});

test('JL-network-12: a skill the posting text never names is not asked about ("Motor controls" from "self-starters")', () => {
  const j = job({ title: 'Vice President, Audience & Event Marketing', company: 'Forbes', description: 'We want self-starters who love audiences. You will grow our event business.' });
  const m = match({
    skills: { matched: [], missing: ['Motor controls', 'Data visualization', 'Event planning'], required: ['Motor controls', 'Data visualization', 'Event planning'], preferred: [] },
    skillDetail: [{ name: 'Motor controls', importance: 'required', state: 'missing', quote: 'self-starters', heldFrom: null, via: null }],
  });
  const qs = planQuestions(j, m, profile());
  for (const q of qs) {
    assert.doesNotMatch(q.text, /Motor controls|Data visualization|Event planning/, q.text);
  }
});

test('JL-network-12: a met degree is asked about as the profile shows it; a skill the profile has and the posting names is asked', () => {
  const j = job({ description: "Requirements: Bachelor's degree. You will build dashboards in SQL and Tableau." });
  const m = match({
    skills: { matched: ['SQL'], missing: ['Tableau'], required: ['SQL', 'Tableau'], preferred: [] },
    skillDetail: [
      { name: 'SQL', importance: 'required', state: 'met', quote: 'SQL', heldFrom: null, via: null },
      { name: 'Tableau', importance: 'required', state: 'missing', quote: 'Tableau', heldFrom: null, via: null },
    ],
    mustHaves: [{ kind: 'degree', requirement: "Bachelor's degree", importance: 'required', state: 'met', quote: "Bachelor's degree", message: 'x' }],
  });
  const qs = planQuestions(j, m, profile());
  assert.match(qs.find((q) => q.target === 'Tableau')!.text, /^The posting asks for Tableau, and your profile does not show it\./);
  assert.equal(qs.find((q) => q.target === 'SQL')!.gap, false);
  assert.match(qs.find((q) => q.target === "Bachelor's degree")!.text, /requires Bachelor's degree, and your profile lists one/);
});

test('JL-network-12: without a match, profile skills the pasted posting names get a question', () => {
  const j = job({ title: 'Store Data Analyst', company: 'Kroger', description: 'Build dashboards in SQL and Tableau.' });
  const qs = planQuestions(j, null, profile());
  const sql = qs.find((q) => q.target === 'SQL');
  assert.ok(sql, 'SQL is in the posting and in the profile');
  assert.equal(sql!.gap, false);
});

test('postingNames matches whole words only', () => {
  assert.equal(postingNames('we want self-starters', 'Motor controls'), false);
  assert.equal(postingNames('sql and tableau', 'SQL'), true);
  assert.equal(postingNames('mysql only', 'SQL'), false);
  assert.equal(postingNames('c++ and go', 'C++'), true);
  assert.equal(postingNames('data   visualization', 'Data visualization'), true);
});

test('JL-network-16: the question bank refuses an empty debrief and a field over 20,000 characters', async () => {
  const { makeRig } = await import('./helpers.ts');
  const rig = await makeRig();
  try {
    await assert.rejects(rig.assistant.savePracticeItem({ jobId: 'greenhouse:acme:1001', kind: 'debrief', notes: '   ' }), /A debrief needs notes/);
    await assert.rejects(rig.assistant.savePracticeItem({ jobId: 'greenhouse:acme:1001', kind: 'debrief', notes: 'x'.repeat(20_001) }), /longer than 20,000 characters/);
    const it = await rig.assistant.savePracticeItem({ jobId: 'greenhouse:acme:1001', kind: 'question', question: 'Tell me about a conflict.', answer: 'SQL', feedback: 'Too short.' });
    assert.throws(() => rig.assistant.updatePracticeItem(it.id, { answer: 'y'.repeat(20_001) }), /longer than 20,000/);
    const edited = rig.assistant.updatePracticeItem(it.id, { answer: 'I used SQL window functions.', feedback: null });
    assert.equal(edited.feedback, null, 'old feedback is dropped with the new answer');
  } finally { await rig.close(); }
});
