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
import { readPdf } from '../src/pdf-read.ts';
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

test('an imported resume follows the person\'s corrections once adopted; a re-import changes no profile', async () => {
  const s = setup();
  try {
    const { resume, proposedProfile } = await s.svc.import(read('jordan-one-column.pdf'), 'jordan-one-column.pdf', 'application/pdf');
    // The person adopts the proposal, then corrects a date and a skill.
    const prof = { id: 'default', ...structuredClone(proposedProfile), version: 'v1', updatedAt: '2026-09-25T12:00:00.000Z' } as Profile;
    s.setProfile(prof);
    const corrected = structuredClone(prof);
    corrected.work[1]!.startDate = '2021-02';
    corrected.skills[5]!.name = 'Postgres';
    s.setProfile(corrected);
    const synced = s.svc.get(resume.id)!;
    const exp = synced.document.sections.find((x) => x.kind === 'experience')!;
    assert.equal(exp.items[1]!.startDate, '2021-02');
    assert.ok(synced.document.sections.find((x) => x.kind === 'skills')!.items[0]!.tags.includes('Postgres'));
    assert.ok(!synced.document.sections.find((x) => x.kind === 'skills')!.items[0]!.tags.includes('PostgreSQL'));
    const p = await s.svc.tailor(resume.id, J_FIT().id);
    const v = s.svc.accept(resume.id, p.id, p.changes.map((c) => c.id));
    assert.equal(v.document.sections.find((x) => x.kind === 'experience')!.items[1]!.startDate, '2021-02');
    assert.deepEqual(checkDocument(v.document, corrected, J_FIT()), []);
    // A second import proposes a profile but never writes one.
    await s.svc.import(read('jordan-one-column.pdf'), 'again.pdf', 'application/pdf');
    assert.equal(s.getProfile().work[1]!.startDate, '2021-02');
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
    const pdf = await s.svc.exportCoverLetter(la.id, 'pdf');
    assert.equal((await readPdf(pdf.bytes)).pages.length, 1);
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

test('base resumes follow profile edits (renames, removals, new entries) and keep what the person set per resume', () => {
  const s = setup();
  try {
    const b = s.svc.create({ name: 'B' });
    const c = s.svc.create({ name: 'C' });
    const cd = structuredClone(c.document);
    const tags = cd.sections.find((x) => x.kind === 'skills')!.items[0]!;
    tags.tags = tags.tags.filter((t) => t !== 'Docker');
    s.svc.update(c.id, { document: cd });
    const p2 = structuredClone(s.getProfile());
    p2.work[0]!.bullets[1] = 'Led a migration of 12 services to PostgreSQL 16 with zero downtime.';
    p2.skills[5]!.name = 'Postgres';
    p2.skills = p2.skills.filter((x) => x.name !== 'Linux');
    p2.work.unshift({ id: 'w9', company: 'Initech Sample LLC', title: 'Engineer', employmentType: null, location: 'Denver, CO', startDate: '2026-08', endDate: null, current: true, summary: null, bullets: ['Joined the platform team.'] });
    s.setProfile(p2);
    for (const r of [s.svc.get(b.id)!, s.svc.get(c.id)!]) {
      assert.deepEqual(checkDocument(r.document, p2, null), [], r.name);
      const skills = r.document.sections.find((x) => x.kind === 'skills')!.items[0]!.tags;
      assert.ok(skills.includes('Postgres') && !skills.includes('PostgreSQL') && !skills.includes('Linux'), `${r.name}: ${skills.join(', ')}`);
      const exp = r.document.sections.find((x) => x.kind === 'experience')!.items;
      assert.equal(exp[0]!.heading, 'Initech Sample LLC');
      assert.ok(exp[1]!.bullets.includes('Led a migration of 12 services to PostgreSQL 16 with zero downtime.'));
    }
    assert.ok(!s.svc.get(c.id)!.document.sections.find((x) => x.kind === 'skills')!.items[0]!.tags.includes('Docker'), 'C keeps Docker hidden');
    assert.ok(s.svc.get(b.id)!.document.sections.find((x) => x.kind === 'skills')!.items[0]!.tags.includes('Docker'));
  } finally { s.done(); }
});
