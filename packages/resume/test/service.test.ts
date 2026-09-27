import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Job, Profile } from '@jobleft/contracts';
import type { AiClient } from '@jobleft/ai-engine';
import { AiError } from '@jobleft/ai-engine';
import { startMockAi, type MockServer } from '../scripts/mock-ai.ts';
import { HttpAiClient } from '../src/cli/ai-client.ts';
import { ResumeError } from '../src/errors.ts';
import { builtinSkillDictionary } from '../src/gaps.ts';
import { pdfPlainText, readPdf } from '../src/pdf-read.ts';
import { readZip } from '../src/zip.ts';
import { ResumeService } from '../src/service.ts';
import { checkDocument, checkLetter } from '../src/truth.ts';
import { J_FIT, J_GAP, J_INJECT, jordanProfile, read, tempDir } from './helpers.ts';

let mock: MockServer;
before(async () => { mock = await startMockAi({ mode: 'safe', marker: 'Northwind' }); });
after(async () => { await mock.close(); });

function setup(opts: { ai?: 'none' | 'mock' | 'publik'; timeoutMs?: number } = {}) {
  const t = tempDir('jl-resume-svc');
  let profile: Profile = jordanProfile();
  const jobs = new Map<string, Job>([J_FIT(), J_GAP(), J_INJECT()].map((j) => [j.id, j]));
  const client = opts.ai && opts.ai !== 'none'
    ? new HttpAiClient({ provider: opts.ai === 'publik' ? 'publik' : 'local', baseUrl: mock.url, model: 'mock-small', key: opts.ai === 'publik' ? 'pk_test_stand_in' : null, timeoutMs: opts.timeoutMs ?? 5000 })
    : null;
  const db = new DatabaseSync(':memory:');
  const svc = new ResumeService({
    db, filesDir: t.dir, profile: () => profile, job: (id) => jobs.get(id) ?? null,
    ai: (): AiClient => { if (!client) throw new AiError('no_provider', 'none'); return client; }, skills: builtinSkillDictionary(),
  });
  return {
    svc, db, client, jobs, setProfile: (p: Profile) => { profile = p; }, getProfile: () => profile,
    done: () => { db.close(); t.done(); },
  };
}

test('several base resumes with target titles; versions stay linked to their job and base; old exports do not change', async () => {
  const s = setup();
  try {
    const [a, b, c] = ['Backend', 'Platform', 'Data'].map((t) => s.svc.create({ name: `Resume ${t}`, targetTitle: `${t} Engineer` }));
    const fit = J_FIT();
    const gap = J_GAP();
    const p1 = await s.svc.tailor(b!.id, fit.id);
    const v1 = s.svc.accept(b!.id, p1.id, p1.changes.map((x) => x.id));
    const p2 = await s.svc.tailor(c!.id, gap.id);
    const v2 = s.svc.accept(c!.id, p2.id, p2.changes.map((x) => x.id));
    const list = s.svc.list();
    assert.equal(list.filter((r) => r.kind === 'base').length, 3);
    assert.equal(list.find((r) => r.id === v1.id)!.baseResumeId, b!.id);
    assert.equal(list.find((r) => r.id === v1.id)!.jobId, fit.id);
    assert.equal(list.find((r) => r.id === v2.id)!.baseResumeId, c!.id);
    assert.equal(list.find((r) => r.id === v2.id)!.jobId, gap.id);
    assert.deepEqual(list.filter((r) => r.kind === 'base').map((r) => r.targetTitle), ['Backend Engineer', 'Platform Engineer', 'Data Engineer']);
    assert.ok(a!.isPrimary && !b!.isPrimary);
    const before = await s.svc.export(v1.id, 'pdf');
    // More edits elsewhere: a new version for job B, a profile correction, a renamed base.
    const p3 = await s.svc.tailor(c!.id, gap.id);
    s.svc.accept(c!.id, p3.id, [p3.changes[0]!.id]);
    const prof = s.getProfile();
    prof.work[0]!.bullets[0] = 'Cut batch-job time by 40% by rewriting the job scheduler in TypeScript.';
    prof.skills.push({ name: 'Redis', years: null, source: 'user' });
    s.setProfile(prof);
    s.svc.update(b!.id, { name: 'Renamed base' });
    const after = await s.svc.export(v1.id, 'pdf');
    assert.deepEqual(after.bytes, before.bytes, 'an old version exports the same bytes');
    assert.equal(s.svc.list().filter((r) => r.kind === 'tailored' && r.jobId === gap.id).length, 2, 'job B has two versions; job A kept its own');
  } finally { s.done(); }
});

