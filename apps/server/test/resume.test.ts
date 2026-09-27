// Resume screen regressions through the local API (QA findings JL-resume-*): an upload is the file's own content and
// saves as edited; a profile save never rewrites it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cleanup, PERSONA, startTest } from './helpers.ts';

const PDF = readFileSync(new URL('../../../packages/resume/test/fixtures/jordan-one-column.pdf', import.meta.url));
const upload = { 'content-type': 'application/pdf', 'x-jobleft-filename': 'jordan-one-column.pdf' };

test('an upload keeps the file\'s summary and skills, saves unchanged or edited, and a profile save leaves it alone (JL-resume-1, JL-resume-5, JL-resume-23, JL-resume-25)', async () => {
  const s = await startTest('resume-own');
  try {
    assert.equal((await s.call('PUT', '/api/v1/profile', PERSONA)).status, 200);
    const up = await s.call('POST', '/api/v1/resumes/import', PDF, upload);
    assert.equal(up.status, 200, up.text);
    const id = up.json.resume.id as string;
    const got = (await s.call('GET', `/api/v1/resumes/${id}`)).json;
    const sec = (d: { sections: Array<{ kind: string; text: string | null; items: Array<{ tags: string[] }> }> }, k: string) => d.sections.find((x) => x.kind === k)!;
    assert.equal(sec(got.document, 'summary').text, 'Software engineer with 3 years of backend experience building APIs and data pipelines.');
    assert.equal(sec(got.document, 'skills').items[0]!.tags.length, 12);
    // The exact document from GET saves (it was refused with "facts that are not in your profile").
    const same = await s.call('PATCH', `/api/v1/resumes/${id}`, { document: got.document });
    assert.equal(same.status, 200, same.text);
    const doc = structuredClone(got.document);
    sec(doc, 'summary').text += ' QA, Agile, SaaS, Berlin, Mondays!';
    const edited = await s.call('PATCH', `/api/v1/resumes/${id}`, { document: doc });
    assert.equal(edited.status, 200, edited.text);
    // A profile save (the phone only) changes neither the edit nor the file's skills.
    assert.equal((await s.call('PUT', '/api/v1/profile', { ...PERSONA, personal: { ...PERSONA.personal, phone: '+1 555 0199' } })).status, 200);
    const back = (await s.call('GET', `/api/v1/resumes/${id}`)).json;
    assert.match(sec(back.document, 'summary').text!, /Mondays!$/);
    assert.equal(sec(back.document, 'skills').items[0]!.tags.length, 12);
    assert.equal(back.document.header.phone, '+1 555 0199', 'the header follows the profile');
    assert.equal(back.updatedAt, edited.json.updatedAt, 'no silent "Last changed"');
  } finally { await s.stop(); cleanup(s.home); }
});
