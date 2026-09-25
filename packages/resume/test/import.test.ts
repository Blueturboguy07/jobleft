import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProfileInput } from '@jobleft/contracts';
import { importInProcess, importResume } from '../src/import/index.ts';
import { JORDAN, PUBLICATIONS } from './fixtures/src/persona.ts';
import { read } from './helpers.ts';

function assertJordan(p: ProfileInput, label: string): void {
  const J = JORDAN;
  assert.equal([p.personal.firstName, p.personal.lastName].join(' '), J.name, `${label}: name`);
  assert.equal(p.personal.email, J.email, `${label}: email`);
  assert.equal(p.personal.phone, J.phone, `${label}: phone`);
  assert.equal(`${p.personal.city}, ${p.personal.region}`, J.city, `${label}: city`);
  assert.deepEqual(p.personal.links.map((l) => l.url), J.links, `${label}: links`);
  assert.equal(p.summary, J.summary, `${label}: summary`);
  assert.equal(p.work.length, J.jobs.length, `${label}: jobs`);
  J.jobs.forEach((j, i) => {
    const w = p.work[i]!;
    assert.equal(w.title, j.title, `${label}: title ${i}`);
    assert.equal(w.company, j.company, `${label}: company ${i}`);
    assert.equal(w.location, j.location, `${label}: location ${i}`);
    assert.equal(w.startDate, j.startYm, `${label}: start ${i} (month kept)`);
    assert.equal(w.endDate, j.endYm, `${label}: end ${i}`);
    assert.equal(w.current, j.current, `${label}: current ${i}`);
    assert.deepEqual(w.bullets, j.bullets, `${label}: bullets of job ${i} stay with job ${i}`);
  });
  assert.equal(p.education.length, 1, `${label}: degrees`);
  const e = p.education[0]!;
  assert.equal(e.school, J.education[0]!.school);
  assert.equal(e.degree, J.education[0]!.degree);
  assert.equal(e.major, J.education[0]!.major);
  assert.equal(e.startDate, J.education[0]!.startYm);
  assert.equal(e.endDate, J.education[0]!.endYm);
  assert.equal(e.gpa, J.education[0]!.gpa);
  assert.deepEqual(p.skills.map((s) => s.name), J.skills, `${label}: skills`);
  assert.deepEqual(p.projects.map((x) => x.name), J.projects.map((x) => x.name), `${label}: projects`);
  assert.deepEqual(p.projects[0]!.bullets, J.projects[0]!.bullets, `${label}: project bullets`);
}

for (const [file, label] of [
  ['jordan-one-column.pdf', 'one-column PDF'], ['jordan-two-column.pdf', 'two-column PDF'], ['jordan-word.docx', 'Word file'],
  ['jordan-layout-table.docx', 'Word file with a layout table'], ['jordan.txt', 'text file'],
] as const) {
  test(`import reads every field of the ${label}`, async () => {
    const r = await importInProcess(read(file), file, '');
    assert.equal(r.report.outcome, 'ok', JSON.stringify(r.report));
    assertJordan(r.proposedProfile, label);
    assert.deepEqual(r.report.counts, { jobs: 2, bullets: 6, skills: 12, education: 1 });
  });
}

test('accents and symbols survive: José, C#, C++, R&D, 100%, Node.js, a long link', async () => {
  const r = await importInProcess(read('jordan-accents.pdf'), 'jordan-accents.pdf', 'application/pdf');
  const p = r.proposedProfile;
  assert.equal(p.personal.firstName, 'José');
  assert.equal(p.personal.lastName, 'Álvarez-Testwell');
  assert.equal(p.personal.email, 'jose.alvarez+jobs@example.com');
  assert.equal(p.personal.links[0]!.url, 'https://example.com/jos%C3%A9/a-very-long-portfolio-link-that-goes-on-and-on-for-testing-purposes/index.html');
  for (const s of ['C#', 'C++', 'R&D', 'Node.js']) assert.ok(p.skills.some((x) => x.name === s), s);
  assert.ok(p.work[0]!.bullets.some((b) => b.includes('100%') && b.includes('Node.js')));
});

test('an unknown section is kept word for word and named as unread', async () => {
  const r = await importInProcess(read('jordan-publications.pdf'), 'x.pdf', 'application/pdf');
  assert.equal(r.report.outcome, 'partial');
  assert.deepEqual(r.report.unreadSections, ['Publications']);
  assert.ok(r.report.warnings.some((w) => w.includes('Publications')));
  assert.deepEqual(r.proposedProfile.extraSections?.[0]?.lines, PUBLICATIONS);
});

test('bad files get a failure and a plain message, never an empty profile', async () => {
  const cases: Array<[string, string]> = [
    ['scanned.pdf', 'image_only'], ['locked.pdf', 'password_protected'], ['empty.pdf', 'empty_file'], ['text-named.pdf', 'unsupported_type'],
  ];
  for (const [file, failure] of cases) {
    const r = await importResume(read(file), file, 'application/pdf');
    assert.equal(r.report.outcome, 'failed', file);
    assert.equal(r.report.failure, failure, file);
    assert.ok(r.message && r.message.length > 20, file);
    assert.equal(r.proposedProfile.work.length, 0);
  }
  const big = new Uint8Array(10 * 1024 * 1024 + 1);
  const r = await importResume(big, 'big.pdf', 'application/pdf');
  assert.equal(r.report.failure, 'too_large');
  assert.match(r.message!, /10 MB/);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal((await importResume(png, 'resume.png', 'image/png')).report.failure, 'image_only');
  const doc = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  assert.equal((await importResume(doc, 'old.doc', 'application/msword')).report.failure, 'unsupported_type');
  const brokenZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]);
  assert.equal((await importResume(brokenZip, 'x.docx', '')).report.failure, 'corrupt');
});

test('a Word file that expands too far is refused, not read (zip bomb guard)', async () => {
  const { writeZip } = await import('../src/zip.ts');
  const huge = new Uint8Array(45 * 1024 * 1024); // zeros compress to almost nothing
  const zip = writeZip([{ name: 'word/document.xml', data: huge }]);
  assert.ok(zip.byteLength < 1024 * 1024);
  const r = await importResume(zip, 'bomb.docx', '');
  assert.equal(r.report.outcome, 'failed');
  assert.equal(r.report.failure, 'too_large');
});

test('the import stops with a message when reading takes too long (no hang)', async () => {
  const t0 = Date.now();
  const r = await importResume(read('jordan-long.pdf'), 'long.pdf', 'application/pdf', { timeoutMs: 1 });
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(r.report.outcome, 'failed');
  assert.match(r.message!, /took more than/);
});

test('import sends nothing over the network', async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('no network in import'); }) as typeof fetch;
  try {
    for (const f of ['jordan-one-column.pdf', 'jordan-two-column.pdf', 'jordan-word.docx']) await importInProcess(read(f), f, '');
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(calls, 0);
});

test('a long multi-page resume is read in full, with jobs in order', async () => {
  const r = await importInProcess(read('jordan-long.pdf'), 'long.pdf', 'application/pdf');
  assert.equal(r.proposedProfile.work.length, 6);
  assert.deepEqual(r.proposedProfile.work.map((w) => w.company), ['Northwind Sample Labs', 'Contoso Example Corp', 'Fabrikam Sample Inc', 'Tailspin Example Toys', 'Sample State University', 'Woodgrove Example Market']);
  for (const w of r.proposedProfile.work) assert.ok(w.bullets.length >= 6, `${w.company}: ${w.bullets.length}`);
});