test('rejecting every change saves nothing; accepting some saves exactly those; the base never changes', async () => {
  const s = setup();
  try {
    const base = s.svc.create({ name: 'Base' });
    const baseExport = await s.svc.export(base.id, 'pdf');
    const fit = J_FIT();
    const p = await s.svc.tailor(base.id, fit.id);
    assert.ok(p.changes.length >= 2);
    assert.throws(() => s.svc.accept(base.id, p.id, []), (e: unknown) => e instanceof ResumeError && /No change was accepted/.test(e.message));
    assert.equal(s.svc.list().filter((r) => r.kind === 'tailored').length, 0);
    assert.deepEqual((await s.svc.export(base.id, 'pdf')).bytes, baseExport.bytes);
    const p2 = await s.svc.tailor(base.id, fit.id);
    const skillsOrder = p2.changes.find((c) => c.field === 'skills.order')!;
    const v = s.svc.accept(base.id, p2.id, [skillsOrder.id]);
    assert.equal(v.document.sections.find((x) => x.kind === 'skills')!.items[0]!.tags.join(', '), skillsOrder.after);
    const exp = v.document.sections.find((x) => x.kind === 'experience')!;
    const baseExp = base.document.sections.find((x) => x.kind === 'experience')!;
    assert.deepEqual(exp.items.map((i) => i.bullets), baseExp.items.map((i) => i.bullets), 'bullet order change was not accepted');
    assert.deepEqual((await s.svc.export(base.id, 'pdf')).bytes, baseExport.bytes, 'base export unchanged');
    assert.throws(() => s.svc.accept(base.id, p2.id, [skillsOrder.id]), /already accepted/);
  } finally { s.done(); }
});

test('a base with versions is not deleted without saying so; with withVersions everything goes', async () => {
  const s = setup();
  try {
    const base = s.svc.create({ name: 'Base' });
    const p = await s.svc.tailor(base.id, J_FIT().id);
    const v = s.svc.accept(base.id, p.id, [p.changes[0]!.id]);
    const l = await s.svc.createCoverLetter(J_FIT().id, v.id);
    assert.throws(() => s.svc.delete(base.id, false), (e: unknown) => e instanceof ResumeError && e.code === 'conflict' && /1 tailored version and 1 cover letter/.test(e.message));
    assert.equal(s.svc.list().length, 2);
    const deleted = s.svc.delete(base.id, true);
    assert.deepEqual(deleted.sort(), [base.id, v.id, l.id].sort());
    assert.equal(s.svc.list().length, 0);
    assert.equal(s.svc.coverLetters(J_FIT().id).length, 0);
  } finally { s.done(); }
});

