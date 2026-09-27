// Server O3: the person controls extension pairing; the extension reaches only its own routes.

import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { cleanup, PERSONA, raw, startTest } from './helpers.ts';
import { withExtension } from '../src/services/extension.ts';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${EXT}`;
// A real one-page PDF (the resume engine reads it; a fake header is refused as damaged).
const PDF = readFileSync(new URL('../../../packages/resume/test/fixtures/jordan-one-column.pdf', import.meta.url));

test('pairing needs the person, five wrong codes void it, and unpairing stops the token at once', async () => {
  const s = await startTest('pair');
  try {
    const ext = (method: string, path: string, token?: string, body?: unknown, origin = ORIGIN) => raw(s.port, {
      method, path, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { origin, ...(token ? { 'x-jobleft-pairing': token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    const req = (code: string) => ({ code, extensionId: EXT, extensionVersion: '0.1.0', protocolVersion: 1, browser: 'Chrome test' });

    // Before any approval: nothing works.
    assert.equal((await ext('GET', '/api/v1/extension/status')).status, 401);
    assert.equal((await ext('POST', '/api/v1/extension/pair', undefined, req('123456'))).status, 401);
    // A web page cannot ask for a code (no launch token; foreign Origin).
    assert.equal((await raw(s.port, { method: 'POST', path: '/api/v1/extension/pairing-code', headers: { origin: 'http://attacker.example' } })).status, 403);
    // Pairing from a web page Origin or with no Origin is refused.
    assert.equal((await ext('POST', '/api/v1/extension/pair', undefined, req('123456'), 'http://attacker.example')).status, 403);
    assert.equal((await raw(s.port, { method: 'POST', path: '/api/v1/extension/pair', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req('123456')) })).status, 403);

    // The app shows its own port next to the code: the extension sends the code to that port only (JL-extension-2, 3).
    assert.equal((await s.call('POST', '/api/v1/extension/pairing-code')).json.port, s.port);

    // Five wrong guesses void the code.
    let code = (await s.call('POST', '/api/v1/extension/pairing-code')).json.code as string;
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) assert.equal((await ext('POST', '/api/v1/extension/pair', undefined, req(wrong))).status, 401);
    assert.equal((await ext('POST', '/api/v1/extension/pair', undefined, req(code))).status, 401, 'the code is void now');

    // The id in the body must match the Origin.
    code = (await s.call('POST', '/api/v1/extension/pairing-code')).json.code;
    assert.equal((await ext('POST', '/api/v1/extension/pair', undefined, { ...req(code), extensionId: 'ponmlkjihgfedcbaponmlkjihgfedcba' })).status, 403);
    const paired = await ext('POST', '/api/v1/extension/pair', undefined, req(code));
    assert.equal(paired.status, 200, paired.text);
    assert.equal(paired.headers['access-control-allow-origin'], ORIGIN);
    const token = paired.json.pairingToken as string;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await ext('POST', '/api/v1/extension/pair', undefined, req(code))).status, 401, 'a code works once');

    // The documented extension calls work; nothing else does.
    await s.call('PUT', '/api/v1/profile', PERSONA);
    await s.call('POST', '/api/v1/resumes/import', PDF, { 'content-type': 'application/pdf', 'x-jobleft-filename': 'cv.pdf' });
    const st = await ext('GET', '/api/v1/extension/status', token);
    assert.equal(st.status, 200);
    assert.equal(st.json.profileComplete, true);
    const fill = await ext('POST', '/api/v1/extension/fill', token, {
      requestId: 'r1', pageUrl: 'https://boards.greenhouse.io/acme/jobs/1', ats: 'greenhouse', step: null, resumeId: null,
      fields: [
        { fieldId: 'f1', label: 'First Name', name: 'first_name', kind: 'text', required: true, options: [], maxLength: null, section: null },
        { fieldId: 'f2', label: 'Email', name: 'email', kind: 'email', required: true, options: [], maxLength: null, section: null },
        { fieldId: 'f3', label: 'Resume/CV', name: 'resume', kind: 'file', required: true, options: [], maxLength: null, section: null },
        { fieldId: 'f4', label: 'What are your salary expectations?', name: 'q1', kind: 'text', required: false, options: [], maxLength: null, section: null },
        { fieldId: 'f5', label: 'Gender', name: 'gender', kind: 'select', required: false, options: [{ value: '1', label: 'Male' }, { value: '2', label: 'Female' }, { value: '3', label: 'Decline to self-identify' }], maxLength: null, section: 'Voluntary Self-Identification' },
        { fieldId: 'f6', label: 'Veteran status', name: 'vet', kind: 'select', required: false, options: [{ value: 'a', label: 'I am a veteran' }, { value: 'b', label: 'I am not a veteran' }, { value: 'c', label: 'I decline to self-identify' }], maxLength: null, section: null },
        { fieldId: 'f7', label: 'Referrer email', name: 'ref', kind: 'email', required: false, options: [], maxLength: null, section: null },
      ],
    });
    assert.equal(fill.status, 200, fill.text);
    const byId = Object.fromEntries(fill.json.fills.map((f: any) => [f.fieldId, f.values[0]]));
    assert.equal(byId.f1, 'Jordan');
    assert.equal(byId.f2, 'jordan.testwell@example.com');
    assert.equal(fill.json.files[0].fieldId, 'f3');
    assert.equal(Buffer.from(fill.json.files[0].base64, 'base64').toString(), PDF.toString());
    for (const f of ['f4', 'f5', 'f7']) assert.ok(fill.json.unknownFieldIds.includes(f), `${f} stays empty`);
    assert.equal(byId.f6, 'c', 'a saved "decline" answer picks the decline option');

    for (const [m, p] of [['POST', '/api/v1/backup'], ['GET', '/api/v1/ai/settings'], ['GET', '/api/v1/network/contacts'], ['GET', '/api/v1/profile'], ['GET', '/api/v1/publik']]) {
      const r = await raw(s.port, { method: m, path: p, headers: { origin: ORIGIN, 'x-jobleft-pairing': token, 'x-jobleft-token': token } });
      assert.equal(r.status, 403, `${m} ${p} is not for the extension`);
    }
    // The extension's own token is not the launch token.
    assert.equal((await s.call('GET', '/api/v1/extension/pairings', undefined, { 'x-jobleft-token': token })).status, 401);

    const list = (await s.call('GET', '/api/v1/extension/pairings')).json;
    assert.equal(list.length, 1);
    assert.equal(list[0].extensionId, EXT);

    // Restart: the pairing survives, and still works.
    await s.stop();
    const s2 = await startTest('pair', { home: s.home });
    try {
      assert.equal((await s2.call('GET', '/api/v1/extension/pairings')).json.length, 1);
      const st2 = await raw(s2.port, { path: '/api/v1/extension/status', headers: { origin: ORIGIN, 'x-jobleft-pairing': token } });
      assert.equal(st2.status, 200);
      // Unpair in the app: the token stops at once.
      assert.equal((await s2.call('DELETE', `/api/v1/extension/pairings/${EXT}`)).status, 200);
      const st3 = await raw(s2.port, { path: '/api/v1/extension/status', headers: { origin: ORIGIN, 'x-jobleft-pairing': token } });
      assert.equal(st3.status, 401);
    } finally { await s2.stop(); }
  } finally { cleanup(s.home); }
});

test('a review that the person submitted marks the job Applied and keeps saved answers', async () => {
  const s = await startTest('review');
  try {
    const ext = (method: string, path: string, token: string, body?: unknown) => raw(s.port, { method, path, body: body === undefined ? undefined : JSON.stringify(body), headers: { origin: ORIGIN, 'x-jobleft-pairing': token, 'content-type': 'application/json' } });
    const code = (await s.call('POST', '/api/v1/extension/pairing-code')).json.code;
    const token = (await raw(s.port, { method: 'POST', path: '/api/v1/extension/pair', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ code, extensionId: EXT, extensionVersion: '0.1.0', protocolVersion: 1, browser: 'Chrome' }) })).json.pairingToken;
    const job = await s.call('POST', '/api/v1/jobs/external', { text: 'Analyst\nCompany: Acme', applyUrl: 'https://jobs.example.com/acme/analyst' });
    const r = await ext('POST', '/api/v1/extension/review', token, {
      requestId: 'rv1', pageUrl: 'https://jobs.example.com/acme/analyst', jobId: null, ats: 'other', filledFieldIds: ['a'], editedFieldIds: [],
      submittedByUser: true, savedAnswers: [{ label: 'How did you hear about us?', value: 'A friend' }], at: '2026-09-25T10:00:00Z',
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.trackerEntry.status, 'applied');
    assert.equal(r.json.trackerEntry.jobId, job.json.job.id);
    const fill = await ext('POST', '/api/v1/extension/fill', token, { requestId: 'r2', pageUrl: 'https://jobs.example.com/x', ats: 'other', step: null, resumeId: null, fields: [{ fieldId: 'h', label: 'How did you hear about us?', name: null, kind: 'text', required: false, options: [], maxLength: null, section: null }] });
    assert.equal(fill.json.fills[0].values[0], 'A friend');
    assert.equal(fill.json.fills[0].source, 'saved_answer');
  } finally { await s.stop(); cleanup(s.home); }
});

test('a resume made in the app is offered and attached as a PDF the app makes (JL-extension-5, JL-extension-11)', async () => {
  const s = await startTest('built-resume');
  try {
    const ext = (path: string, token: string, body: unknown) => raw(s.port, { method: 'POST', path, body: JSON.stringify(body), headers: { origin: ORIGIN, 'x-jobleft-pairing': token, 'content-type': 'application/json' } });
    const code = (await s.call('POST', '/api/v1/extension/pairing-code')).json.code;
    const token = (await raw(s.port, { method: 'POST', path: '/api/v1/extension/pair', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ code, extensionId: EXT, extensionVersion: '0.1.0', protocolVersion: 1, browser: 'Chrome' }) })).json.pairingToken;
    // Plain letters: the PDF font has them all (the persona's summary has 日本語 and an emoji, see below).
    await s.call('PUT', '/api/v1/profile', { ...PERSONA, summary: 'Data analyst.' });
    const made = await s.call('POST', '/api/v1/resumes', { name: 'My resume' });
    assert.equal(made.status, 200, made.text);
    assert.equal(made.json.file, null, 'made from the profile: no uploaded file');

    const page = await ext('/api/v1/extension/page', token, { pageUrl: 'https://boards.greenhouse.io/acme/jobs/1' });
    assert.equal(page.status, 200, page.text);
    const offered = page.json.resumes.find((r: any) => r.id === made.json.id);
    assert.ok(offered, 'the resume made in the app is in the list to attach');
    assert.match(offered.fileName, /\.pdf$/);
    assert.equal(page.json.suggestedResumeId, made.json.id, 'the only resume is the one suggested');

    const fill = await ext('/api/v1/extension/fill', token, {
      requestId: 'r-built', pageUrl: 'https://boards.greenhouse.io/acme/jobs/1', ats: 'greenhouse', step: null, resumeId: made.json.id,
      fields: [{ fieldId: 'cv', label: 'Resume/CV', name: 'resume', kind: 'file', required: true, options: [], maxLength: null, section: null }],
    });
    assert.equal(fill.status, 200, fill.text);
    assert.equal(fill.json.files.length, 1, JSON.stringify(fill.json.warnings));
    const f = fill.json.files[0];
    assert.equal(f.resumeId, made.json.id);
    assert.equal(f.mimeType, 'application/pdf');
    assert.equal(f.fileName, offered.fileName, 'the file attached has the name the popup showed');
    assert.equal(Buffer.from(f.base64, 'base64').subarray(0, 5).toString(), '%PDF-');

    // Letters the PDF font lacks: the app makes the Word file instead of dropping letters, and attaches that.
    await s.call('PUT', '/api/v1/profile', PERSONA);
    const fill2 = await ext('/api/v1/extension/fill', token, {
      requestId: 'r-built-2', pageUrl: 'https://boards.greenhouse.io/acme/jobs/1', ats: 'greenhouse', step: null, resumeId: made.json.id,
      fields: [{ fieldId: 'cv', label: 'Resume/CV', name: 'resume', kind: 'file', required: true, options: [], maxLength: null, section: null }],
    });
    assert.equal(fill2.status, 200, fill2.text);
    assert.equal(fill2.json.files.length, 1, JSON.stringify(fill2.json.warnings));
    assert.match(fill2.json.files[0].fileName, /\.docx$/);
    assert.equal(Buffer.from(fill2.json.files[0].base64, 'base64').subarray(0, 2).toString(), 'PK');
  } finally { await s.stop(); cleanup(s.home); }
});

test('a resume uploaded with no file name is stored and attached with its type\'s extension (JL-extension-6)', async () => {
  // Resumes stored before this fix ("resume", application/pdf) get the extension when they are attached.
  assert.equal(withExtension('resume', 'application/pdf'), 'resume.pdf');
  assert.equal(withExtension('Jordan CV', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'Jordan CV.docx');
  assert.equal(withExtension('jordan-two-column.pdf', 'application/pdf'), 'jordan-two-column.pdf');
  assert.equal(withExtension('CV.PDF', 'application/pdf'), 'CV.PDF');
  assert.equal(withExtension('notes', 'application/octet-stream'), 'notes', 'an unknown type gets no made-up extension');

  const s = await startTest('noname');
  try {
    await s.call('PUT', '/api/v1/profile', PERSONA);
    const up = await s.call('POST', '/api/v1/resumes/import', PDF, { 'content-type': 'application/pdf' });
    assert.equal(up.status, 200, up.text);
    assert.equal(up.json.resume.file.fileName, 'resume.pdf');
    const code = (await s.call('POST', '/api/v1/extension/pairing-code')).json.code;
    const token = (await raw(s.port, { method: 'POST', path: '/api/v1/extension/pair', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ code, extensionId: EXT, extensionVersion: '0.1.0', protocolVersion: 1, browser: 'Chrome' }) })).json.pairingToken;
    const fill = await raw(s.port, {
      method: 'POST', path: '/api/v1/extension/fill', headers: { origin: ORIGIN, 'x-jobleft-pairing': token, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'r-noname', pageUrl: 'https://boards.greenhouse.io/acme/jobs/1', ats: 'greenhouse', step: null, resumeId: null,
        fields: [{ fieldId: 'cv', label: 'Resume/CV', name: 'resume', kind: 'file', required: true, options: [], maxLength: null, section: null, accept: '.pdf,.doc,.docx,.txt,.rtf' }] }),
    });
    assert.equal(fill.status, 200, fill.text);
    assert.equal(fill.json.files[0].fileName, 'resume.pdf');
  } finally { await s.stop(); cleanup(s.home); }
});
