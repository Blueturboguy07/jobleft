import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atsCheckPdf } from '../src/ats.ts';
import { documentFromProfile } from '../src/document.ts';
import { atsCheck } from '../src/index.ts';
import { renderResumePdf } from '../src/render/index.ts';
import { jordanProfile, read } from './helpers.ts';

const strip = (r: Awaited<ReturnType<typeof atsCheckPdf>>) => ({ ...r, checkedAt: '' });

test('jobleft\'s own export grades A, the same way every time', async () => {
  const pdf = renderResumePdf(documentFromProfile(jordanProfile())).bytes;
  const a = await atsCheckPdf(pdf);
  const b = await atsCheck(pdf);
  assert.equal(a.grade, 'A');
  assert.equal(a.score, 100);
  assert.deepEqual(strip(a), strip(b));
});

test('a scanned PDF scores low and says why, with evidence', async () => {
  const r = await atsCheckPdf(read('scanned.pdf'));
  assert.ok(r.score <= 10);
  const f = r.findings.find((x) => x.rule === 'no_text_layer')!;
  assert.equal(f.severity, 'urgent');
  assert.match(f.evidence, /0 characters of text, 1 image/);
});

test('a two-column layout built from a table is caught', async () => {
  const r = await atsCheckPdf(read('jordan-table-two-column.pdf'));
  assert.ok(r.score <= 45, String(r.score));
  const f = r.findings.find((x) => x.rule === 'multi_column')!;
  assert.ok(f && /gap at x =/.test(f.evidence));
  const r2 = await atsCheckPdf(read('jordan-two-column.pdf'));
  assert.ok(r2.findings.some((x) => x.rule === 'multi_column'));
});

test('a password-protected PDF and a non-PDF are graded as unreadable', async () => {
  assert.equal((await atsCheckPdf(read('locked.pdf'))).findings[0]!.rule, 'encrypted');
  assert.equal((await atsCheckPdf(read('text-named.pdf'))).findings[0]!.rule, 'not_a_pdf');
});

function pdfWithContent(content: string): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

test('white or invisible text is found (keywords hidden from people)', async () => {
  const visible = 'BT /F1 12 Tf 72 700 Td (Jordan Testwell jordan.testwell@example.com) Tj ET';
  const white = await atsCheckPdf(pdfWithContent(`${visible}\n1 1 1 rg BT /F1 12 Tf 72 680 Td (Kubernetes Terraform) Tj ET`));
  assert.ok(white.findings.some((f) => f.rule === 'white_text' && /white fill/.test(f.evidence)), JSON.stringify(white.findings));
  assert.ok(white.score <= 40);
  const invisible = await atsCheckPdf(pdfWithContent(`${visible}\nBT 3 Tr /F1 12 Tf 72 680 Td (Kubernetes Terraform) Tj ET`));
  assert.ok(invisible.findings.some((f) => f.rule === 'invisible_text'));
  const clean = await atsCheckPdf(pdfWithContent(visible));
  assert.ok(!clean.findings.some((f) => f.rule === 'white_text' || f.rule === 'invisible_text'));
});

test('the score changes only when the file changes', async () => {
  const p = jordanProfile();
  const a = await atsCheckPdf(renderResumePdf(documentFromProfile(p)).bytes);
  const p2 = jordanProfile();
  p2.skills = [];
  const b = await atsCheckPdf(renderResumePdf(documentFromProfile(p2)).bytes);
  assert.notEqual(a.fileSha256, b.fileSha256);
  assert.ok(b.findings.some((f) => f.rule === 'missing_skills_heading'));
  assert.ok(b.score < a.score);
});