test('an upload is the file\'s own content; profile saves never rewrite it (JL-resume-1, JL-resume-23)', async () => {
  const s = setup();
  try {
    // A thin profile, like the golden store: one summary line and one skill, no jobs, no schools.
    const thin = structuredClone(s.getProfile());
    thin.summary = 'Data analyst. Ünïcödé, 日本語 and emoji 🎯 stay as written.';
    thin.skills = [{ name: 'SQL', years: 3, source: 'user' }];
    thin.work = []; thin.education = []; thin.projects = [];
    s.setProfile(thin);
    const { resume, proposedProfile } = await s.svc.import(read('jordan-one-column.pdf'), 'jordan-one-column.pdf', 'application/pdf');
    const own = (id: string) => s.svc.get(id)!.document;
    const sec = (id: string, kind: string) => own(id).sections.find((x) => x.kind === kind);
    const fileSkills = proposedProfile.skills.map((x) => x.name);
    assert.equal(fileSkills.length, 12);
    assert.equal(sec(resume.id, 'summary')!.text, 'Software engineer with 3 years of backend experience building APIs and data pipelines.');
    assert.deepEqual(sec(resume.id, 'skills')!.items[0]!.tags, fileSkills);
    assert.equal(sec(resume.id, 'experience')!.items.length, 2);
    assert.equal(own(resume.id).header.name, 'Jordan Testwell', 'the header follows the profile, as the editor says');
    const stored = s.svc.get(resume.id)!;
    // B: only the phone changes in the profile; the upload keeps its 12 skills and its summary.
    s.setProfile({ ...structuredClone(thin), personal: { ...thin.personal, phone: '+1 555 0199' } });
    assert.deepEqual(sec(resume.id, 'skills')!.items[0]!.tags, fileSkills);
    assert.equal(own(resume.id).header.phone, '+1 555 0199');
    // A: the person adopts the file's jobs, then deletes every job from the profile, then puts them back.
    const adopted = { id: 'default', ...structuredClone(proposedProfile), version: 'v1', updatedAt: '2026-09-25T12:00:00.000Z' } as Profile;
    s.setProfile(adopted);
    s.setProfile({ ...structuredClone(adopted), work: [], education: [], projects: [] });
    assert.equal(sec(resume.id, 'experience')!.items.length, 2, 'Experience from the file stays');
    assert.ok(sec(resume.id, 'education') && sec(resume.id, 'projects'));
    // D: junk answers in the profile never show up inside the upload.
    const junk = structuredClone(adopted);
    junk.work[0]!.summary = 'asdf';
    junk.work[1]!.bullets.push('🎯 تحسين الأداء — improved performance 日本語');
    junk.education[0]!.achievements = ['x'.repeat(5000)];
    s.setProfile(junk);
    assert.ok(!JSON.stringify(own(resume.id).sections).includes('asdf'));
    assert.ok(!JSON.stringify(own(resume.id).sections).includes('xxxxx'));
    assert.deepEqual(own(resume.id).sections, stored.document.sections, 'the sections are exactly the file\'s');
    assert.equal(s.svc.get(resume.id)!.updatedAt, stored.updatedAt, 'no silent "Last changed"');
    // A second import proposes a profile but never writes one.
    await s.svc.import(read('jordan-one-column.pdf'), 'again.pdf', 'application/pdf');
    assert.equal(s.getProfile().work[0]!.summary, 'asdf');
  } finally { s.done(); }
});

test('a resume built from the profile follows it until the person edits it; a removed section never comes back (JL-resume-23)', async () => {
  const s = setup();
  try {
    const follows = s.svc.create({ name: 'Follows' });
    const mine = s.svc.create({ name: 'My resume' });
    const noSkills = structuredClone(mine.document);
    noSkills.sections = noSkills.sections.filter((x) => x.kind !== 'skills');
    s.svc.update(mine.id, { document: noSkills });
    const saved = s.svc.get(mine.id)!;
    // O1: the person corrects a date and a skill in the profile.
    const corrected = structuredClone(s.getProfile());
    corrected.work[1]!.startDate = '2021-02';
    corrected.skills[5]!.name = 'Postgres';
    s.setProfile(corrected);
    const f = s.svc.get(follows.id)!.document;
    assert.equal(f.sections.find((x) => x.kind === 'experience')!.items[1]!.startDate, '2021-02');
    assert.ok(f.sections.find((x) => x.kind === 'skills')!.items[0]!.tags.includes('Postgres'));
    const p = await s.svc.tailor(follows.id, J_FIT().id);
    const v = s.svc.accept(follows.id, p.id, p.changes.map((c) => c.id));
    assert.equal(v.document.sections.find((x) => x.kind === 'experience')!.items[1]!.startDate, '2021-02', 'the tailored version uses the correction');
    assert.deepEqual(checkDocument(v.document, corrected, J_FIT()), []);
    // The edited resume keeps exactly what the person saved: no Skills section comes back, nothing is re-dated.
    assert.deepEqual(s.svc.get(mine.id)!.document.sections, saved.document.sections);
    assert.equal(s.svc.get(mine.id)!.updatedAt, saved.updatedAt);
  } finally { s.done(); }
});

