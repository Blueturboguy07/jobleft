import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FillRequest, FormField } from '@jobleft/contracts';
import { FillResponseSchema, validate } from '@jobleft/contracts';
import { answerFill } from '../src/answer.ts';
import { field, opts, persona } from './persona.ts';

function req(fields: FormField[]): FillRequest {
  return { requestId: 'r1', pageUrl: 'http://127.0.0.1:47900/p.html', ats: 'other', step: null, fields, resumeId: null };
}

const resume = { id: 'res-default', fileName: 'Jordan_Testwell_Resume.pdf', mimeType: 'application/pdf', base64: 'JVBERi0xLjQK' };

test('standard fields get exact profile values; the answer matches its contract', async () => {
  const fs = [field('First name'), field('Last name'), field('Email'), field('Phone'), field('LinkedIn'), field('Resume', { kind: 'file' })];
  const r = await answerFill(req(fs), { profile: persona(), resume, draftOffer: null });
  assert.ok(validate(FillResponseSchema, r).ok);
  const v = Object.fromEntries(r.fills.map((f) => [f.fieldId, f.values[0]]));
  assert.equal(v[fs[0]!.fieldId], 'Jordan');
  assert.equal(v[fs[1]!.fieldId], 'Testwell');
  assert.equal(v[fs[2]!.fieldId], 'jordan.testwell@example.com');
  assert.equal(v[fs[3]!.fieldId], '555-0100');
  assert.equal(v[fs[4]!.fieldId], 'https://www.linkedin.com/in/jordan-testwell-example');
  assert.equal(r.files[0]?.fieldId, fs[5]!.fieldId);
});

test('no invented facts: missing profile items stay empty with a note', async () => {
  const fs = [field('Middle name'), field('GitHub'), field('Preferred name'), field('Years of experience with Kubernetes'), field('Years of experience'),
    field('School', { entry: 1, section: 'Education' }), field('Certification name')];
  const r = await answerFill(req(fs), { profile: persona(), resume: null, draftOffer: null });
  assert.equal(r.fills.length, 0, JSON.stringify(r.fills));
  assert.equal(r.unknownFieldIds.length, fs.length);
});

test('sensitive questions stay empty without a saved answer; pay never comes from the salary filter', async () => {
  const fs = [
    field('Gender', { kind: 'select', options: opts('Select', 'Male', 'Female', 'Decline to self identify') }),
    field('Veteran status', { kind: 'select', options: opts('I am a protected veteran', 'I am not a protected veteran', "I don't wish to answer") }),
    field('Are you legally authorized to work in the United States?', { kind: 'radio', options: opts('Yes', 'No') }),
    field('Will you require visa sponsorship?', { kind: 'radio', options: opts('Yes', 'No') }),
    field('Desired salary'), field('Date of birth'),
  ];
  const r = await answerFill(req(fs), { profile: persona(), resume: null, draftOffer: null });
  assert.equal(r.fills.length, 0);
  assert.ok(r.notes?.every((n) => n.reason === 'sensitive'));
});

test('one saved answer changes one question, with the exact saved choice', async () => {
  const p = persona();
  p.eeo.veteran = 'no';
  const fs = [
    field('Gender', { kind: 'select', options: opts('Male', 'Female', 'Decline to self identify') }),
    field('Veteran status', { kind: 'select', options: opts('I am a protected veteran', 'I am not a protected veteran', "I don't wish to answer") }),
    field('Disability', { kind: 'select', options: opts('Yes', 'No', 'I do not want to answer') }),
  ];
  const r = await answerFill(req(fs), { profile: p, resume: null, draftOffer: null });
  assert.equal(r.fills.length, 1);
  assert.equal(r.fills[0]?.fieldId, fs[1]!.fieldId);
  assert.deepEqual(r.fills[0]?.values, ['I am not a protected veteran']);
});

test('a second Name or Email (a referrer) never gets the person details', async () => {
  const fs = [field('Full name'), field('Email'), field('Name'), field('Email address'), field('Referrer email')];
  const r = await answerFill(req(fs), { profile: persona(), resume: null, draftOffer: null });
  assert.deepEqual(r.fills.map((f) => f.fieldId), [fs[0]!.fieldId, fs[1]!.fieldId]);
});

test('dropdowns with no exact option stay empty and say so', async () => {
  const fs = [
    field('Country', { kind: 'select', options: opts('United States Minor Outlying Islands', 'Uruguay') }),
    field('Degree', { kind: 'select', section: 'Education', options: opts('Bachelor of Arts', 'Master of Arts') }),
  ];
  const r = await answerFill(req(fs), { profile: persona(), resume: null, draftOffer: null });
  assert.equal(r.fills.length, 0);
  assert.deepEqual(r.notes?.map((n) => n.reason), ['no_option', 'no_option']);
});

test('open questions are never filled; a free provider drafts, a paid one only offers', async () => {
  const q = [field('Why do you want to work here?', { kind: 'textarea' }), field('Tell us about a project you are proud of.', { kind: 'textarea' })];
  const free = await answerFill(req(q), {
    profile: persona(), resume: null,
    draftOffer: { provider: 'Local template', local: true, maxPriceMicrosPerDraft: 0, balanceMicros: null },
    draft: async (fs) => fs.map((f) => ({ fieldId: f.fieldId, text: 'draft', provider: 'Local template' })),
  });
  assert.equal(free.fills.length, 0);
  assert.equal(free.drafts.length, 2);
  const paid = await answerFill(req(q), {
    profile: persona(), resume: null,
    draftOffer: { provider: 'publik API', local: false, maxPriceMicrosPerDraft: 10_000, balanceMicros: 1_000_000 },
    draft: async () => { throw new Error('must not be called'); },
  });
  assert.equal(paid.drafts.length, 0);
  assert.equal(paid.draftOffer?.fieldIds.length, 2);
});

test('dates follow the box format; a day the profile lacks is never made up', async () => {
  const fs = [
    field('Start date', { section: 'Education', placeholder: 'MM/YYYY' }),
    field('End date', { section: 'Education', inputType: 'date', kind: 'date' }),
    field('Start date year', { section: 'Employment' }),
  ];
  const r = await answerFill(req(fs), { profile: persona(), resume: null, draftOffer: null });
  const v = Object.fromEntries(r.fills.map((f) => [f.fieldId, f.values[0]]));
  assert.equal(v[fs[0]!.fieldId], '08/2017');
  assert.equal(v[fs[1]!.fieldId], undefined);
  assert.equal(v[fs[2]!.fieldId], '2023');
});
