// Server O4, O5, O13: confirmed saves survive restarts and kill -9; failures are visible; facts stay as stored.

import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, PERSONA, raw, scratchHome, spawnServer, startTest, waitExit } from './helpers.ts';

// A real one-page PDF (the resume engine reads it; a fake header is refused as damaged).
const PDF = readFileSync(new URL('../../../packages/resume/test/fixtures/jordan-one-column.pdf', import.meta.url));
const CSV = '﻿Notes:\r\n"When exporting your connection data, you may notice that some of the email addresses are missing, because of privacy settings."\r\n\r\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\r\nAlex,Example,https://www.linkedin.com/in/alex-example-test,,"Acme, Inc.",Technical Recruiter,04 Mar 2025\r\nSam,Sample,,sam@example.com,Initech,Data Engineer,12 Jan 2024\r\n,,,,,,\r\n';

async function addTextJob(call: (m: string, p: string, b?: unknown) => Promise<{ status: number; json: any }>, title: string) {
  const r = await call('POST', '/api/v1/jobs/external', { text: `${title} at Acme Robotics\nCompany: Acme Robotics\nWe build robots. Salary not stated here.`, applyUrl: `https://example.com/jobs/${encodeURIComponent(title)}` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.job.id as string;
}

test('every kind of record survives a restart, text and times unchanged', async () => {
  const home = scratchHome('rec');
  let s = await startTest('rec', { home });
  const longNote = 'Long note 🎯 ' + 'é'.repeat(19_000);
  let jobId: string;
  try {
    assert.equal((await s.call('PUT', '/api/v1/profile', { ...PERSONA, unknownKey: 'dropped' })).status, 200);
    jobId = await addTextJob(s.call, 'Data Analyst');
    const t = await s.call('PATCH', `/api/v1/tracker/${encodeURIComponent(jobId)}`, {
      liked: true, status: 'applied',
      notes: [{ text: 'First note 日本語' }, { text: longNote }],
      reminders: [{ at: '2026-10-01T09:00:00+02:00', text: 'Follow up', done: false }, { at: '2026-10-02T23:59:59Z', text: 'Near midnight', done: false }],
    });
    assert.equal(t.status, 200, t.text);
    assert.equal(t.json.statusHistory.length, 1);
    const t2 = await s.call('PATCH', `/api/v1/tracker/${encodeURIComponent(jobId)}`, { status: 'interviewing', notes: [...t.json.notes.map((n: any) => ({ id: n.id, text: n.text })), { text: 'third' }] });
    assert.equal(t2.json.statusHistory.length, 2);
    assert.equal(t2.json.notes[0].id, t.json.notes[0].id, 'note ids are kept');
    assert.equal((await s.call('POST', '/api/v1/filters', { name: 'Remote analyst ✓', filter: { workModels: ['remote'] }, sort: 'most_recent', alert: true })).status, 200);
    const imp = await s.call('POST', '/api/v1/resumes/import', PDF, { 'content-type': 'application/pdf', 'x-jobleft-filename': encodeURIComponent('Jordan Testwell résumé.pdf') });
    assert.equal(imp.status, 200, imp.text);
    assert.equal(imp.json.resume.file.bytes, PDF.length);
    const net = await s.call('POST', '/api/v1/network/import', Buffer.from(CSV), { 'content-type': 'text/csv' });
    assert.equal(net.status, 200, net.text);
    assert.equal(net.json.imported, 2);
    assert.equal(net.json.skipped.length, 0);
    const contacts = (await s.call('GET', '/api/v1/network/contacts')).json;
    assert.equal(contacts.find((c: any) => c.firstName === 'Alex').company, 'Acme, Inc.');
    assert.equal(contacts.find((c: any) => c.firstName === 'Alex').connectedOn, '2025-03-04');
    await s.call('PATCH', `/api/v1/network/contacts/${contacts[0].id}`, { stage: 'messaged', note: 'Said hi', followUpOn: '2026-10-03' });
  } finally { await s.stop(); }

  s = await startTest('rec', { home });
  try {
    const p = (await s.call('GET', '/api/v1/profile')).json;
    assert.equal(p.summary, PERSONA.summary);
    assert.equal(p.unknownKey, undefined);
    const tr = (await s.call('GET', `/api/v1/jobs/${encodeURIComponent(jobId!)}`)).json.tracker;
    assert.equal(tr.liked, true);
    assert.equal(tr.status, 'interviewing');
    assert.deepEqual(tr.notes.map((n: any) => n.text), ['First note 日本語', longNote, 'third']);
    assert.deepEqual(tr.reminders.map((r: any) => r.at), ['2026-10-01T09:00:00+02:00', '2026-10-02T23:59:59Z']);
    assert.equal((await s.call('GET', '/api/v1/filters')).json[0].name, 'Remote analyst ✓');
    const res = (await s.call('GET', '/api/v1/resumes')).json;
    assert.equal(res.length, 1);
    assert.equal(res[0].file.fileName, 'Jordan Testwell résumé.pdf');
    const c = (await s.call('GET', '/api/v1/network/contacts?stage=messaged')).json;
    assert.equal(c.length, 1);
    assert.equal(c[0].followUpOn, '2026-10-03');
    const liked = (await s.call('GET', '/api/v1/tracker?view=liked')).json;
    assert.equal(liked.counts.liked, 1);
    assert.equal(liked.counts.byStatus.interviewing, 1);
  } finally { await s.stop(); cleanup(home); }
});

test('a save confirmed just before kill -9 is there after the restart', async () => {
  const home = scratchHome('kill');
  const a = spawnServer(home);
  const { port, pid } = await a.ready;
  const r = await raw(port, { method: 'PUT', path: '/api/v1/profile', headers: { 'x-jobleft-token': a.token, 'content-type': 'application/json' }, body: JSON.stringify({ ...PERSONA, summary: 'saved right before the kill ✓' }) });
  assert.equal(r.status, 200);
  process.kill(pid, 'SIGKILL');
  await waitExit(a.child);
  const b = spawnServer(home);
  const info = await b.ready;
  const p = await raw(info.port, { path: '/api/v1/profile', headers: { 'x-jobleft-token': b.token } });
  assert.equal(p.json.summary, 'saved right before the kill ✓');
  const old = await raw(info.port, { path: '/api/v1/profile', headers: { 'x-jobleft-token': a.token } });
  assert.equal(old.status, 401, 'the token of the killed run no longer works');
  process.kill(info.pid, 'SIGTERM');
  assert.equal(await waitExit(b.child), 0);
  cleanup(home);
});

test('a save into a read-only data folder is refused with a clear error, and old data stays', { skip: process.platform === 'win32' && 'POSIX permissions only' }, async () => {
  const s = await startTest('ro');
  try {
    await s.call('PUT', '/api/v1/profile', PERSONA);
    chmodSync(join(s.home, 'data'), 0o500);
    const r = await s.call('PUT', '/api/v1/profile', { ...PERSONA, summary: 'should not be saved' });
    assert.equal(r.status, 507, r.text);
    assert.equal(r.json.error.code, 'write_failed');
    assert.match(r.json.error.message, /read-only/);
    chmodSync(join(s.home, 'data'), 0o700);
    assert.equal((await s.call('GET', '/api/v1/profile')).json.summary, PERSONA.summary);
  } finally { chmodSync(join(s.home, 'data'), 0o700); await s.stop(); cleanup(s.home); }
});

test('facts that a job does not state stay null; pay, dates and text come back as stored', async () => {
  const s = await startTest('facts');
  try {
    const id = await addTextJob(s.call, 'Line Cook');
    const j = (await s.call('GET', `/api/v1/jobs/${encodeURIComponent(id)}`)).json.job;
    assert.equal(j.postedAt, null);
    assert.equal(j.pay, null);
    assert.equal(j.workModel, null);
    assert.equal(j.employmentType, null);
    assert.equal(j.yearsRequired, null);
    assert.deepEqual(j.places, []);
    assert.equal(j.statements.sponsorship, null);
    assert.equal(j.company, 'Acme Robotics');
    const list = (await s.call('GET', '/api/v1/jobs?sort=most_recent')).json;
    assert.equal(list.items[0].h1bTag, null);
    assert.equal(list.items[0].match, null);
    assert.equal(list.items[0].networkCount, null);
    // Labelled lines give facts, exactly as stated; a plain date stays on its day in every US time zone.
    const text = 'Payroll Analyst\nCompany: Beta LLC\nLocation: Denver, CO\nWorkplace: Hybrid\nEmployment type: Part-time\nPosted: 2026-09-20\nSalary: $120K to $150K per year';
    const r = await s.call('POST', '/api/v1/jobs/external', { text });
    assert.equal(r.status, 200, r.text);
    const k = r.json.job;
    assert.deepEqual([k.title, k.company, k.workModel, k.employmentType], ['Payroll Analyst', 'Beta LLC', 'hybrid', 'part_time']);
    assert.equal(k.places[0].text, 'Denver, CO');
    assert.equal(k.postedAt, '2026-09-20T12:00:00.000Z');
    assert.deepEqual([k.pay.min, k.pay.max, k.pay.period], [120000, 150000, 'year']);
    const bare = (await s.call('POST', '/api/v1/jobs/external', { text: 'Barista\nCompany: Gamma Cafe\nWe roast beans in Denver.\nPosted: last week' })).json.job;
    assert.deepEqual([bare.workModel, bare.postedAt, bare.places.length], [null, null, 0], 'unlabelled or unclear facts stay unknown');
  } finally { await s.stop(); cleanup(s.home); }
});

test('keys a contract does not declare are never stored, even names such as constructor or toString', async () => {
  const s = await startTest('unknown');
  try {
    const odd = { constructor: { prototype: { polluted: 1 } }, toString: 'x', hasOwnProperty: 1, valueOf: [1], bogus: true };
    const f = await s.call('POST', '/api/v1/filters', { name: 'odd', filter: { ...odd, workModels: ['remote'] }, sort: 'recommended', ...odd });
    assert.equal(f.status, 200, f.text);
    assert.deepEqual(f.json.filter, { workModels: ['remote'] });
    assert.deepEqual((await s.call('GET', '/api/v1/filters')).json[0].filter, { workModels: ['remote'] });
    const p = await s.call('PUT', '/api/v1/profile', { ...PERSONA, ...odd, personal: { ...PERSONA.personal, ...odd } });
    assert.equal(p.status, 200, p.text);
    const back = (await s.call('GET', '/api/v1/profile')).json;
    for (const k of Object.keys(odd)) {
      assert.ok(!Object.hasOwn(back, k), `profile kept ${k}`);
      assert.ok(!Object.hasOwn(back.personal, k), `profile.personal kept ${k}`);
    }
    assert.equal(back.personal.email, PERSONA.personal.email);
    assert.equal(({} as Record<string, unknown>).polluted, undefined, 'no prototype was changed');
    const set = await s.call('PUT', '/api/v1/settings', { crawl: { intervalHours: 12, catchUpOnLaunch: false, runInTray: true, ...odd }, notifications: { reminders: true, alerts: false }, ...odd });
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(Object.keys(set.json.crawl).sort(), ['catchUpOnLaunch', 'intervalHours', 'runInTray']);
    // The menu bar's "Pause checks" is the optional crawl.paused flag; it round-trips and is absent until set.
    const paused = await s.call('PUT', '/api/v1/settings', { crawl: { intervalHours: 12, catchUpOnLaunch: false, runInTray: true, paused: true }, notifications: { reminders: true, alerts: false } });
    assert.equal(paused.status, 200);
    assert.equal(paused.json.crawl.paused, true);
    assert.equal((await s.call('GET', '/api/v1/settings')).json.crawl.paused, true);
  } finally { await s.stop(); cleanup(s.home); }
});

test('resume uploads: the real type is checked, and files come back byte for byte', async () => {
  const s = await startTest('resume');
  try {
    const bad = await s.call('POST', '/api/v1/resumes/import', Buffer.from('not a pdf'), { 'content-type': 'application/pdf' });
    assert.ok([400, 415].includes(bad.status), bad.text);
    const wrongType = await s.call('POST', '/api/v1/resumes/import', PDF, { 'content-type': 'text/plain' });
    assert.equal(wrongType.status, 415);
    const ok = await s.call('POST', '/api/v1/resumes/import', PDF, { 'content-type': 'application/pdf', 'x-jobleft-filename': '..%2F..%2Fevil.pdf' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.resume.file.fileName, 'evil.pdf');
    // Non-Latin names come back character for character, URI-encoded (the contract) or sent as raw UTF-8 bytes.
    const name = 'Jördan résumé 履歴書 🎯.pdf';
    const enc = await s.call('POST', '/api/v1/resumes/import', PDF, { 'content-type': 'application/pdf', 'x-jobleft-filename': encodeURIComponent(name) });
    assert.equal(enc.json.resume.file.fileName, name);
    const rawUtf8 = await s.call('POST', '/api/v1/resumes/import', PDF, { 'content-type': 'application/pdf', 'x-jobleft-filename': Buffer.from(name, 'utf8').toString('latin1') });
    assert.equal(rawUtf8.json.resume.file.fileName, name);
    for (const id of [enc.json.resume.id, rawUtf8.json.resume.id]) assert.equal((await s.call('DELETE', `/api/v1/resumes/${id}`)).status, 200);
    const back = await s.call('GET', `/api/v1/resumes/${ok.json.resume.id}/export?format=pdf`);
    assert.equal(back.status, 200);
    assert.equal(back.headers['content-type'], 'application/pdf');
    assert.ok(back.body.equals(PDF), 'the uploaded file comes back byte for byte');
    // The resume engine renders a Word file from the read document of an uploaded PDF.
    const docx = await s.call('GET', `/api/v1/resumes/${ok.json.resume.id}/export?format=docx`);
    assert.equal(docx.status, 200, docx.text);
    assert.equal(docx.headers['content-type'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.ok(docx.body.length > 1000 && docx.body.subarray(0, 2).toString() === 'PK', 'a real zip-based Word file');
    const del = await s.call('DELETE', `/api/v1/resumes/${ok.json.resume.id}`);
    assert.deepEqual(del.json.deleted, [ok.json.resume.id]);
    assert.equal((await s.call('GET', '/api/v1/resumes')).json.length, 0);
  } finally { await s.stop(); cleanup(s.home); }
});