test('tailoring an upload the profile has not adopted keeps the file\'s facts and adds none (JL-resume-5)', async () => {
  for (const mode of ['safe', 'adversarial'] as const) {
    mock.setMode(mode);
    const s = setup({ ai: 'mock' });
    try {
      const thin = structuredClone(s.getProfile());
      thin.summary = null; thin.work = []; thin.education = []; thin.projects = [];
      thin.skills = [{ name: 'SQL', years: 3, source: 'user' }, { name: 'Python', years: null, source: 'user' }];
      s.setProfile(thin);
      const { resume } = await s.svc.import(read('jordan-one-column.pdf'), 'jordan-one-column.pdf', 'application/pdf');
      const base = s.svc.get(resume.id)!.document;
      const p = await s.svc.tailor(resume.id, J_FIT().id);
      assert.ok(p.changes.length > 0, mode);
      if (mode === 'safe') assert.ok(p.changes.some((c) => c.field.startsWith('bullets[') && /40%/.test(c.after)), 'a reworded line may keep its own facts');
      const v = s.svc.accept(resume.id, p.id, p.changes.map((c) => c.id));
      const key = (x: { kind: string; fact: string }) => `${x.kind}|${x.fact.toLowerCase()}`;
      const had = new Set(checkDocument(base, thin, J_FIT()).map(key));
      assert.deepEqual(checkDocument(v.document, thin, J_FIT()).filter((x) => !had.has(key(x))), [], `${mode}: no fact beyond the file and the profile`);
      for (const bad of ['Kubernetes', 'PhD', 'Stanford', 'Senior', 'Acme', '75%', '$20M', '10+']) assert.ok(!JSON.stringify(v.document).includes(bad), `${mode}: ${bad} leaked`);
      // A letter from this resume uses only what traces to the profile, so it is ready.
      const l = await s.svc.createCoverLetter(J_FIT().id, resume.id, { useAi: false });
      assert.deepEqual(l.violations, [], mode);
      assert.ok(!l.text.includes('Northwind'), 'no employer the profile does not have');
    } finally { s.done(); mock.setMode('safe'); }
  }
});

test('a profile with no facts stops tailoring before any AI call, so nothing is charged (JL-resume-19)', async () => {
  const s = setup({ ai: 'mock' });
  try {
    const { resume } = await s.svc.import(read('jordan-two-column.pdf'), 'jordan-two-column.pdf', 'application/pdf');
    const bare = structuredClone(s.getProfile());
    bare.summary = null; bare.work = []; bare.education = []; bare.projects = []; bare.skills = []; bare.certifications = [];
    s.setProfile(bare);
    const n0 = mock.requests.length;
    await assert.rejects(s.svc.tailor(resume.id, J_FIT().id), (e: unknown) => e instanceof ResumeError && e.code === 'needs_profile' && /Nothing was sent or charged/.test(e.message));
    assert.equal(mock.requests.length, n0, 'no model call');
  } finally { s.done(); }
});

