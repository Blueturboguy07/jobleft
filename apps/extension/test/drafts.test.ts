import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactLeaks, templateDraft } from '../src/drafts.ts';
import { field, persona } from './persona.ts';

/** The tester's profile: one skill, no work, no education, no project. */
function thin() {
  const p = persona();
  return { ...p, work: [], education: [], projects: [], summary: null, skills: [{ name: 'SQL', years: 3, source: 'user' as const }] };
}

test('offline drafts: a project question with no project in the profile is a frame, not "My skills include SQL." (JL-extension-9)', () => {
  const d = templateDraft(field('Tell us about a project you are proud of.', { kind: 'textarea' }), thin(), null);
  assert.notEqual(d, 'My skills include SQL.');
  assert.match(d, /\[name the project\]/, 'the frame says what to fill in');
  assert.match(d, /SQL/, 'it may point at a real skill, inside a blank');
  assert.ok(!/My skills include/.test(d), 'no unrelated fact passed off as an answer');
  // A real project is used when the profile has one.
  const withProject = { ...thin(), projects: [{ id: 'p1', name: 'Billing dashboard', description: 'A dashboard for invoices.', url: null, bullets: [], startDate: null, endDate: null }] };
  assert.match(templateDraft(field('Tell us about a project you are proud of.', { kind: 'textarea' }), withProject as never, null), /^One project I worked on is Billing dashboard\./);
});

test('offline drafts: "why" leaves the reason to the person, and skills alone are not called experience', () => {
  const d = templateDraft(field('Why do you want to work at Acme Practice Co?', { kind: 'textarea' }), thin(), null);
  assert.match(d, /^\[Say what draws you to this company and to this role\.\]/);
  assert.match(d, /My skills include SQL\./);
  assert.match(d, /use these skills/);
  assert.ok(!/experience/.test(d));
  const full = templateDraft(field('Why are you interested in this role?', { kind: 'textarea' }), persona(), null);
  assert.match(full, /I work as a Software Engineer at Northwind Sample Labs\./);
  assert.match(full, /bring this experience/);
  assert.equal(contactLeaks(full, persona()).length, 0);
});

test('offline drafts: a question the profile facts do not answer gets no draft', () => {
  assert.equal(templateDraft(field('Describe a time you disagreed with a teammate.', { kind: 'textarea' }), persona(), null), '');
  assert.equal(templateDraft(field('Why do you want to work here?', { kind: 'textarea' }), { ...thin(), skills: [] }, null), '', 'no facts at all: no draft');
});
