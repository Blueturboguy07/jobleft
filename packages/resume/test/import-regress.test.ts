// Regression tests for import errors found by evaluators: degree and major copied exactly, a title that starts with
// an organisation word, and bullets whose marks a PDF draws as shapes (headless Chrome printing <ul><li>).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importInProcess } from '../src/import/index.ts';
import { read } from './helpers.ts';

test('degree, major, employer and title are copied exactly', async () => {
  const r = await importInProcess(read('import-fields.txt'), 'import-fields.txt', 'text/plain');
  const p = r.proposedProfile;
  assert.deepEqual(p.work.map((w) => [w.company, w.title]), [['Adventure Works Cloud', 'Systems Engineer'], ['Contoso Labs', 'Analytics Intern']]);
  assert.deepEqual(p.education.map((e) => [e.school, e.degree, e.major]), [
    ['Blinn College', 'B.B.A.', 'Business Analytics'],
    ['Sample State University', 'B.S.', 'Industrial Engineering'],
    ['Sample Tech Institute', 'B.S.', 'International Relations'],
  ]);
});

test('bullets drawn as shapes are split where the lines end, and the report says so', async () => {
  const r = await importInProcess(read('chrome-drawn-bullets.pdf'), 'chrome-drawn-bullets.pdf', 'application/pdf');
  const p = r.proposedProfile;
  assert.deepEqual(p.work.map((w) => w.bullets.length), [5, 4]);
  assert.equal(r.report.counts.bullets, 9);
  assert.equal(p.work[0]!.bullets[1], 'Led a migration of 12 services to PostgreSQL with zero downtime and wrote the runbooks that the on-call team used every week for rollbacks');
  assert.ok(r.report.warnings.some((w) => /drawn as shapes/.test(w)), r.report.warnings.join(' | '));
  assert.deepEqual(p.education.map((e) => [e.degree, e.major]), [['B.S.', 'Information Technology']]);
});

test('an exported resume with an organisation word in a title and B.B.A. reads back the same', async () => {
  const { jordanProfile } = await import('./helpers.ts');
  const { documentFromProfile } = await import('../src/document.ts');
  const { renderResumeDocx, renderResumePdf } = await import('../src/render/index.ts');
  const p = jordanProfile();
  p.work[0]!.company = 'Adventure Works Cloud';
  p.work[0]!.title = 'Systems Engineer';
  p.work[1]!.title = 'Analytics Intern';
  p.education[0]!.degree = 'B.B.A.';
  p.education[0]!.major = 'Information Systems';
  const doc = documentFromProfile(p);
  for (const [name, mime, bytes] of [
    ['r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', renderResumeDocx(doc).bytes],
    ['r.pdf', 'application/pdf', renderResumePdf(doc).bytes],
  ] as const) {
    const r = await importInProcess(bytes, name, mime);
    const q = r.proposedProfile;
    assert.deepEqual(q.work.map((w) => [w.company, w.title]), p.work.map((w) => [w.company, w.title]), name);
    assert.deepEqual(q.education.map((e) => [e.degree, e.major]), [['B.B.A.', 'Information Systems']], name);
  }
});