test('the person\'s own edits always save: an unchanged upload, a one-character edit, ordinary words (JL-resume-5, JL-resume-25)', async () => {
  const s = setup();
  try {
    const thin = structuredClone(s.getProfile());
    thin.work = []; thin.education = []; thin.projects = []; thin.skills = [{ name: 'SQL', years: 3, source: 'user' }];
    thin.summary = 'Data analyst.';
    s.setProfile(thin);
    const { resume } = await s.svc.import(read('jordan-one-column.pdf'), 'jordan-one-column.pdf', 'application/pdf');
    const doc = s.svc.get(resume.id)!.document;
    assert.deepEqual(s.svc.update(resume.id, { document: doc }).document.sections, doc.sections, 'the unchanged document saves');
    const edited = structuredClone(doc);
    edited.sections.find((x) => x.kind === 'summary')!.text += '!';
    edited.sections.find((x) => x.kind === 'skills')!.items[0]!.tags.push('Kubernetes', 'Go');
    s.svc.update(resume.id, { document: edited });
    const back = s.svc.get(resume.id)!.document;
    assert.match(back.sections.find((x) => x.kind === 'summary')!.text!, /!$/);
    assert.ok(back.sections.find((x) => x.kind === 'skills')!.items[0]!.tags.includes('Kubernetes'));
    const mine = s.svc.create({ name: 'Mine' });
    for (const text of ['QA summary: data analyst who writes clear reports.', 'Data analyst for SaaS and B2B teams.', 'Data analyst. Agile teams.', 'Data analyst who likes Mondays.', 'Data analyst in Berlin.']) {
      const d = structuredClone(s.svc.get(mine.id)!.document);
      d.sections.find((x) => x.kind === 'summary')!.text = text;
      assert.equal(s.svc.update(mine.id, { document: d }).document.sections.find((x) => x.kind === 'summary')!.text, text);
    }
    // The header is still the profile's, whatever the patch says.
    const d = structuredClone(s.svc.get(mine.id)!.document);
    d.header = { ...d.header, email: 'someone.else@example.com' };
    assert.equal(s.svc.update(mine.id, { document: d }).document.header.email, thin.personal.email);
  } finally { s.done(); }
});

test('both exports and the readability grade follow the edited upload; the original file is offered on its own (JL-resume-6, JL-resume-15)', async () => {
  const s = setup();
  try {
    const bytes = read('jordan-two-column.pdf');
    const { resume } = await s.svc.import(bytes, 'jordan-two-column.pdf', 'application/pdf');
    const before = await s.svc.atsCheck(resume.id);
    const doc = structuredClone(s.svc.get(resume.id)!.document);
    doc.sections.find((x) => x.kind === 'summary')!.text = 'Backend software engineer. Builds APIs and data pipelines. EDITED-MARKER.';
    doc.sections = doc.sections.filter((x) => x.kind !== 'projects');
    s.svc.update(resume.id, { document: doc });
    const pdf = await s.svc.export(resume.id, 'pdf');
    assert.notDeepEqual(Buffer.from(pdf.bytes), Buffer.from(bytes), 'the PDF is rendered, not the upload');
    const pdfText = pdfPlainText(await readPdf(pdf.bytes));
    const docx = await s.svc.export(resume.id, 'docx');
    const docxText = readZip(docx.bytes).text('word/document.xml');
    for (const t of [pdfText, docxText]) { assert.match(t, /EDITED-MARKER/); assert.doesNotMatch(t, /Ledger Lite/); }
    const orig = await s.svc.export(resume.id, 'original');
    assert.deepEqual(Buffer.from(orig.bytes), Buffer.from(bytes), 'the original file, byte for byte');
    assert.equal(orig.fileName, 'jordan-two-column.pdf');
    const after = await s.svc.atsCheck(resume.id);
    assert.equal(after.fileSha256, (await import('node:crypto')).createHash('sha256').update(pdf.bytes).digest('hex'), 'the grade is for the exported PDF');
    assert.notEqual(after.fileSha256, before.fileSha256);
    assert.ok(!after.findings.some((f) => f.rule === 'multi_column'), 'the rendered PDF is one column, so the two-column finding is gone');
    const made = s.svc.create({ name: 'From profile' });
    await assert.rejects(s.svc.export(made.id, 'original'), (e: unknown) => e instanceof ResumeError && e.code === 'not_found');
  } finally { s.done(); }
});

