import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Profile } from '@jobleft/contracts';
import { documentFromProfile, documentText } from '../src/document.ts';
import { importInProcess } from '../src/import/index.ts';
import { readPdf } from '../src/pdf-read.ts';
import { renderLetterPdf, renderResumeDocx, renderResumePdf } from '../src/render/index.ts';
import { readZip } from '../src/zip.ts';
import { jordanProfile } from './helpers.ts';

async function pdfText(bytes: Uint8Array): Promise<{ pages: number; lines: string[] }> {
  const r = await readPdf(bytes);
  const lines: string[] = [];
  for (const p of r.pages) {
    const rows = new Map<number, string[]>();
    for (const it of p.items) { const k = Math.round(it.y); rows.set(k, [...(rows.get(k) ?? []), it.text]); }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) lines.push(rows.get(y)!.join(''));
  }
  return { pages: r.pages.length, lines };
}

function oversized(): Profile {
  const p = jordanProfile();
  for (let i = 0; i < 8; i++) {
    p.work.push({
      id: `old${i}`, company: `Example Company ${String.fromCharCode(65 + i)}`, title: 'Analyst', employmentType: null, location: 'Austin, TX',
      startDate: `${2010 + i}-01`, endDate: `${2010 + i}-12`, current: false, summary: null,
      bullets: Array.from({ length: 6 }, (_, k) => `Handled task number ${k + 1} of the yearly work plan for the team and wrote it up for the managers.`),
    });
  }
  return p;
}

test('the resume PDF is exactly one page, with real text in reading order', async () => {
  const p = jordanProfile();
  const r = renderResumePdf(documentFromProfile(p));
  assert.equal(r.pages, 1);
  assert.deepEqual(r.leftOut, []);
  const t = await pdfText(r.bytes);
  assert.equal(t.pages, 1);
  const all = t.lines.join('\n');
  const order = ['Jordan Testwell', 'jordan.testwell@example.com', 'Summary', 'Experience', 'Education', 'Skills', 'Projects'].map((s) => all.indexOf(s));
  assert.ok(order.every((x) => x >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(!/[ﬀ-ﬆ]/.test(all), 'no ligature characters');
  assert.ok(all.includes('Cut batch-job time by 40% by rewriting the scheduler in TypeScript.'));
});

test('the same document gives the same PDF bytes (an old version exports the same)', () => {
  const doc = documentFromProfile(jordanProfile());
  assert.deepEqual(renderResumePdf(doc).bytes, renderResumePdf(structuredClone(doc)).bytes);
  assert.deepEqual(renderResumeDocx(doc).bytes, renderResumeDocx(structuredClone(doc)).bytes);
});

test('an oversized resume still prints on one page and lists every left-out item; the rest is whole', async () => {
  const p = oversized();
  const doc = documentFromProfile(p);
  const r = renderResumePdf(doc);
  assert.equal(r.pages, 1);
  assert.ok(r.leftOut.length > 0);
  const t = await pdfText(r.bytes);
  assert.equal(t.pages, 1);
  // Every bullet that was not left out is printed whole (checked by joining wrapped lines).
  const printed = t.lines.join(' ').replace(/\s+/g, ' ');
  const kept = r.fit.doc.sections.flatMap((s) => s.items.flatMap((i) => i.bullets));
  for (const b of kept) assert.ok(printed.includes(b), `missing or cut: ${b}`);
  const leftText = r.leftOut.join('\n');
  for (const s of doc.sections) for (const it of s.items) for (const b of it.bullets) {
    if (!kept.includes(b)) assert.ok(leftText.includes(b) || leftText.includes(`${it.heading}`), `dropped silently: ${b}`);
  }
  // The newest job keeps its bullets; the contact line is never dropped.
  assert.ok(printed.includes('Cut batch-job time by 40%'));
  assert.ok(printed.includes('jordan.testwell@example.com'));
});

test('the Word file holds the same text as the PDF, in body paragraphs (no header part, no text boxes)', () => {
  const doc = documentFromProfile(jordanProfile());
  const bytes = renderResumeDocx(doc).bytes;
  const zip = readZip(bytes);
  assert.ok(!zip.names.some((n) => /header|footer/.test(n)));
  const xml = zip.text('word/document.xml');
  assert.ok(!/txbxContent|<w:tbl>/.test(xml));
  const text = xml.split('</w:p>').map((para) => [...para.matchAll(/<w:t xml:space="preserve">([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')).join('\n');
  for (const line of documentText(doc).split('\n').filter(Boolean)) {
    for (const w of line.replace(/^• /, '').split(' | ')) assert.ok(text.replace(/&amp;/g, '&').includes(w.trim()), `docx lacks: ${w}`);
  }
});

test('export then re-import gives back the same profile facts (PDF and Word)', async () => {
  const p = jordanProfile();
  p.personal.firstName = 'José';
  p.skills.push({ name: 'C#', years: null, source: 'user' }, { name: 'R&D', years: null, source: 'user' });
  const doc = documentFromProfile(p);
  for (const [bytes, name] of [[renderResumePdf(doc).bytes, 'x.pdf'], [renderResumeDocx(doc).bytes, 'x.docx']] as const) {
    const r = await importInProcess(bytes, name, '');
    const q = r.proposedProfile;
    assert.equal(q.personal.firstName, 'José', name);
    assert.equal(q.personal.email, p.personal.email);
    assert.deepEqual(q.personal.links.map((l) => l.url), p.personal.links.map((l) => l.url));
    assert.deepEqual(q.work.map((w) => [w.title, w.company, w.location, w.startDate, w.endDate, w.current, w.bullets]), p.work.map((w) => [w.title, w.company, w.location, w.startDate, w.endDate, w.current, w.bullets]), name);
    assert.deepEqual(q.education.map((e) => [e.school, e.degree, e.major, e.startDate, e.endDate, e.gpa]), p.education.map((e) => [e.school, e.degree, e.major, e.startDate, e.endDate, e.gpa]));
    assert.deepEqual(q.skills.map((s) => s.name), p.skills.map((s) => s.name), name);
  }
});

test('characters the PDF fonts cannot show are refused with a message, never replaced', () => {
  const p = jordanProfile();
  p.personal.firstName = 'Łukasz';
  assert.throws(() => renderResumePdf(documentFromProfile(p)), /cannot show these characters/);
  assert.ok(renderResumeDocx(documentFromProfile(p)).bytes.byteLength > 0);
});

test('a cover letter PDF is one page; a letter that is too long is refused, not cut', async () => {
  const letter = 'Jordan Testwell\njordan.testwell@example.com\n\nDear Hiring Manager,\n\nI am writing to apply.\n\nSincerely,\nJordan Testwell';
  const b = renderLetterPdf(letter);
  assert.equal((await readPdf(b)).pages.length, 1);
  const long = letter.replace('I am writing to apply.', Array.from({ length: 90 }, () => 'I am writing to apply for this role and I would like to talk about it at length.').join(' \n\n'));
  assert.throws(() => renderLetterPdf(long), /longer than one page/);
});
