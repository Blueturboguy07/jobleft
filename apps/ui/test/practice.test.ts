// JL-network-14: answers and paid feedback come back from the saved session after a reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PracticeSession } from '@jobleft/contracts';
import { answeredCount, placeholdersIn, savedFor } from '../src/lib/practice.ts';

const s: PracticeSession = {
  id: 'ps_1', jobId: 'greenhouse:stripe:1', company: 'Stripe', title: 'Staff Data Analyst', createdAt: '2026-09-27T15:00:00.000Z',
  questions: [{ id: 'q1', text: 'Tell me about SQL.', target: 'SQL', gap: false }, { id: 'q2', text: 'Why Stripe?', target: null, gap: false }],
  answers: [{ questionId: 'q1', answer: 'SQL', feedback: 'Your answer is just the word "SQL".', sampleAnswer: 'SQL. [Add the result in your own words.]', answeredAt: '2026-09-27T15:01:00.000Z' }],
  resumed: true, madeBy: 'rules', label: 'Practice questions.',
};

test('JL-network-14: a resumed session gives back the answer and its feedback', () => {
  const q1 = savedFor(s, 'q1');
  assert.equal(q1.answer, 'SQL');
  assert.equal(q1.feedback?.feedback, 'Your answer is just the word "SQL".');
  assert.deepEqual(q1.feedback?.placeholders, ['[Add the result in your own words.]']);
  assert.equal(q1.feedback?.forAnswer, 'SQL');
  assert.deepEqual(savedFor(s, 'q2'), { answer: '', feedback: null });
  assert.equal(answeredCount(s), 1);
  assert.deepEqual(placeholdersIn(null), []);
});