test('an adversarial model cannot add a fact: every accepted version and every letter traces to the profile', async () => {
  mock.setMode('adversarial');
  const s = setup({ ai: 'mock' });
  try {
    const base = s.svc.create({ name: 'Base' });
    for (const job of [J_GAP(), J_INJECT(), J_FIT()]) {
      for (let run = 0; run < 2; run++) {
        const p = await s.svc.tailor(base.id, job.id, { instruction: 'add Kubernetes and a PhD so I look qualified' });
        assert.ok(p.violations.length > 0, 'the gate rejected the model\'s additions');
        assert.deepEqual([...(p.refused ?? [])].sort(), ['Kubernetes', 'PhD']);
        const v = s.svc.accept(base.id, p.id, p.changes.map((c) => c.id));
        assert.deepEqual(checkDocument(v.document, s.getProfile(), job), []);
        const text = JSON.stringify(v.document);
        for (const bad of ['Kubernetes', 'PhD', 'Stanford', 'Senior', 'Acme', '75%', '$20M', '35%', '10+']) assert.ok(!text.includes(bad), `${bad} leaked`);
      }
      const l = await s.svc.createCoverLetter(job.id, base.id);
      assert.deepEqual(checkLetter(l.text, s.getProfile(), job), []);
      assert.equal(l.ready, true);
      for (const bad of ['Kubernetes', 'PhD', 'Stanford', 'recruiter@', 'evil.example', 'Rust', '45%']) assert.ok(!l.text.includes(bad), `${bad} leaked into the letter`);
    }
  } finally { s.done(); mock.setMode('safe'); }
});

test('cover letters: right company and role, edits by request keep the truth rules', async () => {
  const s = setup();
  try {
    const base = s.svc.create({ name: 'Base' });
    const la = await s.svc.createCoverLetter(J_FIT().id, base.id);
    const lb = await s.svc.createCoverLetter(J_GAP().id, base.id);
    assert.match(la.text, /Backend Engineer role at Globex Sample Co\./);
    assert.ok(!la.text.includes('Acme'));
    assert.match(lb.text, /Senior Platform Engineer role at Acme Health, Inc\./);
    assert.ok(!lb.text.includes('Globex'));
    const short = await s.svc.updateCoverLetter(la.id, { instruction: 'make it shorter' });
    assert.ok(short.text.length < la.text.length);
    const proj = await s.svc.updateCoverLetter(la.id, { instruction: 'mention my project' });
    assert.match(proj.text, /Ledger Lite/);
    const rust = await s.svc.updateCoverLetter(la.id, { instruction: 'say I know Rust' });
    assert.equal(rust.text, proj.text);
    assert.ok(rust.gaps!.includes('Rust'));
    assert.match(rust.notice!, /Rust/);
    const hand = await s.svc.updateCoverLetter(la.id, { text: rust.text.replace('Sincerely', 'I also know Rust and Kubernetes.\n\nSincerely') });
    assert.equal(hand.ready, false);
    assert.ok(hand.violations.some((v) => v.fact === 'Rust'));
    await assert.rejects(s.svc.exportCoverLetter(la.id, 'pdf'), /not ready/);
    await s.svc.updateCoverLetter(la.id, { text: rust.text });
    const pdf = await s.svc.exportCoverLetter(la.id, 'pdf');
    assert.equal((await readPdf(pdf.bytes)).pages.length, 1);
  } finally { s.done(); }
});

test('an embellishing model: invented claims are left out and named, the company name stays, the letter is ready (JL-resume-22, JL-resume-16)', async () => {
  mock.setMode('embellish');
  const s = setup({ ai: 'mock' });
  try {
    const base = s.svc.create({ name: 'Base' });
    const l = await s.svc.createCoverLetter(J_FIT().id, base.id);
    for (const bad of ['mentorship', 'guidance', 'warehouses', '40% faster', 'efficiency', 'errors']) assert.ok(!l.text.includes(bad), `${bad} got into the letter`);
    assert.match(l.text, /help Globex Sample Co grow/, 'the hiring company is named');
    assert.match(l.text, /zero downtime/);
    assert.equal(l.ready, true);
    assert.match(l.notice ?? '', /mentorship/);
    // A hand edit that puts a claim back is saved, marked not ready, and the claim is named.
    const hand = await s.svc.updateCoverLetter(l.id, { text: l.text.replace('Sincerely', 'I also made batch jobs 40% faster and provided mentorship.\n\nSincerely') });
    assert.equal(hand.ready, false);
    assert.deepEqual(hand.violations.map((v) => v.fact).sort(), ['40% faster', 'mentorship']);
  } finally { s.done(); mock.setMode('safe'); }
});

