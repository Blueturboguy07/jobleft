// JL-onboarding-4 and -9: a stored resume carries the type of what the file holds (a Word file named .pdf is a Word
// file), and the advice for a text file named .pdf is one the upload can follow (the upload takes PDF and Word only).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AiError, type AiClient } from '@jobleft/ai-engine';
import { ResumeError } from '../src/errors.ts';
import { builtinSkillDictionary } from '../src/gaps.ts';
import { ResumeService } from '../src/service.ts';
import { jordanProfile, read, tempDir } from './helpers.ts';

function service() {
  const t = tempDir('jl-resume-type');
  const db = new DatabaseSync(':memory:');
  const svc = new ResumeService({
    db, filesDir: t.dir, profile: () => jordanProfile(), job: () => null,
    ai: (): AiClient => { throw new AiError('no_provider', 'none'); }, skills: builtinSkillDictionary(),
  });
  return { svc, done: () => { db.close(); t.done(); } };
}

test('a Word file named .pdf is stored as a Word file', async () => {
  const s = service();
  try {
    const r = await s.svc.import(read('jordan-layout-table.docx'), 'docx-named.pdf', 'application/pdf');
    assert.equal(r.resume.file?.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  } finally { s.done(); }
});

test('a text file named .pdf gets advice the upload can follow (no .txt)', async () => {
  const s = service();
  try {
    await assert.rejects(s.svc.import(new TextEncoder().encode('Jordan Testwell\nData analyst\n'), 'fake.pdf', 'application/pdf'), (e: unknown) => {
      assert.ok(e instanceof ResumeError);
      assert.match(e.message, /holds plain text/);
      assert.doesNotMatch(e.message, /\.txt/);
      assert.match(e.message, /PDF or a Word \(\.docx\) file/);
      return true;
    });
  } finally { s.done(); }
});
