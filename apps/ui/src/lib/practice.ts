// Interview practice on screen. The server keeps each answer and its feedback (JL-network-14): a reload, or opening
// the same job again, shows them from the session instead of empty boxes.

import type { PracticeSession } from '@jobleft/contracts';

export interface ShownFeedback {
  feedback: string;
  sampleAnswer: string | null;
  placeholders: string[];
  /** The charge of this feedback in micros (null: not charged, or not known after a reload). */
  costMicros: number | null;
  mode: 'ai' | 'rules' | null;
  /** The answer this feedback is about. */
  forAnswer: string;
}

const PLACEHOLDER = /\[[^\]]{2,120}\]/g;

/** The [bracketed placeholders] of a sample answer (the parts the person must fill with their own facts). */
export function placeholdersIn(sample: string | null): string[] {
  return sample ? [...new Set(sample.match(PLACEHOLDER) ?? [])] : [];
}

/** What the session already holds for one question: the saved answer and its feedback. */
export function savedFor(s: PracticeSession, questionId: string): { answer: string; feedback: ShownFeedback | null } {
  const a = (s.answers ?? []).find((x) => x.questionId === questionId);
  if (!a) return { answer: '', feedback: null };
  return {
    answer: a.answer,
    feedback: a.feedback ? { feedback: a.feedback, sampleAnswer: a.sampleAnswer, placeholders: placeholdersIn(a.sampleAnswer), costMicros: null, mode: null, forAnswer: a.answer } : null,
  };
}

/** How many questions of the session have an answer saved. */
export function answeredCount(s: PracticeSession): number {
  const ids = new Set(s.questions.map((q) => q.id));
  return (s.answers ?? []).filter((a) => ids.has(a.questionId) && a.answer.trim()).length;
}