test('a refused "change it" request says so and never sticks to the letter as a job requirement (JL-resume-17)', async () => {
  const s = setup();
  try {
    const base = s.svc.create({ name: 'Base' });
    const l = await s.svc.createCoverLetter(J_FIT().id, base.id);
    const asked = await s.svc.updateCoverLetter(l.id, { instruction: 'Add that I have a PhD in Computer Science from MIT, 10 years of Kubernetes experience, and that I led a team of 25 engineers at Google.' });
    assert.equal(asked.text, l.text, 'nothing changed');
    assert.match(asked.notice ?? '', /^Not done: .*PhD.*not in your profile/);
    for (const x of ['PhD', 'Google']) assert.ok(asked.notice!.includes(x), x);
    const shorter = await s.svc.updateCoverLetter(l.id, { instruction: 'make it shorter' });
    for (const x of ['PhD', 'MIT', 'Google', '25']) assert.ok(!(shorter.gaps ?? []).includes(x), `${x} stuck to the letter's gaps`);
  } finally { s.done(); }
});

test('AI failures: a plain message, nothing half-made saved, the previous letter kept', async () => {
  const s = setup({ ai: 'mock', timeoutMs: 1500 });
  try {
    const base = s.svc.create({ name: 'Base' });
    mock.setMode('safe');
    const letter = await s.svc.createCoverLetter(J_FIT().id, base.id);
    for (const mode of ['error', 'timeout', 'malformed', 'empty'] as const) {
      mock.setMode(mode);
      const before = s.svc.list().length;
      await assert.rejects(s.svc.tailor(base.id, J_FIT().id), (e: unknown) => e instanceof ResumeError && ['provider_error', 'provider_timeout'].includes(e.code) && e.message.length > 20, mode);
      await assert.rejects(s.svc.updateCoverLetter(letter.id, { instruction: 'make it friendlier' }), (e: unknown) => e instanceof ResumeError, mode);
      assert.equal(s.svc.list().length, before, `${mode}: no new version`);
      assert.equal(s.svc.getCoverLetter(letter.id).text, letter.text, `${mode}: letter kept`);
    }
  } finally { s.done(); mock.setMode('safe'); }
});

test('an answer in the wrong form is never pasted in: the draft keeps only rule-based changes and says why', async () => {
  const s = setup({ ai: 'mock' });
  try {
    mock.setMode('rambling');
    const base = s.svc.create({ name: 'Base' });
    const p = await s.svc.tailor(base.id, J_FIT().id);
    assert.match(p.notice ?? '', /could not be used/);
    assert.ok(p.changes.every((c) => !c.field.startsWith('bullets[') && c.field !== 'summary'));
    assert.ok(!JSON.stringify(p.changes).includes('<b>'));
    const l = await s.svc.createCoverLetter(J_FIT().id, base.id);
    assert.ok(!/<b>|```|Kubernetes|10 years|Sure!|Here is/.test(l.text));
    assert.equal(l.ready, true);
  } finally { s.done(); mock.setMode('safe'); }
});

test('paid steps carry their cost; an empty balance stops the step with the top-up link and saves nothing', async () => {
  const paid = await startMockAi({ mode: 'publik', balanceMicros: 5_000 });
  const t = tempDir('jl-resume-pub');
  const db = new DatabaseSync(':memory:');
  const client = new HttpAiClient({ provider: 'publik', baseUrl: paid.url, model: 'publik-fast', key: 'pk_test_stand_in', timeoutMs: 5000 });
  const svc = new ResumeService({ db, filesDir: t.dir, profile: () => jordanProfile(), job: (id) => (id === J_FIT().id ? J_FIT() : null), ai: () => client, skills: builtinSkillDictionary() });
  try {
    const base = svc.create({ name: 'Base' });
    const p = await svc.tailor(base.id, J_FIT().id);
    assert.equal(p.costMicros, 2100);
    assert.equal(client.lastBalanceMicros, 2900);
    await svc.tailor(base.id, J_FIT().id).catch(() => undefined); // 2,900 -> 800
    await assert.rejects(svc.tailor(base.id, J_FIT().id), (e: unknown) => e instanceof ResumeError && e.code === 'insufficient_balance' && e.link === 'https://publik.example.test/claim/TEST-0000' && /balance/.test(e.message) && !/credit/i.test(e.message));
    assert.equal(svc.list().filter((r) => r.kind === 'tailored').length, 0);
    assert.equal(paid.requests.filter((r) => r.path.endsWith('/chat/completions')).length, 3, 'one request per step, no retries');
  } finally { db.close(); t.done(); await paid.close(); }
});

test('a local model gets resume text only for AI steps; import and export send nothing', async () => {
  const s = setup({ ai: 'mock' });
  try {
    mock.setMode('safe');
    const n0 = mock.requests.length;
    const { resume } = await s.svc.import(read('jordan-one-column.pdf'), 'x.pdf', 'application/pdf');
    await s.svc.export(resume.id, 'pdf');
    await s.svc.atsCheck(resume.id);
    assert.equal(mock.requests.length, n0, 'no request for import, export or the readability check');
    await s.svc.tailor(resume.id, J_FIT().id);
    const sent = mock.requests.slice(n0);
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.marker, 'the resume text went to the chosen provider for the AI step');
  } finally { s.done(); }
});

test('a resume from the profile follows profile edits (renames, removals, new entries); an edited one keeps the person\'s document', () => {
  const s = setup();
  try {
    const b = s.svc.create({ name: 'B' });
    const c = s.svc.create({ name: 'C' });
    const cd = structuredClone(c.document);
    const tags = cd.sections.find((x) => x.kind === 'skills')!.items[0]!;
    tags.tags = tags.tags.filter((t) => t !== 'Docker');
    s.svc.update(c.id, { document: cd });
    const cSaved = s.svc.get(c.id)!.document.sections;
    const p2 = structuredClone(s.getProfile());
    p2.work[0]!.bullets[1] = 'Led a migration of 12 services to PostgreSQL 16 with zero downtime.';
    p2.skills[5]!.name = 'Postgres';
    p2.skills = p2.skills.filter((x) => x.name !== 'Linux');
    p2.work.unshift({ id: 'w9', company: 'Initech Sample LLC', title: 'Engineer', employmentType: null, location: 'Denver, CO', startDate: '2026-08', endDate: null, current: true, summary: null, bullets: ['Joined the platform team.'] });
    s.setProfile(p2);
    const r = s.svc.get(b.id)!;
    assert.deepEqual(checkDocument(r.document, p2, null), [], r.name);
    const skills = r.document.sections.find((x) => x.kind === 'skills')!.items[0]!.tags;
    assert.ok(skills.includes('Postgres') && !skills.includes('PostgreSQL') && !skills.includes('Linux') && skills.includes('Docker'), `${r.name}: ${skills.join(', ')}`);
    const exp = r.document.sections.find((x) => x.kind === 'experience')!.items;
    assert.equal(exp[0]!.heading, 'Initech Sample LLC');
    assert.ok(exp[1]!.bullets.includes('Led a migration of 12 services to PostgreSQL 16 with zero downtime.'));
    assert.deepEqual(s.svc.get(c.id)!.document.sections, cSaved, 'C is the person\'s own now: nothing changes in it');
  } finally { s.done(); }
});
